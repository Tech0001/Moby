//! Password-derived credentials, owned only by the worker. No secret export API.
use anyhow::{Context, Result, bail, ensure};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const MEMORY_KIB: u32 = 65536;
const ITERATIONS: u32 = 3;
const MAX_FILE: u64 = 256 * 1024;
const AAD: &[u8] = b"Moby credential vault v1 / Argon2id-19 / XChaCha20Poly1305";

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(transparent)]
pub struct Secret(pub String);

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VaultState {
    /// Also the default for snapshots from workers predating the vault protocol.
    #[default]
    Unsupported,
    NotConfigured,
    Locked,
    Unlocked,
    NotRequired,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VaultStatus {
    pub state: VaultState,
    /// Labels only. Hidden while locked; no API key or secret is ever returned.
    pub credentials: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: [u8; 16],
    nonce: [u8; 24],
    ciphertext: Vec<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Credential {
    pub(crate) api_key: Secret,
    pub(crate) api_secret: Secret,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Contents {
    kraken: BTreeMap<String, Credential>,
    #[serde(default)]
    telegram: Option<TelegramCredential>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct TelegramCredential {
    pub token: Secret,
    pub chat_id: String,
}

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    contents: Contents,
}

pub struct Vault {
    path: PathBuf,
    envelope: Option<Envelope>,
    unlocked: Option<Unlocked>,
}

fn derive(password: &Secret, salt: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>> {
    ensure!(
        !password.0.is_empty() && password.0.len() <= 1024,
        "invalid password length"
    );
    let params = Params::new(MEMORY_KIB, ITERATIONS, 1, Some(32))
        .map_err(|_| anyhow::anyhow!("invalid vault derivation parameters"))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.0.as_bytes(), salt, key.as_mut())
        .map_err(|_| anyhow::anyhow!("password derivation failed"))?;
    Ok(key)
}

pub fn validate_new_password(password: &Secret) -> Result<()> {
    ensure!(
        password.0.chars().count() >= 8 && password.0.len() <= 1024,
        "use a password or passphrase of at least 8 characters (at most 1024 bytes)"
    );
    ensure!(
        !password.0.chars().all(char::is_whitespace),
        "password cannot be only whitespace"
    );
    ensure!(
        !password.0.chars().any(char::is_control),
        "password cannot contain control characters"
    );
    Ok(())
}

impl Vault {
    pub(crate) fn fingerprint(&self) -> Option<String> {
        use sha2::{Digest, Sha256};
        self.unlocked
            .as_ref()?
            .contents
            .kraken
            .get("account")
            .map(|key| {
                let mut hash = Sha256::new();
                hash.update((key.api_key.0.len() as u64).to_be_bytes());
                hash.update(key.api_key.0.as_bytes());
                hash.update(key.api_secret.0.as_bytes());
                format!("{:x}", hash.finalize())
            })
    }
    pub(crate) fn credential(&self) -> Result<Credential> {
        self.unlocked
            .as_ref()
            .context("vault is locked")?
            .contents
            .kraken
            .get("account")
            .cloned()
            .context("enter your Kraken key on 6 API Key first")
    }
    pub fn open(directory: &Path) -> Result<Self> {
        let path = directory.join("vault.json");
        let envelope = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(file) => {
                let metadata = file.metadata()?;
                // SAFETY: geteuid has no preconditions.
                ensure!(
                    metadata.is_file()
                        && metadata.uid() == unsafe { libc::geteuid() }
                        && metadata.mode() & 0o077 == 0,
                    "vault must be a private file owned by you"
                );
                let mut bytes = Vec::new();
                file.take(MAX_FILE + 1).read_to_end(&mut bytes)?;
                ensure!(bytes.len() as u64 <= MAX_FILE, "vault is too large");
                let envelope: Envelope =
                    serde_json::from_slice(&bytes).context("invalid encrypted vault")?;
                // Fixed, versioned KDF parameters prevent a modified header from
                // exhausting memory or downgrading derivation strength.
                ensure!(
                    envelope.version == 1
                        && envelope.memory_kib == MEMORY_KIB
                        && envelope.iterations == ITERATIONS
                        && envelope.parallelism == 1,
                    "unsupported vault format or derivation parameters"
                );
                ensure!(envelope.ciphertext.len() >= 16, "invalid encrypted vault");
                Some(envelope)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e).context("open encrypted vault"),
        };
        Ok(Self {
            path,
            envelope,
            unlocked: None,
        })
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked.is_some()
    }

    pub fn status(&self) -> VaultStatus {
        VaultStatus {
            state: if self.is_unlocked() {
                VaultState::Unlocked
            } else if self.envelope.is_some() {
                VaultState::Locked
            } else {
                VaultState::NotConfigured
            },
            credentials: self
                .unlocked
                .as_ref()
                .map(|u| {
                    if u.contents.kraken.contains_key("account") {
                        vec!["account".into()]
                    } else {
                        vec![]
                    }
                })
                .unwrap_or_default(),
        }
    }

    pub fn create(&mut self, password: Secret) -> Result<()> {
        ensure!(
            self.envelope.is_none(),
            "vault already exists; unlock it instead"
        );
        validate_new_password(&password)?;
        let mut salt = [0; 16];
        OsRng
            .try_fill_bytes(&mut salt)
            .context("system random source unavailable")?;
        let key = derive(&password, &salt)?;
        let contents = Contents::default();
        let envelope = self.save(&key, salt, &contents, true)?;
        self.envelope = Some(envelope);
        self.unlocked = Some(Unlocked { key, contents });
        Ok(())
    }

    pub fn unlock(&mut self, password: Secret) -> Result<()> {
        let envelope = self
            .envelope
            .as_ref()
            .context("set up the vault with `moby` first")?;
        let key = derive(&password, &envelope.salt)?;
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).expect("32-byte key");
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    XNonce::from_slice(&envelope.nonce),
                    Payload {
                        msg: &envelope.ciphertext,
                        aad: AAD,
                    },
                )
                .map_err(|_| anyhow::anyhow!("incorrect password or damaged vault"))?,
        );
        // Never include deserialization errors: they could contain decrypted text.
        let contents: Contents = serde_json::from_slice(&plaintext)
            .map_err(|_| anyhow::anyhow!("invalid vault contents"))?;
        self.unlocked = Some(Unlocked { key, contents });
        Ok(())
    }

    pub fn lock(&mut self) {
        self.unlocked = None;
    }

    pub fn set_credential(&mut self, api_key: Secret, api_secret: Secret) -> Result<()> {
        for value in [&api_key, &api_secret] {
            ensure!(
                !value.0.is_empty()
                    && value.0.len() <= 4096
                    && value.0.bytes().all(|b| b.is_ascii_graphic()),
                "invalid API credential format"
            );
        }
        let unlocked = self
            .unlocked
            .as_ref()
            .context("vault is locked; run `moby` to unlock")?;
        let contents = Contents {
            kraken: BTreeMap::from([(
                "account".into(),
                Credential {
                    api_key,
                    api_secret,
                },
            )]),
            telegram: unlocked.contents.telegram.clone(),
        };
        let envelope = self.save(
            &unlocked.key,
            self.envelope.as_ref().unwrap().salt,
            &contents,
            false,
        )?;
        self.envelope = Some(envelope);
        self.unlocked.as_mut().unwrap().contents = contents;
        Ok(())
    }

    pub fn remove_credential(&mut self) -> Result<()> {
        let unlocked = self
            .unlocked
            .as_ref()
            .context("vault is locked; run moby to unlock")?;
        let contents = Contents {
            telegram: unlocked.contents.telegram.clone(),
            ..Contents::default()
        };
        let envelope = self.save(
            &unlocked.key,
            self.envelope.as_ref().unwrap().salt,
            &contents,
            false,
        )?;
        self.envelope = Some(envelope);
        self.unlocked.as_mut().unwrap().contents = contents;
        Ok(())
    }

    pub(crate) fn telegram(&self) -> Option<TelegramCredential> {
        self.unlocked.as_ref()?.contents.telegram.clone()
    }
    pub fn set_telegram(&mut self, token: Secret, chat_id: String) -> Result<()> {
        let (bot, secret) = token
            .0
            .split_once(':')
            .context("invalid Telegram bot token")?;
        ensure!(
            !bot.is_empty()
                && bot.bytes().all(|b| b.is_ascii_digit())
                && (20..=200).contains(&secret.len())
                && secret
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "invalid Telegram bot token"
        );
        ensure!(
            chat_id.len() <= 32 && chat_id.parse::<i64>().is_ok_and(|id| id != 0),
            "Telegram chat ID must be a nonzero numeric ID"
        );
        let unlocked = self
            .unlocked
            .as_ref()
            .context("unlock the vault before setting up Telegram")?;
        let mut contents = unlocked.contents.clone();
        contents.telegram = Some(TelegramCredential { token, chat_id });
        let envelope = self.save(
            &unlocked.key,
            self.envelope.as_ref().unwrap().salt,
            &contents,
            false,
        )?;
        self.envelope = Some(envelope);
        self.unlocked.as_mut().unwrap().contents = contents;
        Ok(())
    }
    fn save(
        &self,
        key: &[u8; 32],
        salt: [u8; 16],
        contents: &Contents,
        creating: bool,
    ) -> Result<Envelope> {
        let mut nonce = [0; 24];
        OsRng
            .try_fill_bytes(&mut nonce)
            .context("system random source unavailable")?;
        let plaintext = Zeroizing::new(serde_json::to_vec(contents)?);
        let ciphertext = XChaCha20Poly1305::new_from_slice(key)
            .expect("32-byte key")
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: AAD,
                },
            )
            .map_err(|_| anyhow::anyhow!("vault encryption failed"))?;
        let envelope = Envelope {
            version: 1,
            memory_kib: MEMORY_KIB,
            iterations: ITERATIONS,
            parallelism: 1,
            salt,
            nonce,
            ciphertext,
        };
        let bytes = serde_json::to_vec(&envelope)?;
        ensure!(bytes.len() as u64 <= MAX_FILE, "vault is too large");
        let directory = self.path.parent().context("missing vault directory")?;
        let temporary = directory.join(format!(".vault-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            if creating {
                // Publish without overwriting any existing vault, even on a race.
                fs::hard_link(&temporary, &self.path)
                    .context("vault already exists or could not be created")?;
            } else {
                let metadata = fs::symlink_metadata(&self.path)?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    bail!("refusing to replace an invalid vault file");
                }
                fs::rename(&temporary, &self.path)?;
            }
            File::open(directory)?.sync_all()?;
            Ok(())
        })();
        let _ = fs::remove_file(temporary);
        result?;
        Ok(envelope)
    }
}

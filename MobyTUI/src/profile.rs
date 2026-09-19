use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Account,
    Paper,
}
impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Account => "account",
            Self::Paper => "paper",
        }
    }
}

#[derive(Clone)]
pub struct Profile {
    pub root: PathBuf,
    pub directory: PathBuf,
    pub mode: Mode,
    pub account: String,
}
impl Profile {
    pub fn new(root: PathBuf, mode: Mode) -> Self {
        Self::named(root, mode, "main".into()).expect("valid default account")
    }
    pub fn named(root: PathBuf, mode: Mode, account: String) -> Result<Self> {
        ensure!(
            Self::valid_name(&account),
            "account name must start with a lowercase letter and contain 1–24 lowercase letters, digits, hyphens or underscores"
        );
        let base = if account == "main" {
            root.clone()
        } else {
            root.join("accounts").join(&account)
        };
        Ok(Self {
            directory: base.join(mode.name()),
            root,
            mode,
            account,
        })
    }
    fn valid_name(name: &str) -> bool {
        !name.is_empty()
            && name.len() <= 24
            && name.as_bytes()[0].is_ascii_lowercase()
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
    }
    pub fn create_directories(&self) -> Result<()> {
        crate::ipc::create_directory(&self.root)?;
        if self.account != "main" {
            crate::ipc::create_directory(&self.root.join("accounts"))?;
            crate::ipc::create_directory(&self.root.join("accounts").join(&self.account))?;
        }
        crate::ipc::create_directory(&self.directory)
    }
    pub fn list(root: &Path) -> Result<Vec<String>> {
        let mut names = vec!["main".into()];
        let directory = root.join("accounts");
        if root.try_exists()? {
            crate::ipc::check_directory(root)?;
        }
        if directory.try_exists()? {
            crate::ipc::check_directory(&directory)?;
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().to_string();
                if name != "main" && Self::valid_name(&name) && entry.file_type()?.is_dir() {
                    names.push(name);
                }
            }
        }
        names[1..].sort();
        Ok(names)
    }
    pub fn default_root() -> Result<PathBuf> {
        let root = match std::env::var_os("XDG_STATE_HOME") {
            Some(path) if Path::new(&path).is_absolute() => PathBuf::from(path),
            _ => PathBuf::from(
                std::env::var_os("HOME").context("HOME is unset; specify --state-dir")?,
            )
            .join(".local/state"),
        };
        Ok(root.join("moby-tui"))
    }
    pub fn prepare(&self) -> Result<()> {
        self.create_directories()?;
        let marker = self.directory.join("profile.mode");
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&marker)
        {
            Ok(mut file) => {
                // Paper workers must never open a directory containing credentials.
                if self.mode == Mode::Paper
                    && fs::symlink_metadata(self.directory.join("vault.json")).is_ok()
                {
                    fs::remove_file(&marker)?;
                    anyhow::bail!("refusing to use a credential directory as a paper account");
                }
                file.write_all(self.mode.name().as_bytes())?;
                file.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let mut text = String::new();
                OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(marker)?
                    .take(32)
                    .read_to_string(&mut text)?;
                ensure!(
                    text == self.mode.name(),
                    "profile mode mismatch; account and paper data cannot be shared"
                );
            }
            Err(e) => return Err(e.into()),
        }
        ensure!(
            self.mode != Mode::Paper
                || fs::symlink_metadata(self.directory.join("vault.json")).is_err(),
            "paper profiles cannot contain real credentials"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn paper_refuses_credentials_and_a_wrong_profile_marker() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let profile = Profile::new(root.path().into(), Mode::Paper);
        crate::ipc::create_directory(&profile.directory).unwrap();
        let vault = profile.directory.join("vault.json");
        fs::write(&vault, b"never open this").unwrap();
        assert!(profile.prepare().is_err());
        assert_eq!(fs::read(&vault).unwrap(), b"never open this");
        fs::remove_file(vault).unwrap();
        fs::write(profile.directory.join("profile.mode"), b"account").unwrap();
        assert!(profile.prepare().is_err());
        assert_eq!(
            fs::read(profile.directory.join("profile.mode")).unwrap(),
            b"account"
        );
    }
}

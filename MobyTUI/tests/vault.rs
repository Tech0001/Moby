use moby_tui::vault::{Secret, Vault, VaultState};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

fn password() -> Secret {
    Secret("unit-test-only strong passphrase".into())
}
#[test]
fn telegram_token_is_encrypted_and_never_appears_in_vault_status() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = Vault::open(dir.path()).unwrap();
    vault.create(password()).unwrap();
    let token = "123456:telegram-fixture-secret-not-real";
    assert!(
        vault
            .set_telegram(Secret(token.into()), "@invalid-chat".into())
            .is_err()
    );
    vault
        .set_telegram(Secret(token.into()), "-123456".into())
        .unwrap();
    vault
        .set_credential(
            Secret("fixture-key".into()),
            Secret("fixture-secret".into()),
        )
        .unwrap();
    vault.remove_credential().unwrap();
    assert!(
        !fs::read_to_string(dir.path().join("vault.json"))
            .unwrap()
            .contains(token)
    );
    assert!(
        !serde_json::to_string(&vault.status())
            .unwrap()
            .contains(token)
    );
    vault.lock();
    vault.unlock(password()).unwrap();
    assert!(vault.status().credentials.is_empty());
}

#[test]
fn encrypted_credentials_persist_and_tampering_does_not_unlock() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = Vault::open(dir.path()).unwrap();
    vault.create(password()).unwrap();
    vault
        .set_credential(
            Secret("test-api-key".into()),
            Secret("test-api-secret".into()),
        )
        .unwrap();
    let path = dir.path().join("vault.json");
    let file = fs::read_to_string(&path).unwrap();
    for secret in [
        "unit-test-only",
        "test-api-key",
        "test-api-secret",
        "account",
    ] {
        assert!(!file.contains(secret));
    }
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(format!("{:?}", password()), "[REDACTED]");
    assert!(vault.create(password()).is_err());
    vault.lock();
    assert_eq!(vault.status().state, VaultState::Locked);
    assert!(vault.status().credentials.is_empty());
    assert!(vault.remove_credential().is_err());
    assert!(vault.unlock(Secret("wrong-password".into())).is_err());
    assert!(!vault.is_unlocked());
    let mut vault = Vault::open(dir.path()).unwrap();
    assert!(!vault.is_unlocked());
    vault.unlock(password()).unwrap();
    assert_eq!(vault.status().credentials, ["account"]);
    vault.remove_credential().unwrap();
    let updated: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let original: serde_json::Value = serde_json::from_str(&file).unwrap();
    assert_ne!(updated["nonce"], original["nonce"]);
    let mut vault = Vault::open(dir.path()).unwrap();
    vault.unlock(password()).unwrap();
    assert!(vault.status().credentials.is_empty());
    let mut damaged = original;
    damaged["ciphertext"][0] = serde_json::json!(damaged["ciphertext"][0].as_u64().unwrap() ^ 1);
    fs::write(&path, serde_json::to_vec(&damaged).unwrap()).unwrap();
    let mut vault = Vault::open(dir.path()).unwrap();
    assert!(vault.unlock(password()).is_err());
    assert!(!vault.is_unlocked());
    damaged["memory_kib"] = serde_json::json!(u32::MAX);
    fs::write(&path, serde_json::to_vec(&damaged).unwrap()).unwrap();
    assert!(Vault::open(dir.path()).is_err());
}

#[test]
fn vault_refuses_weak_passwords_symlinks_and_unprotected_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = Vault::open(dir.path()).unwrap();
    assert!(vault.create(Secret("seven77".into())).is_err());
    assert!(vault.create(Secret("                ".into())).is_err());
    assert!(!dir.path().join("vault.json").exists());
    let other = dir.path().join("other");
    fs::write(&other, "preserve this").unwrap();
    symlink(&other, dir.path().join("vault.json")).unwrap();
    assert!(Vault::open(dir.path()).is_err());
    assert!(vault.create(password()).is_err());
    assert_eq!(fs::read_to_string(other).unwrap(), "preserve this");
    fs::remove_file(dir.path().join("vault.json")).unwrap();
    vault.create(Secret("eight888".into())).unwrap();
    vault.lock();
    vault.unlock(Secret("eight888".into())).unwrap();
    fs::set_permissions(
        dir.path().join("vault.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(Vault::open(dir.path()).is_err());
}

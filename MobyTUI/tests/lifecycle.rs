use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Output},
};

const BIN: &str = env!("CARGO_BIN_EXE_moby");

fn cli(dir: &Path, args: &[&str]) -> Output {
    Command::new(BIN)
        .arg("--state-dir")
        .arg(dir)
        .args(args)
        .output()
        .unwrap()
}

struct Profile(tempfile::TempDir);
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = cli(self.0.path(), &["stop", "--json"]);
    }
}

#[test]
fn concurrent_launches_share_one_detached_worker_and_stop_cleanly() {
    let dir = Profile(tempfile::tempdir().unwrap());
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.0.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let results = std::thread::scope(|s| {
        let calls: Vec<_> = (0..4)
            .map(|_| s.spawn(|| cli(dir.0.path(), &["start", "--json"])))
            .collect();
        calls
            .into_iter()
            .map(|call| call.join().unwrap())
            .collect::<Vec<_>>()
    });
    let mut pid = None;
    for output in results {
        assert!(output.status.success(), "{:?}", output);
        let status: Value = serde_json::from_slice(&output.stdout).unwrap();
        let id = status["state"]["worker_pid"].as_u64().unwrap();
        if let Some(pid) = pid {
            assert_eq!(pid, id);
        }
        pid = Some(id);
        assert_eq!(status["state"]["vault"]["state"], "not_configured");
    }
    // All launching processes have exited; their background worker survives.
    let output = cli(dir.0.path(), &["status", "--json"]);
    assert!(output.status.success());
    let status: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status["state"]["worker_pid"].as_u64(), pid);
    assert!(cli(dir.0.path(), &["stop", "--json"]).status.success());
    // No sleeps: a stop receipt means the next launch can immediately own the
    // profile, even while the old process is finishing its response transport.
    for _ in 0..10 {
        let output = cli(dir.0.path(), &["start", "--json"]);
        assert!(output.status.success(), "{:?}", output);
        let state: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_ne!(state["state"]["worker_pid"].as_u64(), pid);
        pid = state["state"]["worker_pid"].as_u64();
        assert!(cli(dir.0.path(), &["stop", "--json"]).status.success());
    }
}

#[test]
fn help_and_noninteractive_launches_do_not_start_a_worker() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("unused");
    for args in [
        vec!["--help"],
        vec!["-h"],
        vec!["--version"],
        vec!["key", "--help"],
        vec!["watch", "--help"],
    ] {
        assert!(cli(&dir, &args).status.success());
    }
    for args in [
        vec![],
        vec!["--json"],
        vec!["watch"],
        vec!["unlock"],
        vec!["key", "set"],
    ] {
        assert!(!cli(&dir, &args).status.success());
    }
    assert!(!dir.exists());
    let help = cli(&dir, &["--help"]);
    let help = String::from_utf8(help.stdout).unwrap();
    for flag in [
        "--help",
        "--version",
        "--no-animation",
        "--text-icons",
        "--state-dir",
        "--account",
        "--json",
    ] {
        assert!(help.contains(flag));
    }
}

#[test]
fn named_account_launch_reconnects_to_its_own_worker_and_lists_without_mutating() {
    let root = Profile(tempfile::tempdir().unwrap());
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(root.0.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let output = cli(root.0.path(), &["accounts", "--json"]);
    let names: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(names["accounts"], serde_json::json!(["main"]));
    assert_eq!(std::fs::read_dir(root.0.path()).unwrap().count(), 0);
    let output = cli(root.0.path(), &["--account", "savings", "start", "--json"]);
    assert!(output.status.success(), "{output:?}");
    let first: Value = serde_json::from_slice(&output.stdout).unwrap();
    let output = cli(root.0.path(), &["--account", "savings", "start", "--json"]);
    let next: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(next["state"]["account"], "savings");
    assert_eq!(next["state"]["worker_pid"], first["state"]["worker_pid"]);
    assert!(!root.0.path().join("account").exists());
    assert!(
        cli(root.0.path(), &["--account", "savings", "stop", "--json"])
            .status
            .success()
    );
    for name in [
        "../main",
        "a/b",
        "UPPER",
        "",
        ".",
        "two accounts",
        "a1234567890123456789012345",
    ] {
        assert!(
            !cli(root.0.path(), &["--account", name, "start", "--json"])
                .status
                .success()
        );
    }
}

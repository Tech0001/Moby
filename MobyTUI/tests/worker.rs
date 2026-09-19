use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::Duration,
};
use tempfile::TempDir;
const BIN: &str = env!("CARGO_BIN_EXE_moby");
const PASSWORD: &str = "test-only passphrase";
struct Worker(Child);
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn cli(root: &Path, paper: bool, args: &[&str]) -> Value {
    let mut cmd = Command::new(BIN);
    cmd.arg("--state-dir").arg(root).arg("--json");
    if paper {
        cmd.arg("--demo");
    }
    let output = cmd.args(args).output().unwrap();
    let parsed: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("non-JSON output: {output:?}"));
    assert_eq!(output.status.success(), parsed["ok"].as_bool().unwrap());
    parsed
}
fn start(root: &Path, paper: bool) -> Worker {
    start_named(root, paper, "main")
}
fn start_named(root: &Path, paper: bool, name: &str) -> Worker {
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut cmd = Command::new(BIN);
    cmd.arg("--state-dir")
        .arg(root)
        .arg("--account")
        .arg(name)
        .arg("run");
    if paper {
        cmd.arg("--demo");
    }
    let mut worker = Worker(
        cmd.stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    for _ in 0..100 {
        assert!(
            worker.0.try_wait().unwrap().is_none(),
            "worker exited during startup"
        );
        if cli(root, paper, &["--account", name, "status"])["ok"] == true {
            return worker;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("worker did not start")
}
fn request(dir: &Path, value: Value) -> Value {
    let mut stream = UnixStream::connect(dir.join("worker.sock")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    serde_json::to_writer(&mut stream, &value).unwrap();
    stream.write_all(b"\n").unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}
fn create(dir: &Path) {
    assert_eq!(
        request(dir, json!({"command":"vault_create", "password":PASSWORD}))["ok"],
        true
    );
}
fn set_key(dir: &Path) {
    assert_eq!(
        request(
            dir,
            json!({"command":"set_key",
        "api_key":"TEST-KEY-DO-NOT-EXPORT", "api_secret":"TEST-SECRET-DO-NOT-EXPORT"})
        )["ok"],
        true
    );
}
#[test]
fn telegram_setup_is_private_persistent_and_rejected_by_paper_mode() {
    let root = TempDir::new().unwrap();
    let account = root.path().join("account");
    let worker = start(root.path(), false);
    create(&account);
    let token = "123456:TEST-TELEGRAM-TOKEN-DO-NOT-EXPORT";
    assert_eq!(
        request(
            &account,
            json!({"command":"set_telegram","token":token,"chat_id":"-123456"})
        )["ok"],
        true
    );
    let state = cli(root.path(), false, &["telegram", "status"]);
    assert_eq!(state["data"]["enabled"], true);
    assert!(!state.to_string().contains(token));
    let encrypted = std::fs::read_to_string(account.join("vault.json")).unwrap();
    assert!(!encrypted.contains(token));
    assert_eq!(
        cli(root.path(), false, &["telegram", "disable"])["data"]["enabled"],
        false
    );
    assert_eq!(
        cli(root.path(), false, &["telegram", "enable"])["data"]["enabled"],
        true
    );
    drop(worker);
    let _worker = start(root.path(), false);
    assert_eq!(
        cli(root.path(), false, &["telegram", "status"])["data"]["waiting_for_unlock"],
        true
    );
    assert_eq!(cli(root.path(), false, &["telegram", "test"])["ok"], false);
    assert_eq!(
        request(
            &account,
            json!({"command":"vault_unlock","password":PASSWORD})
        )["ok"],
        true
    );
    // Kraken key replacement/removal must preserve the separately encrypted bot token.
    set_key(&account);
    assert_eq!(cli(root.path(), false, &["key", "remove"])["ok"], true);
    assert_eq!(cli(root.path(), false, &["telegram", "enable"])["ok"], true);
    let before = std::fs::read(account.join("vault.json")).unwrap();
    let _paper = start(root.path(), true);
    assert_eq!(
        request(
            &root.path().join("paper"),
            json!({"command":"set_telegram","token":token,"chat_id":"-123456"})
        )["ok"],
        false
    );
    assert_eq!(cli(root.path(), true, &["telegram", "test"])["ok"], false);
    assert_eq!(std::fs::read(account.join("vault.json")).unwrap(), before);
    assert!(!root.path().join("paper/vault.json").exists());
}

#[test]
fn account_vault_relocks_on_restart_and_never_exports_keys_or_runs_simulation() {
    let root = TempDir::new().unwrap();
    let account = root.path().join("account");
    let worker = start(root.path(), false);
    assert_eq!(
        cli(root.path(), false, &["status"])["state"]["vault"]["state"],
        "not_configured"
    );
    assert_eq!(cli(root.path(), false, &["key", "check"])["ok"], false);
    assert_eq!(cli(root.path(), false, &["balances", "sync"])["ok"], false);
    assert_eq!(
        cli(root.path(), false, &["balances"])["updated_at"],
        Value::Null
    );
    create(&account);
    set_key(&account);
    let state = cli(root.path(), false, &["status"]);
    assert_eq!(state["state"]["vault"]["credentials"][0], "account");
    assert_eq!(state["state"]["account_status"]["keys"][0]["saved"], true);
    assert!(!state.to_string().contains("DO-NOT-EXPORT"));
    assert!(
        !std::fs::read_to_string(account.join("vault.json"))
            .unwrap()
            .contains("DO-NOT-EXPORT")
    );
    assert_eq!(cli(root.path(), false, &["resume"])["ok"], false);
    assert_eq!(
        request(
            &account,
            json!({"command":"demo_fill","id":"bad","asset":"BTC","amount":"1"})
        )["ok"],
        false
    );
    assert_eq!(cli(root.path(), false, &["lock"])["ok"], true);
    assert_eq!(cli(root.path(), false, &["wallets", "sync"])["ok"], false);
    assert_eq!(cli(root.path(), false, &["pause"])["ok"], true);
    assert_eq!(
        request(
            &account,
            json!({"command":"vault_unlock","password":"incorrect"})
        )["ok"],
        false
    );
    drop(worker);
    let mut worker = start(root.path(), false);
    assert_eq!(
        cli(root.path(), false, &["status"])["state"]["vault"]["state"],
        "locked"
    );
    assert_eq!(
        request(
            &account,
            json!({"command":"vault_unlock","password":PASSWORD})
        )["ok"],
        true
    );
    assert_eq!(
        cli(root.path(), false, &["status"])["state"]["vault"]["credentials"][0],
        "account"
    );
    let stop = cli(root.path(), false, &["stop"]);
    assert_eq!(stop["ok"], true);
    assert_eq!(stop["state"]["vault"]["state"], "locked");
    for _ in 0..100 {
        if worker.0.try_wait().unwrap().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(worker.0.try_wait().unwrap().unwrap().success());
    assert!(!account.join("worker.sock").exists());
}

#[test]
fn paper_clients_share_state_and_restart_without_duplicate_fills() {
    let root = TempDir::new().unwrap();
    let paper = root.path().join("paper");
    let worker = start(root.path(), true);
    let fill = [
        "demo", "fill", "--id", "one", "--asset", "BTC", "--amount", "0.29",
    ];
    assert_eq!(cli(root.path(), false, &fill)["ok"], true); // demo subcommand routes to paper
    let status = cli(root.path(), true, &["status"]);
    assert_eq!(status["state"]["assets"][0]["queued"], "0.29");
    assert_eq!(status["state"]["mode"], "paper");
    assert_eq!(status["state"]["vault"]["state"], "not_required");
    assert!(!paper.join("vault.json").exists());
    let mut slow = UnixStream::connect(paper.join("worker.sock")).unwrap();
    slow.write_all(b"{").unwrap();
    assert_eq!(cli(root.path(), true, &["status"])["ok"], true);
    let second = Command::new(BIN)
        .arg("--state-dir")
        .arg(root.path())
        .args(["run", "--demo"])
        .output()
        .unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("another worker"));
    for file in [
        "worker.sock",
        "worker.lock",
        "state.sqlite3",
        "state.sqlite3-wal",
        "state.sqlite3-shm",
    ] {
        assert_eq!(
            std::fs::metadata(paper.join(file))
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0,
            "{file} is not private"
        );
    }
    drop(worker);
    assert_eq!(cli(root.path(), true, &["status"])["ok"], false);
    let _restarted = start(root.path(), true);
    let duplicate = cli(root.path(), true, &fill);
    assert_eq!(duplicate["state"]["fill_count"], 1);
    assert_eq!(duplicate["state"]["assets"][0]["queued"], "0.29");
    assert_eq!(duplicate["state"]["paused"], true);
}

// Background account reads legitimately update caches, nonces and activity.
// Isolation must preserve credentials and all money-moving state.
fn business_state(state: &Value) -> Value {
    json!({
        "account":state["account"], "mode":state["mode"], "vault":state["vault"],
        "paused":state["paused"], "fills":state["fills"], "withdrawals":state["withdrawals"],
        "fill_count":state["fill_count"], "completed_count":state["completed_count"],
        "config":state["account_status"]["live"]["config"],
        "queues":state["account_status"]["live"]["queues"],
        "order_receipts":state["account_status"]["live"]["order_receipts"],
    })
}

#[test]
fn demo_cannot_touch_configured_account_even_while_both_workers_are_running() {
    let root = TempDir::new().unwrap();
    let account = root.path().join("account");
    let _account = start(root.path(), false);
    create(&account);
    set_key(&account);
    let before = cli(root.path(), false, &["status"])["state"].clone();
    let bytes = std::fs::read(account.join("vault.json")).unwrap();
    let _paper = start(root.path(), true);
    let state = cli(root.path(), true, &["status"])["state"].clone();
    assert_ne!(state["worker_pid"], before["worker_pid"]);
    let paper = root.path().join("paper");
    for command in [
        json!({"command":"vault_create","password":PASSWORD}),
        json!({"command":"set_key","api_key":"bad","api_secret":"bad"}),
        json!({"command":"check_key"}),
        json!({"command":"refresh_wallets"}),
        json!({"command":"refresh_balances"}),
    ] {
        assert_eq!(request(&paper, command)["ok"], false);
    }
    assert_eq!(
        cli(
            root.path(),
            true,
            &[
                "demo", "fill", "--id", "test", "--asset", "BTC", "--amount", "0.3"
            ]
        )["ok"],
        true
    );
    assert_eq!(
        cli(
            root.path(),
            true,
            &["demo", "balance", "--asset", "BTC", "--amount", "0"]
        )["ok"],
        true
    );
    assert_eq!(cli(root.path(), true, &["resume"])["ok"], true);
    assert_eq!(cli(root.path(), true, &["pause"])["ok"], true);
    let digest = cli(root.path(), true, &["status"])["state"]["queue_digest"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        cli(root.path(), true, &["clear-queue", "--confirm", &digest])["ok"],
        true
    );
    assert_eq!(cli(root.path(), true, &["stop"])["ok"], true);
    assert!(!paper.join("vault.json").exists());
    assert!(
        std::fs::read(account.join("vault.json")).unwrap() == bytes,
        "paper changed the configured account vault"
    );
    let after = cli(root.path(), false, &["status"])["state"].clone();
    assert_eq!(business_state(&after), business_state(&before));
}

#[test]
fn socket_cannot_be_replaced_by_a_file_and_profile_must_be_private() {
    let root = TempDir::new().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let paper = root.path().join("paper");
    std::fs::create_dir(&paper).unwrap();
    std::fs::set_permissions(&paper, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(paper.join("worker.sock"), "keep me").unwrap();
    let run = || {
        Command::new(BIN)
            .arg("--state-dir")
            .arg(root.path())
            .args(["run", "--demo"])
            .output()
            .unwrap()
    };
    assert!(!run().status.success());
    assert_eq!(
        std::fs::read_to_string(paper.join("worker.sock")).unwrap(),
        "keep me"
    );
    std::fs::set_permissions(&paper, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(String::from_utf8_lossy(&run().stderr).contains("private"));
}

#[test]
fn named_accounts_keep_keys_lock_state_and_paper_activity_separate() {
    let root = TempDir::new().unwrap();
    let main = root.path().join("account");
    let second = root.path().join("accounts/second/account");
    let _main = start(root.path(), false);
    create(&main);
    set_key(&main);
    let main_before = std::fs::read(main.join("vault.json")).unwrap();
    let main_state = cli(root.path(), false, &["status"])["state"].clone();
    let _second = start_named(root.path(), false, "second");
    assert_eq!(
        cli(root.path(), false, &["--account", "second", "status"])["state"]["vault"]["state"],
        "not_configured"
    );
    assert!(
        !second.join("vault.json").exists(),
        "another account's vault was copied"
    );
    let password = "separate fixture password";
    assert_eq!(
        request(
            &second,
            json!({"command":"vault_create", "password":password})
        )["ok"],
        true
    );
    assert_eq!(
        request(
            &second,
            json!({"command":"set_key", "api_key":"SECOND-FIXTURE-KEY", "api_secret":"SECOND-FIXTURE-SECRET"})
        )["ok"],
        true
    );
    let status = cli(root.path(), false, &["--account", "second", "status"]);
    assert_eq!(status["state"]["account"], "second");
    assert_eq!(
        status["state"]["account_status"]["keys"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        status["state"]["account_status"]["keys"][0]["saved"]
            .as_bool()
            .unwrap()
    );
    assert!(!status.to_string().contains("SECOND-FIXTURE"));
    assert_eq!(
        cli(root.path(), false, &["--account", "second", "lock"])["ok"],
        true
    );
    assert_eq!(
        request(
            &second,
            json!({"command":"vault_unlock", "password":PASSWORD})
        )["ok"],
        false
    );
    assert_eq!(
        request(
            &second,
            json!({"command":"vault_unlock", "password":password})
        )["ok"],
        true
    );
    assert_eq!(
        cli(
            root.path(),
            false,
            &["--account", "second", "key", "remove"]
        )["ok"],
        true
    );
    assert_eq!(
        cli(root.path(), false, &["--account", "second", "status"])["state"]["account_status"]["keys"]
            [0]["saved"],
        false
    );
    assert!(
        std::fs::read(main.join("vault.json")).unwrap() == main_before,
        "named account changed main account vault"
    );
    assert_eq!(
        business_state(&cli(root.path(), false, &["status"])["state"]),
        business_state(&main_state)
    );
    assert_eq!(
        cli(root.path(), false, &["status"])["state"]["vault"]["state"],
        "unlocked"
    );
    let _main_paper = start(root.path(), true);
    let _second_paper = start_named(root.path(), true, "second");
    let fill = cli(
        root.path(),
        false,
        &[
            "--account",
            "second",
            "demo",
            "fill",
            "--id",
            "one",
            "--asset",
            "BTC",
            "--amount",
            "0.25",
        ],
    );
    assert_eq!(fill["state"]["account"], "second");
    assert_eq!(fill["state"]["fill_count"], 1);
    assert_eq!(
        cli(root.path(), true, &["status"])["state"]["fill_count"],
        0
    );
    assert_eq!(
        cli(root.path(), false, &["accounts"])["accounts"],
        json!(["main", "second"])
    );
    assert!(
        !root
            .path()
            .join("accounts/second/paper/vault.json")
            .exists()
    );
}

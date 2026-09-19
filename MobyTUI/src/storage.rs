use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use rust_decimal::Decimal;
use std::{
    fs,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

use crate::model::{Plan, decimal};

pub(crate) fn open_profile(directory: &Path, mode: &str) -> Result<Connection> {
    let path = directory.join("state.sqlite3");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    let metadata = file.metadata()?;
    // SAFETY: geteuid has no preconditions.
    ensure!(
        metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() },
        "invalid database file"
    );
    if metadata.len() > 0 {
        let db = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        ensure!(
            get(&db, "mode")?.as_deref() == Some(mode),
            "database mode mismatch; account and paper data cannot be shared"
        );
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure!(
            version <= if mode == "account" { 2 } else { 1 },
            "database was created by a newer Moby version"
        );
    }
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Connection::open(path).context("open Moby database")
}

pub fn open(directory: &Path) -> Result<Connection> {
    let db = open_profile(directory, "demo")?;
    db.busy_timeout(std::time::Duration::from_secs(2))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(version <= 1, "database was created by a newer Moby version");
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS amounts (
            asset TEXT PRIMARY KEY, queued TEXT NOT NULL, spendable TEXT NOT NULL,
            last_submission INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS fills (
            id TEXT PRIMARY KEY, asset TEXT NOT NULL, amount TEXT NOT NULL, at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS withdrawals (
            id TEXT PRIMARY KEY, asset TEXT NOT NULL, amount TEXT NOT NULL, fee TEXT NOT NULL,
            destination TEXT NOT NULL, status TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS withdrawals_active ON withdrawals(status, asset);
        CREATE INDEX IF NOT EXISTS withdrawals_time ON withdrawals(created_at);
        CREATE INDEX IF NOT EXISTS fills_time ON fills(at);
        CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL
        );
        PRAGMA user_version=1;
    ",
    )?;
    if get(&db, "mode")?.is_none() {
        let tx = db.unchecked_transaction()?;
        set(&tx, "mode", "demo")?;
        set(&tx, "paused", "true")?;
        set(&tx, "plan", &serde_json::to_string(&Plan::demo())?)?;
        set(&tx, "revision", "0")?;
        set(&tx, "next_outcome", "complete")?;
        for rule in Plan::demo().rules {
            tx.execute(
                "INSERT OR IGNORE INTO amounts(asset,queued,spendable) VALUES(?1,'0','0')",
                [&rule.asset],
            )?;
        }
        tx.commit()?;
    }
    ensure!(
        get(&db, "mode")?.as_deref() == Some("demo"),
        "this executable only opens demo profiles"
    );
    let mut saved_plan: serde_json::Value =
        serde_json::from_str(&get(&db, "plan")?.context("missing plan")?)?;
    if crate::model::migrate_cooldown_config(&mut saved_plan)? {
        let plan: Plan = serde_json::from_value(saved_plan)?;
        plan.validate()?;
        set(&db, "plan", &serde_json::to_string(&plan)?)?;
    }
    Ok(db)
}

pub fn get(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set(db: &Connection, key: &str, value: &str) -> Result<()> {
    db.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])?;
    Ok(())
}

pub fn plan(db: &Connection) -> Result<Plan> {
    let plan: Plan = serde_json::from_str(&get(db, "plan")?.context("missing plan")?)?;
    plan.validate()?;
    Ok(plan)
}

pub fn paused(db: &Connection) -> Result<bool> {
    Ok(get(db, "paused")?.as_deref() != Some("false"))
}

pub fn funds(db: &Connection, asset: &str) -> Result<(Decimal, Decimal, i64)> {
    let (q, b, last): (String, String, i64) = db.query_row(
        "SELECT queued,spendable,last_submission FROM amounts WHERE asset=?1",
        [asset],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    Ok((decimal(&q)?, decimal(&b)?, last))
}

pub fn set_funds(db: &Connection, asset: &str, queue: Decimal, balance: Decimal) -> Result<()> {
    ensure!(
        queue >= Decimal::ZERO && balance >= Decimal::ZERO,
        "negative queue or balance"
    );
    db.execute(
        "UPDATE amounts SET queued=?2,spendable=?3 WHERE asset=?1",
        params![
            asset,
            queue.normalize().to_string(),
            balance.normalize().to_string()
        ],
    )?;
    Ok(())
}

pub fn active(db: &Connection, asset: Option<&str>) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM withdrawals WHERE status IN ('submitted','pending','held','unknown') AND (?1 IS NULL OR asset=?1))", [asset], |r| r.get(0))?)
}

pub fn event(db: &Connection, at: i64, message: &str) -> Result<()> {
    db.execute(
        "INSERT INTO activity(at,message) VALUES(?1,?2)",
        params![at, message],
    )?;
    // Event display is bounded; immutable fills and withdrawal receipts remain in SQLite.
    db.execute(
        "DELETE FROM activity WHERE id <= (SELECT MAX(id)-1000 FROM activity)",
        [],
    )?;
    Ok(())
}

pub fn bump_revision(db: &Connection) -> Result<()> {
    let old: u64 = get(db, "revision")?.context("missing revision")?.parse()?;
    set(
        db,
        "revision",
        &old.checked_add(1).context("revision overflow")?.to_string(),
    )
}

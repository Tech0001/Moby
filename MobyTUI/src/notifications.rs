//! Optional outbound Telegram alerts. The durable outbox never controls withdrawals.
use crate::{
    live::model::{Status as LiveStatus, Transfer},
    model::{amount, now},
    storage,
    vault::{TelegramCredential, Vault},
};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Status {
    pub configured: bool,
    pub enabled: bool,
    pub waiting_for_unlock: bool,
    pub pending: u64,
    pub last_sent_at: Option<i64>,
    pub last_error: Option<String>,
}
struct Flight {
    cancelled: Arc<AtomicBool>,
    result: mpsc::Receiver<std::result::Result<(), DeliveryError>>,
    ids: Vec<String>,
}
#[derive(Debug)]
struct DeliveryError {
    message: &'static str,
    retry: i64,
}
pub(crate) struct Notifications {
    capture_at: i64,
    flight: Option<Flight>,
}
impl Drop for Notifications {
    fn drop(&mut self) {
        self.cancel();
    }
}
fn enqueue(db: &Connection, id: &str, kind: &str, text: &str, ready: i64) -> Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO notification_outbox(id,kind,message,ready_at) VALUES(?1,?2,?3,?4)",
        params![id, kind, text, ready],
    )?;
    Ok(())
}
impl Notifications {
    pub fn open(db: &Connection) -> Result<Self> {
        db.execute_batch("CREATE TABLE IF NOT EXISTS notification_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,message TEXT NOT NULL,ready_at INTEGER NOT NULL,sent_at INTEGER);
          CREATE TABLE IF NOT EXISTS notification_seen(id TEXT PRIMARY KEY,status TEXT NOT NULL,reference TEXT);
          CREATE TABLE IF NOT EXISTS notification_health(id TEXT PRIMARY KEY,since_at INTEGER NOT NULL,alerted INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS notification_burst(id TEXT PRIMARY KEY,at INTEGER NOT NULL);")?;
        Ok(Self {
            capture_at: 0,
            flight: None,
        })
    }
    pub fn cancel(&mut self) {
        if let Some(flight) = self.flight.take() {
            flight.cancelled.store(true, Ordering::SeqCst);
        }
    }
    pub fn configure(&mut self, db: &Connection, enabled: bool, configured: bool) -> Result<()> {
        self.cancel();
        let tx = db.unchecked_transaction()?;
        tx.execute_batch("DELETE FROM notification_outbox; DELETE FROM notification_seen; DELETE FROM notification_health; DELETE FROM notification_burst;
          INSERT INTO notification_seen SELECT id,json_extract(payload,'$.status'),json_extract(payload,'$.exchange_id') FROM live_records WHERE kind='transfer';")?;
        storage::set(
            &tx,
            "telegram.enabled",
            if enabled { "true" } else { "false" },
        )?;
        storage::set(
            &tx,
            "telegram.configured",
            if configured { "true" } else { "false" },
        )?;
        storage::set(&tx, "telegram.error", "")?;
        storage::set(&tx, "telegram.next", "0")?;
        storage::set(&tx, "telegram.failures", "0")?;
        tx.execute("DELETE FROM meta WHERE key='telegram.sent'", [])?;
        tx.commit()?;
        self.capture_at = 0;
        Ok(())
    }
    pub fn status(db: &Connection, unlocked: bool) -> Result<Status> {
        let enabled = storage::get(db, "telegram.enabled")?.as_deref() == Some("true");
        Ok(Status {
            configured: storage::get(db, "telegram.configured")?.as_deref() == Some("true"),
            enabled,
            waiting_for_unlock: enabled && !unlocked,
            pending: db.query_row(
                "SELECT count(*) FROM notification_outbox WHERE sent_at IS NULL",
                [],
                |r| r.get(0),
            )?,
            last_sent_at: storage::get(db, "telegram.sent")?.and_then(|s| s.parse().ok()),
            last_error: storage::get(db, "telegram.error")?.filter(|s| !s.is_empty()),
        })
    }
    pub fn test(db: &Connection, vault: &Vault, name: &str) -> Result<()> {
        ensure!(
            vault.telegram().is_some(),
            "unlock and set up Telegram first"
        );
        ensure!(
            Self::status(db, true)?.enabled,
            "enable Telegram before sending a test"
        );
        // Coalesce repeated clicks while delivery is pending.
        let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM notification_outbox WHERE kind='test' AND sent_at IS NULL)", [], |r| r.get(0))?;
        if !pending {
            enqueue(
                db,
                &uuid::Uuid::new_v4().to_string(),
                "test",
                &format!(
                    "Moby · {name}: Telegram alerts are connected. No withdrawal was made by this test."
                ),
                now(),
            )?;
        }
        Ok(())
    }
    fn capture(
        &mut self,
        db: &Connection,
        live: &LiveStatus,
        paused: bool,
        name: &str,
        at: i64,
    ) -> Result<()> {
        let tx = db.unchecked_transaction()?;
        let changed = tx.prepare("SELECT r.payload,s.reference,s.status FROM live_records r LEFT JOIN notification_seen s ON s.id=r.id
            WHERE r.kind='transfer' AND (s.id IS NULL OR s.status != json_extract(r.payload,'$.status') OR s.reference IS NOT json_extract(r.payload,'$.exchange_id')) ORDER BY r.at,r.id LIMIT 1000")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?,r.get::<_, Option<String>>(1)?,r.get::<_, Option<String>>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for (payload, old_reference, old_status) in changed {
            let t: Transfer = serde_json::from_str(&payload)?;
            if t.exchange_id.is_some()
                && ["pending", "held", "complete"].contains(&t.status.as_str())
                && (old_reference.is_none() || old_status.as_deref() == Some("unknown"))
            {
                let key = format!("started:{}", t.asset);
                let previous: Option<i64> = tx
                    .query_row(
                        "SELECT at FROM notification_burst WHERE id=?1",
                        [&key],
                        |r| r.get(0),
                    )
                    .optional()?;
                if previous.is_none_or(|previous| at - previous >= 300) {
                    enqueue(
                        &tx,
                        &format!("{}:started", t.id),
                        "started",
                        &format!(
                            "Moby · {name}: {} withdrawals started. Kraken accepted a chunk of {} {} (including fee).",
                            t.asset, t.gross, t.asset
                        ),
                        at,
                    )?;
                    tx.execute(
                        "INSERT OR REPLACE INTO notification_burst VALUES(?1,?2)",
                        params![key, at],
                    )?;
                }
            }
            if t.status == "complete" {
                enqueue(
                    &tx,
                    &format!("{}:complete", t.id),
                    "complete",
                    &format!(
                        "{} {} delivered · fee {} {}",
                        t.net, t.asset, t.fee, t.asset
                    ),
                    at + 60,
                )?;
            } else if ["held", "unknown", "failed", "rejected"].contains(&t.status.as_str()) {
                enqueue(
                    &tx,
                    &format!("{}:{}", t.id, t.status),
                    "attention",
                    &format!(
                        "Moby · {name}: withdrawal {}.\n{} {} · request {}\nCheck Moby and Kraken before retrying. No uncertain withdrawal is automatically resent.",
                        t.status, t.gross, t.asset, t.id
                    ),
                    at,
                )?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO notification_seen VALUES(?1,?2,?3)",
                params![t.id, t.status, t.exchange_id],
            )?;
        }
        let mut conditions = std::collections::BTreeMap::new();
        if let Some(config) = &live.config {
            let rest_down = live.rest_error.is_some()
                || live
                    .rest_updated_at
                    .is_none_or(|last| at - last > (config.poll_seconds as i64 * 2).max(60));
            let ws_down = config.websocket && live.websocket != "Connected";
            if rest_down || ws_down {
                conditions.insert("connection".to_owned(), (300i64, format!("Moby · {name}: Kraken monitoring needs attention. {} {} Moby is retrying.", if rest_down { "Trade/balance catch-up is unavailable." } else { "REST catch-up is working." }, if ws_down { "WebSocket is disconnected." } else { "" })));
            }
            if !paused {
                for rule in &config.rules {
                    if rule.enabled
                        && let Some(q) = live.queues.get(&rule.asset)
                        && amount(&q.amount)? >= amount(&rule.minimum)?
                        && amount(&q.amount)? > rust_decimal::Decimal::ZERO
                        && !live
                            .transfers
                            .iter()
                            .any(|t| t.asset == rule.asset && t.active())
                    {
                        conditions.insert(format!("queue:{}",rule.asset), ((rule.cooldown_seconds as i64 + 300).max(1800),format!("Moby · {name}: {} has been waiting without an active withdrawal. Check its watch rule and waiting reason in Moby.",rule.asset)));
                    }
                }
            }
        }
        for (id, (delay, message)) in &conditions {
            tx.execute(
                "INSERT OR IGNORE INTO notification_health(id,since_at) VALUES(?1,?2)",
                params![id, at],
            )?;
            let (since, alerted): (i64, bool) = tx.query_row(
                "SELECT since_at,alerted FROM notification_health WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if !alerted && at - since >= *delay {
                enqueue(
                    &tx,
                    &format!("health:{id}:{since}"),
                    "attention",
                    message,
                    at,
                )?;
                tx.execute("UPDATE notification_health SET alerted=1 WHERE id=?1", [id])?;
            }
        }
        let health = tx
            .prepare("SELECT id,since_at,alerted FROM notification_health")?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, since, alerted) in health {
            if !conditions.contains_key(&id) {
                if id == "connection" && alerted && live.config.is_some() {
                    enqueue(
                        &tx,
                        &format!("recovered:{since}"),
                        "attention",
                        &format!("Moby · {name}: Kraken monitoring recovered."),
                        at,
                    )?;
                }
                tx.execute("DELETE FROM notification_health WHERE id=?1", [id])?;
            }
        }
        let stalled = tx.prepare("SELECT payload FROM live_records WHERE kind='transfer' AND json_extract(payload,'$.status') IN ('pending','submitting') AND at<=?1")?
            .query_map([at-1800], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for payload in stalled {
            let t: Transfer = serde_json::from_str(&payload)?;
            enqueue(
                &tx,
                &format!("{}:stalled", t.id),
                "attention",
                &format!(
                    "Moby · {name}: withdrawal taking over 30 minutes. {} {} · request {}. Still awaiting confirmation; no automatic retry.",
                    t.gross, t.asset, t.id
                ),
                at,
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn tick(
        &mut self,
        db: &Connection,
        vault: &Vault,
        live: &LiveStatus,
        paused: bool,
        name: &str,
        at: i64,
    ) -> Result<()> {
        if let Some(flight) = &self.flight {
            match flight.result.try_recv() {
                Ok(result) => {
                    let flight = self.flight.take().unwrap();
                    match result {
                        Ok(()) => {
                            let tx = db.unchecked_transaction()?;
                            for id in flight.ids {
                                tx.execute(
                                    "UPDATE notification_outbox SET sent_at=?1 WHERE id=?2",
                                    params![at, id],
                                )?;
                            }
                            storage::set(&tx, "telegram.sent", &at.to_string())?;
                            storage::set(&tx, "telegram.error", "")?;
                            storage::set(&tx, "telegram.failures", "0")?;
                            storage::set(&tx, "telegram.next", &(at + 2).to_string())?;
                            tx.commit()?;
                        }
                        Err(error) => {
                            let failures = storage::get(db, "telegram.failures")?
                                .and_then(|s| s.parse::<u32>().ok())
                                .unwrap_or(0)
                                .saturating_add(1);
                            storage::set(db, "telegram.failures", &failures.to_string())?;
                            storage::set(db, "telegram.error", error.message)?;
                            let delay = error.retry.max((15 * (1i64 << failures.min(6))).min(900));
                            storage::set(db, "telegram.next", &(at + delay).to_string())?;
                        }
                    }
                }
                Err(mpsc::TryRecvError::Empty) => (),
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.flight = None;
                    storage::set(
                        db,
                        "telegram.error",
                        "Telegram delivery interrupted; retrying",
                    )?;
                    storage::set(db, "telegram.next", &(at + 60).to_string())?;
                }
            }
        }
        if !vault.is_unlocked() {
            self.cancel();
            return Ok(());
        }
        if !Self::status(db, true)?.enabled {
            return Ok(());
        }
        if at >= self.capture_at {
            self.capture(db, live, paused, name, at)?;
            self.capture_at = at + 2;
        }
        if self.flight.is_some()
            || at
                < storage::get(db, "telegram.next")?
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0)
        {
            return Ok(());
        }
        let Some(credential) = vault.telegram() else {
            return Ok(());
        };
        let messages = db.prepare("SELECT id,kind,message FROM notification_outbox WHERE sent_at IS NULL AND ready_at<=?1 ORDER BY CASE kind WHEN 'attention' THEN 0 WHEN 'test' THEN 1 ELSE 2 END,ready_at,id LIMIT 20")?
            .query_map([at],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let Some(first) = messages.first() else {
            return Ok(());
        };
        let completed = first.1 == "complete";
        let mut text = if completed {
            format!("Moby · {name}: withdrawals completed\n")
        } else {
            String::new()
        };
        let mut ids = Vec::new();
        for (id, kind, message) in messages {
            if (!completed && !ids.is_empty())
                || (completed && kind != "complete")
                || text.len() + message.len() > 3500
            {
                break;
            }
            text.push_str(&message);
            text.push('\n');
            ids.push(id);
        }
        ensure!(!ids.is_empty(), "notification exceeds message limit");
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = cancelled.clone();
        let (sender, result) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(deliver(
                "https://api.telegram.org",
                credential,
                &text,
                &cancel,
            ));
        });
        self.flight = Some(Flight {
            cancelled,
            result,
            ids,
        });
        Ok(())
    }
}

fn deliver(
    origin: &str,
    credential: TelegramCredential,
    text: &str,
    cancelled: &AtomicBool,
) -> std::result::Result<(), DeliveryError> {
    let error = || DeliveryError {
        message: "Telegram could not confirm delivery; retrying",
        retry: 30,
    };
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| error())?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(error());
    }
    // The token is part of Telegram's URL. Never display/log reqwest errors or URLs.
    let response = client
        .post(format!("{origin}/bot{}/sendMessage", credential.token.0))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({"chat_id":credential.chat_id,"text":text}).to_string())
        .send()
        .map_err(|_| error())?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    response
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| error())?;
    if bytes.len() > 65536 {
        return Err(error());
    }
    let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| error())?;
    if status == 200 && body["ok"].as_bool() == Some(true) {
        return Ok(());
    }
    Err(DeliveryError {
        message: match status {
            401 => "Telegram rejected the bot token; set up alerts again",
            400 | 403 => "Telegram could not reach this chat; start the bot and check the chat ID",
            429 => "Telegram rate limited delivery; waiting before retrying",
            _ => "Telegram delivery failed; retrying",
        },
        retry: body["parameters"]["retry_after"]
            .as_i64()
            .unwrap_or(30)
            .clamp(1, 86400),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{live::tests as fixture, vault::Secret};
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE live_records(kind TEXT,id TEXT,at INTEGER,payload TEXT);").unwrap();
        db
    }
    fn transfer(id: &str, status: &str) -> Transfer {
        Transfer {
            id: id.into(),
            asset: "BTC".into(),
            gross: "10".into(),
            net: "9".into(),
            fee: "1".into(),
            destination: fixture::destination(),
            status: status.into(),
            exchange_id: None,
            txid: None,
            error: None,
            created_at: 100,
            updated_at: 100,
        }
    }
    fn save(db: &Connection, t: &Transfer) {
        db.execute("DELETE FROM live_records WHERE id=?1", [&t.id])
            .unwrap();
        db.execute(
            "INSERT INTO live_records VALUES('transfer',?1,?2,?3)",
            params![t.id, t.created_at, serde_json::to_string(t).unwrap()],
        )
        .unwrap();
    }
    fn count(db: &Connection, kind: &str) -> u64 {
        db.query_row(
            "SELECT count(*) FROM notification_outbox WHERE kind=?1",
            [kind],
            |r| r.get(0),
        )
        .unwrap()
    }
    #[test]
    fn capture_deduplicates_persists_and_batches_without_announcing_unverified_receipts() {
        let db = db();
        let mut n = Notifications::open(&db).unwrap();
        n.configure(&db, true, true).unwrap();
        let mut t = transfer("one", "unknown");
        save(&db, &t);
        n.capture(&db, &LiveStatus::default(), true, "fixture", 200)
            .unwrap();
        t.exchange_id = Some("attached-but-not-verified".into());
        save(&db, &t);
        n.capture(&db, &LiveStatus::default(), true, "fixture", 201)
            .unwrap();
        assert_eq!(count(&db, "started"), 0);
        assert_eq!(count(&db, "attention"), 1);
        t.status = "pending".into();
        save(&db, &t);
        n.capture(&db, &LiveStatus::default(), true, "fixture", 202)
            .unwrap();
        assert_eq!(count(&db, "started"), 1);
        let mut second = transfer("two", "pending");
        second.exchange_id = Some("second-ref".into());
        save(&db, &second);
        n.capture(&db, &LiveStatus::default(), true, "fixture", 203)
            .unwrap();
        assert_eq!(
            count(&db, "started"),
            1,
            "routine start alerts are grouped into five-minute bursts"
        );
        t.status = "complete".into();
        second.status = "complete".into();
        save(&db, &t);
        save(&db, &second);
        n.capture(&db, &LiveStatus::default(), true, "fixture", 204)
            .unwrap();
        assert_eq!(count(&db, "complete"), 2);
        let ready: i64 = db
            .query_row(
                "SELECT min(ready_at) FROM notification_outbox WHERE kind='complete'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            ready, 264,
            "completion messages wait one minute for batching"
        );
        drop(n);
        let mut n = Notifications::open(&db).unwrap();
        n.capture(&db, &LiveStatus::default(), true, "fixture", 205)
            .unwrap();
        assert_eq!(
            count(&db, "complete"),
            2,
            "restart cannot duplicate a captured event"
        );
        assert!(
            Notifications::status(&db, false)
                .unwrap()
                .waiting_for_unlock
        );
        n.configure(&db, true, true).unwrap();
        n.capture(
            &db,
            &LiveStatus::default(),
            true,
            "different-recipient",
            206,
        )
        .unwrap();
        assert_eq!(
            Notifications::status(&db, true).unwrap().pending,
            0,
            "recipient changes discard old messages and baseline history"
        );
    }
    #[test]
    fn health_alerts_wait_then_report_recovery_once_and_ignore_intentional_pause() {
        let db = db();
        let mut n = Notifications::open(&db).unwrap();
        let mut live = LiveStatus {
            config: Some(fixture::config()),
            ..Default::default()
        };
        n.capture(&db, &live, true, "fixture", 100).unwrap();
        n.capture(&db, &live, true, "fixture", 399).unwrap();
        assert_eq!(count(&db, "attention"), 0);
        n.capture(&db, &live, true, "fixture", 400).unwrap();
        assert_eq!(count(&db, "attention"), 1);
        n.capture(&db, &live, true, "fixture", 401).unwrap();
        assert_eq!(count(&db, "attention"), 1);
        live.rest_updated_at = Some(402);
        live.websocket = "Connected".into();
        live.queues.insert(
            "BTC".into(),
            crate::live::model::Queue {
                amount: "10".into(),
                ..Default::default()
            },
        );
        n.capture(&db, &live, true, "fixture", 402).unwrap();
        assert_eq!(count(&db, "attention"), 2);
        n.capture(&db, &live, true, "fixture", 403).unwrap();
        assert_eq!(count(&db, "attention"), 2);
        let queue_health: i64 = db
            .query_row(
                "SELECT count(*) FROM notification_health WHERE id LIKE 'queue:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queue_health, 0);
    }
    #[test]
    fn delivery_retry_is_durable_and_does_not_expose_token_or_remote_error() {
        use std::io::{BufRead, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(socket.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(n) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = n.trim().parse::<usize>().unwrap();
                }
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            let body = r#"{"ok":false,"description":"secret-token-must-not-leak","parameters":{"retry_after":123}}"#;
            write!(socket,"HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let result = deliver(
            &origin,
            TelegramCredential {
                token: Secret("123:fixture-secret-token-not-real".into()),
                chat_id: "123".into(),
            },
            "fixture",
            &AtomicBool::new(false),
        );
        server.join().unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.retry, 123);
        assert!(!error.message.contains("secret"));
        let db = db();
        let mut n = Notifications::open(&db).unwrap();
        enqueue(&db, "test-id", "test", "fixture", 100).unwrap();
        let (sender, result) = mpsc::channel();
        sender.send(Err(error)).unwrap();
        n.flight = Some(Flight {
            cancelled: Arc::new(AtomicBool::new(false)),
            result,
            ids: vec!["test-id".into()],
        });
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        n.tick(&db, &vault, &LiveStatus::default(), true, "fixture", 100)
            .unwrap();
        assert_eq!(Notifications::status(&db, false).unwrap().pending, 1);
        assert_eq!(
            storage::get(&db, "telegram.next").unwrap().as_deref(),
            Some("223")
        );
        let (sender, result) = mpsc::channel();
        sender.send(Ok(())).unwrap();
        n.flight = Some(Flight {
            cancelled: Arc::new(AtomicBool::new(false)),
            result,
            ids: vec!["test-id".into()],
        });
        n.tick(&db, &vault, &LiveStatus::default(), true, "fixture", 224)
            .unwrap();
        assert_eq!(Notifications::status(&db, false).unwrap().pending, 0);
        assert_eq!(
            Notifications::status(&db, false).unwrap().last_sent_at,
            Some(224)
        );
    }
}

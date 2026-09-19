//! Durable account automation. Exchange IO never happens while a transaction is open.
use super::{
    model::*,
    transport::{Operation, Quote, Reply, Submission, WithdrawalStatus},
};
use crate::{
    model::{AccountBalance, Wallet, WithdrawalCooldown, add, amount, decimal, now, subtract},
    storage,
};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::BTreeMap;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    fingerprint: Option<String>,
    config: Option<Config>,
    since: Option<i64>,
    cursor: Option<i64>,
    cleared_at: i64,
    watch_from: i64,
    paused: bool,
    queues: BTreeMap<String, Queue>,
    revision: u64,
    orders: Vec<Order>,
    orders_at: Option<i64>,
    last_asset: Option<String>,
    cooldown: Option<WithdrawalCooldown>,
}
pub(crate) struct Live {
    saved: Saved,
    pub rest_due: i64,
    pub status_due: i64,
    pub token_due: i64,
    pub ws_state: String,
    pub ws_at: Option<i64>,
    pub rest_at: Option<i64>,
    pub rest_error: Option<String>,
    pub ws_failures: u32,
    failures: u32,
    pub want_orders: bool,
    orders_error: Option<String>,
    poll_failures: u32,
}
fn load<T: DeserializeOwned>(db: &Connection, kind: &str, id: &str) -> Result<Option<T>> {
    let value: Option<String> = db
        .query_row(
            "SELECT payload FROM live_records WHERE kind=?1 AND id=?2",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?;
    value
        .map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
}
fn records<T: DeserializeOwned>(db: &Connection, kind: &str, limit: usize) -> Result<Vec<T>> {
    let mut stmt = db.prepare(
        "SELECT payload FROM live_records WHERE kind=?1 ORDER BY at DESC,id DESC LIMIT ?2",
    )?;
    stmt.query_map(params![kind, limit as i64], |r| r.get::<_, String>(0))?
        .map(|v| Ok(serde_json::from_str(&v?)?))
        .collect()
}
fn put(db: &Connection, kind: &str, id: &str, at: i64, record: &impl Serialize) -> Result<()> {
    db.execute("INSERT INTO live_records(kind,id,at,payload) VALUES(?1,?2,?3,?4) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,at=excluded.at",params![kind,id,at,serde_json::to_string(record)?])?;
    Ok(())
}
fn poll_delay(active: &[Transfer], at: i64) -> i64 {
    match active
        .iter()
        .map(|t| t.created_at)
        .max()
        .map(|created| at.saturating_sub(created))
    {
        Some(age) if age < 60 => 10,
        Some(age) if age < 360 => 30,
        _ => 120,
    }
}
impl Live {
    pub fn open(db: &Connection) -> Result<Self> {
        db.execute_batch("CREATE TABLE IF NOT EXISTS live_records(kind TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS live_record_time ON live_records(kind,at); CREATE INDEX IF NOT EXISTS live_record_state ON live_records(kind,json_extract(payload,'$.status'));")?;
        let mut saved: Saved = storage::get(db, "live")?
            .map(|v| -> Result<Saved> {
                let mut value: serde_json::Value = serde_json::from_str(&v)?;
                if let Some(config) = value.get_mut("config").filter(|config| !config.is_null()) {
                    crate::model::migrate_cooldown_config(config)?;
                }
                Ok(serde_json::from_value(value)?)
            })
            .transpose()?
            .unwrap_or_default();
        if let Some(config) = &saved.config {
            config.validate()?;
        }
        saved.paused = true; // Restart/unlock never silently arms money movement.
        // Upgrade per-asset timers without shortening any outstanding wait.
        if saved.cooldown.is_none() {
            saved.cooldown = saved.config.as_ref().and_then(|config| {
                config
                    .rules
                    .iter()
                    .filter_map(|rule| {
                        let at = saved.queues.get(&rule.asset)?.last_submission;
                        (at > 0).then(|| {
                            WithdrawalCooldown::new(&rule.asset, at, config.cooldown_seconds)
                        })
                    })
                    .max_by_key(|timer| timer.until)
            });
        }
        saved.revision += 1;
        let tx = db.unchecked_transaction()?;
        for mut transfer in records::<Transfer>(&tx, "transfer", usize::MAX / 2)? {
            if transfer.status == "submitting" {
                transfer.status = "unknown".into();
                transfer.error = Some("Worker stopped during submission; reconcile the exchange receipt before any retry".into());
                put(
                    &tx,
                    "transfer",
                    &transfer.id,
                    transfer.created_at,
                    &transfer,
                )?;
            }
        }
        for mut receipt in records::<OrderReceipt>(&tx, "order", usize::MAX / 2)? {
            if receipt.status == "submitting" {
                receipt.status = "unknown".into();
                receipt.message =
                    "Worker stopped during submission; request will not be resent".into();
                put(
                    &tx,
                    "order",
                    &receipt.request.request_id,
                    receipt.at,
                    &receipt,
                )?;
            }
        }
        storage::set(&tx, "live", &serde_json::to_string(&saved)?)?;
        tx.commit()?;
        Ok(Self {
            saved,
            rest_due: 0,
            status_due: 0,
            token_due: 0,
            ws_state: "Disconnected".into(),
            ws_at: None,
            rest_at: None,
            rest_error: None,
            ws_failures: 0,
            failures: 0,
            want_orders: false,
            poll_failures: 0,
            orders_error: None,
        })
    }
    fn save(&mut self, db: &Connection, mut next: Saved) -> Result<()> {
        next.revision = next.revision.checked_add(1).context("revision overflow")?;
        storage::set(db, "live", &serde_json::to_string(&next)?)?;
        self.saved = next;
        Ok(())
    }
    pub fn paused(&self) -> bool {
        self.saved.paused
    }
    pub fn cooldown(&self) -> Option<&WithdrawalCooldown> {
        self.saved.cooldown.as_ref()
    }
    pub fn configured(&self) -> bool {
        self.saved.config.is_some()
    }
    pub fn orders_freshness(&self) -> (Option<i64>, Option<&str>) {
        (self.saved.orders_at, self.orders_error.as_deref())
    }
    pub fn matches_key(&self, fingerprint: &str) -> bool {
        self.saved.fingerprint.as_deref() == Some(fingerprint)
    }
    pub fn monitoring(&self, fingerprint: &str) -> bool {
        self.configured() && self.matches_key(fingerprint)
    }
    pub fn websocket_enabled(&self) -> bool {
        self.saved.config.as_ref().is_some_and(|c| c.websocket)
    }
    pub fn busy_transfers(&self, db: &Connection) -> Result<Vec<Transfer>> {
        let mut statement=db.prepare("SELECT payload FROM live_records WHERE kind='transfer' AND json_extract(payload,'$.status') IN ('submitting','pending','held','unknown')")?;
        statement
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|s| Ok(serde_json::from_str(&s?)?))
            .collect()
    }
    pub fn bind(&mut self, db: &Connection, fingerprint: &str) -> Result<()> {
        if let Some(old) = &self.saved.fingerprint {
            ensure!(
                old == fingerprint,
                "account key changed; reset its previous configuration first"
            );
        } else {
            let mut saved = self.saved.clone();
            saved.fingerprint = Some(fingerprint.into());
            self.save(db, saved)?;
        }
        Ok(())
    }
    pub fn pause(&mut self, db: &Connection) -> Result<()> {
        let mut saved = self.saved.clone();
        saved.paused = true;
        self.save(db, saved)?;
        storage::event(
            db,
            now(),
            "Withdrawals paused; fill monitoring continues. Already dispatched requests may still complete.",
        )
    }
    pub fn resume(&mut self, db: &Connection, fingerprint: &str) -> Result<()> {
        ensure!(
            self.monitoring(fingerprint),
            "configure watch rules for this key first"
        );
        let mut saved = self.saved.clone();
        saved.paused = false;
        self.rest_at = None;
        self.rest_due = 0;
        self.save(db, saved)?;
        storage::event(
            db,
            now(),
            "Withdrawals enabled; reconciling trade history and balances before scheduling",
        )
    }
    pub fn replace_key(&mut self, db: &Connection) -> Result<()> {
        ensure!(
            self.saved.paused && self.busy_transfers(db)?.is_empty(),
            "pause and reconcile active withdrawals before replacing the account key"
        );
        ensure!(
            self.saved
                .queues
                .values()
                .all(|q| amount(&q.amount).is_ok_and(|a| a.is_zero())),
            "clear the reviewed queue before replacing the account key"
        );
        ensure!(
            !records::<OrderReceipt>(db, "order", usize::MAX / 2)?
                .iter()
                .any(|r| matches!(r.status.as_str(), "submitting" | "unknown")),
            "reconcile uncertain order requests before replacing the key"
        );
        Ok(())
    }
    pub fn reset(&mut self, db: &Connection) -> Result<()> {
        // Old receipts stay in the database for audit but are removed from this profile's active namespace.
        let tx = db.unchecked_transaction()?;
        tx.execute(
            "UPDATE live_records SET kind=?1 || kind WHERE kind NOT LIKE 'archived:%'",
            [format!("archived:{}:", uuid::Uuid::new_v4())],
        )?;
        let next = Saved {
            paused: true,
            revision: self.saved.revision,
            ..Default::default()
        };
        storage::set(&tx, "live", &serde_json::to_string(&next)?)?;
        tx.commit()?;
        self.saved = next;
        self.rest_at = None;
        self.rest_error = None;
        Ok(())
    }
    // The identity, wallet snapshot and review digest are independent trust checks.
    #[allow(clippy::too_many_arguments)]
    pub fn configure(
        &mut self,
        db: &Connection,
        config: Config,
        expected: &str,
        name: &str,
        fingerprint: &str,
        wallets: &[Wallet],
        at: i64,
    ) -> Result<()> {
        config.validate()?;
        ensure!(
            config.account == name,
            "configuration belongs to a different named account"
        );
        ensure!(
            config.digest()? == expected,
            "configuration digest changed; validate again"
        );
        ensure!(
            self.saved.paused,
            "pause withdrawals before editing watch rules"
        );
        ensure!(
            self.busy_transfers(db)?.is_empty(),
            "reconcile active withdrawals before changing rules"
        );
        if self.configured() {
            ensure!(
                self.matches_key(fingerprint),
                "watch rules belong to a different key"
            );
        }
        for rule in &config.rules {
            let minimum = minimum_for_destinations(&rule.asset, &rule.destinations, wallets)?;
            ensure!(
                amount(&rule.chunk)? >= minimum,
                "{} chunk {} is below Kraken's minimum {}; increase the chunk and allow room for fees",
                rule.asset,
                rule.chunk,
                minimum
            );
            ensure!(
                amount(&rule.minimum)? >= minimum,
                "{} minimum {} is below Kraken's minimum {} for the selected destinations",
                rule.asset,
                rule.minimum,
                minimum
            );
        }
        for (symbol, q) in &self.saved.queues {
            ensure!(
                amount(&q.amount)?.is_zero() || config.rules.iter().any(|r| &r.asset == symbol),
                "clear queued {symbol} before removing its rule"
            );
        }
        let mut saved = self.saved.clone();
        saved.fingerprint = Some(fingerprint.into());
        if saved.since.is_none() {
            saved.since = Some(at);
            saved.cursor = Some(at);
        }
        // Each configuration is a new watch boundary. Existing queues remain explicit.
        saved.watch_from = at;
        for rule in &config.rules {
            saved
                .queues
                .entry(rule.asset.clone())
                .or_insert_with(|| Queue {
                    amount: "0".into(),
                    ..Default::default()
                });
        }
        if let Some(timer) = &mut saved.cooldown {
            timer.until = timer
                .started_at
                .saturating_add(config.cooldown_seconds as i64);
        }
        saved.config = Some(config);
        self.save(db, saved)?;
        self.rest_due = 0;
        self.token_due = 0;
        storage::event(
            db,
            at,
            "Watch rules saved; monitoring future fills. Withdrawals remain paused",
        )
    }
    pub fn queue_digest(&self) -> Result<String> {
        digest(&(self.saved.revision, &self.saved.queues))
    }
    pub fn set_cooldown(
        &mut self,
        db: &Connection,
        seconds: u64,
        expected: &str,
        at: i64,
    ) -> Result<()> {
        ensure!(
            self.saved.paused,
            "pause withdrawals before changing cooldowns"
        );
        ensure!(
            self.busy_transfers(db)?.is_empty(),
            "wait for active withdrawals to settle before changing cooldowns"
        );
        ensure!(
            (1..=86400).contains(&seconds),
            "cooldown must be 1–86400 seconds"
        );
        let current = self
            .saved
            .config
            .as_ref()
            .context("configure watch rules first")?;
        ensure!(
            current.digest()? == expected,
            "watch rules changed; refresh and review the cooldown again"
        );
        let mut saved = self.saved.clone();
        let config = saved.config.as_mut().unwrap();
        config.cooldown_seconds = seconds;
        config.validate()?;
        if let Some(timer) = &mut saved.cooldown {
            timer.until = timer.started_at.saturating_add(seconds as i64);
        }
        // Timing-only edits retain the fill boundary, cursor, queue, wallet
        // rotation and last submission. New fills share this same timer.
        saved.revision = saved.revision.checked_add(1).context("revision overflow")?;
        let tx = db.unchecked_transaction()?;
        storage::set(&tx, "live", &serde_json::to_string(&saved)?)?;
        storage::event(
            &tx,
            at,
            &format!(
                "Account-wide withdrawal cooldown set to {seconds}s; withdrawals remain paused"
            ),
        )?;
        tx.commit()?;
        self.saved = saved;
        Ok(())
    }
    pub fn clear(&mut self, db: &Connection, expected: &str, at: i64) -> Result<()> {
        ensure!(self.saved.paused, "pause before clearing the queue");
        ensure!(
            self.busy_transfers(db)?.is_empty(),
            "cannot clear while withdrawals are active or uncertain"
        );
        ensure!(
            self.queue_digest()? == expected,
            "queue changed; fetch a fresh queue digest"
        );
        let mut saved = self.saved.clone();
        for q in saved.queues.values_mut() {
            q.amount = "0".into();
        }
        saved.cleared_at = at;
        self.save(db, saved)?;
        storage::event(
            db,
            at,
            "Queue cleared; delayed fills at or before this boundary cannot restore it",
        )
    }
    pub fn operation(&mut self, db: &Connection, at: i64) -> Result<Option<Operation>> {
        if self.want_orders {
            self.want_orders = false;
            if !self.configured() {
                return Ok(Some(Operation::Orders));
            }
        }
        if !self.configured() {
            return Ok(None);
        }
        if at >= self.rest_due {
            self.rest_due = at + self.saved.config.as_ref().unwrap().poll_seconds as i64;
            let pending_since:Option<i64>=db.query_row("SELECT MIN(CAST(json_extract(payload,'$.time') AS INTEGER)) FROM live_records WHERE kind='ws'",[],|r|r.get(0))?;
            let overlap = self.saved.cursor.unwrap_or(at).saturating_sub(60);
            return Ok(Some(Operation::Reconcile {
                start: pending_since
                    .map(|t| overlap.min(t.saturating_sub(1)))
                    .unwrap_or(overlap)
                    .max(self.saved.since.unwrap_or(at)),
                end: at.min(self.saved.cursor.unwrap_or(at).saturating_add(3600)),
            }));
        }
        let active = self.busy_transfers(db)?;
        if active.iter().any(|t| t.exchange_id.is_some()) && at >= self.status_due {
            self.status_due = at + poll_delay(&active, at);
            return Ok(Some(Operation::Poll {
                since: active.iter().map(|t| t.created_at).min().unwrap() - 60,
            }));
        }
        if self.websocket_enabled() && self.ws_state == "Disconnected" && at >= self.token_due {
            self.token_due = at + 60;
            return Ok(Some(Operation::Token));
        }
        if self.saved.paused
            || self.saved.cursor.is_none_or(|cursor| {
                at - cursor > self.saved.config.as_ref().unwrap().poll_seconds as i64 * 2
            })
            || self.rest_error.is_some()
            || self.rest_at.is_none_or(|t| at - t > 60)
        {
            return Ok(None);
        }
        let config = self.saved.config.as_ref().unwrap();
        if active.len() >= config.max_inflight
            || active
                .iter()
                .any(|transfer| transfer.status == "submitting")
            || self.cooldown().is_some_and(|timer| timer.remaining(at) > 0)
        {
            return Ok(None);
        }
        let start = self
            .saved
            .last_asset
            .as_ref()
            .and_then(|asset| config.rules.iter().position(|r| &r.asset == asset))
            .map(|i| i + 1)
            .unwrap_or(0);
        for offset in 0..config.rules.len() {
            let rule = &config.rules[(start + offset) % config.rules.len()];
            let queue = &self.saved.queues[&rule.asset];
            if !rule.enabled
                || active.iter().any(|t| t.asset == rule.asset)
                || at < queue.retry_at
                || amount(&queue.amount)? < amount(&rule.minimum)?
            {
                continue;
            }
            return Ok(Some(Operation::Quote {
                rule: rule.clone(),
                destination: rule.destinations[queue.destination_index % rule.destinations.len()]
                    .clone(),
                queued: queue.amount.clone(),
            }));
        }
        Ok(None)
    }
    pub fn sync(
        &mut self,
        db: &Connection,
        trades: Vec<Trade>,
        balances: &[AccountBalance],
        orders: Vec<Order>,
        end: i64,
        at: i64,
    ) -> Result<()> {
        let tx = db.unchecked_transaction()?;
        let mut saved = self.saved.clone();
        let config = saved.config.as_ref().context("missing watch rules")?;
        for fill in &trades {
            if let Some(existing) = load::<Trade>(&tx, "fill", &fill.id)? {
                ensure!(
                    existing == *fill,
                    "exchange returned conflicting data for an already recorded fill"
                );
                continue;
            }
            let time = decimal(&fill.time)?;
            ensure!(
                time >= Decimal::ZERO && time <= Decimal::from(end + 1),
                "invalid fill timestamp"
            );
            // Fees and debits come from settlement ledgers, not requested/cumulative order size.
            if time > Decimal::from(saved.cleared_at.max(saved.since.unwrap_or(0))) {
                for (symbol, debit) in &fill.debits {
                    if let Some(q) = saved.queues.get_mut(symbol) {
                        q.amount = subtract(amount(&q.amount)?, amount(debit)?)?
                            .max(Decimal::ZERO)
                            .normalize()
                            .to_string();
                    }
                }
                if time > Decimal::from(saved.watch_from)
                    && config.rules.iter().any(|rule| rule.matches(fill))
                {
                    let q = saved
                        .queues
                        .get_mut(&fill.received_asset)
                        .context("missing queue")?;
                    q.amount = add(amount(&q.amount)?, amount(&fill.received)?)?
                        .normalize()
                        .to_string();
                }
            }
            put(
                &tx,
                "fill",
                &fill.id,
                time.trunc().to_string().parse()?,
                fill,
            )?;
            tx.execute(
                "DELETE FROM live_records WHERE kind='ws' AND id=?1",
                [&fill.id],
            )?;
        }
        let active = self.busy_transfers(&tx)?;
        let totals: BTreeMap<_, _> = balances
            .iter()
            .map(|b| (asset(&b.asset), &b.balance))
            .collect();
        for (symbol, q) in &mut saved.queues {
            // Exchange balances already exclude in-flight debits. Never subtract a reservation twice.
            if active.iter().any(|t| &t.asset == symbol) {
                continue;
            }
            let total = totals
                .get(symbol)
                .map(|v| decimal(v))
                .transpose()?
                .unwrap_or(Decimal::ZERO)
                .max(Decimal::ZERO);
            let queued = amount(&q.amount)?;
            if queued > total {
                q.amount = total.normalize().to_string();
                storage::event(
                    &tx,
                    at,
                    &format!(
                        "Queued {symbol} reduced to current owned balance after a sale/withdrawal"
                    ),
                )?;
            }
        }
        saved.cursor = Some(end);
        saved.orders = orders;
        saved.orders_at = Some(at);
        // Recover accepted placement receipts after a lost HTTP response, without resending.
        for mut receipt in records::<OrderReceipt>(&tx, "order", usize::MAX / 2)? {
            if receipt.status == "unknown"
                && matches!(receipt.request.action, OrderAction::Place { .. })
                && let Some(order) = saved
                    .orders
                    .iter()
                    .find(|o| o.client_id.as_deref() == Some(&receipt.request.request_id))
            {
                receipt.status = "accepted".into();
                receipt.exchange_id = Some(order.id.clone());
                receipt.message = "Recovered by client order ID".into();
                put(
                    &tx,
                    "order",
                    &receipt.request.request_id,
                    receipt.at,
                    &receipt,
                )?;
            }
        }
        saved.revision += 1;
        storage::set(&tx, "live", &serde_json::to_string(&saved)?)?;
        tx.commit()?;
        self.saved = saved;
        self.rest_at = Some(at);
        self.rest_error = None;
        self.orders_error = None;
        self.failures = 0;
        if end < at - 1 {
            self.rest_due = at + 2;
        }
        Ok(())
    }
    pub fn block(&mut self, db: &Connection, symbol: &str, reason: &str, at: i64) -> Result<()> {
        let mut saved = self.saved.clone();
        let q = saved.queues.get_mut(symbol).context("missing queue")?;
        q.failures = q.failures.saturating_add(1);
        q.retry_at = at + (15i64.saturating_mul(1i64 << q.failures.min(5))).min(600);
        if q.blocked.as_deref() != Some(reason) {
            storage::event(db, at, &format!("{symbol}: {reason}"))?;
        }
        q.blocked = Some(reason.into());
        self.save(db, saved)
    }
    pub fn reserve(&mut self, db: &Connection, quote: Quote, at: i64) -> Result<Option<Operation>> {
        if self.saved.paused || at - quote.at > 20 {
            return Ok(None);
        }
        let config = self.saved.config.as_ref().context("missing rules")?;
        let rule = config
            .rules
            .iter()
            .find(|r| r.asset == quote.asset)
            .context("rule removed")?;
        ensure!(
            rule.enabled && rule.destinations.contains(&quote.destination),
            "quote destination no longer configured"
        );
        let active = self.busy_transfers(db)?;
        ensure!(
            active.len() < config.max_inflight
                && !active
                    .iter()
                    .any(|t| t.asset == quote.asset || t.status == "submitting"),
            "withdrawal already active"
        );
        ensure!(
            self.cooldown().is_none_or(|timer| timer.remaining(at) == 0),
            "account-wide withdrawal cooldown is still active"
        );
        let gross = amount(&quote.gross)?;
        let fee = amount(&quote.fee)?;
        ensure!(
            gross >= amount(&rule.minimum)?
                && gross <= amount(&rule.chunk)?
                && gross <= amount(&self.saved.queues[&rule.asset].amount)?,
            "quote exceeds rule or queue"
        );
        ensure!(
            gross > fee && add(amount(&quote.net)?, fee)? == gross,
            "inconsistent withdrawal quote"
        );
        ensure!(
            fee <= amount(&rule.max_fee)?
                && fee
                    .checked_mul(Decimal::from(100))
                    .context("fee overflow")?
                    <= gross
                        .checked_mul(amount(&rule.max_fee_percent)?)
                        .context("fee overflow")?,
            "withdrawal fee exceeds configured cap"
        );
        if let Some(budget) = &rule.daily_fee_budget {
            let mut spent = Decimal::ZERO;
            for t in records::<Transfer>(db, "transfer", usize::MAX / 2)? {
                if t.asset == rule.asset
                    && t.created_at > at.saturating_sub(86400)
                    && t.status != "rejected"
                    && t.status != "not_sent"
                {
                    spent = add(spent, amount(&t.fee)?)?;
                }
            }
            ensure!(
                add(spent, fee)? <= amount(budget)?,
                "rolling 24-hour fee budget reached"
            );
        }
        let transfer = Transfer {
            id: uuid::Uuid::new_v4().to_string(),
            asset: rule.asset.clone(),
            gross: quote.gross,
            net: quote.net,
            fee: quote.fee,
            destination: quote.destination,
            status: "submitting".into(),
            exchange_id: None,
            txid: None,
            error: None,
            created_at: at,
            updated_at: at,
        };
        let mut saved = self.saved.clone();
        saved.last_asset = Some(transfer.asset.clone());
        saved.cooldown = Some(WithdrawalCooldown::new(
            &transfer.asset,
            at,
            config.cooldown_seconds,
        ));
        let q = saved.queues.get_mut(&transfer.asset).unwrap();
        q.amount = subtract(amount(&q.amount)?, gross)?.normalize().to_string();
        q.last_submission = at;
        q.destination_index += 1;
        q.blocked = None;
        q.failures = 0;
        saved.revision += 1;
        let tx = db.unchecked_transaction()?;
        put(&tx, "transfer", &transfer.id, at, &transfer)?;
        storage::set(&tx, "live", &serde_json::to_string(&saved)?)?;
        storage::event(
            &tx,
            at,
            &format!(
                "Withdrawal intent recorded: {} {} including fee",
                transfer.gross, transfer.asset
            ),
        )?;
        tx.commit()?;
        self.saved = saved;
        Ok(Some(Operation::Submit {
            transfer,
            token: quote.token,
        }))
    }
    pub fn submitted(
        &mut self,
        db: &Connection,
        id: &str,
        result: Submission,
        at: i64,
    ) -> Result<()> {
        let mut transfer: Transfer =
            load(db, "transfer", id)?.context("missing withdrawal intent")?;
        if transfer.status != "submitting" {
            return Ok(());
        }
        let mut saved = self.saved.clone();
        match result {
            Submission::Accepted { exchange_id, held } => {
                transfer.exchange_id = Some(exchange_id);
                transfer.status = if held { "held" } else { "pending" }.into();
            }
            Submission::Rejected(reason) => {
                transfer.status = "rejected".into();
                transfer.error = Some(reason);
                let q = saved
                    .queues
                    .get_mut(&transfer.asset)
                    .context("missing queue")?;
                q.amount = add(amount(&q.amount)?, amount(&transfer.gross)?)?
                    .normalize()
                    .to_string();
                q.retry_at = at + 300;
                q.blocked = Some("Exchange rejected withdrawal; waiting before rechecking".into());
            }
            Submission::Unknown(reason) => {
                transfer.status = "unknown".into();
                transfer.error = Some(reason);
            }
        }
        transfer.updated_at = at;
        // Start the full interval after the attempt returns. Time spent waiting
        // for a slow/throttled request must not let the next asset send early.
        if let Some(timer) = &mut saved.cooldown
            && timer.asset == transfer.asset
            && timer.started_at == transfer.created_at
        {
            let seconds = timer.until.saturating_sub(timer.started_at);
            timer.started_at = at.max(timer.started_at);
            timer.until = timer.started_at.saturating_add(seconds);
            saved
                .queues
                .get_mut(&transfer.asset)
                .context("missing queue")?
                .last_submission = timer.started_at;
        }
        saved.revision += 1;
        let tx = db.unchecked_transaction()?;
        put(&tx, "transfer", id, transfer.created_at, &transfer)?;
        storage::set(&tx, "live", &serde_json::to_string(&saved)?)?;
        storage::event(
            &tx,
            at,
            &format!("Withdrawal {}: {}", transfer.id, transfer.status),
        )?;
        tx.commit()?;
        self.saved = saved;
        self.rest_due = 0;
        self.status_due = 0;
        Ok(())
    }
    pub fn statuses(
        &mut self,
        db: &Connection,
        statuses: Vec<WithdrawalStatus>,
        at: i64,
    ) -> Result<()> {
        let tx = db.unchecked_transaction()?;
        let mut changed = false;
        for mut t in self.busy_transfers(&tx)? {
            let Some(id) = &t.exchange_id else {
                continue;
            }; // Never guess an uncertain transfer by amount/time.
            let Some(s) = statuses.iter().find(|s| &s.id == id) else {
                continue;
            };
            ensure!(
                s.asset == t.asset
                    && s.destination == t.destination.wallet_id
                    && s.method == t.destination.method_id
                    && amount(&s.net)? == amount(&t.net)?,
                "withdrawal receipt does not match recorded intent"
            );
            let status = match s.status.as_str() {
                "success" => "complete",
                "failed" => "failed",
                "pending" => {
                    if t.status == "held" {
                        "held"
                    } else {
                        "pending"
                    }
                }
                _ => "unknown",
            };
            if t.status != status {
                changed = true;
                storage::event(&tx, at, &format!("Withdrawal {}: {status}", t.id))?;
            }
            t.status = status.into();
            t.txid = s.txid.clone();
            t.fee = s.fee.clone();
            t.updated_at = at;
            // Failed transfers are not automatically returned/retried; receipts remain reviewable.
            put(&tx, "transfer", &t.id, t.created_at, &t)?;
        }
        tx.commit()?;
        self.poll_failures = 0;
        self.status_due = at + poll_delay(&self.busy_transfers(db)?, at);
        // Unchanged pending receipts don't justify a full trade/balance sync.
        if changed {
            self.rest_due = 0;
        }
        Ok(())
    }
    pub fn attach_receipt(&mut self, db: &Connection, id: &str, exchange_id: &str) -> Result<()> {
        crate::model::text(exchange_id, "exchange withdrawal ID")?;
        let mut t: Transfer = load(db, "transfer", id)?.context("withdrawal not found")?;
        ensure!(
            t.status == "unknown",
            "only an unknown submission can have its receipt attached"
        );
        ensure!(
            !records::<Transfer>(db, "transfer", usize::MAX / 2)?
                .iter()
                .any(|other| other.id != id && other.exchange_id.as_deref() == Some(exchange_id)),
            "receipt already linked to another transfer"
        );
        t.exchange_id = Some(exchange_id.into());
        put(db, "transfer", id, t.created_at, &t)?;
        self.status_due = 0;
        Ok(())
    }
    pub fn resolve_not_sent(
        &mut self,
        db: &Connection,
        id: &str,
        expected: &str,
        confirmed: bool,
        at: i64,
    ) -> Result<()> {
        ensure!(
            self.saved.paused,
            "pause withdrawals before reviewing an uncertain request"
        );
        ensure!(
            confirmed,
            "confirm you checked Kraken withdrawal history and this request was never sent"
        );
        if let Some(previous) = load::<String>(db, "resolution", id)? {
            ensure!(
                previous == expected,
                "withdrawal was already resolved with a different review"
            );
            return Ok(());
        }
        let mut transfer: Transfer = load(db, "transfer", id)?.context("withdrawal not found")?;
        ensure!(
            transfer.status == "unknown" && transfer.exchange_id.is_none(),
            "only an uncertain request without an exchange receipt can be marked not sent"
        );
        ensure!(
            at.saturating_sub(transfer.created_at) >= 120,
            "wait at least two minutes, then check Kraken withdrawal history"
        );
        ensure!(
            digest(&transfer)? == expected,
            "withdrawal changed; review it again"
        );
        let mut saved = self.saved.clone();
        let queue = saved
            .queues
            .get_mut(&transfer.asset)
            .context("withdrawal rule no longer exists")?;
        queue.amount = add(amount(&queue.amount)?, amount(&transfer.gross)?)?
            .normalize()
            .to_string();
        queue.blocked = None;
        queue.retry_at = 0;
        saved.revision += 1;
        transfer.status = "not_sent".into();
        transfer.updated_at = at;
        transfer.error = Some("User confirmed in Kraken history that no withdrawal was sent; queued amount restored, withdrawals remain paused".into());
        let tx = db.unchecked_transaction()?;
        put(&tx, "transfer", id, transfer.created_at, &transfer)?;
        put(&tx, "resolution", id, at, &expected)?;
        storage::set(&tx, "live", &serde_json::to_string(&saved)?)?;
        storage::event(
            &tx,
            at,
            &format!("Withdrawal {id} reviewed as not sent; withdrawals remain paused"),
        )?;
        tx.commit()?;
        self.saved = saved;
        self.rest_due = 0;
        Ok(())
    }
    pub fn order(
        &mut self,
        db: &Connection,
        request: OrderCommand,
        expected: &str,
        name: &str,
    ) -> Result<Option<Operation>> {
        if self.order_recorded(db, &request, expected, name)? {
            return Ok(None);
        }
        let hash = request.digest()?;
        ensure!(
            !records::<OrderReceipt>(db, "order", usize::MAX / 2)?
                .iter()
                .any(|r| matches!(r.status.as_str(), "unknown" | "submitting")),
            "reconcile the uncertain order request before sending another"
        );
        let receipt = OrderReceipt {
            request: request.clone(),
            digest: hash,
            status: "submitting".into(),
            exchange_id: None,
            message: "Recorded before sending; retries with this ID will not resubmit".into(),
            at: now(),
        };
        put(db, "order", &request.request_id, receipt.at, &receipt)?;
        Ok(Some(Operation::Order(request)))
    }
    pub fn order_recorded(
        &self,
        db: &Connection,
        request: &OrderCommand,
        expected: &str,
        name: &str,
    ) -> Result<bool> {
        request.validate()?;
        ensure!(
            request.account == name,
            "order request belongs to another account"
        );
        let hash = request.digest()?;
        ensure!(hash == expected, "order changed; validate and review again");
        if let Some(old) = load::<OrderReceipt>(db, "order", &request.request_id)? {
            ensure!(
                old.digest == hash,
                "request ID already used for different order instructions"
            );
            return Ok(true);
        }
        Ok(false)
    }
    pub fn order_result(&mut self, db: &Connection, id: &str, result: Submission) -> Result<()> {
        let mut receipt: OrderReceipt = load(db, "order", id)?.context("missing order intent")?;
        match result {
            Submission::Accepted { exchange_id, .. } => {
                receipt.status = "accepted".into();
                receipt.exchange_id = Some(exchange_id);
                receipt.message =
                    "Kraken accepted the request; inspect refreshed order status".into();
            }
            Submission::Rejected(message) => {
                receipt.status = "rejected".into();
                receipt.message = message;
            }
            Submission::Unknown(message) => {
                receipt.status = "unknown".into();
                receipt.message = message;
            }
        }
        put(db, "order", id, receipt.at, &receipt)?;
        storage::event(
            db,
            now(),
            &format!("Order request {id}: {}", receipt.status),
        )?;
        self.want_orders = true;
        self.rest_due = 0;
        Ok(())
    }
    pub fn handle_reply(
        &mut self,
        db: &Connection,
        operation: &Operation,
        reply: Reply,
        at: i64,
    ) -> Result<Option<Operation>> {
        match reply {
            Reply::Sync {
                trades,
                accounting_balances,
                orders,
                end,
                ..
            } => self.sync(db, trades, &accounting_balances, orders, end, at)?,
            Reply::Quote(quote) => {
                let symbol = quote.asset.clone();
                match self.reserve(db, quote, at) {
                    Ok(op) => return Ok(op),
                    Err(e) => self.block(db, &symbol, &e.to_string(), at)?,
                }
            }
            Reply::Submitted(result) => {
                if let Operation::Submit { transfer, .. } = operation {
                    self.submitted(db, &transfer.id, result, at)?;
                } else {
                    bail!("unexpected submission result");
                }
            }
            Reply::Statuses(statuses) => self.statuses(db, statuses, at)?,
            Reply::Orders(orders) => {
                self.orders_error = None;
                for mut receipt in records::<OrderReceipt>(db, "order", usize::MAX / 2)? {
                    if receipt.status == "unknown"
                        && matches!(receipt.request.action, OrderAction::Place { .. })
                        && let Some(order) = orders
                            .iter()
                            .find(|o| o.client_id.as_deref() == Some(&receipt.request.request_id))
                    {
                        receipt.status = "accepted".into();
                        receipt.exchange_id = Some(order.id.clone());
                        receipt.message = "Recovered by client order ID".into();
                        put(
                            db,
                            "order",
                            &receipt.request.request_id,
                            receipt.at,
                            &receipt,
                        )?;
                    }
                }
                let mut next = self.saved.clone();
                next.orders = orders;
                next.orders_at = Some(at);
                self.save(db, next)?;
            }
            Reply::Order(result) => {
                if let Operation::Order(request) = operation {
                    self.order_result(db, &request.request_id, result)?;
                } else {
                    bail!("unexpected order result");
                }
            }
            Reply::Token(_) => bail!("token must be handed directly to websocket task"),
        }
        Ok(None)
    }
    pub fn failed(
        &mut self,
        db: &Connection,
        operation: &Operation,
        reason: &str,
        at: i64,
    ) -> Result<()> {
        match operation {
            Operation::Quote { rule, .. } => self.block(db, &rule.asset, reason, at)?,
            Operation::Submit { transfer, .. } => {
                self.submitted(db, &transfer.id, Submission::Unknown(reason.into()), at)?
            }
            Operation::Order(request) => {
                self.order_result(db, &request.request_id, Submission::Unknown(reason.into()))?
            }
            Operation::Reconcile { .. } => {
                self.rest_error = Some(reason.into());
                self.failures = self.failures.saturating_add(1);
                self.rest_due = at + (15 * (1i64 << self.failures.min(5))).min(600);
            }
            Operation::Token => self.ws_disconnected(at),
            Operation::Orders => self.orders_error = Some(reason.into()),
            Operation::Poll { .. } => {
                self.poll_failures = self.poll_failures.saturating_add(1);
                self.status_due = at + (15 * (1i64 << self.poll_failures.min(5))).min(300);
            }
        }
        storage::event(db, at, &format!("{} failed: {reason}", operation.label()))
    }
    pub fn ws_disconnected(&mut self, at: i64) {
        self.ws_state = "Disconnected".into();
        self.ws_failures = self.ws_failures.saturating_add(1);
        self.token_due = at + (5 * (1i64 << self.ws_failures.saturating_sub(1).min(4))).min(60);
        if self.rest_error.is_none() {
            self.rest_due = self.rest_due.min(at);
        }
    }
    pub fn ws_trade(
        &mut self,
        db: &Connection,
        id: &str,
        payload: &serde_json::Value,
        at: i64,
    ) -> Result<()> {
        // Raw authenticated executions are evidence, not additional credits. REST ledger reconciliation is authoritative.
        let time = decimal(
            payload["time"]
                .as_str()
                .context("websocket trade omitted time")?,
        )?;
        if self
            .saved
            .since
            .is_none_or(|since| time <= Decimal::from(since))
        {
            return Ok(());
        }
        if load::<Trade>(db, "fill", id)?.is_none() {
            put(db, "ws", id, at, payload)?;
        }
        if self.rest_error.is_none() {
            self.rest_due = self.rest_due.min(at);
        }
        Ok(())
    }
    pub fn status(&self, db: &Connection) -> Result<Status> {
        // An old uncertain receipt must remain reviewable even after newer activity.
        let mut transfers: Vec<Transfer> = records(db, "transfer", 200)?;
        for t in self.busy_transfers(db)? {
            if !transfers.iter().any(|recent| recent.id == t.id) {
                transfers.push(t);
            }
        }
        Ok(Status {
            config: self.saved.config.clone(),
            config_digest: self.saved.config.as_ref().map(Config::digest).transpose()?,
            monitoring_since: self.saved.since,
            caught_up_through: self.saved.cursor,
            rest_updated_at: self.rest_at,
            rest_error: self.rest_error.clone(),
            websocket: self.ws_state.clone(),
            websocket_updated_at: self.ws_at,
            pending_ws_trades: db.query_row(
                "SELECT COUNT(*) FROM live_records WHERE kind='ws'",
                [],
                |r| r.get(0),
            )?,
            queues: self.saved.queues.clone(),
            trades: records(db, "fill", 200)?,
            transfers,
            orders: self.saved.orders.clone(),
            orders_updated_at: self.saved.orders_at,
            orders_error: self.orders_error.clone(),
            order_receipts: records(db, "order", 100)?,
        })
    }
}

pub(super) fn minimum_for_destinations(
    asset: &str,
    destinations: &[Destination],
    wallets: &[Wallet],
) -> Result<Decimal> {
    ensure!(!destinations.is_empty(), "select at least one destination");
    destinations.iter().try_fold(Decimal::ZERO, |minimum, d| {
        Ok(minimum.max(verify_destination(asset, d, wallets)?.withdrawal_minimum()?))
    })
}

pub(super) fn verify_destination<'a>(
    asset: &str,
    d: &Destination,
    wallets: &'a [Wallet],
) -> Result<&'a FundingMethod> {
    let wallet = wallets
        .iter()
        .find(|w| w.id == d.wallet_id)
        .context("saved destination missing; sync Kraken wallets")?;
    ensure!(
        wallet.verified
            && wallet.source == "kraken"
            && wallet.address == d.address
            && wallet.memo == d.memo,
        "destination must be verified and match its pinned address and memo/tag"
    );
    wallet
        .methods
        .iter()
        .find(|m| m.id == d.method_id && m.asset == asset && m.network == d.network)
        .context("destination method, network or asset does not match Kraken")
}

//! One serialized account owner coordinates cached reads and durable live automation.
mod refresh;
use crate::{
    kraken::{ReadKind, ReadResult},
    model::*,
    storage,
    vault::{Credential, Vault},
};
use anyhow::{Context, Result, ensure};
use refresh::{Refresh, Resource};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    check: Option<SavedCheck>,
    wallets: Vec<Wallet>,
    wallets_fingerprint: Option<String>,
    wallets_updated_at: Option<i64>,
    sync_error: Option<String>,
    balances: Vec<AccountBalance>,
    balances_fingerprint: Option<String>,
    balances_updated_at: Option<i64>,
    balances_error: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct SavedCheck {
    fingerprint: String,
    status: KeyStatus,
}

pub(crate) struct Job {
    pub generation: u64,
    pub fingerprint: String,
    pub kind: ReadKind,
    pub credential: Credential,
    pub nonce: u64,
    pub cancelled: Arc<AtomicBool>,
}
pub(crate) struct Finished {
    pub generation: u64,
    pub fingerprint: String,
    pub kind: ReadKind,
    pub result: std::result::Result<ReadResult, String>,
}

pub(crate) struct LiveFinished {
    pub generation: u64,
    pub fingerprint: String,
    pub operation: crate::live::transport::Operation,
    pub result: std::result::Result<crate::live::transport::Reply, String>,
}

enum Work {
    Read(ReadKind),
    Live(Box<crate::live::transport::Operation>),
}
fn resource(kind: ReadKind) -> Resource {
    match kind {
        ReadKind::Balances => Resource::Balances,
        ReadKind::Wallets => Resource::Wallets,
        ReadKind::Key => Resource::Key,
    }
}

pub(crate) struct Account {
    db: Connection,
    started_at: i64,
    saved: Saved,
    generation: u64,
    cancelled: Option<Arc<AtomicBool>>,
    live: crate::live::store::Live,
    pending: Option<crate::live::transport::Operation>,
    ws_cancelled: Option<Arc<AtomicBool>>,
    ws_generation: u64,
    refresh: Refresh,
    refresh_identity: Option<String>,
    prefer_refresh: bool,
    writing: bool,
    session: crate::kraken::session::Shared,
    notifications: crate::notifications::Notifications,
    notifications_due: i64,
}
impl Account {
    pub fn open(directory: &Path) -> Result<Self> {
        let db = storage::open_profile(directory, "account")?;
        db.busy_timeout(std::time::Duration::from_secs(2))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL); PRAGMA user_version=2;")?;
        storage::set(&db, "mode", "account")?;
        let saved = match storage::get(&db, "account")? {
            Some(value) => serde_json::from_str(&value)?,
            None => Saved::default(),
        };
        let live = crate::live::store::Live::open(&db)?;
        let notifications = crate::notifications::Notifications::open(&db)?;
        storage::event(
            &db,
            now(),
            "Account worker started with withdrawals paused. Unlock to reconnect monitoring.",
        )?;
        Ok(Self {
            db,
            saved,
            started_at: now(),
            generation: 0,
            cancelled: None,
            live,
            pending: None,
            ws_cancelled: None,
            ws_generation: 0,
            refresh: Refresh::default(),
            refresh_identity: None,
            prefer_refresh: true,
            writing: false,
            session: crate::kraken::session::Session::shared(),
            notifications,
            notifications_due: 0,
        })
    }
    fn save(&self) -> Result<()> {
        storage::set(&self.db, "account", &serde_json::to_string(&self.saved)?)
    }
    pub fn invalidate(&mut self, key_changed: bool) -> Result<()> {
        self.notifications.cancel();
        self.db.execute("DELETE FROM notification_health", [])?;
        self.refresh = Refresh::default();
        self.refresh_identity = None;
        // Lock/unlock must not reset a Kraken throttle or refill its request budget.
        // A replacement key gets its own session; old jobs retain the old one.
        if key_changed {
            self.session = crate::kraken::session::Session::shared();
        } else {
            self.session.lock().unwrap().clear_metadata();
        }
        self.live.pause(&self.db)?;
        self.cancel_pending()?;
        self.disconnect_ws();
        self.generation = self.generation.wrapping_add(1);
        if let Some(cancelled) = &self.cancelled {
            cancelled.store(true, Ordering::Relaxed);
        }
        if key_changed {
            self.live.reset(&self.db)?;
            self.saved.check = None;
            self.saved.wallets.clear();
            self.saved.wallets_fingerprint = None;
            self.saved.wallets_updated_at = None;
            self.saved.sync_error = None;
            self.saved.balances.clear();
            self.saved.balances_fingerprint = None;
            self.saved.balances_updated_at = None;
            self.saved.balances_error = None;
            self.save()?;
        }
        Ok(())
    }
    pub fn begin(&mut self, vault: &Vault, kind: ReadKind) -> Result<Job> {
        ensure!(
            self.cancelled.is_none(),
            "a Kraken check is already running; wait for it to finish"
        );
        let credential = vault.credential()?;
        let fingerprint = vault.fingerprint().context("key is missing")?;
        let previous = storage::get(&self.db, "nonce")?
            .map(|s| s.parse::<u64>())
            .transpose()?
            .unwrap_or(0);
        let time: u64 = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis()
            .try_into()?;
        let nonce = previous.checked_add(1).context("nonce overflow")?.max(time);
        // One job owns the nonce stream. Reserve more than its bounded 1000
        // requests before dispatch; unused nonces are never reused.
        storage::set(
            &self.db,
            "nonce",
            &nonce
                .checked_add(1_000_000)
                .context("nonce overflow")?
                .to_string(),
        )?;
        let cancelled = Arc::new(AtomicBool::new(false));
        self.cancelled = Some(cancelled.clone());
        Ok(Job {
            generation: self.generation,
            fingerprint,
            kind,
            credential,
            nonce,
            cancelled,
        })
    }
    pub fn finish(&mut self, finished: Finished, vault: &Vault) -> Result<()> {
        self.cancelled = None;
        self.refresh.cancelled(resource(finished.kind));
        if finished.generation != self.generation
            || !vault.is_unlocked()
            || vault.fingerprint().as_deref() != Some(&finished.fingerprint)
        {
            return Ok(());
        }
        self.refresh
            .finished(resource(finished.kind), now(), finished.result.is_ok());
        let mut status = KeyStatus {
            label: "Kraken".into(),
            saved: true,
            checked_at: Some(now()),
            permissions: vec![],
            account_id: None,
            error: None,
        };
        match finished.result {
            Ok(data) => {
                status.permissions = data.info.permissions;
                status.account_id = Some(data.info.account_id);
                if let Some(wallets) = data.wallets {
                    self.saved.wallets = wallets;
                    self.saved.wallets_fingerprint = Some(finished.fingerprint.clone());
                    self.saved.wallets_updated_at = Some(now());
                    self.saved.sync_error = None;
                }
                if let Some(balances) = data.balances {
                    self.saved.balances = balances;
                    self.saved.balances_fingerprint = Some(finished.fingerprint.clone());
                    self.saved.balances_updated_at = Some(now());
                    self.saved.balances_error = None;
                }
                storage::event(
                    &self.db,
                    now(),
                    if finished.kind == ReadKind::Wallets {
                        "Kraken wallet destinations refreshed; watch rules are unchanged"
                    } else if finished.kind == ReadKind::Balances {
                        "Kraken balances refreshed; held amounts include spot non-margin orders only"
                    } else {
                        "Kraken API key permissions checked"
                    },
                )?;
            }
            Err(error) => {
                status.error = Some(error.clone());
                if finished.kind == ReadKind::Wallets {
                    self.saved.sync_error = Some(error.clone());
                }
                if finished.kind == ReadKind::Balances {
                    self.saved.balances_error = Some(error);
                }
                storage::event(
                    &self.db,
                    now(),
                    "Kraken check failed; previous account data retained",
                )?;
            }
        }
        self.saved.check = Some(SavedCheck {
            fingerprint: finished.fingerprint,
            status,
        });
        self.save()
    }
    pub fn check_replace_key(&mut self) -> Result<()> {
        // Read jobs are cancelled by invalidate after changing the credential.
        // Durable active/unknown writes still block replacement below.
        self.live.replace_key(&self.db)
    }
    fn cancel_pending(&mut self) -> Result<()> {
        if let Some(operation) = self.pending.take() {
            match operation {
                crate::live::transport::Operation::Submit { transfer, .. } => self.live.submitted(
                    &self.db,
                    &transfer.id,
                    crate::live::transport::Submission::Rejected(
                        "Cancelled before dispatch".into(),
                    ),
                    now(),
                )?,
                crate::live::transport::Operation::Order(order) => self.live.order_result(
                    &self.db,
                    &order.request_id,
                    crate::live::transport::Submission::Rejected(
                        "Cancelled before dispatch".into(),
                    ),
                )?,
                _ => (),
            }
        }
        Ok(())
    }
    pub fn pause(&mut self) -> Result<()> {
        self.generation = self.generation.wrapping_add(1);
        self.live.pause(&self.db)?;
        // Cancel a quote/submission at the transport's last pre-dispatch check.
        if let Some(flag) = &self.cancelled {
            flag.store(true, Ordering::SeqCst);
        }
        self.cancel_pending()
    }
    pub fn configure(
        &mut self,
        vault: &Vault,
        config: crate::live::Config,
        digest: &str,
        name: &str,
    ) -> Result<()> {
        ensure!(
            self.pending.is_none() && !self.writing,
            "wait for the current Kraken job before changing rules"
        );
        let fingerprint = vault
            .fingerprint()
            .context("unlock and set your account key first")?;
        ensure!(
            vault.is_unlocked() && self.saved.wallets_fingerprint.as_deref() == Some(&fingerprint),
            "unlock and sync saved Kraken destinations first"
        );
        ensure!(
            !self.refresh_status(vault, now()).wallets.stale,
            "Kraken wallet data is stale; automatic refresh must succeed before applying rules"
        );
        self.live.configure(
            &self.db,
            config,
            digest,
            name,
            &fingerprint,
            &self.saved.wallets,
            now(),
        )?;
        // An automatic read may have started while the editor was open. Discard
        // its result after changing the watch boundary, instead of losing the edit.
        self.generation = self.generation.wrapping_add(1);
        if let Some(flag) = &self.cancelled {
            flag.store(true, Ordering::SeqCst);
        }
        self.disconnect_ws();
        Ok(())
    }
    pub fn set_cooldown(
        &mut self,
        vault: &Vault,
        asset: &str,
        seconds: u64,
        expected: &str,
    ) -> Result<()> {
        ensure!(
            self.pending.is_none() && !self.writing,
            "wait for the current Kraken job before changing cooldowns"
        );
        let fingerprint = vault
            .fingerprint()
            .context("unlock and set your account key first")?;
        ensure!(
            vault.is_unlocked() && self.live.matches_key(&fingerprint),
            "unlock the configured account first"
        );
        self.live
            .set_cooldown(&self.db, asset, seconds, expected, now())
    }
    pub fn resume(&mut self, vault: &Vault) -> Result<()> {
        let fingerprint = vault.fingerprint().context("unlock and set a key first")?;
        ensure!(vault.is_unlocked(), "unlock the vault first");
        let check = self
            .saved
            .check
            .as_ref()
            .filter(|c| c.fingerprint == fingerprint)
            .context("check the API key first")?;
        ensure!(
            check.status.error.is_none(),
            "key check failed; recheck the API key first"
        );
        for permission in [
            "query-funds",
            "query-open-trades",
            "query-closed-trades",
            "query-ledger",
            "withdraw-funds",
        ] {
            ensure!(
                check.status.permissions.iter().any(|p| p == permission),
                "missing Kraken permission: {permission}"
            );
        }
        self.live.resume(&self.db, &fingerprint)
    }
    pub fn clear_queue(&mut self, digest: &str) -> Result<()> {
        self.live.clear(&self.db, digest, now())
    }
    pub fn refresh_orders(&mut self, vault: &Vault) -> Result<()> {
        vault.credential()?;
        self.prepare_refresh(vault)?;
        self.session.lock().unwrap().invalidate_orders();
        self.refresh.request(Resource::Orders);
        Ok(())
    }
    pub fn request_read(&mut self, vault: &Vault, kind: ReadKind) -> Result<()> {
        vault.credential()?;
        self.prepare_refresh(vault)?;
        if kind == ReadKind::Key {
            self.session.lock().unwrap().invalidate_inspection();
        }
        self.refresh.request(resource(kind));
        Ok(())
    }
    pub fn submit_order(
        &mut self,
        vault: &Vault,
        order: crate::live::OrderCommand,
        digest: &str,
        name: &str,
    ) -> Result<()> {
        vault.credential()?;
        self.live
            .bind(&self.db, &vault.fingerprint().context("key missing")?)?;
        if self.live.order_recorded(&self.db, &order, digest, name)? {
            return Ok(());
        }
        if !matches!(order.action, crate::live::model::OrderAction::Cancel { .. }) {
            let status = self.refresh_status(vault, now());
            ensure!(
                !status.balances.stale && !status.orders.stale,
                "Kraken balances or orders are stale; automatic refresh must succeed before placing or amending orders"
            );
        }
        ensure!(
            self.cancelled.is_none() && self.pending.is_none(),
            "wait for the current Kraken job before sending an order"
        );
        self.pending = self.live.order(&self.db, order, digest, name)?;
        Ok(())
    }
    pub fn attach_receipt(&mut self, id: &str, exchange_id: &str) -> Result<()> {
        self.live.attach_receipt(&self.db, id, exchange_id)
    }
    pub fn resolve_not_sent(
        &mut self,
        vault: &Vault,
        id: &str,
        digest: &str,
        confirmed: bool,
    ) -> Result<()> {
        vault.credential()?;
        ensure!(
            self.cancelled.is_none() && self.pending.is_none(),
            "wait for the current Kraken job before resolving this withdrawal"
        );
        self.live
            .resolve_not_sent(&self.db, id, digest, confirmed, now())
    }
    pub fn configure_telegram(
        &mut self,
        enabled: bool,
        vault: &Vault,
        new_recipient: bool,
    ) -> Result<()> {
        ensure!(
            !enabled || vault.telegram().is_some(),
            "unlock and set up Telegram first"
        );
        let status = crate::notifications::Notifications::status(&self.db, vault.is_unlocked())?;
        if !new_recipient && status.enabled == enabled {
            return Ok(());
        }
        let configured = vault.telegram().is_some() || status.configured;
        self.notifications.configure(&self.db, enabled, configured)
    }
    pub fn test_telegram(&self, vault: &Vault, name: &str) -> Result<()> {
        crate::notifications::Notifications::test(&self.db, vault, name)
    }
    pub fn tick_notifications(&mut self, vault: &Vault, name: &str) -> Result<()> {
        let at = now();
        if at < self.notifications_due {
            return Ok(());
        }
        self.notifications_due = at + 2;
        let enabled =
            crate::notifications::Notifications::status(&self.db, vault.is_unlocked())?.enabled;
        let live = if enabled && vault.is_unlocked() {
            self.live.status(&self.db)?
        } else {
            Default::default()
        };
        self.notifications
            .tick(&self.db, vault, &live, self.live.paused(), name, at)
    }
    pub fn tick(
        &mut self,
        vault: &Vault,
        completed: &tokio::sync::mpsc::Sender<LiveFinished>,
        reads: &tokio::sync::mpsc::Sender<Finished>,
    ) -> Result<()> {
        let Some(work) = self.next_work(vault, now())? else {
            return Ok(());
        };
        if let Work::Read(kind) = work {
            let job = self.begin(vault, kind)?;
            self.refresh.started(resource(kind));
            let reads = reads.clone();
            let session = self.session.clone();
            tokio::task::spawn_blocking(move || {
                let result = crate::kraken::read(
                    job.credential,
                    job.kind,
                    job.nonce,
                    job.cancelled,
                    session,
                )
                .map_err(|error| error.to_string());
                let _ = reads.blocking_send(Finished {
                    generation: job.generation,
                    fingerprint: job.fingerprint,
                    kind: job.kind,
                    result,
                });
            });
            return Ok(());
        }
        let Work::Live(operation) = work else {
            unreachable!()
        };
        let operation = *operation;
        let fingerprint = vault.fingerprint().context("key missing")?;
        self.live.bind(&self.db, &fingerprint)?;
        let job = self.begin(vault, ReadKind::Key)?;
        self.writing = operation.writes();
        for r in Self::operation_resources(&operation) {
            self.refresh.started(*r);
        }
        let completed = completed.clone();
        let session = self.session.clone();
        tokio::task::spawn_blocking(move || {
            let result = crate::live::transport::execute(
                job.credential,
                job.nonce,
                job.cancelled,
                &operation,
                session,
            )
            .map_err(|e| e.to_string());
            let _ = completed.blocking_send(LiveFinished {
                generation: job.generation,
                fingerprint: job.fingerprint,
                operation,
                result,
            });
        });
        Ok(())
    }
    fn prepare_refresh(&mut self, vault: &Vault) -> Result<()> {
        let fingerprint = vault
            .fingerprint()
            .context("unlock and set an account key first")?;
        if self.refresh_identity.as_ref() != Some(&fingerprint) {
            self.refresh = Refresh::default();
            self.refresh_identity = Some(fingerprint);
            self.prefer_refresh = true;
            self.live.rest_due = 0;
            self.live.token_due = 0;
        }
        Ok(())
    }
    fn next_work(&mut self, vault: &Vault, at: i64) -> Result<Option<Work>> {
        if self.cancelled.is_some() || !vault.is_unlocked() || vault.fingerprint().is_none() {
            return Ok(None);
        }
        let fingerprint = vault.fingerprint().unwrap();
        if self.live.configured() && !self.live.matches_key(&fingerprint) {
            return Ok(None);
        }
        self.prepare_refresh(vault)?;
        if !self.session.lock().unwrap().ready() {
            return Ok(None);
        }
        // Durable submissions always dispatch first. Otherwise alternate due
        // account reads and automation so neither can starve the other.
        if let Some(op) = self.pending.take() {
            return Ok(Some(Work::Live(Box::new(op))));
        }
        // Reconciliation already fetches balances and orders. Give a due catch-up
        // their shared turn instead of doing a separate balance/order read first.
        if self.live.configured()
            && at >= self.live.rest_due
            && self
                .refresh
                .next(at)
                .is_none_or(|r| matches!(r, Resource::Balances | Resource::Orders))
            && let Some(op) = self.live.operation(&self.db, at)?
        {
            self.prefer_refresh = true;
            return Ok(Some(Work::Live(Box::new(op))));
        }
        let refresh = self.refresh.next(at);
        if (!self.prefer_refresh || refresh.is_none())
            && let Some(op) = self.live.operation(&self.db, at)?
        {
            self.prefer_refresh = true;
            return Ok(Some(Work::Live(Box::new(op))));
        }
        if let Some(r) = refresh {
            self.prefer_refresh = false;
            return Ok(Some(match r {
                Resource::Orders => Work::Live(Box::new(crate::live::transport::Operation::Orders)),
                Resource::Balances => Work::Read(ReadKind::Balances),
                Resource::Wallets => Work::Read(ReadKind::Wallets),
                Resource::Key => Work::Read(ReadKind::Key),
            }));
        }
        Ok(None)
    }
    fn operation_resources(operation: &crate::live::transport::Operation) -> &'static [Resource] {
        use crate::live::transport::Operation;
        match operation {
            Operation::Orders => &[Resource::Orders],
            Operation::Reconcile { .. } => &[Resource::Balances, Resource::Orders],
            _ => &[],
        }
    }
    fn refresh_status(&self, vault: &Vault, at: i64) -> AccountRefresh {
        let enabled = vault.is_unlocked() && vault.fingerprint().is_some();
        let (orders_at, orders_error) = self.live.orders_freshness();
        AccountRefresh {
            balances: self.refresh.status(
                Resource::Balances,
                self.saved.balances_updated_at,
                self.saved.balances_error.as_deref(),
                enabled,
                at,
            ),
            wallets: self.refresh.status(
                Resource::Wallets,
                self.saved.wallets_updated_at,
                self.saved.sync_error.as_deref(),
                enabled,
                at,
            ),
            orders: self
                .refresh
                .status(Resource::Orders, orders_at, orders_error, enabled, at),
        }
    }
    pub fn finish_live(
        &mut self,
        finished: LiveFinished,
        vault: &Vault,
        events: &tokio::sync::mpsc::Sender<crate::live::websocket::Update>,
    ) -> Result<()> {
        self.cancelled = None;
        self.writing = false;
        for r in Self::operation_resources(&finished.operation) {
            self.refresh.cancelled(*r);
        }
        let writes = finished.operation.writes();
        if !writes
            && (finished.generation != self.generation
                || !vault.is_unlocked()
                || vault.fingerprint().as_deref() != Some(&finished.fingerprint))
        {
            return Ok(());
        }
        match finished.result {
            Ok(crate::live::transport::Reply::Token(token)) => {
                self.disconnect_ws();
                self.live.ws_state = "Connecting".into();
                let cancel = Arc::new(AtomicBool::new(false));
                self.ws_cancelled = Some(cancel.clone());
                tokio::spawn(crate::live::websocket::run(
                    token,
                    self.ws_generation,
                    cancel,
                    events.clone(),
                ));
            }
            Ok(reply) => {
                let balances = if let crate::live::transport::Reply::Sync { balances, .. } = &reply
                {
                    Some(balances.clone())
                } else {
                    None
                };
                match self
                    .live
                    .handle_reply(&self.db, &finished.operation, reply, now())
                {
                    Ok(next) => {
                        self.pending = next;
                        for r in Self::operation_resources(&finished.operation) {
                            self.refresh.finished(*r, now(), true);
                        }
                        if let Some(balances) = balances {
                            self.saved.balances = balances;
                            self.saved.balances_fingerprint = Some(finished.fingerprint);
                            self.saved.balances_updated_at = Some(now());
                            self.saved.balances_error = None;
                            self.save()?;
                        }
                        if matches!(
                            finished.operation,
                            crate::live::transport::Operation::Order(_)
                        ) {
                            self.session.lock().unwrap().invalidate_orders();
                            self.refresh.request(Resource::Balances);
                            self.refresh.request(Resource::Orders);
                        }
                    }
                    Err(error) => {
                        // Persisted state failures are fatal. Exchange-data validation
                        // failures stay visible in the UI and retry with backoff.
                        if error.downcast_ref::<rusqlite::Error>().is_some() {
                            return Err(error);
                        }
                        for r in Self::operation_resources(&finished.operation) {
                            self.refresh.finished(*r, now(), false);
                        }
                        self.live.failed(
                            &self.db,
                            &finished.operation,
                            &error.to_string(),
                            now(),
                        )?;
                    }
                }
            }
            Err(reason) => {
                for r in Self::operation_resources(&finished.operation) {
                    self.refresh.finished(*r, now(), false);
                }
                self.live
                    .failed(&self.db, &finished.operation, &reason, now())?;
            }
        }
        Ok(())
    }
    fn disconnect_ws(&mut self) {
        if let Some(flag) = self.ws_cancelled.take() {
            flag.store(true, Ordering::SeqCst);
        }
        self.ws_generation = self.ws_generation.wrapping_add(1);
        self.live.ws_state = "Disconnected".into();
    }
    pub fn websocket(&mut self, update: crate::live::websocket::Update) -> Result<()> {
        if update.generation != self.ws_generation {
            return Ok(());
        }
        match update.event {
            crate::live::websocket::Event::Connected => {
                self.session.lock().unwrap().invalidate_orders();
                self.live.ws_state = "Connected".into();
                self.live.ws_at = Some(now());
                self.live.ws_failures = 0;
                self.live.rest_due = 0;
            }
            crate::live::websocket::Event::Trades(trades) => {
                if !trades.is_empty() {
                    self.session.lock().unwrap().invalidate_orders();
                }
                self.live.ws_at = Some(now());
                for (id, value) in trades {
                    self.live.ws_trade(&self.db, &id, &value, now())?;
                }
            }
            crate::live::websocket::Event::Disconnected => {
                self.ws_cancelled = None;
                self.live.ws_disconnected(now());
            }
        }
        Ok(())
    }
    pub fn snapshot(&self, vault: &Vault) -> Result<Snapshot> {
        let fingerprint = vault.fingerprint();
        let status = self
            .saved
            .check
            .as_ref()
            .filter(|check| fingerprint.as_deref() == Some(&check.fingerprint))
            .map(|check| check.status.clone())
            .unwrap_or(KeyStatus {
                label: "Kraken".into(),
                saved: fingerprint.is_some(),
                checked_at: None,
                permissions: vec![],
                account_id: None,
                error: None,
            });
        let keys = vec![status];
        let visible = fingerprint.is_some() && fingerprint == self.saved.wallets_fingerprint;
        let balances_visible =
            fingerprint.is_some() && fingerprint == self.saved.balances_fingerprint;
        let live_visible = vault.is_unlocked()
            && fingerprint
                .as_deref()
                .is_some_and(|f| self.live.matches_key(f));
        let live = if live_visible {
            self.live.status(&self.db)?
        } else {
            Default::default()
        };
        let activity = self
            .db
            .prepare("SELECT at,message FROM activity ORDER BY id DESC LIMIT 100")?
            .query_map([], |r| {
                Ok(Activity {
                    at: r.get(0)?,
                    message: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Snapshot {
            protocol_version: crate::PROTOCOL_VERSION,
            version: env!("CARGO_PKG_VERSION").into(),
            worker_pid: std::process::id(),
            mode: "account".into(),
            account: "Kraken".into(),
            paused: self.live.paused(),
            vault: vault.status(),
            account_status: AccountStatus {
                telegram: crate::notifications::Notifications::status(
                    &self.db,
                    vault.is_unlocked(),
                )?,
                live: live.clone(),
                keys,
                wallets: if visible {
                    self.saved.wallets.clone()
                } else {
                    vec![]
                },
                wallets_updated_at: if visible {
                    self.saved.wallets_updated_at
                } else {
                    None
                },
                sync_error: self.saved.sync_error.clone(),
                balances: if balances_visible {
                    self.saved.balances.clone()
                } else {
                    vec![]
                },
                balances_updated_at: if balances_visible {
                    self.saved.balances_updated_at
                } else {
                    None
                },
                balances_error: self.saved.balances_error.clone(),
                busy: self.cancelled.is_some(),
                refresh: self.refresh_status(vault, now()),
            },
            started_at: self.started_at,
            observed_at: now(),
            plan_digest: live.config_digest.clone().unwrap_or_default(),
            queue_digest: self.live.queue_digest()?,
            assets: vec![],
            fills: if vault.is_unlocked()
                && fingerprint
                    .as_deref()
                    .is_some_and(|f| self.live.matches_key(f))
            {
                live.trades
                    .clone()
                    .into_iter()
                    .map(|f| Fill {
                        id: f.id,
                        asset: f.received_asset,
                        amount: f.received,
                        at: decimal(&f.time)
                            .map(|d| d.trunc().to_string().parse().unwrap_or(0))
                            .unwrap_or(0),
                    })
                    .collect()
            } else {
                vec![]
            },
            withdrawals: if vault.is_unlocked()
                && fingerprint
                    .as_deref()
                    .is_some_and(|f| self.live.matches_key(f))
            {
                live.transfers
                    .clone()
                    .into_iter()
                    .map(|t| Withdrawal {
                        id: t.id,
                        asset: t.asset,
                        amount: t.net,
                        fee: t.fee,
                        destination: t.destination.address,
                        status: t.status,
                        created_at: t.created_at,
                        updated_at: t.updated_at,
                    })
                    .collect()
            } else {
                vec![]
            },
            activity,
            fill_count: if live_visible {
                self.db.query_row(
                    "SELECT COUNT(*) FROM live_records WHERE kind='fill'",
                    [],
                    |r| r.get(0),
                )?
            } else {
                0
            },
            completed_count: if live_visible {
                self.db.query_row("SELECT COUNT(*) FROM live_records WHERE kind='transfer' AND json_extract(payload,'$.status')='complete'",[],|r|r.get(0))?
            } else {
                0
            },
        })
    }
}

impl Drop for Account {
    fn drop(&mut self) {
        self.disconnect_ws();
        if let Some(cancelled) = &self.cancelled {
            cancelled.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{engine::Engine, kraken::Inspection, vault::Secret};
    fn vault(dir: &Path) -> Vault {
        let mut vault = Vault::open(dir).unwrap();
        vault.create(Secret("fixture passphrase".into())).unwrap();
        vault
            .set_credential(
                Secret("fixture-account-key".into()),
                Secret("fixture-secret".into()),
            )
            .unwrap();
        vault
    }
    fn completed(job: Job, identity: &str) -> Finished {
        Finished {
            generation: job.generation,
            fingerprint: job.fingerprint,
            kind: job.kind,
            result: Ok(ReadResult {
                info: Inspection {
                    permissions: vec!["query-funds".into()],
                    account_id: identity.into(),
                },
                wallets: (job.kind == ReadKind::Wallets).then(|| {
                    vec![Wallet {
                        id: "fixture".into(),
                        name: "Wallet".into(),
                        address: "fixture-address".into(),
                        memo: None,
                        assets: vec!["BTC".into()],
                        network: "Bitcoin".into(),
                        verified: true,
                        source: "kraken".into(),
                        rule: None,
                        methods: vec![],
                    }]
                }),
                balances: (job.kind == ReadKind::Balances).then(|| {
                    vec![AccountBalance {
                        asset: "ZUSD".into(),
                        balance: "1000".into(),
                        credit: "0".into(),
                        credit_used: "0".into(),
                        held_for_orders: "200".into(),
                        available_for_trading: Some("800".into()),
                    }]
                }),
            }),
        }
    }
    #[test]
    fn unconfigured_paused_accounts_refresh_all_data_and_recheck_after_restart_and_unlock() {
        use crate::live::transport::{Operation, Reply};
        let dir = tempfile::tempdir().unwrap();
        let mut vault = vault(dir.path());
        let mut account = Account::open(dir.path()).unwrap();
        let at = now();
        assert!(matches!(
            account.next_work(&vault, at).unwrap(),
            Some(Work::Read(ReadKind::Balances))
        ));
        let job = account.begin(&vault, ReadKind::Balances).unwrap();
        assert!(
            account.next_work(&vault, at).unwrap().is_none(),
            "private requests must remain serialized"
        );
        account.finish(completed(job, "one"), &vault).unwrap();
        assert!(matches!(
            account.next_work(&vault, at).unwrap(),
            Some(Work::Live(op)) if matches!(*op, Operation::Orders)
        ));
        account
            .live
            .bind(&account.db, &vault.fingerprint().unwrap())
            .unwrap();
        let job = account.begin(&vault, ReadKind::Key).unwrap();
        let (events, _) = tokio::sync::mpsc::channel(1);
        account
            .finish_live(
                LiveFinished {
                    generation: job.generation,
                    fingerprint: job.fingerprint,
                    operation: Operation::Orders,
                    result: Ok(Reply::Orders(vec![])),
                },
                &vault,
                &events,
            )
            .unwrap();
        assert!(matches!(
            account.next_work(&vault, at).unwrap(),
            Some(Work::Read(ReadKind::Wallets))
        ));
        let job = account.begin(&vault, ReadKind::Wallets).unwrap();
        account.finish(completed(job, "one"), &vault).unwrap();
        assert!(account.next_work(&vault, at).unwrap().is_none());
        let state = account.snapshot(&vault).unwrap();
        assert!(state.paused && state.account_status.live.config.is_none());
        assert!(state.fills.is_empty() && state.withdrawals.is_empty());
        assert!(!state.account_status.refresh.balances.stale);
        assert!(!state.account_status.refresh.orders.stale);
        assert!(!state.account_status.refresh.wallets.stale);
        account.pause().unwrap();
        assert!(matches!(
            account.next_work(&vault, at + 31).unwrap(),
            Some(Work::Read(ReadKind::Balances))
        ));
        drop(account);
        let mut account = Account::open(dir.path()).unwrap();
        assert!(
            account
                .snapshot(&vault)
                .unwrap()
                .account_status
                .refresh
                .balances
                .stale
        );
        assert!(matches!(
            account.next_work(&vault, at).unwrap(),
            Some(Work::Read(ReadKind::Balances))
        ));
        account.invalidate(false).unwrap();
        vault.lock();
        assert!(account.next_work(&vault, at + 600).unwrap().is_none());
        assert!(
            !account
                .snapshot(&vault)
                .unwrap()
                .account_status
                .refresh
                .balances
                .enabled
        );
        vault.unlock(Secret("fixture passphrase".into())).unwrap();
        assert!(matches!(
            account.next_work(&vault, at).unwrap(),
            Some(Work::Read(ReadKind::Balances))
        ));
    }

    #[test]
    fn stale_data_blocks_new_order_risk_and_rule_edits_but_not_idempotent_receipts_or_cancel() {
        use crate::live::{OrderCommand, tests as fixture};
        let dir = tempfile::tempdir().unwrap();
        let vault = vault(dir.path());
        let mut account = Account::open(dir.path()).unwrap();
        let order: OrderCommand = serde_json::from_value(serde_json::json!({
            "request_id":"fixture-new", "account":"main",
            "order":{"action":"place","pair":"BTC/USDC","side":"buy","order_type":"limit","volume":"0.1","price":"100"}
        })).unwrap();
        assert!(
            account
                .submit_order(&vault, order.clone(), &order.digest().unwrap(), "main")
                .unwrap_err()
                .to_string()
                .contains("stale")
        );
        assert!(
            account
                .live
                .status(&account.db)
                .unwrap()
                .order_receipts
                .is_empty()
        );
        let config = fixture::config();
        account.saved.wallets = vec![fixture::wallet()];
        account.saved.wallets_fingerprint = vault.fingerprint();
        account.saved.wallets_updated_at = Some(now());
        assert!(
            account
                .configure(&vault, config.clone(), &config.digest().unwrap(), "main")
                .unwrap_err()
                .to_string()
                .contains("stale")
        );
        account.prepare_refresh(&vault).unwrap();
        account.refresh.finished(Resource::Wallets, now(), true);
        // A read started during editing does not discard the completed form.
        let job = account.begin(&vault, ReadKind::Balances).unwrap();
        account
            .configure(&vault, config.clone(), &config.digest().unwrap(), "main")
            .unwrap();
        account.finish(completed(job, "one"), &vault).unwrap();
        assert!(
            account.saved.balances.is_empty(),
            "cancelled read must not publish a stale result"
        );
        assert!(account.live.paused());
        let cancel: OrderCommand = serde_json::from_value(serde_json::json!({
            "request_id":"fixture-cancel", "account":"main",
            "order":{"action":"cancel","order_id":"fixture-order"}
        }))
        .unwrap();
        account
            .submit_order(&vault, cancel.clone(), &cancel.digest().unwrap(), "main")
            .unwrap();
        account
            .submit_order(&vault, cancel.clone(), &cancel.digest().unwrap(), "main")
            .unwrap();
        assert!(
            account.pending.is_some(),
            "receipt lookup must retain the original pending request"
        );
        assert_eq!(
            account
                .live
                .status(&account.db)
                .unwrap()
                .order_receipts
                .len(),
            1
        );
    }

    #[test]
    fn reconciliation_refreshes_account_caches_without_duplicate_polls_or_skipping_wallets() {
        use crate::live::{
            tests as fixture,
            transport::{Operation, Reply},
        };
        let dir = tempfile::tempdir().unwrap();
        let vault = vault(dir.path());
        let mut account = Account::open(dir.path()).unwrap();
        let at = now();
        let mut config = fixture::config();
        config.websocket = false;
        account
            .live
            .configure(
                &account.db,
                config.clone(),
                &config.digest().unwrap(),
                "main",
                &vault.fingerprint().unwrap(),
                &[fixture::wallet()],
                at,
            )
            .unwrap();
        // A due reconciliation must satisfy the initial balance/order refresh,
        // without dispatching a redundant standalone BalanceEx first.
        let Some(Work::Live(op)) = account.next_work(&vault, at).unwrap() else {
            panic!("automation was starved by reads");
        };
        assert!(matches!(*op, Operation::Reconcile { .. }));
        let job = account.begin(&vault, ReadKind::Key).unwrap();
        let (events, _) = tokio::sync::mpsc::channel(1);
        account
            .finish_live(
                LiveFinished {
                    generation: job.generation,
                    fingerprint: job.fingerprint,
                    operation: *op,
                    result: Ok(Reply::Sync {
                        trades: vec![],
                        balances: vec![fixture::balance("BTC", "3", "0")],
                        accounting_balances: vec![fixture::balance("BTC", "3", "0")],
                        orders: vec![],
                        end: at,
                    }),
                },
                &vault,
                &events,
            )
            .unwrap();
        let fresh = account.snapshot(&vault).unwrap().account_status.refresh;
        assert!(!fresh.balances.stale && !fresh.orders.stale);
        assert!(matches!(
            account.next_work(&vault, at).unwrap(),
            Some(Work::Read(ReadKind::Wallets))
        ));
        let job = account.begin(&vault, ReadKind::Wallets).unwrap();
        account.finish(completed(job, "one"), &vault).unwrap();
        assert!(
            account.next_work(&vault, at).unwrap().is_none(),
            "reconciliation should satisfy scheduled balance/order refreshes"
        );
        account.refresh.request(Resource::Balances);
        let command = serde_json::from_value(serde_json::json!({
            "request_id":"priority", "account":"main", "order":{"action":"cancel","order_id":"fixture"}
        })).unwrap();
        account.pending = Some(Operation::Order(command));
        assert!(
            matches!(account.next_work(&vault, at).unwrap(), Some(Work::Live(op)) if matches!(*op, Operation::Order(_))),
            "already recorded write must take priority over account reads"
        );
    }

    #[test]
    fn manual_refreshes_queue_and_coalesce_while_background_reads_run() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault(dir.path());
        let mut account = Account::open(dir.path()).unwrap();
        account.prepare_refresh(&vault).unwrap();
        let job = account.begin(&vault, ReadKind::Balances).unwrap();
        account.refresh.started(Resource::Balances);
        for _ in 0..3 {
            account.request_read(&vault, ReadKind::Wallets).unwrap();
            account.request_read(&vault, ReadKind::Balances).unwrap();
        }
        assert!(
            account
                .snapshot(&vault)
                .unwrap()
                .account_status
                .refresh
                .wallets
                .refreshing
        );
        assert!(account.next_work(&vault, now()).unwrap().is_none());
        account.finish(completed(job, "one"), &vault).unwrap();
        assert!(matches!(
            account.next_work(&vault, now()).unwrap(),
            Some(Work::Read(ReadKind::Wallets))
        ));
        let job = account.begin(&vault, ReadKind::Wallets).unwrap();
        account.finish(completed(job, "one"), &vault).unwrap();
        assert!(
            !account
                .snapshot(&vault)
                .unwrap()
                .account_status
                .refresh
                .wallets
                .refreshing
        );
        assert!(matches!(
            account.next_work(&vault, now()).unwrap(),
            Some(Work::Live(op)) if matches!(*op, crate::live::transport::Operation::Orders)
        ));
    }

    #[test]
    fn locking_or_replacing_credentials_discards_inflight_results_and_hides_cached_wallets() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = vault(dir.path());
        let mut account = Account::open(dir.path()).unwrap();
        let job = account.begin(&vault, ReadKind::Wallets).unwrap();
        assert!(account.begin(&vault, ReadKind::Key).is_err());
        let cancel = job.cancelled.clone();
        account.invalidate(false).unwrap();
        vault.lock();
        assert!(cancel.load(Ordering::Relaxed));
        account.finish(completed(job, "one"), &vault).unwrap();
        assert!(
            account
                .snapshot(&vault)
                .unwrap()
                .account_status
                .wallets
                .is_empty()
        );
        vault.unlock(Secret("fixture passphrase".into())).unwrap();
        let job = account.begin(&vault, ReadKind::Wallets).unwrap();
        account.finish(completed(job, "one"), &vault).unwrap();
        assert_eq!(
            account
                .snapshot(&vault)
                .unwrap()
                .account_status
                .wallets
                .len(),
            1
        );
        vault.lock();
        assert!(
            account
                .snapshot(&vault)
                .unwrap()
                .account_status
                .wallets
                .is_empty()
        );
        vault.unlock(Secret("fixture passphrase".into())).unwrap();
        // Simulate a crash after saving a replaced secret but before invalidating
        // the cache. Fingerprints must bind both key and secret across restart.
        vault
            .set_credential(
                Secret("fixture-account-key".into()),
                Secret("replacement".into()),
            )
            .unwrap();
        drop(account);
        let account = Account::open(dir.path()).unwrap();
        let state = account.snapshot(&vault).unwrap().account_status;
        assert!(state.wallets.is_empty());
        assert!(state.keys[0].saved && state.keys[0].checked_at.is_none());
    }
    #[test]
    fn failed_sync_preserves_wallets_and_nonces_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault(dir.path());
        let mut account = Account::open(dir.path()).unwrap();
        let job = account.begin(&vault, ReadKind::Wallets).unwrap();
        account.finish(completed(job, "one"), &vault).unwrap();
        let job = account.begin(&vault, ReadKind::Wallets).unwrap();
        let nonce = job.nonce;
        let mut failed = completed(job, "one");
        failed.result = Err("offline".into());
        account.finish(failed, &vault).unwrap();
        let state = account.snapshot(&vault).unwrap().account_status;
        assert_eq!(state.wallets.len(), 1);
        assert_eq!(state.sync_error.as_deref(), Some("offline"));
        drop(account);
        let mut account = Account::open(dir.path()).unwrap();
        let job = account.begin(&vault, ReadKind::Key).unwrap();
        assert!(job.nonce > nonce + 26);
        let cancel = job.cancelled.clone();
        drop(account);
        assert!(cancel.load(Ordering::Relaxed));
    }
    #[test]
    fn balances_preserve_freshness_on_failure_hide_when_locked_and_discard_replaced_key_results() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = vault(dir.path());
        let mut account = Account::open(dir.path()).unwrap();
        let job = account.begin(&vault, ReadKind::Balances).unwrap();
        account.finish(completed(job, "one"), &vault).unwrap();
        let before = account.snapshot(&vault).unwrap().account_status;
        assert_eq!(
            before.balances[0].available_for_trading.as_deref(),
            Some("800")
        );
        assert!(before.wallets.is_empty());
        drop(account);
        let mut account = Account::open(dir.path()).unwrap();
        let job = account.begin(&vault, ReadKind::Balances).unwrap();
        let mut failed = completed(job, "one");
        failed.result = Err("offline".into());
        account.finish(failed, &vault).unwrap();
        let cached = account.snapshot(&vault).unwrap().account_status;
        assert_eq!(cached.balances, before.balances);
        assert_eq!(cached.balances_updated_at, before.balances_updated_at);
        assert_eq!(cached.balances_error.as_deref(), Some("offline"));
        let job = account.begin(&vault, ReadKind::Balances).unwrap();
        account.invalidate(false).unwrap();
        vault.lock();
        account.finish(completed(job, "one"), &vault).unwrap();
        let locked = account.snapshot(&vault).unwrap().account_status;
        assert!(locked.balances.is_empty() && locked.balances_updated_at.is_none());
        vault.unlock(Secret("fixture passphrase".into())).unwrap();
        let job = account.begin(&vault, ReadKind::Balances).unwrap();
        vault
            .set_credential(
                Secret("replacement-key".into()),
                Secret("replacement-secret".into()),
            )
            .unwrap();
        account.finish(completed(job, "one"), &vault).unwrap();
        let replaced = account.snapshot(&vault).unwrap().account_status;
        assert!(replaced.balances.is_empty() && replaced.balances_updated_at.is_none());
        account.invalidate(true).unwrap();
        assert!(
            account
                .snapshot(&vault)
                .unwrap()
                .account_status
                .balances_error
                .is_none()
        );
    }

    #[test]
    fn database_mode_mismatch_is_rejected_without_changing_existing_database() {
        for account in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            if account {
                drop(Account::open(dir.path()).unwrap());
            } else {
                drop(Engine::open(dir.path(), 100).unwrap());
            }
            let path = dir.path().join("state.sqlite3");
            let before = std::fs::read(&path).unwrap();
            if account {
                assert!(Engine::open(dir.path(), 100).is_err());
            } else {
                assert!(Account::open(dir.path()).is_err());
            }
            assert_eq!(std::fs::read(path).unwrap(), before);
        }
    }
    #[test]
    fn late_receipt_is_saved_after_lock_and_old_quote_is_discarded_after_pause_resume() {
        use crate::live::{
            tests as fixture,
            transport::{Operation, Reply, Submission},
        };
        let dir = tempfile::tempdir().unwrap();
        let mut vault = vault(dir.path());
        let mut account = Account::open(dir.path()).unwrap();
        let fp = vault.fingerprint().unwrap();
        let config = fixture::config();
        account
            .live
            .configure(
                &account.db,
                config.clone(),
                &config.digest().unwrap(),
                "main",
                &fp,
                &[fixture::wallet()],
                100,
            )
            .unwrap();
        account
            .live
            .sync(
                &account.db,
                vec![fixture::fill("fill", "BTC", "30", "101")],
                &[fixture::balance("BTC", "30", "0")],
                vec![],
                102,
                102,
            )
            .unwrap();
        account.live.resume(&account.db, &fp).unwrap();
        let operation = account
            .live
            .reserve(&account.db, fixture::quote(110), 110)
            .unwrap()
            .unwrap();
        let job = account.begin(&vault, ReadKind::Key).unwrap();
        account.invalidate(false).unwrap();
        vault.lock();
        let (events, _) = tokio::sync::mpsc::channel(1);
        account
            .finish_live(
                LiveFinished {
                    generation: job.generation,
                    fingerprint: job.fingerprint,
                    operation,
                    result: Ok(Reply::Submitted(Submission::Accepted {
                        exchange_id: "confirmed-ref".into(),
                        held: false,
                    })),
                },
                &vault,
                &events,
            )
            .unwrap();
        assert_eq!(
            account.live.status(&account.db).unwrap().transfers[0]
                .exchange_id
                .as_deref(),
            Some("confirmed-ref")
        );
        assert!(
            account
                .snapshot(&vault)
                .unwrap()
                .account_status
                .live
                .transfers
                .is_empty()
        );
        vault.unlock(Secret("fixture passphrase".into())).unwrap();
        let job = account.begin(&vault, ReadKind::Key).unwrap();
        account.pause().unwrap();
        account.live.resume(&account.db, &fp).unwrap();
        account
            .finish_live(
                LiveFinished {
                    generation: job.generation,
                    fingerprint: job.fingerprint,
                    operation: Operation::Quote {
                        rule: fixture::config().rules[0].clone(),
                        destination: fixture::destination(),
                        queued: "20".into(),
                    },
                    result: Ok(Reply::Quote(fixture::quote(now()))),
                },
                &vault,
                &events,
            )
            .unwrap();
        assert!(account.pending.is_none());
        assert_eq!(account.live.status(&account.db).unwrap().transfers.len(), 1);
    }
}

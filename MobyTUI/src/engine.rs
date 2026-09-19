use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{model::*, storage as db};

pub struct Engine {
    connection: Connection,
    started_at: i64,
}

impl Engine {
    pub fn open(directory: &std::path::Path, at: i64) -> Result<Self> {
        let connection = db::open(directory)?;
        // A persisted intent without a receipt must never be retried automatically.
        let tx = connection.unchecked_transaction()?;
        if db::get(&tx, "withdrawal_cooldown")?.is_none() {
            let plan = db::plan(&tx)?;
            let mut timer: Option<WithdrawalCooldown> = None;
            for rule in &plan.rules {
                let (_, _, at) = db::funds(&tx, &rule.asset)?;
                if at > 0 {
                    let candidate = WithdrawalCooldown::new(&rule.asset, at, plan.cooldown_seconds);
                    if timer.as_ref().is_none_or(|old| candidate.until > old.until) {
                        timer = Some(candidate);
                    }
                }
            }
            if let Some(timer) = timer {
                db::set(&tx, "withdrawal_cooldown", &serde_json::to_string(&timer)?)?;
            }
        }
        let recovered = tx.execute(
            "UPDATE withdrawals SET status='unknown',updated_at=?1 WHERE status='submitted'",
            [at],
        )?;
        if recovered > 0 {
            db::event(
                &tx,
                at,
                "Interrupted submissions need review; automatic retries are blocked",
            )?;
        }
        db::event(
            &tx,
            at,
            "Demo worker started. No exchange connection or real funds.",
        )?;
        db::bump_revision(&tx)?;
        tx.commit()?;
        Ok(Self {
            connection,
            started_at: at,
        })
    }

    pub fn handle(&mut self, request: Request, at: i64) -> Result<Response> {
        if matches!(request, Request::Status) {
            return Ok(Response {
                ok: true,
                message: "Current worker state".into(),
                state: Some(self.snapshot(at)?),
            });
        }
        let tx = self.connection.transaction()?;
        let plan = db::plan(&tx)?;
        let message = match request {
            Request::Status => unreachable!(),
            Request::CheckKey
            | Request::RemoveKey
            | Request::RefreshWallets
            | Request::RefreshBalances
            | Request::RefreshOrders
            | Request::ConfigureWatch { .. }
            | Request::SetCooldown { .. }
            | Request::SubmitOrder { .. }
            | Request::AttachWithdrawalReceipt { .. }
            | Request::ResolveWithdrawalNotSent { .. }
            | Request::SetTelegram { .. }
            | Request::EnableTelegram { .. }
            | Request::TestTelegram
            | Request::Stop
            | Request::VaultCreate { .. }
            | Request::VaultUnlock { .. }
            | Request::VaultLock
            | Request::SetKey { .. } => bail!("worker control requires IPC"),
            Request::Pause => {
                db::set(&tx, "paused", "true")?;
                "Withdrawals paused; fills continue to accumulate".to_string()
            }
            Request::Resume => {
                reconcile(&tx, &plan, at)?;
                db::set(&tx, "paused", "false")?;
                "Demo withdrawals resumed after checking simulated balances".to_string()
            }
            Request::ApplyPlan {
                plan: replacement,
                digest,
            } => {
                replacement.validate()?;
                ensure!(
                    replacement.digest()? == digest,
                    "plan changed since review; validate it again"
                );
                ensure!(db::paused(&tx)?, "pause before replacing a plan");
                ensure!(
                    !db::active(&tx, None)?,
                    "wait for or resolve active withdrawals before replacing a plan"
                );
                for rule in &plan.rules {
                    if !replacement.rules.iter().any(|r| r.asset == rule.asset) {
                        ensure!(
                            db::funds(&tx, &rule.asset)?.0 == Decimal::ZERO,
                            "{} still has queued funds; clear the queue before removing its rule",
                            rule.asset
                        );
                    }
                }
                for rule in &replacement.rules {
                    tx.execute(
                        "INSERT OR IGNORE INTO amounts(asset,queued,spendable) VALUES(?1,'0','0')",
                        [&rule.asset],
                    )?;
                }
                if let Some(mut timer) = withdrawal_cooldown(&tx)? {
                    timer.until = timer
                        .started_at
                        .saturating_add(replacement.cooldown_seconds as i64);
                    db::set(&tx, "withdrawal_cooldown", &serde_json::to_string(&timer)?)?;
                }
                db::set(&tx, "plan", &serde_json::to_string(&replacement)?)?;
                format!("Reviewed demo plan applied ({digest}); withdrawals remain paused")
            }
            Request::DemoFill {
                id,
                asset,
                amount: value,
            } => {
                text(&id, "fill ID")?;
                ensure!(
                    plan.rules.iter().any(|r| r.asset == asset),
                    "no rule for asset {asset}"
                );
                let value = positive(&value)?;
                let previous: Option<(String, String)> = tx
                    .query_row("SELECT asset,amount FROM fills WHERE id=?1", [&id], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .optional()?;
                if let Some((old_asset, old_amount)) = previous {
                    ensure!(
                        old_asset == asset && decimal(&old_amount)? == value,
                        "fill ID already exists with different contents"
                    );
                    format!("Fill {id} already recorded; no funds added twice")
                } else {
                    let (queue, balance, _) = db::funds(&tx, &asset)?;
                    db::set_funds(&tx, &asset, add(queue, value)?, add(balance, value)?)?;
                    tx.execute(
                        "INSERT INTO fills(id,asset,amount,at) VALUES(?1,?2,?3,?4)",
                        params![id, asset, value.normalize().to_string(), at],
                    )?;
                    format!("Simulated fill {id}: received {value} {asset} net of trading fees")
                }
            }
            Request::DemoBalance {
                asset,
                amount: value,
            } => {
                ensure!(
                    plan.rules.iter().any(|r| r.asset == asset),
                    "no rule for asset {asset}"
                );
                let value = amount(&value)?;
                let (queue, _, _) = db::funds(&tx, &asset)?;
                db::set_funds(&tx, &asset, queue, value)?;
                format!("Simulated spendable {asset} balance set to {value}")
            }
            Request::DemoOutcome { outcome } => {
                db::set(
                    &tx,
                    "next_outcome",
                    match outcome {
                        Outcome::Complete => "complete",
                        Outcome::Held => "held",
                        Outcome::Unknown => "unknown",
                        Outcome::Rejected => "rejected",
                    },
                )?;
                format!("Next simulated withdrawal outcome: {outcome:?}")
            }
            Request::DemoResolve { id, resolution } => {
                let job = withdrawal(&tx, &id)?;
                ensure!(
                    matches!(job.status.as_str(), "unknown" | "held"),
                    "only held or unknown simulated withdrawals can be resolved"
                );
                match resolution {
                    Resolution::Complete => {
                        tx.execute(
                            "UPDATE withdrawals SET status='complete',updated_at=?2 WHERE id=?1",
                            params![id, at],
                        )?;
                    }
                    Resolution::NotSent => {
                        release(&tx, &job, at)?;
                    }
                }
                format!("Simulated withdrawal {id} resolved: {resolution:?}")
            }
            Request::ClearQueue { digest } => {
                ensure!(db::paused(&tx)?, "pause before clearing queued funds");
                ensure!(
                    !db::active(&tx, None)?,
                    "active withdrawals must settle or be reviewed first"
                );
                ensure!(
                    queue_digest(&tx)? == digest,
                    "queue changed since review; fetch status again"
                );
                tx.execute("UPDATE amounts SET queued='0'", [])?;
                "Queued amounts cleared; fill history and balances retained".to_string()
            }
        };
        db::event(&tx, at, &message)?;
        db::bump_revision(&tx)?;
        tx.commit()?;
        Ok(Response {
            ok: true,
            message,
            state: Some(self.snapshot(at)?),
        })
    }

    pub fn tick(&mut self, at: i64) -> Result<()> {
        self.tick_with_submission(at, true)
    }

    pub fn tick_with_submission(&mut self, at: i64, allow_submission: bool) -> Result<()> {
        let tx = self.connection.transaction()?;
        let plan = db::plan(&tx)?;
        let mut changed = false;
        let completed: Vec<String> = tx
            .prepare("SELECT id FROM withdrawals WHERE status='pending' AND created_at <= ?1")?
            .query_map([at - 3], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for id in completed {
            tx.execute(
                "UPDATE withdrawals SET status='complete',updated_at=?2 WHERE id=?1",
                params![id, at],
            )?;
            db::event(&tx, at, &format!("Simulated withdrawal {id} completed"))?;
            changed = true;
        }
        if allow_submission && !db::paused(&tx)? {
            changed |= reconcile(&tx, &plan, at)?;
            let cooldown = withdrawal_cooldown(&tx)?;
            let start = cooldown
                .as_ref()
                .and_then(|timer| plan.rules.iter().position(|rule| rule.asset == timer.asset))
                .map(|index| index + 1)
                .unwrap_or(0);
            for offset in 0..plan.rules.len() {
                if cooldown
                    .as_ref()
                    .is_some_and(|timer| timer.remaining(at) > 0)
                {
                    break;
                }
                let rule = &plan.rules[(start + offset) % plan.rules.len()];
                let in_flight: u64 = tx.query_row("SELECT COUNT(*) FROM withdrawals WHERE status IN ('submitted','pending','held','unknown')", [], |r| r.get(0))?;
                if in_flight >= 2 {
                    break;
                }
                if db::active(&tx, Some(&rule.asset))? {
                    continue;
                }
                let (queue, balance, _) = db::funds(&tx, &rule.asset)?;
                let fee = amount(&rule.fee)?;
                let spendable = subtract(balance, amount(&rule.reserve)?)?.max(Decimal::ZERO);
                let net = subtract(queue.min(spendable), fee)?
                    .max(Decimal::ZERO)
                    .min(amount(&rule.chunk)?);
                if net < amount(&rule.minimum)? {
                    continue;
                }
                let total = add(net, fee)?;
                let id = Uuid::new_v4().to_string();
                let outcome = db::get(&tx, "next_outcome")?.context("missing demo outcome")?;
                let status = match outcome.as_str() {
                    "complete" => "pending",
                    "held" => "held",
                    "unknown" => "unknown",
                    "rejected" => "failed",
                    _ => bail!("invalid saved demo outcome"),
                };
                // Reserve before submission. The demo makes no network request. A future
                // exchange adapter must commit an intent before making a money-moving call.
                if status != "failed" {
                    db::set_funds(
                        &tx,
                        &rule.asset,
                        subtract(queue, total)?,
                        subtract(balance, total)?,
                    )?;
                }
                tx.execute("INSERT INTO withdrawals(id,asset,amount,fee,destination,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
                    params![id,rule.asset,net.normalize().to_string(),fee.normalize().to_string(),rule.destination,status,at])?;
                tx.execute(
                    "UPDATE amounts SET last_submission=?2 WHERE asset=?1",
                    params![rule.asset, at],
                )?;
                db::set(&tx, "next_outcome", "complete")?;
                let timer = WithdrawalCooldown::new(&rule.asset, at, plan.cooldown_seconds);
                db::set(&tx, "withdrawal_cooldown", &serde_json::to_string(&timer)?)?;
                db::event(
                    &tx,
                    at,
                    &format!(
                        "Simulated {net} {} → {}: {status} (fee {fee})",
                        rule.asset, rule.destination
                    ),
                )?;
                changed = true;
                break; // Every asset shares the newly started timer.
            }
        }
        if changed {
            db::bump_revision(&tx)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn snapshot(&self, at: i64) -> Result<Snapshot> {
        let connection = &self.connection;
        let plan = db::plan(connection)?;
        let paused = db::paused(connection)?;
        let cooldown = withdrawal_cooldown(connection)?;
        let mut assets = Vec::new();
        for rule in &plan.rules {
            let (queue, balance, _) = db::funds(connection, &rule.asset)?;
            let active: Option<String> = connection.query_row("SELECT status FROM withdrawals WHERE asset=?1 AND status IN ('submitted','pending','held','unknown') LIMIT 1", [&rule.asset], |r| r.get(0)).optional()?;
            let blocked = if let Some(state) = active {
                Some(format!("{state} withdrawal"))
            } else if paused {
                Some("Paused".into())
            } else if let Some(timer) = cooldown.as_ref().filter(|timer| timer.remaining(at) > 0) {
                Some(format!(
                    "Account cooldown: {}s after {}",
                    timer.remaining(at),
                    timer.asset
                ))
            } else if queue < add(amount(&rule.minimum)?, amount(&rule.fee)?)? {
                Some("Waiting for fills / minimum".into())
            } else if balance
                < add(
                    add(amount(&rule.reserve)?, amount(&rule.minimum)?)?,
                    amount(&rule.fee)?,
                )?
            {
                Some("Balance / reserve".into())
            } else {
                None
            };
            assets.push(AssetStatus {
                rule: rule.clone(),
                queued: queue.normalize().to_string(),
                spendable: balance.normalize().to_string(),
                blocked,
            });
        }
        let fills = connection
            .prepare("SELECT id,asset,amount,at FROM fills ORDER BY at DESC,rowid DESC LIMIT 100")?
            .query_map([], |r| {
                Ok(Fill {
                    id: r.get(0)?,
                    asset: r.get(1)?,
                    amount: r.get(2)?,
                    at: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        // Active jobs stay visible even after many newer completions.
        let withdrawals = connection.prepare("SELECT id,asset,amount,fee,destination,status,created_at,updated_at FROM withdrawals ORDER BY CASE WHEN status IN ('submitted','pending','held','unknown') THEN 0 ELSE 1 END, created_at DESC,rowid DESC LIMIT 100")?
            .query_map([], job_row)?.collect::<rusqlite::Result<_>>()?;
        let activity = connection
            .prepare("SELECT at,message FROM activity ORDER BY id DESC LIMIT 100")?
            .query_map([], |r| {
                Ok(Activity {
                    at: r.get(0)?,
                    message: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Snapshot {
            protocol_version: 1,
            version: env!("CARGO_PKG_VERSION").into(),
            worker_pid: std::process::id(),
            mode: "demo".into(),
            account: "demo".into(),
            paused,
            withdrawal_cooldown: cooldown,
            withdrawal_cooldown_seconds: Some(plan.cooldown_seconds),
            vault: Default::default(),
            account_status: Default::default(),
            started_at: self.started_at,
            observed_at: at,
            plan_digest: plan.digest()?,
            queue_digest: queue_digest(connection)?,
            assets,
            fills,
            withdrawals,
            activity,
            fill_count: connection.query_row("SELECT COUNT(*) FROM fills", [], |r| r.get(0))?,
            completed_count: connection.query_row(
                "SELECT COUNT(*) FROM withdrawals WHERE status='complete'",
                [],
                |r| r.get(0),
            )?,
        })
    }
}

fn withdrawal_cooldown(connection: &Connection) -> Result<Option<WithdrawalCooldown>> {
    db::get(connection, "withdrawal_cooldown")?
        .map(|json| serde_json::from_str(&json).map_err(Into::into))
        .transpose()
}

fn queue_digest(connection: &Connection) -> Result<String> {
    let revision = db::get(connection, "revision")?.context("missing revision")?;
    let mut digest = Sha256::new();
    digest.update(revision);
    for pair in connection
        .prepare("SELECT asset,queued FROM amounts ORDER BY asset")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
    {
        digest.update(serde_json::to_vec(&pair?)?);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn job_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Withdrawal> {
    Ok(Withdrawal {
        id: r.get(0)?,
        asset: r.get(1)?,
        amount: r.get(2)?,
        fee: r.get(3)?,
        destination: r.get(4)?,
        status: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

fn withdrawal(connection: &Connection, id: &str) -> Result<Withdrawal> {
    connection.query_row("SELECT id,asset,amount,fee,destination,status,created_at,updated_at FROM withdrawals WHERE id=?1", [id], job_row).optional()?.context("withdrawal not found")
}

fn release(connection: &Connection, job: &Withdrawal, at: i64) -> Result<()> {
    let (queue, balance, _) = db::funds(connection, &job.asset)?;
    let total = add(decimal(&job.amount)?, decimal(&job.fee)?)?;
    db::set_funds(
        connection,
        &job.asset,
        add(queue, total)?,
        add(balance, total)?,
    )?;
    connection.execute(
        "UPDATE withdrawals SET status='failed',updated_at=?2 WHERE id=?1",
        params![job.id, at],
    )?;
    Ok(())
}

fn reconcile(connection: &Connection, plan: &Plan, at: i64) -> Result<bool> {
    let mut changed = false;
    for rule in &plan.rules {
        let (queue, balance, _) = db::funds(connection, &rule.asset)?;
        if queue > balance {
            db::set_funds(connection, &rule.asset, balance, balance)?;
            db::event(
                connection,
                at,
                &format!(
                    "{} queue reduced from {queue} to {balance} after balance check",
                    rule.asset
                ),
            )?;
            changed = true;
        }
    }
    Ok(changed)
}

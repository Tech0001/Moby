use moby_tui::{
    engine::Engine,
    model::{Outcome, Plan, Request, Resolution, Snapshot, amount},
    storage,
};
use tempfile::TempDir;

fn setup() -> (TempDir, Engine) {
    let dir = TempDir::new().unwrap();
    let engine = Engine::open(dir.path(), 1000).unwrap();
    (dir, engine)
}

fn send(engine: &mut Engine, request: Request, at: i64) -> Snapshot {
    engine.handle(request, at).unwrap().state.unwrap()
}

fn fill(id: &str, value: &str) -> Request {
    Request::DemoFill {
        id: id.into(),
        asset: "BTC".into(),
        amount: value.into(),
    }
}

#[test]
fn locked_worker_settles_pending_jobs_without_starting_new_chunks() {
    let (_dir, mut engine) = setup();
    send(&mut engine, fill("before-lock", "0.01"), 1000);
    send(&mut engine, Request::Resume, 1000);
    engine.tick_with_submission(1000, true).unwrap();
    let before = engine.snapshot(1000).unwrap();
    assert_eq!(before.withdrawals.len(), 1);
    engine.tick_with_submission(1010, false).unwrap();
    let locked = engine.snapshot(1010).unwrap();
    assert_eq!(locked.withdrawals.len(), 1);
    assert_eq!(locked.withdrawals[0].status, "complete");
    assert_eq!(locked.assets[0].queued, before.assets[0].queued);
    assert!(!locked.paused); // Locking does not alter the saved pause setting.
    engine.tick_with_submission(1011, true).unwrap();
    assert_eq!(engine.snapshot(1011).unwrap().withdrawals.len(), 2);
}

#[test]
fn exact_amounts_and_duplicate_fills_survive_restart() {
    let (dir, mut engine) = setup();
    send(&mut engine, fill("trade-1", "0.29"), 1001);
    let duplicate = send(&mut engine, fill("trade-1", "0.2900"), 1002);
    assert_eq!(duplicate.fill_count, 1);
    assert_eq!(duplicate.assets[0].queued, "0.29");
    assert!(engine.handle(fill("trade-1", "0.3"), 1003).is_err());
    drop(engine);
    let mut restarted = Engine::open(dir.path(), 1004).unwrap();
    let state = send(&mut restarted, fill("trade-1", "0.29"), 1005);
    assert_eq!(state.assets[0].queued, "0.29");
    assert_eq!(state.assets[0].spendable, "0.29");
    assert!(state.paused);
    assert_eq!(state.fill_count, 1);
}

#[test]
fn overflow_rolls_back_fill_and_balances_together() {
    let (_dir, mut engine) = setup();
    send(
        &mut engine,
        fill("big", "79228162514264337593543950335"),
        1001,
    );
    assert!(engine.handle(fill("overflow", "1"), 1002).is_err());
    assert!(engine.handle(fill("rounded", "0.000001"), 1002).is_err());
    let state = engine.snapshot(1003).unwrap();
    assert_eq!(state.fill_count, 1);
    assert_eq!(state.assets[0].queued, "79228162514264337593543950335");
}

#[test]
fn pause_allows_fills_and_settlement_but_no_new_chunks() {
    let (_dir, mut engine) = setup();
    send(&mut engine, fill("a", "0.01"), 1000);
    engine.tick(1000).unwrap();
    assert!(engine.snapshot(1000).unwrap().withdrawals.is_empty());
    send(&mut engine, Request::Resume, 1000);
    engine.tick(1000).unwrap();
    let running = engine.snapshot(1000).unwrap();
    assert_eq!(running.withdrawals.len(), 1);
    assert_eq!(running.withdrawals[0].amount, "0.001");
    assert_eq!(running.withdrawals[0].fee, "0.00001");
    assert_eq!(running.assets[0].queued, "0.00899");
    send(&mut engine, Request::Pause, 1001);
    send(&mut engine, fill("b", "0.29"), 1001);
    engine.tick(1010).unwrap();
    let state = engine.snapshot(1010).unwrap();
    assert_eq!(state.withdrawals.len(), 1);
    assert_eq!(state.withdrawals[0].status, "complete");
    assert_eq!(state.assets[0].queued, "0.29899");
}

#[test]
fn resume_reduces_queue_after_manual_sale_without_requeuing_history() {
    let (_dir, mut engine) = setup();
    send(&mut engine, fill("sold", "0.29"), 1000);
    send(
        &mut engine,
        Request::DemoBalance {
            asset: "BTC".into(),
            amount: "0.001".into(),
        },
        1001,
    );
    let state = send(&mut engine, Request::Resume, 1002);
    assert_eq!(state.assets[0].queued, "0.001");
    engine.tick(1002).unwrap();
    let state = send(&mut engine, fill("sold", "0.29"), 1003);
    assert_eq!(state.assets[0].queued, "0");
    assert_eq!(state.withdrawals[0].amount, "0.00099");
    assert_eq!(state.fill_count, 1);
}

#[test]
fn unknown_survives_restart_blocks_retry_and_can_be_resolved_once() {
    let (dir, mut engine) = setup();
    send(&mut engine, fill("a", "0.01"), 1000);
    send(
        &mut engine,
        Request::DemoOutcome {
            outcome: Outcome::Unknown,
        },
        1000,
    );
    send(&mut engine, Request::Resume, 1000);
    engine.tick(1000).unwrap();
    let state = engine.snapshot(1000).unwrap();
    let id = state.withdrawals[0].id.clone();
    assert_eq!(state.withdrawals[0].status, "unknown");
    drop(engine);
    let mut engine = Engine::open(dir.path(), 1010).unwrap();
    engine.tick(1020).unwrap();
    assert_eq!(engine.snapshot(1020).unwrap().withdrawals.len(), 1);
    send(&mut engine, Request::Pause, 1020);
    let state = send(
        &mut engine,
        Request::DemoResolve {
            id: id.clone(),
            resolution: Resolution::NotSent,
        },
        1021,
    );
    assert_eq!(state.assets[0].queued, "0.01");
    assert!(
        engine
            .handle(
                Request::DemoResolve {
                    id,
                    resolution: Resolution::NotSent
                },
                1022
            )
            .is_err()
    );
    assert_eq!(engine.snapshot(1022).unwrap().assets[0].queued, "0.01");
}

#[test]
fn held_transfer_consumes_one_slot_and_blocks_only_its_asset() {
    let (_dir, mut engine) = setup();
    send(&mut engine, fill("btc", "0.01"), 1000);
    send(
        &mut engine,
        Request::DemoFill {
            id: "eth".into(),
            asset: "ETH".into(),
            amount: "1".into(),
        },
        1000,
    );
    send(
        &mut engine,
        Request::DemoFill {
            id: "usdc".into(),
            asset: "USDC".into(),
            amount: "1000".into(),
        },
        1000,
    );
    send(
        &mut engine,
        Request::DemoOutcome {
            outcome: Outcome::Held,
        },
        1000,
    );
    send(&mut engine, Request::Resume, 1000);
    engine.tick(1000).unwrap();
    assert_eq!(engine.snapshot(1000).unwrap().withdrawals.len(), 2);
    engine.tick(1003).unwrap();
    let state = engine.snapshot(1003).unwrap();
    assert_eq!(
        state
            .withdrawals
            .iter()
            .filter(|w| w.asset == "BTC")
            .count(),
        1
    );
    assert!(state.withdrawals.iter().any(|w| w.asset == "USDC"));
}

#[test]
fn rejected_submission_does_not_debit_and_respects_cooldown() {
    let (_dir, mut engine) = setup();
    send(&mut engine, fill("a", "0.01"), 1000);
    send(
        &mut engine,
        Request::DemoOutcome {
            outcome: Outcome::Rejected,
        },
        1000,
    );
    send(&mut engine, Request::Resume, 1000);
    engine.tick(1000).unwrap();
    let state = engine.snapshot(1000).unwrap();
    assert_eq!(state.withdrawals[0].status, "failed");
    assert_eq!(state.assets[0].queued, "0.01");
    engine.tick(1001).unwrap();
    assert_eq!(engine.snapshot(1001).unwrap().withdrawals.len(), 1);
    engine.tick(1005).unwrap();
    assert_eq!(engine.snapshot(1005).unwrap().withdrawals.len(), 2);
}

#[test]
fn reserve_fee_minimum_and_chunk_are_enforced_together() {
    let (_dir, mut engine) = setup();
    let mut plan = Plan::demo();
    plan.rules[0].reserve = "0.005".into();
    let digest = plan.digest().unwrap();
    send(&mut engine, Request::ApplyPlan { plan, digest }, 1000);
    send(&mut engine, fill("a", "0.0055"), 1000);
    send(&mut engine, Request::Resume, 1000);
    engine.tick(1000).unwrap();
    let state = engine.snapshot(1000).unwrap();
    assert_eq!(state.withdrawals[0].amount, "0.00049");
    assert_eq!(state.assets[0].spendable, "0.005");
    engine.tick(1010).unwrap();
    assert_eq!(engine.snapshot(1010).unwrap().withdrawals.len(), 1);
}

#[test]
fn plans_require_exact_review_pause_and_no_active_jobs() {
    let (_dir, mut engine) = setup();
    let mut plan = Plan::demo();
    let old_digest = plan.digest().unwrap();
    plan.rules[0].destination = "Different destination".into();
    assert!(
        engine
            .handle(
                Request::ApplyPlan {
                    plan: plan.clone(),
                    digest: old_digest
                },
                1000
            )
            .is_err()
    );
    send(&mut engine, fill("a", "0.01"), 1000);
    send(&mut engine, Request::Resume, 1000);
    assert!(
        engine
            .handle(
                Request::ApplyPlan {
                    digest: plan.digest().unwrap(),
                    plan: plan.clone()
                },
                1000
            )
            .is_err()
    );
    engine.tick(1000).unwrap();
    send(&mut engine, Request::Pause, 1001);
    assert!(
        engine
            .handle(
                Request::ApplyPlan {
                    digest: plan.digest().unwrap(),
                    plan: plan.clone()
                },
                1001
            )
            .is_err()
    );
    engine.tick(1003).unwrap();
    let state = send(
        &mut engine,
        Request::ApplyPlan {
            digest: plan.digest().unwrap(),
            plan,
        },
        1003,
    );
    assert!(state.paused);
}

#[test]
fn clear_rejects_a_stale_preview_and_does_not_forget_seen_fills() {
    let (_dir, mut engine) = setup();
    let before = send(&mut engine, fill("a", "0.29"), 1000);
    let after = send(&mut engine, fill("b", "0.1"), 1001);
    assert!(
        engine
            .handle(
                Request::ClearQueue {
                    digest: before.queue_digest
                },
                1001
            )
            .is_err()
    );
    send(
        &mut engine,
        Request::ClearQueue {
            digest: after.queue_digest,
        },
        1001,
    );
    let state = send(&mut engine, fill("a", "0.29"), 1002);
    assert_eq!(state.assets[0].queued, "0");
    assert_eq!(state.assets[0].spendable, "0.39");
    assert_eq!(state.fill_count, 2);
}

#[test]
fn interrupted_intent_becomes_unknown_on_restart() {
    let (dir, mut engine) = setup();
    send(&mut engine, fill("a", "0.01"), 1000);
    send(&mut engine, Request::Resume, 1000);
    engine.tick(1000).unwrap();
    drop(engine);
    let connection = storage::open(dir.path()).unwrap();
    connection
        .execute("UPDATE withdrawals SET status='submitted'", [])
        .unwrap();
    drop(connection);
    let mut engine = Engine::open(dir.path(), 1010).unwrap();
    engine.tick(1010).unwrap();
    let state = engine.snapshot(1010).unwrap();
    assert_eq!(state.withdrawals.len(), 1);
    assert_eq!(state.withdrawals[0].status, "unknown");
}

#[test]
fn malformed_plans_and_unrepresentable_amounts_are_rejected() {
    for bad in [
        "-1",
        "NaN",
        "inf",
        "1e3",
        "0.0000000000000000001",
        "79228162514264337593543950336",
        "1\u{1b}[31m",
    ] {
        assert!(amount(bad).is_err(), "accepted {bad}");
    }
    let mut plan = Plan::demo();
    plan.rules.push(plan.rules[0].clone());
    assert!(plan.validate().is_err());
    let mut plan = Plan::demo();
    plan.account = "live".into();
    assert!(plan.validate().is_err());
    let mut plan = Plan::demo();
    plan.rules[0].minimum = "9999".into();
    assert!(plan.validate().is_err());
    let mut raw = serde_json::to_value(Plan::demo()).unwrap();
    raw["rules"][0]["chunk"] = serde_json::json!(0.29);
    assert!(serde_json::from_value::<Plan>(raw).is_err());
}

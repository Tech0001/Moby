use super::{
    model::*,
    store::Live,
    transport::{Operation, Quote, Reply, Submission, WithdrawalStatus},
};
use crate::{
    model::{AccountBalance, Wallet, decimal},
    storage,
    vault::Secret,
};
use rusqlite::Connection;
use std::collections::BTreeMap;
const METHOD: &str = "d4ec4d52-b159-428e-ba64-f45455a978a1";
pub(crate) fn destination() -> Destination {
    Destination {
        wallet_id: "ABTEST1-TEST2-TEST33".into(),
        method_id: METHOD.into(),
        address: "fixture-address".into(),
        memo: Some("Tag: 123".into()),
        network: "Fixture network".into(),
    }
}
fn rule(symbol: &str) -> WatchRule {
    WatchRule {
        asset: symbol.into(),
        enabled: true,
        destinations: vec![destination()],
        order_types: ORDER_TYPES.iter().map(|s| s.to_string()).collect(),
        sides: vec!["buy".into(), "sell".into()],
        pairs: vec![],
        order_ids: vec![],
        chunk: "10".into(),
        minimum: "1".into(),
        reserve: "2".into(),
        max_fee: "1".into(),
        max_fee_percent: "10".into(),
        daily_fee_budget: Some("2".into()),
    }
}
#[test]
fn large_wallet_rotations_are_bounded_and_still_reject_duplicates() {
    let mut rule = rule("USDC");
    rule.destinations = (0..64)
        .map(|i| {
            let mut destination = destination();
            destination.wallet_id = format!("wallet-{i}");
            destination
        })
        .collect();
    rule.validate().unwrap();
    rule.destinations.push(destination());
    assert!(rule.validate().err().unwrap().to_string().contains("1–64"));
    rule.destinations.truncate(30);
    rule.validate().unwrap();
    rule.destinations.push(rule.destinations[0].clone());
    assert!(
        rule.validate()
            .err()
            .unwrap()
            .to_string()
            .contains("duplicate destination")
    );
}

pub(crate) fn config() -> Config {
    Config {
        schema_version: 2,
        cooldown_seconds: 60,
        account: "main".into(),
        poll_seconds: 30,
        max_inflight: 2,
        websocket: true,
        rules: vec![rule("BTC"), rule("USDC")],
    }
}
pub(crate) fn wallet() -> Wallet {
    Wallet {
        id: destination().wallet_id,
        name: "Fixture wallet".into(),
        address: destination().address,
        memo: destination().memo,
        assets: vec!["BTC".into(), "USDC".into()],
        network: destination().network,
        verified: true,
        source: "kraken".into(),
        rule: None,
        methods: ["BTC", "USDC"]
            .into_iter()
            .map(|s| FundingMethod {
                id: METHOD.into(),
                asset: s.into(),
                network: destination().network,
                minimum: Some("1".into()),
                maximum: Some("1000".into()),
            })
            .collect(),
    }
}
fn database() -> (tempfile::TempDir, Connection, Live) {
    let dir = tempfile::tempdir().unwrap();
    let db = storage::open_profile(dir.path(), "account").unwrap();
    db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE activity(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,message TEXT NOT NULL);PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;").unwrap();
    storage::set(&db, "mode", "account").unwrap();
    let mut live = Live::open(&db).unwrap();
    let config = config();
    live.configure(
        &db,
        config.clone(),
        &config.digest().unwrap(),
        "main",
        "fixture-key",
        &[wallet()],
        100,
    )
    .unwrap();
    (dir, db, live)
}
pub(crate) fn balance(symbol: &str, total: &str, hold: &str) -> AccountBalance {
    AccountBalance {
        asset: symbol.into(),
        balance: total.into(),
        credit: "0".into(),
        credit_used: "0".into(),
        held_for_orders: hold.into(),
        available_for_trading: Some((decimal(total).unwrap() - decimal(hold).unwrap()).to_string()),
    }
}
pub(crate) fn fill(id: &str, symbol: &str, net: &str, time: &str) -> Trade {
    Trade {
        id: id.into(),
        order_id: "order-one".into(),
        pair: "BTC/USDC".into(),
        side: if symbol == "BTC" { "buy" } else { "sell" }.into(),
        order_type: "market".into(),
        time: time.into(),
        margin: false,
        received_asset: symbol.into(),
        received: net.into(),
        debits: BTreeMap::new(),
    }
}
pub(crate) fn quote(at: i64) -> Quote {
    Quote {
        asset: "BTC".into(),
        destination: destination(),
        gross: "10".into(),
        net: "9".into(),
        fee: "1".into(),
        token: Secret("fixture-quote".into()),
        at,
    }
}
fn queued(live: &Live, db: &Connection, symbol: &str) -> String {
    live.status(db).unwrap().queues[symbol].amount.clone()
}
#[test]
fn unknown_recovery_requires_paused_review_and_refunds_exactly_once_across_restart() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![fill("bought", "BTC", "30", "101")],
        &[balance("BTC", "30", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    live.resume(&db, "fixture-key").unwrap();
    let Operation::Submit { transfer, .. } = live.reserve(&db, quote(110), 110).unwrap().unwrap()
    else {
        panic!()
    };
    live.submitted(
        &db,
        &transfer.id,
        Submission::Unknown("fixture disconnect".into()),
        111,
    )
    .unwrap();
    let t = live.status(&db).unwrap().transfers[0].clone();
    let reviewed = digest(&t).unwrap();
    assert!(
        live.resolve_not_sent(&db, &t.id, &reviewed, true, 231)
            .is_err()
    );
    live.pause(&db).unwrap();
    assert!(
        live.resolve_not_sent(&db, &t.id, &reviewed, true, 229)
            .is_err()
    );
    assert!(
        live.resolve_not_sent(&db, &t.id, "stale digest", true, 231)
            .is_err()
    );
    assert!(
        live.resolve_not_sent(&db, &t.id, &reviewed, false, 231)
            .is_err()
    );
    assert_eq!(queued(&live, &db, "BTC"), "20");
    live.resolve_not_sent(&db, &t.id, &reviewed, true, 231)
        .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "30");
    assert!(live.paused());
    drop(live);
    let mut live = Live::open(&db).unwrap();
    live.resolve_not_sent(&db, &t.id, &reviewed, true, 232)
        .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "30");
    assert_eq!(live.status(&db).unwrap().transfers[0].status, "not_sent");
    // Reconciliation still caps restored credit to actual funds before resuming.
    live.sync(&db, vec![], &[balance("BTC", "4", "0")], vec![], 233, 233)
        .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "4");
}
#[test]
fn receipt_polling_slows_with_age_and_unchanged_pending_does_not_reconcile() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![fill("bought", "BTC", "30", "101")],
        &[balance("BTC", "30", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    live.resume(&db, "fixture-key").unwrap();
    let Operation::Submit { transfer, .. } = live.reserve(&db, quote(110), 110).unwrap().unwrap()
    else {
        panic!()
    };
    live.submitted(
        &db,
        &transfer.id,
        Submission::Accepted {
            exchange_id: "ref".into(),
            held: false,
        },
        110,
    )
    .unwrap();
    for (at, delay) in [(120, 10), (180, 30), (500, 120)] {
        live.rest_due = 9999;
        live.status_due = 0;
        assert!(matches!(
            live.operation(&db, at).unwrap(),
            Some(Operation::Poll { .. })
        ));
        assert_eq!(live.status_due, at + delay);
        live.statuses(
            &db,
            vec![WithdrawalStatus {
                id: "ref".into(),
                asset: "BTC".into(),
                net: "9".into(),
                fee: "1".into(),
                destination: destination().wallet_id,
                method: METHOD.into(),
                status: "pending".into(),
                txid: None,
            }],
            at,
        )
        .unwrap();
        assert_eq!(live.rest_due, 9999);
    }
    live.pause(&db).unwrap();
    let t = live.status(&db).unwrap().transfers[0].clone();
    assert!(
        live.resolve_not_sent(&db, &t.id, &digest(&t).unwrap(), true, 999)
            .is_err(),
        "accepted withdrawals cannot be declared not sent"
    );
}

#[test]
fn cooldown_edit_preserves_queue_fill_boundary_and_shared_timer_across_restart() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![fill("first-order", "BTC", "30", "101")],
        &[balance("BTC", "30", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    let expected = live.status(&db).unwrap().config.unwrap().digest().unwrap();
    live.resume(&db, "fixture-key").unwrap();
    assert!(
        live.set_cooldown(&db, 120, &expected, 109).is_err(),
        "edits require pause"
    );
    let Some(Operation::Submit { transfer, .. }) = live.reserve(&db, quote(110), 110).unwrap()
    else {
        panic!()
    };
    live.submitted(
        &db,
        &transfer.id,
        Submission::Accepted {
            exchange_id: "ref-btc".into(),
            held: false,
        },
        110,
    )
    .unwrap();
    live.pause(&db).unwrap();
    assert!(
        live.set_cooldown(&db, 120, &expected, 111).is_err(),
        "an active withdrawal blocks edits"
    );
    live.statuses(
        &db,
        vec![WithdrawalStatus {
            id: "ref-btc".into(),
            asset: "BTC".into(),
            net: "9".into(),
            fee: "1".into(),
            destination: destination().wallet_id,
            method: METHOD.into(),
            status: "success".into(),
            txid: None,
        }],
        111,
    )
    .unwrap();
    for seconds in [0, 86401] {
        assert!(live.set_cooldown(&db, seconds, &expected, 112).is_err());
    }
    assert!(live.set_cooldown(&db, 120, "stale", 112).is_err());
    let before = live.status(&db).unwrap();
    live.set_cooldown(&db, 120, &expected, 112).unwrap();
    let after = live.status(&db).unwrap();
    assert_eq!(after.config.unwrap().cooldown_seconds, 120);
    assert_eq!(after.queues["BTC"].last_submission, 110);
    assert_eq!(
        after.queues["BTC"].destination_index,
        before.queues["BTC"].destination_index
    );
    assert_eq!(after.caught_up_through, before.caught_up_through);
    assert_eq!(queued(&live, &db, "BTC"), "20");
    assert!(
        live.set_cooldown(&db, 180, &expected, 113).is_err(),
        "old config digest must not overwrite another edit"
    );
    // A delayed fill predating the timing edit still counts, once, into the
    // existing queue. It must not get a new independent withdrawal timer.
    let late = fill("second-order", "BTC", "5", "105");
    for _ in 0..2 {
        live.sync(
            &db,
            vec![late.clone()],
            &[balance("BTC", "25", "0")],
            vec![],
            115,
            115,
        )
        .unwrap();
    }
    assert_eq!(queued(&live, &db, "BTC"), "25");
    drop(live);
    let mut live = Live::open(&db).unwrap();
    assert_eq!(
        live.status(&db).unwrap().config.unwrap().cooldown_seconds,
        120
    );
    live.resume(&db, "fixture-key").unwrap();
    assert!(
        live.reserve(&db, quote(229), 229)
            .err()
            .unwrap()
            .to_string()
            .contains("cooldown")
    );
    assert_eq!(queued(&live, &db, "BTC"), "25");
    assert!(matches!(
        live.reserve(&db, quote(230), 230).unwrap(),
        Some(Operation::Submit { .. })
    ));
    assert!(
        live.reserve(&db, quote(231), 231).is_err(),
        "another order cannot overlap the active send"
    );
}
#[test]
fn fee_budget_does_not_reset_at_utc_midnight() {
    let (_dir, db, mut live) = database();
    let mut c = config();
    c.rules[0].daily_fee_budget = Some("1".into());
    live.configure(
        &db,
        c.clone(),
        &c.digest().unwrap(),
        "main",
        "fixture-key",
        &[wallet()],
        100,
    )
    .unwrap();
    live.sync(
        &db,
        vec![fill("bought", "BTC", "30", "101")],
        &[balance("BTC", "30", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    live.resume(&db, "fixture-key").unwrap();
    let at = 86399;
    let Operation::Submit { transfer, .. } = live.reserve(&db, quote(at), at).unwrap().unwrap()
    else {
        panic!()
    };
    live.submitted(
        &db,
        &transfer.id,
        Submission::Accepted {
            exchange_id: "ref".into(),
            held: false,
        },
        at,
    )
    .unwrap();
    live.statuses(
        &db,
        vec![WithdrawalStatus {
            id: "ref".into(),
            asset: "BTC".into(),
            net: "9".into(),
            fee: "1".into(),
            destination: destination().wallet_id,
            method: METHOD.into(),
            status: "success".into(),
            txid: None,
        }],
        at,
    )
    .unwrap();
    assert!(
        live.reserve(&db, quote(86460), 86460)
            .err()
            .unwrap()
            .to_string()
            .contains("24-hour")
    );
    assert!(
        live.reserve(&db, quote(at + 86400), at + 86400)
            .unwrap()
            .is_some()
    );
}
#[test]
fn filled_orders_chunk_cool_down_rotate_wallets_and_give_other_assets_a_turn() {
    let (_dir, db, mut live) = database();
    let mut c = config();
    c.max_inflight = 2;
    c.cooldown_seconds = 120;
    let mut second = wallet();
    second.id = "second-wallet".into();
    second.address = "second-fixture-address".into();
    let mut dest = destination();
    dest.wallet_id = second.id.clone();
    dest.address = second.address.clone();
    c.rules[0].destinations.push(dest.clone());
    live.configure(
        &db,
        c.clone(),
        &c.digest().unwrap(),
        "main",
        "fixture-key",
        &[wallet(), second],
        100,
    )
    .unwrap();
    live.sync(
        &db,
        vec![
            fill("buy", "BTC", "30", "101"),
            fill("sell", "USDC", "30", "101"),
        ],
        &[balance("BTC", "30", "0"), balance("USDC", "30", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    live.resume(&db, "fixture-key").unwrap();
    for (at, asset) in [(110, "BTC"), (230, "USDC")] {
        live.sync(
            &db,
            vec![],
            &[balance("BTC", "30", "0"), balance("USDC", "30", "0")],
            vec![],
            at,
            at,
        )
        .unwrap();
        live.rest_due = 9999;
        live.token_due = 9999;
        if asset == "USDC" {
            assert!(live.operation(&db, at - 1).unwrap().is_none());
            let mut early = quote(at - 1);
            early.asset = asset.into();
            assert!(
                live.reserve(&db, early, at - 1)
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("account-wide")
            );
        }
        let Some(Operation::Quote { rule, .. }) = live.operation(&db, at).unwrap() else {
            panic!("expected eligible asset")
        };
        assert_eq!(rule.asset, asset);
        let mut q = quote(at);
        q.asset = asset.into();
        let Operation::Submit { transfer, .. } = live.reserve(&db, q, at).unwrap().unwrap() else {
            panic!()
        };
        live.submitted(
            &db,
            &transfer.id,
            Submission::Accepted {
                exchange_id: format!("ref-{asset}"),
                held: false,
            },
            at,
        )
        .unwrap();
        live.statuses(
            &db,
            vec![WithdrawalStatus {
                id: format!("ref-{asset}"),
                asset: asset.into(),
                net: "9".into(),
                fee: "1".into(),
                destination: destination().wallet_id,
                method: METHOD.into(),
                status: "success".into(),
                txid: None,
            }],
            at + 1,
        )
        .unwrap();
    }
    live.rest_due = 9999;
    live.token_due = 9999;
    assert!(
        live.operation(&db, 240).unwrap().is_none(),
        "the shared cooldown also blocks BTC"
    );
    live.sync(
        &db,
        vec![],
        &[balance("BTC", "30", "0"), balance("USDC", "30", "0")],
        vec![],
        349,
        349,
    )
    .unwrap();
    live.rest_due = 9999;
    assert!(live.operation(&db, 349).unwrap().is_none());
    drop(live);
    let mut live = Live::open(&db).unwrap();
    live.resume(&db, "fixture-key").unwrap();
    live.sync(
        &db,
        vec![],
        &[balance("BTC", "30", "0"), balance("USDC", "30", "0")],
        vec![],
        350,
        350,
    )
    .unwrap();
    live.rest_due = 9999;
    live.token_due = 9999;
    let Some(Operation::Quote {
        rule, destination, ..
    }) = live.operation(&db, 350).unwrap()
    else {
        panic!()
    };
    assert_eq!(rule.asset, "BTC");
    assert_eq!(destination, dest);
}

#[test]
fn legacy_rules_migrate_to_one_cooldown_without_losing_queues_or_the_timer() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![
            fill("btc", "BTC", "30", "101"),
            fill("usdc", "USDC", "30", "101"),
        ],
        &[balance("BTC", "30", "0"), balance("USDC", "30", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    let before = live.status(&db).unwrap();
    let mut saved: serde_json::Value =
        serde_json::from_str(&crate::storage::get(&db, "live").unwrap().unwrap()).unwrap();
    saved.as_object_mut().unwrap().remove("cooldown");
    saved["config"]["schema_version"] = 1.into();
    saved["config"]
        .as_object_mut()
        .unwrap()
        .remove("cooldown_seconds");
    for (index, rule) in saved["config"]["rules"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        rule["cooldown_seconds"] = if index == 0 { 60 } else { 120 }.into();
    }
    saved["queues"]["BTC"]["last_submission"] = 110.into();
    saved["queues"]["USDC"]["last_submission"] = 115.into();
    crate::storage::set(&db, "live", &saved.to_string()).unwrap();
    drop(live);
    let mut live = Live::open(&db).unwrap();
    let state = live.status(&db).unwrap();
    assert!(live.paused());
    assert_eq!(state.config.as_ref().unwrap().schema_version, 2);
    assert_eq!(state.config.unwrap().cooldown_seconds, 120);
    assert_eq!(state.caught_up_through, before.caught_up_through);
    assert_eq!(state.monitoring_since, before.monitoring_since);
    assert_eq!(queued(&live, &db, "BTC"), "30");
    assert_eq!(queued(&live, &db, "USDC"), "30");
    assert_eq!(live.cooldown().unwrap().until, 235);
    live.resume(&db, "fixture-key").unwrap();
    assert!(live.reserve(&db, quote(234), 234).is_err());
    assert!(live.reserve(&db, quote(235), 235).unwrap().is_some());
}

#[test]
fn account_cooldown_blocks_other_assets_before_dispatch_and_after_rejection() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![
            fill("btc", "BTC", "30", "101"),
            fill("usdc", "USDC", "30", "101"),
        ],
        &[balance("BTC", "30", "0"), balance("USDC", "30", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    live.resume(&db, "fixture-key").unwrap();
    let Some(Operation::Submit { transfer, .. }) = live.reserve(&db, quote(110), 110).unwrap()
    else {
        panic!()
    };
    for at in [110, 111, 199] {
        let mut next = quote(at);
        next.asset = "USDC".into();
        assert!(live.reserve(&db, next, at).is_err());
    }
    live.submitted(
        &db,
        &transfer.id,
        Submission::Rejected("fixture rejection".into()),
        200,
    )
    .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "30");
    drop(live);
    let mut live = Live::open(&db).unwrap();
    live.resume(&db, "fixture-key").unwrap();
    let mut next = quote(259);
    next.asset = "USDC".into();
    assert!(
        live.reserve(&db, next, 259)
            .err()
            .unwrap()
            .to_string()
            .contains("account-wide")
    );
    let mut next = quote(260);
    next.asset = "USDC".into();
    assert!(matches!(
        live.reserve(&db, next, 260).unwrap(),
        Some(Operation::Submit { .. })
    ));
}
#[test]
fn filters_partial_fills_overlap_restart_and_clear_boundary_never_double_credit() {
    let (_dir, db, mut live) = database();
    let fills = vec![
        fill("old", "BTC", "30", "99.9"),
        fill("part-one", "BTC", "6", "101.1"),
        fill("part-two", "BTC", "4", "101.2"),
    ];
    live.ws_trade(&db, "part-one", &serde_json::json!({"time":"101.1"}), 101)
        .unwrap();
    live.sync(
        &db,
        fills.clone(),
        &[balance("XXBT", "100", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "10");
    assert_eq!(live.status(&db).unwrap().pending_ws_trades, 0);
    drop(live);
    let mut live = Live::open(&db).unwrap();
    assert!(live.paused());
    live.sync(&db, fills, &[balance("XXBT", "100", "0")], vec![], 103, 103)
        .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "10");
    let digest = live.queue_digest().unwrap();
    live.clear(&db, &digest, 104).unwrap();
    live.sync(
        &db,
        vec![fill("late", "BTC", "40", "103.9")],
        &[balance("BTC", "100", "0")],
        vec![],
        105,
        105,
    )
    .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "0");
    assert!(live.clear(&db, &digest, 106).is_err());
}
#[test]
fn ignored_sale_still_debits_queued_asset_and_order_holds_do_not_erase_it() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![fill("bought", "BTC", "20", "101")],
        &[balance("BTC", "20", "19")],
        vec![],
        102,
        102,
    )
    .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "20");
    let mut sale = fill("sold", "USDC", "10", "103");
    sale.order_type = "excluded-type".into();
    sale.debits.insert("BTC".into(), "8".into());
    live.sync(
        &db,
        vec![sale],
        &[balance("BTC", "12", "10"), balance("USDC", "10", "0")],
        vec![],
        104,
        104,
    )
    .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "12");
    assert_eq!(queued(&live, &db, "USDC"), "0");
    live.sync(&db, vec![], &[balance("BTC", "2", "0")], vec![], 105, 105)
        .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "2");
    live.sync(&db, vec![], &[], vec![], 106, 106).unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "0");
}
#[test]
fn websocket_authentication_failure_is_identified_and_preserves_rest_monitoring() {
    let (_dir, db, mut live) = database();
    live.failed(&db, &Operation::Token, "fixture permission denied", 105)
        .unwrap();
    let message: String = db
        .query_row(
            "SELECT message FROM activity ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        message,
        "WebSocket authentication failed: fixture permission denied"
    );
    assert_eq!(live.ws_state, "Disconnected");
    assert!(live.token_due > 105);
    // A failed WebSocket login still schedules REST catch-up while paused.
    assert!(matches!(
        live.operation(&db, 106).unwrap(),
        Some(Operation::Reconcile { .. })
    ));
    assert!(live.status(&db).unwrap().rest_error.is_none());
}

#[test]
fn all_order_types_sides_pairs_and_specific_order_ids_are_configurable() {
    let r = rule("BTC");
    for kind in ORDER_TYPES {
        let mut trade = fill("t", "BTC", "1", "101");
        trade.order_type = (*kind).into();
        assert!(r.matches(&trade));
    }
    let mut r = r;
    r.pairs = vec!["BTC/USD".into()];
    assert!(!r.matches(&fill("t", "BTC", "1", "101")));
    r.pairs.clear();
    r.order_ids = vec!["special".into()];
    assert!(!r.matches(&fill("t", "BTC", "1", "101")));
    r.order_ids.clear();
    r.sides = vec!["sell".into()];
    assert!(!r.matches(&fill("t", "BTC", "1", "101")));
    r.sides = vec!["buy".into()];
    let mut margin = fill("t", "BTC", "1", "101");
    margin.margin = true;
    assert!(!r.matches(&margin));
}
#[test]
fn write_intent_survives_crash_and_unknown_is_never_retried() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![fill("bought", "BTC", "30", "101")],
        &[balance("BTC", "30", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    live.resume(&db, "fixture-key").unwrap();
    let operation = live.reserve(&db, quote(110), 110).unwrap().unwrap();
    let Operation::Submit { transfer, .. } = operation else {
        panic!()
    };
    assert_eq!(queued(&live, &db, "BTC"), "20");
    drop(live);
    let mut live = Live::open(&db).unwrap();
    assert_eq!(live.status(&db).unwrap().transfers[0].status, "unknown");
    live.resume(&db, "fixture-key").unwrap();
    live.sync(&db, vec![], &[balance("BTC", "20", "0")], vec![], 190, 190)
        .unwrap();
    live.rest_due = 1000;
    live.status_due = 1000;
    live.token_due = 1000;
    assert!(live.operation(&db, 200).unwrap().is_none());
    assert!(live.reserve(&db, quote(200), 200).is_err());
    live.attach_receipt(&db, &transfer.id, "exchange-ref")
        .unwrap();
    live.statuses(
        &db,
        vec![WithdrawalStatus {
            id: "exchange-ref".into(),
            asset: "BTC".into(),
            net: "9".into(),
            fee: "1".into(),
            destination: destination().wallet_id,
            method: METHOD.into(),
            status: "success".into(),
            txid: Some("chain-proof".into()),
        }],
        201,
    )
    .unwrap();
    assert_eq!(live.status(&db).unwrap().transfers[0].status, "complete");
    assert_eq!(queued(&live, &db, "BTC"), "20");
}
#[test]
fn paused_and_stale_quotes_cannot_submit_and_rejected_intents_refund_once() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![fill("bought", "BTC", "30", "101")],
        &[balance("BTC", "30", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    assert!(live.reserve(&db, quote(110), 110).unwrap().is_none());
    live.resume(&db, "fixture-key").unwrap();
    assert!(live.reserve(&db, quote(110), 140).unwrap().is_none());
    let Operation::Submit { transfer, .. } = live.reserve(&db, quote(140), 140).unwrap().unwrap()
    else {
        panic!()
    };
    live.submitted(
        &db,
        &transfer.id,
        Submission::Rejected("cancelled before sending".into()),
        141,
    )
    .unwrap();
    live.submitted(
        &db,
        &transfer.id,
        Submission::Rejected("duplicate reply".into()),
        142,
    )
    .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "30");
}
#[test]
fn fee_caps_budgets_inflight_limits_and_destination_changes_fail_closed() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![fill("bought", "BTC", "50", "101")],
        &[balance("BTC", "50", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    live.resume(&db, "fixture-key").unwrap();
    let mut expensive = quote(110);
    expensive.fee = "2".into();
    expensive.net = "8".into();
    assert!(live.reserve(&db, expensive, 110).is_err());
    let mut redirected = quote(110);
    redirected.destination.address = "different".into();
    assert!(live.reserve(&db, redirected, 110).is_err());
    for at in [110, 180] {
        let Operation::Submit { transfer, .. } = live.reserve(&db, quote(at), at).unwrap().unwrap()
        else {
            panic!()
        };
        live.submitted(
            &db,
            &transfer.id,
            Submission::Accepted {
                exchange_id: format!("ref-{at}"),
                held: false,
            },
            at,
        )
        .unwrap();
        assert!(live.reserve(&db, quote(at + 1), at + 1).is_err());
        live.statuses(
            &db,
            vec![WithdrawalStatus {
                id: format!("ref-{at}"),
                asset: "BTC".into(),
                net: "9".into(),
                fee: "1".into(),
                destination: destination().wallet_id,
                method: METHOD.into(),
                status: "success".into(),
                txid: None,
            }],
            at + 1,
        )
        .unwrap();
    }
    assert!(
        live.reserve(&db, quote(250), 250)
            .err()
            .unwrap()
            .to_string()
            .contains("24-hour fee")
    );
}
#[test]
fn account_destinations_and_digest_are_bound_and_paper_wallets_cannot_be_applied() {
    let (_dir, db, mut live) = database();
    let config = config();
    assert!(
        live.configure(
            &db,
            config.clone(),
            &config.digest().unwrap(),
            "other",
            "fixture-key",
            &[wallet()],
            200
        )
        .is_err()
    );
    assert!(
        live.configure(
            &db,
            config.clone(),
            "stale",
            "main",
            "fixture-key",
            &[wallet()],
            200
        )
        .is_err()
    );
    let mut w = wallet();
    w.source = "paper".into();
    assert!(
        live.configure(
            &db,
            config.clone(),
            &config.digest().unwrap(),
            "main",
            "fixture-key",
            &[w],
            200
        )
        .is_err()
    );
    assert!(live.resume(&db, "other-key").is_err());
}

#[test]
fn configuration_rejects_both_undersized_chunks_and_thresholds_without_saving() {
    let (_dir, db, mut live) = database();
    let original = live.status(&db).unwrap().config.unwrap();
    let mut w = wallet();
    // The selected network's minimum has risen since the previous configuration.
    w.methods[0].minimum = Some("2".into());
    for (chunk, minimum, expected) in [
        ("1.5", "1", "BTC chunk 1.5 is below Kraken's minimum 2"),
        ("3", "1", "BTC minimum 1 is below Kraken's minimum 2"),
    ] {
        let mut config = original.clone();
        config.rules[0].chunk = chunk.into();
        config.rules[0].minimum = minimum.into();
        let digest = config.digest().unwrap(); // Local JSON validation cannot know Kraken limits.
        let error = live
            .configure(
                &db,
                config,
                &digest,
                "main",
                "fixture-key",
                &[w.clone()],
                200,
            )
            .err()
            .unwrap();
        assert!(error.to_string().contains(expected), "{error}");
        assert_eq!(live.status(&db).unwrap().config.unwrap(), original);
        assert!(live.paused());
    }
    let mut config = original;
    config.rules[0].chunk = "3".into();
    config.rules[0].minimum = "2".into();
    live.configure(
        &db,
        config.clone(),
        &config.digest().unwrap(),
        "main",
        "fixture-key",
        &[w],
        200,
    )
    .unwrap();
    assert_eq!(live.status(&db).unwrap().config.unwrap(), config);
}

#[test]
fn rotated_destinations_use_the_highest_exact_minimum_for_the_selected_asset() {
    let (_dir, db, mut live) = database();
    let mut config = config();
    config.rules.truncate(1);
    let mut first = wallet();
    first.methods[0].minimum = Some("0.000000000000000001".into());
    // The unrelated USDC method still has a minimum of 1 and must not be selected.
    let mut second = first.clone();
    second.id = "second-wallet".into();
    second.methods[0].id = "ed22b41d-df39-4aba-840e-a13b8f8d30dc".into();
    second.methods[0].minimum = Some("0.000000000000000003".into());
    second.methods[0].network = "Second network".into();
    let mut d = destination();
    d.wallet_id = second.id.clone();
    d.method_id = second.methods[0].id.clone();
    d.network = second.methods[0].network.clone();
    config.rules[0].destinations.push(d);
    let wallets = [first, second];
    assert_eq!(
        super::store::minimum_for_destinations("BTC", &config.rules[0].destinations, &wallets)
            .unwrap(),
        decimal("0.000000000000000003").unwrap(),
    );
    config.rules[0].minimum = "0.000000000000000002".into();
    assert!(
        live.configure(
            &db,
            config.clone(),
            &config.digest().unwrap(),
            "main",
            "fixture-key",
            &wallets,
            200,
        )
        .is_err()
    );
    config.rules[0].minimum = "0.000000000000000003".into();
    live.configure(
        &db,
        config.clone(),
        &config.digest().unwrap(),
        "main",
        "fixture-key",
        &wallets,
        200,
    )
    .unwrap();
}

#[test]
fn missing_or_invalid_kraken_minimum_blocks_setup_but_explicit_zero_is_valid() {
    let (_dir, db, mut live) = database();
    let mut config = config();
    let original = config.clone();
    for minimum in [None, Some(""), Some("invalid"), Some("-1")] {
        let mut w = wallet();
        w.methods[0].minimum = minimum.map(str::to_owned);
        let error = live
            .configure(
                &db,
                config.clone(),
                &config.digest().unwrap(),
                "main",
                "fixture-key",
                &[w],
                200,
            )
            .err()
            .unwrap();
        assert!(error.to_string().contains("Kraken minimum"), "{error}");
        assert_eq!(live.status(&db).unwrap().config.unwrap(), original);
    }
    let mut w = wallet();
    w.methods[0].minimum = Some("0".into());
    config.rules[0].minimum = "0".into();
    live.configure(
        &db,
        config.clone(),
        &config.digest().unwrap(),
        "main",
        "fixture-key",
        &[w],
        200,
    )
    .unwrap();
    config.rules[0].chunk = "0".into();
    assert!(config.validate().is_err());
}

#[test]
fn conflicting_fill_rolls_back_entire_batch_and_never_advances_cursor() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![fill("one", "BTC", "10", "101")],
        &[balance("BTC", "100", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    assert!(
        live.sync(
            &db,
            vec![
                fill("new", "BTC", "10", "103"),
                fill("one", "BTC", "11", "101")
            ],
            &[balance("BTC", "100", "0")],
            vec![],
            104,
            104
        )
        .is_err()
    );
    assert_eq!(queued(&live, &db, "BTC"), "10");
    assert_eq!(live.status(&db).unwrap().trades.len(), 1);
    assert_eq!(live.status(&db).unwrap().caught_up_through, Some(102));
}
#[test]
fn agent_order_requests_are_idempotent_across_restart_and_do_not_resubmit_unknowns() {
    let (_dir, db, mut live) = database();
    let command:OrderCommand=serde_json::from_value(serde_json::json!({"request_id":"request-1","account":"main","order":{"action":"place","pair":"BTC/USDC","side":"buy","order_type":"limit","volume":"0.1","price":"100","price2":null}})).unwrap();
    let hash = command.digest().unwrap();
    assert!(
        live.order(&db, command.clone(), &hash, "main")
            .unwrap()
            .is_some()
    );
    assert!(
        live.order(&db, command.clone(), &hash, "main")
            .unwrap()
            .is_none()
    );
    drop(live);
    let mut live = Live::open(&db).unwrap();
    assert!(
        live.order(&db, command.clone(), &hash, "main")
            .unwrap()
            .is_none()
    );
    let mut second = command.clone();
    second.request_id = "request-2".into();
    assert!(
        live.order(&db, second.clone(), &second.digest().unwrap(), "main")
            .is_err()
    );
    live.handle_reply(
        &db,
        &Operation::Orders,
        Reply::Orders(vec![Order {
            id: "exchange-order".into(),
            pair: "BTC/USDC".into(),
            side: "buy".into(),
            order_type: "limit".into(),
            volume: "0.1".into(),
            filled: "0.1".into(),
            price: "100".into(),
            status: "closed".into(),
            client_id: Some("request-1".into()),
        }]),
        200,
    )
    .unwrap();
    assert_eq!(
        live.status(&db).unwrap().order_receipts[0].status,
        "accepted"
    );
    assert!(
        live.order(&db, second.clone(), &second.digest().unwrap(), "main")
            .unwrap()
            .is_some()
    );
}

#[test]
fn catch_up_blocks_withdrawals_until_the_cursor_reaches_present_and_ws_errors_keep_backoff() {
    let (_dir, db, mut live) = database();
    live.resume(&db, "fixture-key").unwrap();
    let op = live.operation(&db, 10000).unwrap().unwrap();
    assert!(matches!(
        op,
        Operation::Reconcile {
            start: 100,
            end: 3700
        }
    ));
    live.sync(
        &db,
        vec![fill("older", "BTC", "30", "101")],
        &[balance("BTC", "30", "0")],
        vec![],
        3700,
        10000,
    )
    .unwrap();
    live.status_due = 20000;
    live.token_due = 20000;
    assert!(live.operation(&db, 10001).unwrap().is_none());
    assert!(matches!(
        live.operation(&db, 10002).unwrap(),
        Some(Operation::Reconcile { end: 7300, .. })
    ));
    live.failed(
        &db,
        &Operation::Reconcile {
            start: 3640,
            end: 7300,
        },
        "fixture offline",
        10002,
    )
    .unwrap();
    let next = live.rest_due;
    live.ws_trade(&db, "late", &serde_json::json!({"time":"105.5"}), 10003)
        .unwrap();
    assert_eq!(live.rest_due, next);
    let op = live.operation(&db, next).unwrap().unwrap();
    assert!(matches!(op, Operation::Reconcile { start: 104, .. }));
}
#[test]
fn changing_rules_does_not_skip_a_sale_that_happened_during_pause() {
    let (_dir, db, mut live) = database();
    live.sync(
        &db,
        vec![fill("bought", "BTC", "20", "101")],
        &[balance("BTC", "100", "0")],
        vec![],
        102,
        102,
    )
    .unwrap();
    let config = config();
    live.configure(
        &db,
        config.clone(),
        &config.digest().unwrap(),
        "main",
        "fixture-key",
        &[wallet()],
        110,
    )
    .unwrap();
    let mut sale = fill("sale", "USDC", "10", "105");
    sale.debits.insert("BTC".into(), "8".into());
    live.sync(
        &db,
        vec![sale],
        &[balance("BTC", "92", "0"), balance("USDC", "10", "0")],
        vec![],
        111,
        111,
    )
    .unwrap();
    assert_eq!(queued(&live, &db, "BTC"), "12");
    assert_eq!(queued(&live, &db, "USDC"), "0");
}

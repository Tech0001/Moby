//! Bounded Kraken operations. Only Submit/Order may write to the exchange.
use super::{model::*, store::verify_destination};
use crate::{
    kraken::Reader,
    model::{AccountBalance, add, amount, decimal, now, positive, subtract, text},
    vault::{Credential, Secret},
};
use anyhow::{Context, Result, bail, ensure};
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, atomic::AtomicBool},
};

#[derive(Debug)]
pub struct Rejected(pub String);
impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Rejected {}

pub(crate) enum Operation {
    Reconcile {
        start: i64,
        end: i64,
    },
    Orders,
    Token,
    Quote {
        rule: WatchRule,
        destination: Destination,
        queued: String,
    },
    Submit {
        transfer: Transfer,
        token: Secret,
    },
    Poll {
        since: i64,
    },
    Order(OrderCommand),
}
impl Operation {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Reconcile { .. } => "Fill reconciliation",
            Self::Orders => "Order refresh",
            Self::Token => "WebSocket authentication",
            Self::Quote { .. } => "Withdrawal quote",
            Self::Submit { .. } => "Withdrawal submission",
            Self::Poll { .. } => "Withdrawal status check",
            Self::Order(_) => "Order request",
        }
    }
    pub fn writes(&self) -> bool {
        matches!(self, Self::Submit { .. } | Self::Order(_))
    }
}
pub(crate) struct Quote {
    pub asset: String,
    pub destination: Destination,
    pub gross: String,
    pub net: String,
    pub fee: String,
    pub token: Secret,
    pub at: i64,
}
pub(crate) enum Submission {
    Accepted { exchange_id: String, held: bool },
    Rejected(String),
    Unknown(String),
}
pub(crate) enum Reply {
    Sync {
        trades: Vec<Trade>,
        balances: Vec<AccountBalance>,
        accounting_balances: Vec<AccountBalance>,
        orders: Vec<Order>,
        end: i64,
    },
    Orders(Vec<Order>),
    Token(Secret),
    Quote(Quote),
    Submitted(Submission),
    Statuses(Vec<WithdrawalStatus>),
    Order(Submission),
}
#[derive(Debug)]
pub(crate) struct WithdrawalStatus {
    pub id: String,
    pub asset: String,
    pub net: String,
    pub fee: String,
    pub destination: String,
    pub method: String,
    pub status: String,
    pub txid: Option<String>,
}

fn s(value: &Value, key: &str) -> Result<String> {
    let v = value
        .get(key)
        .context("Kraken response missing a required field")?;
    let result = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => bail!("invalid Kraken field type"),
    };
    ensure!(
        result.len() <= 512 && !result.chars().any(char::is_control),
        "invalid Kraken field"
    );
    Ok(result)
}
fn optional(value: &Value, key: &str) -> Result<Option<String>> {
    if value.get(key).is_none_or(Value::is_null) {
        Ok(None)
    } else {
        s(value, key).map(Some)
    }
}
fn object(value: &Value) -> Result<&serde_json::Map<String, Value>> {
    value
        .as_object()
        .context("Kraken returned an invalid object")
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    value
        .get(key)
        .and_then(Value::as_array)
        .context("Kraken returned an invalid list")
}
fn value_amount(value: &Value, expected_asset: &str) -> Result<Decimal> {
    let a = &value["asset"];
    ensure!(
        s(a, "class")? == "currency" && asset(&s(a, "name")?) == expected_asset,
        "funding amount is in an unexpected asset"
    );
    amount(&s(value, "amount")?)
}
#[derive(Clone, Debug, Deserialize)]
struct Pair {
    altname: String,
    wsname: Option<String>,
    base: String,
    quote: String,
    lot_decimals: u32,
    pair_decimals: u32,
    ordermin: String,
    costmin: Option<String>,
    status: Option<String>,
}
impl Pair {
    fn canonical(&self) -> String {
        format!("{}/{}", self.base_symbol(), self.quote_symbol())
    }
    fn base_symbol(&self) -> String {
        asset(
            self.wsname
                .as_deref()
                .and_then(|p| p.split_once('/'))
                .map(|p| p.0)
                .unwrap_or(&self.base),
        )
    }
    fn quote_symbol(&self) -> String {
        asset(
            self.wsname
                .as_deref()
                .and_then(|p| p.split_once('/'))
                .map(|p| p.1)
                .unwrap_or(&self.quote),
        )
    }
}
fn canonical_asset(pairs: &BTreeMap<String, Pair>, raw: &str) -> String {
    for pair in pairs.values() {
        if pair.base == raw {
            return pair.base_symbol();
        }
        if pair.quote == raw {
            return pair.quote_symbol();
        }
    }
    asset(raw)
}
fn pair_metadata<'a>(pairs: &'a BTreeMap<String, Pair>, name: &str) -> Option<&'a Pair> {
    pairs
        .get(name)
        .or_else(|| {
            pairs.values().find(|p| {
                p.altname == name || p.wsname.as_deref() == Some(name) || p.canonical() == name
            })
        })
        .or_else(|| {
            // Display symbols can differ from Kraken's legacy altname (BTC/XBT,
            // DOGE/XDG). Only accept a compact alias if metadata identifies it
            // unambiguously; never guess where an unknown pair should split.
            let mut matches = pairs
                .values()
                .filter(|p| p.canonical().replace('/', "") == name);
            let pair = matches.next()?;
            matches.next().is_none().then_some(pair)
        })
}
fn find_pair<'a>(pairs: &'a BTreeMap<String, Pair>, name: &str) -> Result<&'a Pair> {
    text(name, "Kraken pair")?;
    pair_metadata(pairs, name)
        .with_context(|| format!("Kraken pair metadata is unavailable or ambiguous for {name}"))
}

fn fill_pair_assets(
    pairs: &BTreeMap<String, Pair>,
    name: &str,
    margin: bool,
) -> Result<(String, String)> {
    text(name, "Kraken pair")?;
    if let Some(pair) = pair_metadata(pairs, name) {
        return Ok((pair.base_symbol(), pair.quote_symbol()));
    }
    // Synthetic spot pairs need not have a native AssetPairs listing. Accept
    // only explicit BASE/QUOTE names whose two assets are independently known
    // in Kraken metadata. parse_trade still requires the actual settlement
    // ledgers to agree with both assets, side, volume, cost and fees. Never use
    // this fallback to invent trading limits or enable order placement.
    if !margin && let Some((base, quote)) = name.split_once('/') {
        let base = canonical_asset(pairs, base);
        let quote = canonical_asset(pairs, quote);
        let known = |symbol: &str| {
            pairs
                .values()
                .any(|pair| pair.base_symbol() == symbol || pair.quote_symbol() == symbol)
        };
        if base != quote && known(&base) && known(&quote) {
            return Ok((base, quote));
        }
    }
    bail!(
        "Kraken pair metadata is unavailable or ambiguous for {name}; settlement assets cannot be verified"
    )
}

pub(crate) fn execute(
    credential: Credential,
    nonce: u64,
    cancelled: Arc<AtomicBool>,
    operation: &Operation,
    session: crate::kraken::session::Shared,
) -> Result<Reply> {
    let mut api = Reader::with_session("https://api.kraken.com".into(), nonce, cancelled, session)?;
    execute_with(&mut api, &credential, operation)
}
fn execute_with(api: &mut Reader, key: &Credential, operation: &Operation) -> Result<Reply> {
    match operation {
        Operation::Reconcile { start, end } => {
            let pairs = api.public::<BTreeMap<String, Pair>>("AssetPairs")?;
            let trades = trades(api, key, &pairs, *start, *end)?;
            let balances = api.balances(key)?;
            let orders = orders(api, key, &pairs)?;
            let accounting_balances = balances
                .iter()
                .cloned()
                .map(|mut b| {
                    b.asset = canonical_asset(&pairs, &b.asset);
                    b
                })
                .collect();
            Ok(Reply::Sync {
                trades,
                balances,
                accounting_balances,
                orders,
                end: *end,
            })
        }
        Operation::Orders => {
            let pairs = api.public::<BTreeMap<String, Pair>>("AssetPairs")?;
            Ok(Reply::Orders(orders(api, key, &pairs)?))
        }
        Operation::Token => {
            let result: Value = api.private(key, "GetWebSocketsToken", &[])?;
            let token = s(&result, "token")?;
            ensure!(
                !token.is_empty(),
                "Kraken returned an empty websocket token"
            );
            Ok(Reply::Token(Secret(token)))
        }
        Operation::Quote {
            rule,
            destination,
            queued,
        } => Ok(Reply::Quote(quote(api, key, rule, destination, queued)?)),
        Operation::Submit { transfer, token } => {
            let body = json!({"scope":{"method_id":transfer.destination.method_id},"address_id":transfer.destination.wallet_id,"expected_address":transfer.destination.address,"amount":{"asset_amount":{"asset":{"class":"currency","name":transfer.asset},"amount":transfer.gross}},"fee":{"quoted_fee":{"token":token.0},"fee_included":true}});
            let result: Result<Value> =
                api.funding(key, "/funding/v1/withdrawals", &[], Some(&body));
            let result = result.and_then(|v| {
                let id = s(&v, "withdrawal_id")?;
                text(&id, "withdrawal receipt")?;
                ensure!(
                    value_amount(&v["gross_amount"]["asset_amount"], &transfer.asset)?
                        == amount(&transfer.gross)?
                        && value_amount(&v["net_amount"]["asset_amount"], &transfer.asset)?
                            == amount(&transfer.net)?
                        && value_amount(&v["fee"]["asset_amount"], &transfer.asset)?
                            == amount(&transfer.fee)?,
                    "withdrawal response differs from the pinned quote; reconcile account activity"
                );
                Ok(Submission::Accepted {
                    exchange_id: id,
                    held: optional(&v, "approval_request_id")?.is_some(),
                })
            });
            Ok(Reply::Submitted(submission(result)))
        }
        Operation::Poll { since } => Ok(Reply::Statuses(withdrawals(api, key, *since)?)),
        Operation::Order(command) => Ok(Reply::Order(order(api, key, command))),
    }
}
fn submission(result: Result<Submission>) -> Submission {
    match result {
        Ok(s) => s,
        Err(e) => {
            if let Some(rejected) = e.downcast_ref::<Rejected>() {
                Submission::Rejected(rejected.0.clone())
            } else {
                Submission::Unknown(e.to_string())
            }
        }
    }
}
fn trades(
    api: &mut Reader,
    key: &Credential,
    pairs: &BTreeMap<String, Pair>,
    start: i64,
    end: i64,
) -> Result<Vec<Trade>> {
    let mut raw = BTreeMap::<String, Value>::new();
    let mut offset = 0usize;
    let start = start.to_string();
    let end = end.to_string();
    let mut expected = None;
    loop {
        ensure!(
            offset <= 10000,
            "trade history window is too large; no cursor advanced"
        );
        let page: Value = api.private(
            key,
            "TradesHistory",
            &[
                ("start", &start),
                ("end", &end),
                ("ofs", &offset.to_string()),
                ("ledgers", "true"),
                ("consolidate_taker", "false"),
            ],
        )?;
        let count = page["count"]
            .as_u64()
            .context("trade history omitted total count")? as usize;
        if let Some(old) = expected {
            ensure!(
                old == count,
                "trade history changed during pagination; retrying the complete window"
            );
        } else {
            expected = Some(count);
        }
        let entries = object(&page["trades"])?;
        if raw.len() >= count {
            ensure!(entries.is_empty(), "inconsistent trade history count");
            break;
        }
        ensure!(!entries.is_empty(), "incomplete trade history page");
        for (id, t) in entries {
            text(id, "trade ID")?;
            ensure!(
                raw.insert(id.clone(), t.clone()).is_none(),
                "duplicate trade history page"
            );
        }
        offset += entries.len();
        if raw.len() == count {
            break;
        }
        ensure!(raw.len() < count, "inconsistent trade history count");
    }
    let mut ledger_ids = BTreeSet::new();
    for v in raw.values() {
        if !is_margin(v)? {
            for id in array(v, "ledgers")? {
                let id = id.as_str().context("invalid ledger ID")?;
                text(id, "ledger ID")?;
                ledger_ids.insert(id.to_owned());
            }
        }
    }
    let ledger_ids: Vec<_> = ledger_ids.into_iter().collect();
    let mut ledgers = BTreeMap::new();
    for chunk in ledger_ids.chunks(20) {
        let entries: Value = api.private(key, "QueryLedgers", &[("id", &chunk.join(","))])?;
        for id in chunk {
            let ledger = entries
                .get(id)
                .context("settlement ledger is not available yet; will retry")?;
            ledgers.insert(id.clone(), ledger.clone());
        }
    }
    let mut result = Vec::new();
    let mut used_ledgers = BTreeSet::new();
    for (id, raw) in raw {
        result.push(parse_trade(&id, &raw, pairs, &ledgers, &mut used_ledgers)?);
    }
    result.sort_by(|a, b| {
        decimal(&a.time)
            .unwrap()
            .cmp(&decimal(&b.time).unwrap())
            .then(a.id.cmp(&b.id))
    });
    Ok(result)
}
fn is_margin(v: &Value) -> Result<bool> {
    Ok(amount(&s(v, "margin")?)? > Decimal::ZERO
        || optional(v, "misc")?.is_some_and(|m| m.split(',').any(|s| s == "closing"))
        || optional(v, "leverage")?
            .is_some_and(|l| l != "0" && l != "1" && l != "none" && !l.is_empty()))
}
fn parse_trade(
    id: &str,
    v: &Value,
    pairs: &BTreeMap<String, Pair>,
    ledgers: &BTreeMap<String, Value>,
    used: &mut BTreeSet<String>,
) -> Result<Trade> {
    let pair_name = s(v, "pair")?;
    let side = s(v, "type")?;
    ensure!(side == "buy" || side == "sell", "invalid trade side");
    let margin = is_margin(v)?;
    let (base, quote) = fill_pair_assets(pairs, &pair_name, margin)?;
    let pair = format!("{base}/{quote}");
    let (recv, spent) = if side == "buy" {
        (base, quote)
    } else {
        (quote, base)
    };
    let volume = positive(&s(v, "vol")?)?;
    let cost = positive(&s(v, "cost")?)?;
    let expected_recv = if side == "buy" { volume } else { cost };
    let expected_spent = if side == "buy" { cost } else { volume };
    let mut received = Decimal::ZERO;
    let mut gross_recv = Decimal::ZERO;
    let mut gross_spent = Decimal::ZERO;
    let mut debits = BTreeMap::<String, Decimal>::new();
    if !margin {
        let ids = array(v, "ledgers")?;
        ensure!(!ids.is_empty(), "fill has no settlement ledgers yet");
        for ledger_id in ids {
            let ledger_id = ledger_id.as_str().context("invalid ledger ID")?;
            ensure!(
                used.insert(ledger_id.into()),
                "shared settlement ledger cannot safely be attributed to individual fills"
            );
            let entry = ledgers
                .get(ledger_id)
                .context("missing settlement ledger")?;
            ensure!(
                s(entry, "type")? == "trade",
                "fill references a non-trade ledger"
            );
            let symbol = canonical_asset(pairs, &s(entry, "asset")?);
            let change = decimal(&s(entry, "amount")?)?;
            let fee = amount(&s(entry, "fee")?)?;
            ensure!(
                symbol == recv || symbol == spent,
                "unexpected settlement asset"
            );
            if change > Decimal::ZERO {
                ensure!(symbol == recv && change >= fee, "unexpected trade credit");
                gross_recv = add(gross_recv, change)?;
                received = add(received, subtract(change, fee)?)?;
            } else {
                ensure!(symbol == spent, "unexpected trade debit");
                gross_spent = add(gross_spent, -change)?;
                let entry = debits.entry(symbol).or_default();
                *entry = add(*entry, add(-change, fee)?)?;
            }
        }
        ensure!(
            gross_recv == expected_recv && gross_spent == expected_spent,
            "trade volume and settlement ledgers disagree; funds not queued"
        );
    }
    let time = s(v, "time")?;
    ensure!(decimal(&time)? >= Decimal::ZERO, "invalid fill time");
    // ordertype is the user's original order; tradeordertype can be market/limit
    // after a stop or trailing trigger fires. Filters must retain the original type.
    let order_type = s(v, "ordertype")?.replace('_', "-").to_lowercase();
    Ok(Trade {
        id: id.into(),
        order_id: s(v, "ordertxid")?,
        pair,
        side,
        order_type,
        time,
        margin,
        received_asset: recv,
        received: received.normalize().to_string(),
        debits: debits
            .into_iter()
            .map(|(a, v)| (a, v.normalize().to_string()))
            .collect(),
    })
}
fn orders(
    api: &mut Reader,
    key: &Credential,
    pairs: &BTreeMap<String, Pair>,
) -> Result<Vec<Order>> {
    let open: Value = api.private(key, "OpenOrders", &[])?;
    let mut result = Vec::new();
    for (id, value) in object(&open["open"])? {
        result.push(parse_order(id, value, pairs)?);
    }
    // Recent completed orders keep immediately-filled market orders visible.
    let closed = api.closed_orders(key)?;
    for (id, value) in object(&closed["closed"])? {
        result.push(parse_order(id, value, pairs)?);
    }
    ensure!(result.len() <= 10000, "order list exceeds size limit");
    Ok(result)
}
fn parse_order(id: &str, v: &Value, pairs: &BTreeMap<String, Pair>) -> Result<Order> {
    text(id, "order ID")?;
    let descr = &v["descr"];
    let raw_pair = s(descr, "pair")?;
    text(&raw_pair, "order pair")?;
    // Orders are display/receipt records, not settlement instructions. A
    // historical or unfamiliar market must not discard the entire order list
    // and prevent otherwise validated fills from being reconciled. Preserve
    // Kraken's name when it cannot be normalized; fills still validate their
    // assets and settlement ledgers, and order placement needs native metadata.
    let pair = pair_metadata(pairs, &raw_pair)
        .map(Pair::canonical)
        .unwrap_or(raw_pair);
    let volume = s(v, "vol")?;
    amount(&volume)?;
    let filled = s(v, "vol_exec")?;
    amount(&filled)?;
    Ok(Order {
        id: id.into(),
        pair,
        side: s(descr, "type")?,
        order_type: s(descr, "ordertype")?,
        volume,
        filled,
        price: s(descr, "price")?,
        status: s(v, "status")?,
        client_id: optional(v, "cl_ord_id")?,
    })
}
fn quote(
    api: &mut Reader,
    key: &Credential,
    rule: &WatchRule,
    destination: &Destination,
    queued: &str,
) -> Result<Quote> {
    let wallets = api.wallets(key)?;
    let method = verify_destination(&rule.asset, destination, &wallets)?;
    let path = format!("/funding/v1/limits/withdrawal/currency/{}", rule.asset);
    let limits: Value = api.funding(key, &path, &[], None)?;
    let available = value_amount(&limits["available_balance"], &rule.asset)?;
    let limit = array(&limits, "withdrawal_limits")?
        .iter()
        .find(|v| v["method_id"].as_str() == Some(&destination.method_id))
        .context("Kraken omitted limits for the selected funding method")?;
    let maximum = value_amount(&limit["maximum_amount"], &rule.asset)?;
    let minimum = method.withdrawal_minimum()?.max(amount(&rule.minimum)?);
    let mut gross = amount(queued)?
        .min(amount(&rule.chunk)?)
        .min(maximum)
        .min(subtract(available, amount(&rule.reserve)?)?.max(Decimal::ZERO));
    if let Some(max) = &method.maximum {
        gross = gross.min(amount(max)?);
    }
    ensure!(
        gross >= minimum && gross > Decimal::ZERO,
        "Available chunk {} {} is below minimum {} after reserving {}",
        gross,
        rule.asset,
        minimum,
        rule.reserve
    );
    // Always pin the fee; never let the exchange choose an unbounded current fee.
    let fees: Value = api.funding(
        key,
        &format!("/funding/v1/fees/{}", destination.method_id),
        &[
            ("amount", &gross.normalize().to_string()),
            ("fee_included", "true"),
        ],
        None,
    )?;
    ensure!(
        value_amount(&fees["gross_amount"], &rule.asset)? == gross,
        "quote changed gross amount"
    );
    let net = value_amount(&fees["net_amount"], &rule.asset)?;
    let fee = value_amount(&fees["fee"], &rule.asset)?;
    ensure!(
        net > Decimal::ZERO && add(net, fee)? == gross,
        "invalid withdrawal fee quote"
    );
    // Some funding minimums apply to the amount received. Requiring both avoids a rejected small chunk.
    ensure!(
        net >= minimum,
        "Chunk would deliver {} {} after fees, below minimum {}; increase the gross chunk",
        net,
        rule.asset,
        minimum
    );
    let token = s(&fees, "withdrawal_fee_token")?;
    ensure!(!token.is_empty(), "Kraken omitted the pinned fee token");
    Ok(Quote {
        asset: rule.asset.clone(),
        destination: destination.clone(),
        gross: gross.normalize().to_string(),
        net: net.normalize().to_string(),
        fee: fee.normalize().to_string(),
        token: Secret(token),
        at: now(),
    })
}
fn withdrawals(api: &mut Reader, key: &Credential, since: i64) -> Result<Vec<WithdrawalStatus>> {
    let mut cursor: Option<String> = None;
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    let start = chrono::DateTime::from_timestamp(since, 0)
        .context("invalid withdrawal timestamp")?
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    for _ in 0..100 {
        let query = if let Some(ref c) = cursor {
            vec![("cursor", c.as_str())]
        } else {
            vec![("limit", "500"), ("start_time", start.as_str())]
        };
        let page: Value = api.funding(key, "/funding/v1/withdrawals", &query, None)?;
        for v in array(&page, "withdrawals")? {
            let symbol = asset(&s(&v["amount"]["asset"], "name")?);
            if v["amount"]["asset"]["class"] != "currency" {
                continue;
            }
            let Some(destination) = optional(v, "address_id")? else {
                continue;
            };
            result.push(WithdrawalStatus {
                id: s(v, "withdrawal_id")?,
                asset: symbol.clone(),
                net: value_amount(&v["amount"], &symbol)?.normalize().to_string(),
                fee: value_amount(&v["fee"], &symbol)?.normalize().to_string(),
                destination,
                method: s(v, "method_id")?,
                status: s(v, "status")?,
                txid: optional(v, "onchain_transaction")?,
            });
        }
        cursor = optional(&page, "next_cursor")?;
        if cursor.is_none() {
            return Ok(result);
        }
        ensure!(
            seen.insert(cursor.clone()),
            "repeated withdrawal history cursor"
        );
    }
    bail!("withdrawal history pagination incomplete")
}
fn order(api: &mut Reader, key: &Credential, command: &OrderCommand) -> Submission {
    // Preflight errors prove no write was sent. Once dispatch begins, only an explicit rejection is retryable.
    let prepared = (|| -> Result<(String, Vec<(String, String)>)> {
        command.validate()?;
        let info = api.inspect(key)?;
        let permission = if matches!(command.action, OrderAction::Cancel { .. }) {
            "close-trades"
        } else {
            "modify-trades"
        };
        ensure!(
            info.permissions.iter().any(|p| p == permission),
            "required order permission is missing"
        );
        match &command.action {
            OrderAction::Place {
                pair,
                side,
                order_type,
                volume,
                price,
                price2,
                post_only,
            } => {
                let pairs = api.public::<BTreeMap<String, Pair>>("AssetPairs")?;
                let market = find_pair(&pairs, pair)?;
                ensure!(
                    market.status.as_deref() == Some("online"),
                    "market is not online"
                );
                ensure!(
                    positive(volume)? >= amount(&market.ordermin)?,
                    "{} trading minimum is {} {}; requested {} {}. No order was sent",
                    market.canonical(),
                    market.ordermin,
                    asset(&market.base),
                    volume,
                    asset(&market.base)
                );
                ensure!(
                    amount(volume)?.scale() <= market.lot_decimals,
                    "{} order size allows at most {} decimal places. No order was sent",
                    market.canonical(),
                    market.lot_decimals
                );
                if order_type == "limit" {
                    let p = positive(price.as_deref().unwrap())?;
                    ensure!(
                        p.scale() <= market.pair_decimals,
                        "limit price has too many decimal places"
                    );
                    if let Some(min) = &market.costmin {
                        ensure!(
                            p.checked_mul(amount(volume)?)
                                .context("order value overflow")?
                                >= amount(min)?,
                            "{} minimum trade value is {} {}. No order was sent",
                            market.canonical(),
                            min,
                            asset(&market.quote)
                        );
                    }
                }
                let mut params = vec![
                    ("pair".into(), market.altname.clone()),
                    ("type".into(), side.clone()),
                    ("ordertype".into(), order_type.clone()),
                    ("volume".into(), volume.clone()),
                    ("cl_ord_id".into(), command.request_id.clone()),
                    (
                        "oflags".into(),
                        if *post_only { "fciq,post" } else { "fciq" }.into(),
                    ),
                ];
                if let Some(p) = price {
                    params.push(("price".into(), p.clone()));
                }
                if let Some(p) = price2 {
                    params.push(("price2".into(), p.clone()));
                }
                Ok(("AddOrder".into(), params))
            }
            OrderAction::Amend {
                order_id,
                volume,
                limit_price,
                trigger_price,
            } => {
                let mut params = vec![("txid".into(), order_id.clone())];
                for (key, value) in [
                    ("order_qty", volume),
                    ("limit_price", limit_price),
                    ("trigger_price", trigger_price),
                ] {
                    if let Some(v) = value {
                        params.push((key.into(), v.clone()));
                    }
                }
                Ok(("AmendOrder".into(), params))
            }
            OrderAction::Cancel { order_id } => Ok((
                "CancelOrder".into(),
                vec![("txid".into(), order_id.clone())],
            )),
        }
    })();
    let (operation, params) = match prepared {
        Ok(p) => p,
        Err(e) => return Submission::Rejected(e.to_string()),
    };
    let refs: Vec<_> = params
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let result = api
        .private::<Value>(key, &operation, &refs)
        .and_then(|value| {
            let id = match &command.action {
                OrderAction::Place { .. } => {
                    let ids = array(&value, "txid")?;
                    ensure!(ids.len() == 1, "unexpected order receipt");
                    ids[0]
                        .as_str()
                        .context("missing order receipt")?
                        .to_string()
                }
                OrderAction::Amend { order_id, .. } => {
                    text(&s(&value, "amend_id")?, "amend receipt")?;
                    order_id.clone()
                }
                OrderAction::Cancel { order_id } => {
                    ensure!(
                        value["count"].as_u64() == Some(1),
                        "cancellation receipt is uncertain"
                    );
                    order_id.clone()
                }
            };
            text(&id, "order receipt")?;
            Ok(Submission::Accepted {
                exchange_id: id,
                held: false,
            })
        });
    submission(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kraken::{
        signature,
        tests::{credential, key_info, server},
    };
    use std::sync::atomic::Ordering;
    const METHOD: &str = "d4ec4d52-b159-428e-ba64-f45455a978a1";
    fn reader(origin: String) -> Reader {
        Reader::new(origin, 100, Arc::new(AtomicBool::new(false))).unwrap()
    }
    fn envelope(v: Value) -> Value {
        json!({"error":[],"result":v})
    }
    fn money(value: &str) -> Value {
        json!({"asset":{"class":"currency","name":"BTC"},"amount":value})
    }
    fn pair() -> Value {
        json!({"XXBTZUSD":{"altname":"XBTUSD","wsname":"XBT/USD","base":"XXBT","quote":"ZUSD","lot_decimals":8,"pair_decimals":1,"ordermin":"0.0001","costmin":"0.5","status":"online"}})
    }
    fn raw_trade(id: &str, side: &str, kind: &str) -> Value {
        json!({"ordertxid":"O-ONE","pair":"XXBTZUSD","time":101.123456789,"type":side,"ordertype":kind,"price":"10","cost":"20","vol":"2","fee":"0.1","margin":"0","ledgers":[format!("{id}-base"),format!("{id}-quote")]})
    }
    fn raw_order(pair: &str, status: &str) -> Value {
        json!({"descr":{"pair":pair,"type":"buy","ordertype":"limit","price":"10"},"vol":"2","vol_exec":"0","status":status})
    }
    fn synthetic_market_assets() -> BTreeMap<String, Pair> {
        serde_json::from_value(json!({
            "XXLMZUSD":{"altname":"XLMUSD","wsname":"XLM/USD","base":"XXLM","quote":"ZUSD","lot_decimals":8,"pair_decimals":5,"ordermin":"1"},
            "USDCUSD":{"altname":"USDCUSD","wsname":"USDC/USD","base":"USDC","quote":"ZUSD","lot_decimals":8,"pair_decimals":5,"ordermin":"1"}
        })).unwrap()
    }
    fn ledger(amount: &str, fee: &str, asset: &str) -> Value {
        json!({"type":"trade","asset":asset,"amount":amount,"fee":fee,"refid":"T-ONE"})
    }
    fn destination() -> Destination {
        Destination {
            wallet_id: "ABTEST1-TEST2-TEST33".into(),
            method_id: METHOD.into(),
            address: "fixture-address".into(),
            memo: None,
            network: "Bitcoin".into(),
        }
    }
    fn rule() -> WatchRule {
        WatchRule {
            asset: "BTC".into(),
            enabled: true,
            destinations: vec![destination()],
            order_types: vec!["market".into()],
            sides: vec!["buy".into()],
            pairs: vec![],
            order_ids: vec![],
            chunk: "10".into(),
            minimum: "1".into(),
            reserve: "5".into(),
            max_fee: "1".into(),
            max_fee_percent: "10".into(),
            daily_fee_budget: None,
        }
    }
    #[test]
    fn legacy_asset_codes_follow_market_metadata_without_merging_earn_buckets() {
        let pairs:BTreeMap<String,Pair>=serde_json::from_value(json!({"XREPZUSD":{"altname":"REPUSD","wsname":"REP/USD","base":"XREP","quote":"ZUSD","lot_decimals":8,"pair_decimals":3,"ordermin":"1","status":"online"}})).unwrap();
        assert_eq!(canonical_asset(&pairs, "XREP"), "REP");
        assert_eq!(find_pair(&pairs, "REP/USD").unwrap().canonical(), "REP/USD");
        assert_eq!(canonical_asset(&pairs, "REP.F"), "REP.F");
    }
    #[test]
    fn pair_metadata_accepts_display_aliases_but_rejects_unknown_or_ambiguous_pairs() {
        let mut pairs: BTreeMap<String, Pair> = serde_json::from_value(pair()).unwrap();
        for name in ["XXBTZUSD", "XBTUSD", "XBT/USD", "BTC/USD", "BTCUSD"] {
            assert_eq!(find_pair(&pairs, name).unwrap().canonical(), "BTC/USD");
        }
        assert!(
            find_pair(&pairs, "MISSINGUSD")
                .unwrap_err()
                .to_string()
                .contains("MISSINGUSD")
        );
        let other: BTreeMap<String, Pair> = serde_json::from_value(json!({
            "OTHER": {"altname":"OTHER","wsname":"BT/CUSD","base":"BT","quote":"CUSD","lot_decimals":8,"pair_decimals":1,"ordermin":"1"}
        })).unwrap();
        pairs.extend(other);
        assert!(
            find_pair(&pairs, "BTCUSD").is_err(),
            "an ambiguous compact alias cannot identify settlement assets"
        );
        assert_eq!(find_pair(&pairs, "BTC/USD").unwrap().canonical(), "BTC/USD");
    }
    #[test]
    fn orders_keep_unmapped_pair_names_without_weakening_amount_validation() {
        let pairs: BTreeMap<String, Pair> = serde_json::from_value(pair()).unwrap();
        for status in ["open", "closed", "canceled", "expired"] {
            let value = raw_order("UNLISTEDUSD", status);
            let order = parse_order("O-OLD", &value, &pairs).unwrap();
            assert_eq!(order.pair, "UNLISTEDUSD");
            assert_eq!(order.status, status);
        }
        let mut invalid = raw_order("UNLISTEDUSD", "open");
        invalid["vol_exec"] = json!("-1");
        assert!(parse_order("O-OLD", &invalid, &pairs).is_err());
        assert!(parse_order("O-OLD", &raw_order("", "closed"), &pairs).is_err());
        assert!(parse_order("O-OLD", &raw_order("BAD\nPAIR", "closed"), &pairs).is_err());
    }
    #[test]
    fn historical_order_metadata_miss_does_not_discard_valid_settled_fills() {
        let (origin, server) = server(vec![
            (200, envelope(pair())),
            (
                200,
                envelope(json!({"count":1,"trades":{"T-ONE":raw_trade("T-ONE","buy","market")}})),
            ),
            (
                200,
                envelope(
                    json!({"T-ONE-base":ledger("2","0.001","XXBT"),"T-ONE-quote":ledger("-20","0","ZUSD")}),
                ),
            ),
            (
                200,
                envelope(json!({"XXBT":{"balance":"1.999","hold_trade":"0"}})),
            ),
            (
                200,
                envelope(json!({"open":{"O-CURRENT":raw_order("XBTUSD","open")}})),
            ),
            (
                200,
                envelope(json!({"closed":{"O-OLD":raw_order("UNLISTEDUSD","canceled")}})),
            ),
        ]);
        let reply = execute_with(
            &mut reader(origin),
            &credential(),
            &Operation::Reconcile {
                start: 100,
                end: 102,
            },
        )
        .unwrap();
        let Reply::Sync {
            trades,
            accounting_balances,
            orders,
            end,
            ..
        } = reply
        else {
            panic!("expected full reconciliation");
        };
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].received_asset, "BTC");
        assert_eq!(trades[0].received, "1.999");
        assert_eq!(accounting_balances[0].asset, "BTC");
        assert_eq!(orders.len(), 2);
        assert_eq!(orders[0].pair, "BTC/USD");
        assert_eq!(orders[1].pair, "UNLISTEDUSD");
        assert_eq!(end, 102);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(
            requests
                .iter()
                .all(|r| !r.uri.contains("AddOrder") && !r.uri.contains("withdraw"))
        );
    }
    #[test]
    fn missing_fill_metadata_still_blocks_settlement_and_identifies_the_pair() {
        let pairs: BTreeMap<String, Pair> = serde_json::from_value(pair()).unwrap();
        let mut raw = raw_trade("T-ONE", "buy", "market");
        raw["pair"] = json!("UNLISTEDUSD");
        let error = parse_trade(
            "T-ONE",
            &raw,
            &pairs,
            &BTreeMap::new(),
            &mut BTreeSet::new(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("UNLISTEDUSD"));
        assert!(error.contains("metadata"));
    }
    #[test]
    fn synthetic_fills_use_settlement_assets_and_fees_without_a_native_market() {
        let pairs = synthetic_market_assets();
        assert!(
            find_pair(&pairs, "XLM/USDC").is_err(),
            "synthetic markets cannot borrow another market's order limits"
        );
        for pair_name in ["XLM/USDC", "XXLM/USDC"] {
            for side in ["buy", "sell"] {
                for fee_on_received in [true, false] {
                    let mut raw = raw_trade("T-ONE", side, "limit");
                    raw["pair"] = json!(pair_name);
                    let credit_fee = if fee_on_received { "0.001" } else { "0" };
                    let debit_fee = if fee_on_received { "0" } else { "0.1" };
                    let ledgers = if side == "buy" {
                        BTreeMap::from([
                            ("T-ONE-base".into(), ledger("2", credit_fee, "XXLM")),
                            ("T-ONE-quote".into(), ledger("-20", debit_fee, "USDC")),
                        ])
                    } else {
                        BTreeMap::from([
                            ("T-ONE-base".into(), ledger("-2", debit_fee, "XXLM")),
                            ("T-ONE-quote".into(), ledger("20", credit_fee, "USDC")),
                        ])
                    };
                    let fill =
                        parse_trade("T-ONE", &raw, &pairs, &ledgers, &mut BTreeSet::new()).unwrap();
                    assert_eq!(fill.pair, "XLM/USDC");
                    assert_eq!(
                        fill.received_asset,
                        if side == "buy" { "XLM" } else { "USDC" }
                    );
                    let gross = if side == "buy" { "2" } else { "20" };
                    assert_eq!(
                        amount(&fill.received).unwrap(),
                        decimal(gross).unwrap() - decimal(credit_fee).unwrap()
                    );
                    let spent = if side == "buy" { "USDC" } else { "XLM" };
                    let debit = if side == "buy" { "20" } else { "2" };
                    assert_eq!(
                        amount(&fill.debits[spent]).unwrap(),
                        decimal(debit).unwrap() + decimal(debit_fee).unwrap()
                    );
                }
            }
        }
    }
    #[test]
    fn synthetic_fills_reject_unverified_assets_missing_ledgers_and_mismatched_settlement() {
        let pairs = synthetic_market_assets();
        let mut raw = raw_trade("T-ONE", "buy", "limit");
        raw["pair"] = json!("XLM/USDC");
        let ledgers = BTreeMap::from([
            ("T-ONE-base".into(), ledger("2", "0", "XXLM")),
            ("T-ONE-quote".into(), ledger("-20", "0", "USDC")),
        ]);
        for name in [
            "UNKNOWN/USDC",
            "XLM/UNKNOWN",
            "XLM.F/USDC",
            "XLM/XLM",
            "XLMUSDC",
            "XLM/USDC/USD",
        ] {
            let mut invalid = raw.clone();
            invalid["pair"] = json!(name);
            assert!(
                parse_trade("T-ONE", &invalid, &pairs, &ledgers, &mut BTreeSet::new()).is_err(),
                "must reject {name}"
            );
        }
        let mut margin = raw.clone();
        margin["margin"] = json!("1");
        assert!(parse_trade("T-ONE", &margin, &pairs, &ledgers, &mut BTreeSet::new()).is_err());
        assert!(
            parse_trade(
                "T-ONE",
                &raw,
                &pairs,
                &BTreeMap::new(),
                &mut BTreeSet::new()
            )
            .is_err()
        );
        for (field, value) in [
            ("asset", "ZUSD"),
            ("amount", "3"),
            ("type", "deposit"),
            ("fee", "3"),
        ] {
            let mut invalid = ledgers.clone();
            invalid.get_mut("T-ONE-base").unwrap()[field] = json!(value);
            assert!(
                parse_trade("T-ONE", &raw, &pairs, &invalid, &mut BTreeSet::new()).is_err(),
                "must reject bad ledger {field}"
            );
        }
        let mut used = BTreeSet::new();
        parse_trade("T-ONE", &raw, &pairs, &ledgers, &mut used).unwrap();
        assert!(parse_trade("T-OTHER", &raw, &pairs, &ledgers, &mut used).is_err());
    }
    #[test]
    fn rest_fills_use_actual_ledger_fee_currency_and_exact_partial_amounts() {
        let pairs: BTreeMap<String, Pair> = serde_json::from_value(pair()).unwrap();
        for kind in ORDER_TYPES {
            for side in ["buy", "sell"] {
                let mut raw = raw_trade("T-ONE", side, kind);
                raw["tradeordertype"] = json!("market");
                let ledgers = if side == "buy" {
                    BTreeMap::from([
                        ("T-ONE-base".into(), ledger("2", "0.001", "XXBT")),
                        ("T-ONE-quote".into(), ledger("-20", "0", "ZUSD")),
                    ])
                } else {
                    BTreeMap::from([
                        ("T-ONE-base".into(), ledger("-2", "0", "XXBT")),
                        ("T-ONE-quote".into(), ledger("20", "0.1", "ZUSD")),
                    ])
                };
                let fill =
                    parse_trade("T-ONE", &raw, &pairs, &ledgers, &mut BTreeSet::new()).unwrap();
                assert_eq!(fill.received, if side == "buy" { "1.999" } else { "19.9" });
                assert_eq!(fill.time, "101.123456789");
                assert_eq!(fill.order_type, *kind);
                assert_eq!(
                    fill.debits[if side == "buy" { "USD" } else { "BTC" }],
                    if side == "buy" { "20" } else { "2" }
                );
            }
        }
    }
    #[test]
    fn history_pages_and_ledger_queries_are_complete_before_balances_can_be_reconciled() {
        let pages = vec![
            (
                200,
                envelope(json!({"count":2,"trades":{"T-ONE":raw_trade("T-ONE","buy","market")}})),
            ),
            (
                200,
                envelope(
                    json!({"count":2,"trades":{"T-TWO":raw_trade("T-TWO","sell","stop-loss")}}),
                ),
            ),
            (
                200,
                envelope(
                    json!({"T-ONE-base":ledger("2","0","XXBT"),"T-ONE-quote":ledger("-20","0.1","ZUSD"),"T-TWO-base":ledger("-2","0","XXBT"),"T-TWO-quote":ledger("20","0.1","ZUSD")}),
                ),
            ),
        ];
        let (origin, server) = server(pages);
        let mut api = reader(origin);
        let key = credential();
        let fills = trades(
            &mut api,
            &key,
            &serde_json::from_value(pair()).unwrap(),
            100,
            102,
        )
        .unwrap();
        assert_eq!(fills.len(), 2);
        let req = server.join().unwrap();
        assert!(
            req[0].body.contains("consolidate_taker=false") && req[0].body.contains("ledgers=true")
        );
        assert!(req[1].body.contains("ofs=1"));
        assert_eq!(req[2].uri, "/0/private/QueryLedgers");
        for (i, r) in req.iter().enumerate() {
            assert_eq!(
                r.headers["api-sign"],
                signature(&key.api_secret, &r.uri, 101 + i as u64, &r.body).unwrap()
            );
        }
    }
    #[test]
    fn incomplete_pages_missing_ledgers_and_shared_ledger_ambiguity_do_not_credit_funds() {
        let (origin, server) = server(vec![(200, envelope(json!({"count":1,"trades":{}})))]);
        let pairs: BTreeMap<String, Pair> = serde_json::from_value(pair()).unwrap();
        assert!(trades(&mut reader(origin), &credential(), &pairs, 100, 102).is_err());
        server.join().unwrap();
        let raw = raw_trade("T-ONE", "buy", "market");
        assert!(
            parse_trade(
                "T-ONE",
                &raw,
                &pairs,
                &BTreeMap::new(),
                &mut BTreeSet::new()
            )
            .is_err()
        );
        let ledgers = BTreeMap::from([
            ("T-ONE-base".into(), ledger("3", "0", "XXBT")),
            ("T-ONE-quote".into(), ledger("-20", "0.1", "ZUSD")),
        ]);
        assert!(parse_trade("T-ONE", &raw, &pairs, &ledgers, &mut BTreeSet::new()).is_err());
    }
    #[test]
    fn funding_quote_checks_pinned_destination_current_limits_reserve_and_quoted_fee() {
        let (origin, server) = server(vec![
            (
                200,
                json!({"networks":[{"network_id":"btc","name":"Bitcoin"}],"network_groups":[]}),
            ),
            (
                200,
                json!({"methods":[{"method_id":METHOD,"asset":{"name":"BTC"},"network":{"network_id":"btc","network_name":"Bitcoin"},"minimum_amount":"1","maximum_amount":"100"}]}),
            ),
            (
                200,
                json!({"addresses":[{"address_id":destination().wallet_id,"name":"fixture","verified":true,"scope":{"method_id":METHOD},"address_details":{"crypto":{"address":"fixture-address"}}}]}),
            ),
            (
                200,
                json!({"available_balance":money("12"),"withdrawal_limits":[{"method_id":METHOD,"maximum_amount":money("100")}]}),
            ),
            (
                200,
                json!({"gross_amount":money("7"),"net_amount":money("6.5"),"fee":money("0.5"),"withdrawal_fee_token":"fixture-token"}),
            ),
        ]);
        let q = quote(
            &mut reader(origin),
            &credential(),
            &rule(),
            &destination(),
            "100",
        )
        .unwrap();
        assert_eq!(q.gross, "7");
        assert_eq!(q.fee, "0.5");
        let requests = server.join().unwrap();
        assert_eq!(
            requests[3].uri,
            "/funding/v1/limits/withdrawal/currency/BTC"
        );
        assert_eq!(
            requests[4].uri,
            format!("/funding/v1/fees/{METHOD}?amount=7&fee_included=true")
        );
        assert!(requests.iter().all(|r| r.method == "GET"));
    }
    #[test]
    fn submission_pins_address_fee_and_amount_and_never_retries_service_errors() {
        let t = Transfer {
            id: "local-one".into(),
            asset: "BTC".into(),
            gross: "10".into(),
            net: "9".into(),
            fee: "1".into(),
            destination: destination(),
            status: "submitting".into(),
            exchange_id: None,
            txid: None,
            error: None,
            created_at: 100,
            updated_at: 100,
        };
        for accepted in [true, false] {
            let (origin, server) = server(vec![if accepted {
                (
                    200,
                    json!({"withdrawal_id":"exchange-id","gross_amount":{"asset_amount":money("10")},"net_amount":{"asset_amount":money("9")},"fee":{"asset_amount":money("1")}}),
                )
            } else {
                (503, json!({"private":"never echo this"}))
            }]);
            let key = credential();
            let mut api = reader(origin);
            let reply = execute_with(
                &mut api,
                &key,
                &Operation::Submit {
                    transfer: t.clone(),
                    token: Secret("fixture-pinned-fee".into()),
                },
            )
            .unwrap();
            if accepted {
                assert!(matches!(
                    reply,
                    Reply::Submitted(Submission::Accepted { .. })
                ));
            } else {
                assert!(matches!(reply, Reply::Submitted(Submission::Unknown(_))));
            }
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 1);
            let r = &requests[0];
            assert_eq!(r.method, "POST");
            assert_eq!(r.uri, "/funding/v1/withdrawals");
            assert_eq!(r.headers["api-nonce"], "101");
            assert_eq!(
                r.headers["api-sign"],
                signature(&key.api_secret, &r.uri, 101, &r.body).unwrap()
            );
            let body: Value = serde_json::from_str(&r.body).unwrap();
            assert_eq!(body["expected_address"], "fixture-address");
            assert_eq!(body["fee"]["quoted_fee"]["token"], "fixture-pinned-fee");
            assert_eq!(body["fee"]["fee_included"], true);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let mut api = Reader::new("http://127.0.0.1:1".into(), 100, cancel.clone()).unwrap();
        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(
            execute_with(
                &mut api,
                &credential(),
                &Operation::Submit {
                    transfer: t,
                    token: Secret("fixture".into())
                }
            )
            .unwrap(),
            Reply::Submitted(Submission::Rejected(_))
        ));
    }
    #[test]
    fn undersized_orders_report_trading_minimum_before_any_order_submission() {
        for (volume, expected) in [
            (
                "180000",
                "SHIB/USDC trading minimum is 770000 SHIB; requested 180000 SHIB. No order was sent",
            ),
            (
                "770000.000001",
                "SHIB/USDC order size allows at most 5 decimal places. No order was sent",
            ),
        ] {
            let command = OrderCommand {
                request_id: "minimum-fixture".into(),
                account: "main".into(),
                action: OrderAction::Place {
                    pair: "SHIB/USDC".into(),
                    side: "buy".into(),
                    order_type: "market".into(),
                    volume: volume.into(),
                    price: None,
                    price2: None,
                    post_only: false,
                },
            };
            let (origin, server) = server(vec![
                (200, key_info(&["query-funds", "modify-trades"])),
                (
                    200,
                    envelope(json!({"SHIBUSDC":{
                        "altname":"SHIBUSDC","wsname":"SHIB/USDC","base":"SHIB","quote":"USDC",
                        "lot_decimals":5,"pair_decimals":9,"ordermin":"770000","costmin":"0.5","status":"online"
                    }})),
                ),
            ]);
            let Submission::Rejected(message) = order(&mut reader(origin), &credential(), &command)
            else {
                panic!("invalid size must be rejected before dispatch");
            };
            assert_eq!(message, expected);
            let requests = server.join().unwrap();
            assert_eq!(
                requests.iter().map(|r| r.uri.as_str()).collect::<Vec<_>>(),
                ["/0/private/GetApiKeyInfo", "/0/public/AssetPairs"]
            );
        }
    }

    #[test]
    fn order_writes_have_client_ids_and_no_validate_request_is_sent() {
        let command = OrderCommand {
            request_id: "moby-test-1".into(),
            account: "main".into(),
            action: OrderAction::Place {
                pair: "BTC/USD".into(),
                side: "buy".into(),
                order_type: "limit".into(),
                volume: "0.001".into(),
                price: Some("1000".into()),
                price2: None,
                post_only: true,
            },
        };
        let (origin, server) = server(vec![
            (200, key_info(&["query-funds", "modify-trades"])),
            (200, envelope(pair())),
            (200, envelope(json!({"txid":["ORDER-ONE"]}))),
        ]);
        assert!(matches!(
            order(&mut reader(origin), &credential(), &command),
            Submission::Accepted { .. }
        ));
        let requests = server.join().unwrap();
        assert_eq!(requests[2].uri, "/0/private/AddOrder");
        assert!(requests[2].body.contains("cl_ord_id=moby-test-1"));
        assert!(!requests[2].body.contains("validate"));
    }
}

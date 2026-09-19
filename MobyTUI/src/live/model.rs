use crate::model::{amount, positive, text};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const ORDER_TYPES: &[&str] = &[
    "market",
    "limit",
    "take-profit",
    "take-profit-limit",
    "stop-loss",
    "stop-loss-limit",
    "trailing-stop",
    "trailing-stop-limit",
    "iceberg",
];

pub fn asset(value: &str) -> String {
    match value {
        "XXBT" | "XBT" => "BTC",
        "XETH" => "ETH",
        "ZUSD" => "USD",
        "ZEUR" => "EUR",
        "ZGBP" => "GBP",
        "ZCAD" => "CAD",
        "ZJPY" => "JPY",
        "ZAUD" => "AUD",
        "XLTC" => "LTC",
        "XXRP" => "XRP",
        "XXLM" => "XLM",
        "XDG" | "XXDG" | "XDOGE" => "DOGE",
        "XETC" => "ETC",
        "XXMR" => "XMR",
        "XZEC" => "ZEC",
        _ => value,
    }
    .to_owned()
}
fn symbol(s: &str) -> Result<()> {
    ensure!(
        !s.is_empty()
            && s.len() <= 16
            && s.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
        "use canonical uppercase crypto asset symbols"
    );
    ensure!(asset(s) == s, "use canonical symbol {}", asset(s));
    Ok(())
}
fn default_poll() -> u64 {
    30
}
fn default_inflight() -> usize {
    2
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Destination {
    pub wallet_id: String,
    pub method_id: String,
    pub address: String,
    pub memo: Option<String>,
    pub network: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WatchRule {
    pub asset: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub destinations: Vec<Destination>,
    pub order_types: Vec<String>,
    pub sides: Vec<String>,
    /// Empty means any pair. Otherwise canonical BASE/QUOTE symbols.
    #[serde(default)]
    pub pairs: Vec<String>,
    /// Empty means all orders matching the other filters, including external orders.
    #[serde(default)]
    pub order_ids: Vec<String>,
    /// Gross amount debited per chunk, INCLUDING the withdrawal fee.
    pub chunk: String,
    /// Minimum net amount after withdrawal fees; must cover every destination's synced Kraken minimum.
    pub minimum: String,
    pub reserve: String,
    pub max_fee: String,
    pub max_fee_percent: String,
    /// Optional rolling 24-hour fee budget denominated in this asset.
    pub daily_fee_budget: Option<String>,
    pub cooldown_seconds: u64,
}
impl WatchRule {
    pub fn validate(&self) -> Result<()> {
        symbol(&self.asset)?;
        ensure!(
            !self.destinations.is_empty() && self.destinations.len() <= 64,
            "each rule needs 1–64 saved destinations"
        );
        let mut seen = BTreeSet::new();
        for d in &self.destinations {
            text(&d.wallet_id, "wallet ID")?;
            uuid::Uuid::parse_str(&d.method_id)
                .map_err(|_| anyhow::anyhow!("method ID must be a Kraken funding UUID"))?;
            ensure!(
                !d.address.is_empty()
                    && d.address.len() <= 512
                    && !d.address.chars().any(char::is_control),
                "invalid expected address"
            );
            if let Some(memo) = &d.memo {
                text(memo, "memo/tag")?;
            }
            text(&d.network, "network")?;
            ensure!(
                seen.insert((&d.wallet_id, &d.method_id)),
                "duplicate destination"
            );
        }
        ensure!(
            !self.order_types.is_empty()
                && self.order_types.len() <= ORDER_TYPES.len()
                && self
                    .order_types
                    .iter()
                    .all(|s| ORDER_TYPES.contains(&s.as_str())),
            "select supported order types"
        );
        ensure!(
            !self.sides.is_empty()
                && self.sides.len() <= 2
                && self.sides.iter().all(|s| s == "buy" || s == "sell"),
            "sides must contain buy and/or sell"
        );
        ensure!(
            self.pairs.len() <= 100 && self.order_ids.len() <= 100,
            "too many watch filters"
        );
        for pair in &self.pairs {
            let (a, b) = pair
                .split_once('/')
                .ok_or_else(|| anyhow::anyhow!("pairs must use BASE/QUOTE"))?;
            symbol(a)?;
            symbol(b)?;
        }
        for id in &self.order_ids {
            text(id, "order ID")?;
        }
        ensure!(
            positive(&self.chunk)? >= amount(&self.minimum)?,
            "chunk must cover minimum"
        );
        amount(&self.reserve)?;
        amount(&self.max_fee)?;
        ensure!(
            amount(&self.max_fee_percent)? <= rust_decimal::Decimal::from(100),
            "maximum fee percent exceeds 100"
        );
        if let Some(budget) = &self.daily_fee_budget {
            positive(budget)?;
        }
        ensure!(
            (1..=86400).contains(&self.cooldown_seconds),
            "cooldown must be 1–86400 seconds"
        );
        Ok(())
    }
    pub fn matches(&self, fill: &Trade) -> bool {
        self.enabled
            && self.asset == fill.received_asset
            && !fill.margin
            && self.sides.contains(&fill.side)
            && self.order_types.contains(&fill.order_type)
            && (self.pairs.is_empty() || self.pairs.contains(&fill.pair))
            && (self.order_ids.is_empty() || self.order_ids.contains(&fill.order_id))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema_version: u32,
    pub account: String,
    #[serde(default = "default_poll")]
    pub poll_seconds: u64,
    #[serde(default = "default_inflight")]
    pub max_inflight: usize,
    #[serde(default = "yes")]
    pub websocket: bool,
    pub rules: Vec<WatchRule>,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1,
            "unsupported watch configuration schema"
        );
        text(&self.account, "account name")?;
        ensure!(
            (10..=300).contains(&self.poll_seconds),
            "REST polling must be 10–300 seconds"
        );
        ensure!(
            (1..=4).contains(&self.max_inflight),
            "global inflight limit must be 1–4 (one per asset)"
        );
        ensure!(
            !self.rules.is_empty() && self.rules.len() <= 32,
            "configure 1–32 asset rules"
        );
        let mut seen = BTreeSet::new();
        for rule in &self.rules {
            rule.validate()?;
            ensure!(seen.insert(&rule.asset), "duplicate asset rule");
        }
        Ok(())
    }
    pub fn digest(&self) -> Result<String> {
        self.validate()?;
        digest(self)
    }
}
pub fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Trade {
    pub id: String,
    pub order_id: String,
    pub pair: String,
    pub side: String,
    pub order_type: String,
    /// Exact epoch seconds, including subsecond portion.
    pub time: String,
    pub margin: bool,
    pub received_asset: String,
    pub received: String,
    /// Actual ledger debits including fees, even for excluded fills.
    pub debits: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Queue {
    pub amount: String,
    pub last_submission: i64,
    pub destination_index: usize,
    pub blocked: Option<String>,
    pub retry_at: i64,
    pub failures: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transfer {
    pub id: String,
    pub asset: String,
    pub gross: String,
    pub net: String,
    pub fee: String,
    pub destination: Destination,
    pub status: String,
    pub exchange_id: Option<String>,
    pub txid: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
impl Transfer {
    pub fn active(&self) -> bool {
        matches!(
            self.status.as_str(),
            "submitting" | "pending" | "held" | "unknown"
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Order {
    pub id: String,
    pub pair: String,
    pub side: String,
    pub order_type: String,
    pub volume: String,
    pub filled: String,
    pub price: String,
    pub status: String,
    pub client_id: Option<String>,
}
impl Order {
    pub fn is_cancelled(&self) -> bool {
        matches!(self.status.as_str(), "canceled" | "cancelled")
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum OrderAction {
    Place {
        pair: String,
        side: String,
        order_type: String,
        volume: String,
        price: Option<String>,
        price2: Option<String>,
        #[serde(default)]
        post_only: bool,
    },
    Amend {
        order_id: String,
        volume: Option<String>,
        limit_price: Option<String>,
        trigger_price: Option<String>,
    },
    Cancel {
        order_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OrderCommand {
    pub request_id: String,
    pub account: String,
    #[serde(rename = "order")]
    pub action: OrderAction,
}
impl OrderCommand {
    pub fn validate(&self) -> Result<()> {
        // Kraken cl_ord_id free text has an 18 character limit.
        ensure!(
            !self.request_id.is_empty()
                && self.request_id.len() <= 18
                && self
                    .request_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "request_id must be 1–18 letters, digits or hyphens"
        );
        text(&self.account, "account")?;
        match &self.action {
            OrderAction::Place {
                pair,
                side,
                order_type,
                volume,
                price,
                price2,
                post_only,
            } => {
                let (a, b) = pair
                    .split_once('/')
                    .ok_or_else(|| anyhow::anyhow!("pair must use BASE/QUOTE"))?;
                symbol(a)?;
                symbol(b)?;
                ensure!(side == "buy" || side == "sell", "side must be buy or sell");
                ensure!(
                    ORDER_TYPES.contains(&order_type.as_str()) && order_type != "iceberg",
                    "unsupported placement type; iceberg fills can still be monitored"
                );
                positive(volume)?;
                let needs_price = order_type != "market";
                ensure!(
                    price.is_some() == needs_price,
                    "this order type requires a price or trigger (market requires none)"
                );
                let needs_price2 = matches!(
                    order_type.as_str(),
                    "stop-loss-limit" | "take-profit-limit" | "trailing-stop-limit"
                );
                ensure!(
                    price2.is_some() == needs_price2,
                    "price2 is required only for conditional limit orders"
                );
                for p in [price, price2].into_iter().flatten() {
                    // Trailing orders need a relative offset, Kraken +/- or % syntax.
                    let numeric = p.trim_start_matches(['+', '-']).trim_end_matches('%');
                    positive(numeric)?;
                    ensure!(p.len() <= 42, "invalid price");
                    if !order_type.starts_with("trailing-") {
                        positive(p)?;
                    }
                }
                if order_type.starts_with("trailing-") {
                    ensure!(
                        price
                            .as_ref()
                            .is_some_and(|p| p.starts_with('+') || p.starts_with('-')),
                        "trailing trigger needs a signed offset"
                    );
                }
                ensure!(
                    !post_only || order_type == "limit",
                    "post_only is only supported for limit orders"
                );
            }
            OrderAction::Amend {
                order_id,
                volume,
                limit_price,
                trigger_price,
            } => {
                text(order_id, "order ID")?;
                ensure!(
                    volume.is_some() || limit_price.is_some() || trigger_price.is_some(),
                    "specify an amendment"
                );
                for p in [volume, limit_price, trigger_price].into_iter().flatten() {
                    positive(p)?;
                }
            }
            OrderAction::Cancel { order_id } => text(order_id, "order ID")?,
        }
        Ok(())
    }
    pub fn digest(&self) -> Result<String> {
        self.validate()?;
        digest(self)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderReceipt {
    pub request: OrderCommand,
    pub digest: String,
    pub status: String,
    pub exchange_id: Option<String>,
    pub message: String,
    pub at: i64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Status {
    pub config: Option<Config>,
    pub config_digest: Option<String>,
    pub monitoring_since: Option<i64>,
    pub caught_up_through: Option<i64>,
    pub rest_updated_at: Option<i64>,
    pub rest_error: Option<String>,
    pub websocket: String,
    pub websocket_updated_at: Option<i64>,
    pub pending_ws_trades: u64,
    pub queues: BTreeMap<String, Queue>,
    pub trades: Vec<Trade>,
    pub transfers: Vec<Transfer>,
    pub orders: Vec<Order>,
    pub orders_updated_at: Option<i64>,
    pub orders_error: Option<String>,
    pub order_receipts: Vec<OrderReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FundingMethod {
    pub id: String,
    pub asset: String,
    pub network: String,
    pub minimum: Option<String>,
    pub maximum: Option<String>,
}

impl FundingMethod {
    pub fn withdrawal_minimum(&self) -> Result<rust_decimal::Decimal> {
        let minimum = self.minimum.as_deref().with_context(|| {
            format!(
                "Kraken minimum unavailable for {} on {}; sync Wallets with F before configuring withdrawals",
                self.asset, self.network
            )
        })?;
        amount(minimum).with_context(|| {
            format!(
                "Kraken minimum is invalid for {} on {}; sync Wallets with F",
                self.asset, self.network
            )
        })
    }
}

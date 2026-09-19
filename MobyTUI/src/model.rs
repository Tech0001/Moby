use anyhow::{Result, ensure};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn amount(value: &str) -> Result<Decimal> {
    ensure!(
        !value.is_empty() && value.len() <= 40,
        "invalid decimal length"
    );
    ensure!(
        value.bytes().all(|b| b.is_ascii_digit() || b == b'.'),
        "amount must be an unsigned decimal string"
    );
    let parsed = Decimal::from_str_exact(value)?;
    ensure!(
        parsed >= Decimal::ZERO && parsed.scale() <= 18,
        "amount must be nonnegative with at most 18 decimal places"
    );
    Ok(parsed)
}

pub fn positive(value: &str) -> Result<Decimal> {
    let parsed = amount(value)?;
    ensure!(parsed > Decimal::ZERO, "amount must be greater than zero");
    Ok(parsed)
}

pub fn add(a: Decimal, b: Decimal) -> Result<Decimal> {
    let result = a
        .checked_add(b)
        .ok_or_else(|| anyhow::anyhow!("decimal overflow"))?;
    // checked_add can reduce scale to fit the 96-bit mantissa. Reject any
    // rounding instead of silently dropping small amounts next to large ones.
    ensure!(
        result.checked_sub(a) == Some(b) && result.checked_sub(b) == Some(a),
        "decimal precision would be lost"
    );
    Ok(result)
}

pub fn subtract(a: Decimal, b: Decimal) -> Result<Decimal> {
    let result = a
        .checked_sub(b)
        .ok_or_else(|| anyhow::anyhow!("decimal overflow"))?;
    ensure!(
        result.checked_add(b) == Some(a) && a.checked_sub(result) == Some(b),
        "decimal precision would be lost"
    );
    Ok(result)
}

pub fn decimal(value: &str) -> Result<Decimal> {
    // Stored values have already been validated; never pass through floating point.
    Ok(Decimal::from_str(value)?)
}

pub fn text(value: &str, label: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= 128 && !value.chars().any(char::is_control),
        "{label} must be 1–128 characters without control characters"
    );
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub asset: String,
    pub destination: String,
    /// Amount received by the destination in the simulator, excluding its fee.
    pub chunk: String,
    pub minimum: String,
    pub reserve: String,
    pub fee: String,
    pub cooldown_seconds: u64,
}

impl Rule {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.asset.is_empty()
                && self.asset.len() <= 16
                && self
                    .asset
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            "asset must be an uppercase symbol"
        );
        text(&self.destination, "destination")?;
        let chunk = positive(&self.chunk)?;
        let minimum = positive(&self.minimum)?;
        ensure!(chunk >= minimum, "chunk must be at least the minimum");
        add(add(chunk, amount(&self.fee)?)?, amount(&self.reserve)?)?;
        ensure!(
            (1..=86400).contains(&self.cooldown_seconds),
            "cooldown must be 1–86400 seconds"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub schema_version: u32,
    pub account: String,
    pub rules: Vec<Rule>,
}

impl Plan {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.schema_version == 1, "unsupported plan schema");
        ensure!(
            self.account == "demo",
            "this prototype only supports the demo account"
        );
        ensure!(
            !self.rules.is_empty() && self.rules.len() <= 32,
            "a plan needs 1–32 rules"
        );
        let mut seen = std::collections::HashSet::new();
        for rule in &self.rules {
            rule.validate()?;
            ensure!(
                seen.insert(&rule.asset),
                "duplicate rule for {}",
                rule.asset
            );
        }
        Ok(())
    }

    pub fn digest(&self) -> Result<String> {
        self.validate()?;
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }

    pub fn demo() -> Self {
        serde_json::from_str(include_str!("../examples/demo-plan.json")).expect("bundled demo plan")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status,
    Stop,
    VaultCreate {
        password: crate::vault::Secret,
    },
    VaultUnlock {
        password: crate::vault::Secret,
    },
    VaultLock,
    SetKey {
        api_key: crate::vault::Secret,
        api_secret: crate::vault::Secret,
    },
    CheckKey,
    RemoveKey,
    RefreshWallets,
    RefreshBalances,
    RefreshOrders,
    ConfigureWatch {
        config: crate::live::Config,
        digest: String,
    },
    SetCooldown {
        asset: String,
        seconds: u64,
        expected_config: String,
    },
    SubmitOrder {
        order: Box<crate::live::OrderCommand>,
        digest: String,
    },
    AttachWithdrawalReceipt {
        id: String,
        exchange_id: String,
    },
    ResolveWithdrawalNotSent {
        id: String,
        digest: String,
        confirmed: bool,
    },
    SetTelegram {
        token: crate::vault::Secret,
        chat_id: String,
    },
    EnableTelegram {
        enabled: bool,
    },
    TestTelegram,
    Pause,
    Resume,
    ApplyPlan {
        plan: Plan,
        digest: String,
    },
    DemoFill {
        id: String,
        asset: String,
        amount: String,
    },
    DemoBalance {
        asset: String,
        amount: String,
    },
    DemoOutcome {
        outcome: Outcome,
    },
    DemoResolve {
        id: String,
        resolution: Resolution,
    },
    ClearQueue {
        digest: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStatus {
    pub label: String,
    pub saved: bool,
    pub checked_at: Option<i64>,
    pub permissions: Vec<String>,
    pub account_id: Option<String>,
    pub error: Option<String>,
}

impl KeyStatus {
    pub fn access(&self) -> String {
        if self.error.is_some() {
            return "Check failed".into();
        }
        if self.checked_at.is_none() {
            return "Not checked".into();
        }
        let has = |permission: &str| self.permissions.iter().any(|p| p == permission);
        let mut access = vec![];
        if has("query-funds") {
            access.push("Read");
        }
        if has("modify-trades") || has("close-trades") {
            access.push("Orders");
        }
        if has("withdraw-funds") {
            access.push("Withdrawals");
        }
        access.join(" / ")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wallet {
    pub id: String,
    pub name: String,
    pub address: String,
    pub memo: Option<String>,
    pub assets: Vec<String>,
    pub network: String,
    pub verified: bool,
    pub source: String,
    pub rule: Option<Rule>,
    #[serde(default)]
    pub methods: Vec<crate::live::model::FundingMethod>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AccountStatus {
    pub telegram: crate::notifications::Status,
    pub live: crate::live::Status,
    pub keys: Vec<KeyStatus>,
    pub wallets: Vec<Wallet>,
    pub wallets_updated_at: Option<i64>,
    pub sync_error: Option<String>,
    pub balances: Vec<AccountBalance>,
    pub balances_updated_at: Option<i64>,
    pub balances_error: Option<String>,
    pub busy: bool,
    pub refresh: AccountRefresh,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AccountRefresh {
    pub balances: RefreshStatus,
    pub orders: RefreshStatus,
    pub wallets: RefreshStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RefreshStatus {
    pub enabled: bool,
    pub stale: bool,
    pub refreshing: bool,
    pub interval_seconds: u64,
    pub next_refresh_at: Option<i64>,
}
impl Default for RefreshStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            stale: true,
            refreshing: false,
            interval_seconds: 0,
            next_refresh_at: None,
        }
    }
}
impl RefreshStatus {
    pub fn label(&self) -> &'static str {
        if !self.enabled {
            "Not refreshing"
        } else if self.stale {
            "STALE · last known data"
        } else if self.refreshing {
            "Refreshing"
        } else {
            "Current"
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountBalance {
    /// Kraken's asset code, retained exactly (including Earn/rewards suffixes).
    pub asset: String,
    pub balance: String,
    pub credit: String,
    pub credit_used: String,
    pub held_for_orders: String,
    /// Kraken's trading-availability formula; not a withdrawal quote.
    /// Suffixed asset buckets are shown separately without claiming availability.
    pub available_for_trading: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, clap::ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Complete,
    Held,
    Unknown,
    Rejected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, clap::ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    Complete,
    NotSent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetStatus {
    pub rule: Rule,
    pub queued: String,
    pub spendable: String,
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    pub id: String,
    pub asset: String,
    pub amount: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Withdrawal {
    pub id: String,
    pub asset: String,
    pub amount: String,
    pub fee: String,
    pub destination: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    pub at: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub protocol_version: u32,
    pub version: String,
    #[serde(default)]
    pub worker_pid: u32,
    pub mode: String,
    pub account: String,
    pub paused: bool,
    #[serde(default)]
    pub vault: crate::vault::VaultStatus,
    #[serde(default)]
    pub account_status: AccountStatus,
    pub started_at: i64,
    pub observed_at: i64,
    pub plan_digest: String,
    pub queue_digest: String,
    pub assets: Vec<AssetStatus>,
    pub fills: Vec<Fill>,
    pub withdrawals: Vec<Withdrawal>,
    pub activity: Vec<Activity>,
    pub fill_count: u64,
    pub completed_count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Snapshot>,
}

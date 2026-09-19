//! Read-only Kraken transport: key inspection, balances and saved destinations.
pub(crate) mod session;
use crate::{
    model::{AccountBalance, Wallet, add, subtract},
    vault::{Credential, Secret},
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use reqwest::{blocking::Client, header::HeaderValue};
use rust_decimal::Decimal;
use serde::{Deserialize, de::DeserializeOwned};
use sha2::{Digest, Sha256, Sha512};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

#[derive(Clone)]
pub(crate) struct Inspection {
    pub permissions: Vec<String>,
    pub account_id: String,
}
pub(crate) struct ReadResult {
    pub info: Inspection,
    pub wallets: Option<Vec<Wallet>>,
    pub balances: Option<Vec<AccountBalance>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadKind {
    Key,
    Wallets,
    Balances,
}

#[derive(Deserialize)]
struct KeyInfo {
    permissions: Vec<String>,
    iban: Secret,
}
#[derive(Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    error: Vec<String>,
    result: Option<T>,
}

pub(crate) fn signature(secret: &Secret, uri: &str, nonce: u64, body: &str) -> Result<String> {
    let decoded = Zeroizing::new(
        STANDARD
            .decode(&secret.0)
            .map_err(|_| anyhow::anyhow!("API secret must be base64 encoded"))?,
    );
    ensure!(!decoded.is_empty(), "API secret is empty");
    let mut hash = Sha256::new();
    hash.update(nonce.to_string());
    hash.update(body);
    let mut mac = Hmac::<Sha512>::new_from_slice(&decoded)
        .map_err(|_| anyhow::anyhow!("invalid API secret"))?;
    mac.update(uri.as_bytes());
    mac.update(&hash.finalize());
    Ok(STANDARD.encode(mac.finalize().into_bytes()))
}

pub(crate) struct Reader {
    client: Client,
    origin: String,
    nonce: u64,
    requests: u32,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    session: session::Shared,
}
impl Reader {
    #[cfg(test)]
    pub(crate) fn new(origin: String, nonce: u64, cancelled: Arc<AtomicBool>) -> Result<Self> {
        Self::with_session(origin, nonce, cancelled, session::Session::shared())
    }
    pub(crate) fn with_session(
        origin: String,
        nonce: u64,
        cancelled: Arc<AtomicBool>,
        session: session::Shared,
    ) -> Result<Self> {
        Ok(Self {
            session,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(10))
                .user_agent(concat!("Moby/", env!("CARGO_PKG_VERSION")))
                .build()?,
            origin,
            nonce,
            requests: 0,
            deadline: Instant::now() + Duration::from_secs(120),
            cancelled,
        })
    }
    fn request<T: DeserializeOwned>(
        &mut self,
        credential: &Credential,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T> {
        ensure!(
            [
                "/0/private/GetApiKeyInfo",
                "/0/private/BalanceEx",
                "/funding/v1/addresses",
                "/funding/v1/networks",
                "/funding/v1/methods/withdraw"
            ]
            .contains(&path),
            "endpoint is not read-only"
        );
        self.request_inner(credential, path, query)
    }
    fn request_inner<T: DeserializeOwned>(
        &mut self,
        credential: &Credential,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T> {
        ensure!(
            !self.cancelled.load(Ordering::Relaxed),
            "Kraken refresh cancelled"
        );
        let private_post = path.starts_with("/0/private/");
        let mut url = reqwest::Url::parse(&format!("{}{path}", self.origin))?;
        if !private_post && !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        let mut body = String::new();
        if private_post {
            let mut form = reqwest::Url::parse("http://localhost/")?;
            form.query_pairs_mut()
                .append_pair("nonce", &(self.nonce + 1).to_string())
                .extend_pairs(query.iter().copied());
            body = form.query().unwrap().into();
        }
        self.perform(
            Some(credential),
            url,
            if private_post { "POST" } else { "GET" },
            body,
            "application/x-www-form-urlencoded",
        )
    }
    pub(crate) fn private<T: DeserializeOwned>(
        &mut self,
        credential: &Credential,
        operation: &str,
        params: &[(&str, &str)],
    ) -> Result<T> {
        ensure!(
            [
                "TradesHistory",
                "QueryLedgers",
                "OpenOrders",
                "ClosedOrders",
                "QueryOrders",
                "GetWebSocketsToken",
                "AddOrder",
                "AmendOrder",
                "CancelOrder"
            ]
            .contains(&operation),
            "unsupported private operation"
        );
        let envelope: Envelope<T> =
            self.request_inner(credential, &format!("/0/private/{operation}"), params)?;
        if !envelope.error.is_empty() {
            // Only known request rejections prove that no order was accepted.
            // Translate known codes to local text; never echo arbitrary exchange
            // text or argument suffixes, which may contain secrets or user data.
            let reasons: Option<Vec<_>> = envelope
                .error
                .iter()
                .map(|error| private_rejection(operation, error))
                .collect();
            let definite = envelope.result.is_none() && reasons.is_some();
            let message = if definite {
                format!("Kraken {operation}: {}", reasons.unwrap().join("; "))
            } else if matches!(operation, "AddOrder" | "AmendOrder" | "CancelOrder") {
                format!(
                    "Kraken {operation} returned an unclassified error; check account activity before retrying a write"
                )
            } else {
                format!(
                    "Kraken {operation} returned an unclassified error; check API restrictions and service status"
                )
            };
            return Err(if definite {
                anyhow::Error::new(crate::live::transport::Rejected(message))
            } else {
                anyhow::anyhow!(message)
            });
        }
        envelope.result.context("Kraken returned no result")
    }
    pub(crate) fn public<T: DeserializeOwned>(&mut self, operation: &str) -> Result<T> {
        ensure!(
            ["AssetPairs", "Assets"].contains(&operation),
            "unsupported public operation"
        );
        if let Some(value) = self.session.lock().unwrap().get(operation, 3600) {
            return serde_json::from_value(value)
                .map_err(|_| anyhow::anyhow!("invalid cached market metadata"));
        }
        let url = reqwest::Url::parse(&format!("{}/0/public/{operation}", self.origin))?;
        let envelope: Envelope<serde_json::Value> =
            self.perform(None, url, "GET", String::new(), "application/json")?;
        ensure!(envelope.error.is_empty(), "Kraken metadata request failed");
        let value = envelope
            .result
            .context("Kraken returned no market metadata")?;
        let parsed = serde_json::from_value(value.clone())
            .map_err(|_| anyhow::anyhow!("invalid Kraken market metadata"))?;
        self.session.lock().unwrap().put(operation, value);
        Ok(parsed)
    }
    pub(crate) fn closed_orders(&mut self, credential: &Credential) -> Result<serde_json::Value> {
        if let Some(value) = self.session.lock().unwrap().get("ClosedOrders", 120) {
            return Ok(value);
        }
        let value: serde_json::Value = self.private(credential, "ClosedOrders", &[("ofs", "0")])?;
        self.session
            .lock()
            .unwrap()
            .put("ClosedOrders", value.clone());
        Ok(value)
    }
    pub(crate) fn funding<T: DeserializeOwned>(
        &mut self,
        credential: &Credential,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&serde_json::Value>,
    ) -> Result<T> {
        ensure!(
            path.starts_with("/funding/v1/"),
            "unsupported funding endpoint"
        );
        let mut url = reqwest::Url::parse(&format!("{}{path}", self.origin))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        self.perform(
            Some(credential),
            url,
            if body.is_some() { "POST" } else { "GET" },
            body.map(serde_json::to_string)
                .transpose()?
                .unwrap_or_default(),
            "application/json",
        )
    }
    fn perform<T: DeserializeOwned>(
        &mut self,
        credential: Option<&Credential>,
        url: reqwest::Url,
        method: &str,
        body: String,
        content_type: &str,
    ) -> Result<T> {
        session::wait(&self.session, url.path(), &self.cancelled, self.deadline)?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(crate::live::transport::Rejected(
                "Request cancelled before dispatch".into(),
            )
            .into());
        }
        self.requests += 1;
        ensure!(self.requests <= 1000, "Kraken job request budget exceeded");
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .context("Kraken job timed out")?;
        self.nonce = self.nonce.checked_add(1).context("nonce overflow")?;
        let uri = match url.query() {
            Some(q) => format!("{}?{q}", url.path()),
            None => url.path().into(),
        };
        let beta = url.path().starts_with("/funding/");
        let operation = match url.path() {
            "/funding/v1/methods/withdraw" => "withdrawal methods",
            "/funding/v1/addresses" => "wallet addresses",
            "/funding/v1/networks" => "wallet networks",
            "/0/private/GetApiKeyInfo" => "key check",
            "/0/private/BalanceEx" => "account balances",
            _ => "request",
        };
        let max_response = if url.path().starts_with("/0/public/") {
            16 * 1024 * 1024
        } else {
            2 * 1024 * 1024
        };
        let mut request = self
            .client
            .request(reqwest::Method::from_bytes(method.as_bytes())?, url)
            .header("Content-Type", content_type)
            .body(body.clone());
        if let Some(credential) = credential {
            let mut key = HeaderValue::from_str(&credential.api_key.0)
                .map_err(|_| anyhow::anyhow!("invalid API key format"))?;
            key.set_sensitive(true);
            let mut sign = HeaderValue::from_str(&signature(
                &credential.api_secret,
                &uri,
                self.nonce,
                &body,
            )?)?;
            sign.set_sensitive(true);
            request = request.header("API-Key", key).header("API-Sign", sign);
            if beta {
                request = request.header("API-Nonce", self.nonce.to_string());
            }
        }
        // This is the final cancellation point. An already dispatched request may
        // complete after Pause/Lock, and its receipt must still be recorded.
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(crate::live::transport::Rejected(
                "Request cancelled before dispatch".into(),
            )
            .into());
        }
        let response = request
            .timeout(remaining.min(Duration::from_secs(10)))
            .send()
            .map_err(|_| {
                anyhow::anyhow!(
                    "Kraken connection failed or timed out; check your connection and try again"
                )
            })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            if status == 429 {
                let seconds = response
                    .headers()
                    .get("Retry-After")
                    .and_then(|s| s.to_str().ok())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(120);
                self.session.lock().unwrap().block(seconds);
            }
            let reason = match status {
                401 | 403 => {
                    "access rejected; check key permissions, IP restrictions and API authentication"
                }
                404 => "endpoint not found; check Moby's Kraken API compatibility",
                429 => "rate limit reached; wait before retrying",
                500..=599 => "service unavailable; try again later",
                _ => "request rejected",
            };
            // Operation names are local constants. Never include the response body,
            // request headers or query values in a displayed/persisted error.
            bail!("Kraken {operation}: HTTP {status}; {reason}");
        }
        let mut bytes = Zeroizing::new(Vec::new());
        response
            .take(max_response + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| anyhow::anyhow!("could not read Kraken response"))?;
        ensure!(
            bytes.len() as u64 <= max_response,
            "Kraken response exceeds size limit"
        );
        // A rate-limit response stops every kind of request for this account.
        // Never log a remote body or automatically retry a write.
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
            && let Some(errors) = value.get("error").and_then(|v| v.as_array())
        {
            for error in errors.iter().filter_map(|v| v.as_str()) {
                if error.contains("Rate limit") || error.contains("Throttled") {
                    let seconds = error
                        .rsplit(':')
                        .next()
                        .and_then(|s| s.trim().parse::<i64>().ok())
                        .map(|until| until.saturating_sub(crate::model::now()).max(1) as u64)
                        .unwrap_or(120);
                    self.session.lock().unwrap().block(seconds);
                    bail!("Kraken rate limit reached; all account requests are cooling down");
                }
            }
        }
        // Do not echo deserialization errors or response bodies; GetApiKeyInfo
        // includes the API key, and funding responses can contain personal data.
        serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("unexpected Kraken response format"))
    }
    pub(crate) fn inspect(&mut self, credential: &Credential) -> Result<Inspection> {
        if let Some(info) = self.session.lock().unwrap().inspection() {
            return Ok(info);
        }
        let envelope: Envelope<KeyInfo> =
            self.request(credential, "/0/private/GetApiKeyInfo", &[])?;
        if !envelope.error.is_empty() {
            let message = if envelope.error.iter().any(|e| e == "EAPI:Invalid nonce") {
                "Kraken rejected the nonce; use a dedicated API key for Moby"
            } else if envelope
                .error
                .iter()
                .any(|e| e.contains("Rate limit") || e.contains("Throttled"))
            {
                "Kraken rate limit reached; wait before retrying"
            } else {
                "Kraken rejected authentication; check the key, secret, IP restrictions and API 2FA settings"
            };
            bail!("{message}");
        }
        let info = envelope
            .result
            .context("Kraken returned no key information")?;
        ensure!(
            !info.iban.0.is_empty(),
            "Kraken did not identify the key's account"
        );
        ensure!(
            info.permissions.len() <= 64
                && info.permissions.iter().all(
                    |p| p.len() <= 64 && p.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
                ),
            "invalid permission list"
        );
        ensure!(
            info.permissions.iter().any(|p| p == "query-funds"),
            "enable Funds → Query on your Kraken key for wallet sync"
        );
        ensure!(
            !info
                .permissions
                .iter()
                .any(|p| p == "add-withdraw-address" || p == "update-withdraw-address"),
            "disable withdrawal address management on your Kraken key"
        );
        let info = Inspection {
            permissions: info.permissions,
            account_id: format!("{:x}", Sha256::digest(info.iban.0.as_bytes())),
        };
        self.session.lock().unwrap().inspected(info.clone());
        Ok(info)
    }
    pub(crate) fn wallets(&mut self, credential: &Credential) -> Result<Vec<Wallet>> {
        let cached = self.session.lock().unwrap().get("Networks", 3600);
        let value = match cached {
            Some(value) => value,
            None => {
                let value =
                    self.request::<serde_json::Value>(credential, "/funding/v1/networks", &[])?;
                // Only network descriptions are cached; destinations and minimums
                // are still revalidated when preparing a withdrawal.
                let _: Networks = serde_json::from_value(value.clone())
                    .map_err(|_| anyhow::anyhow!("invalid Kraken networks"))?;
                self.session.lock().unwrap().put("Networks", value.clone());
                value
            }
        };
        let networks: Networks = serde_json::from_value(value)
            .map_err(|_| anyhow::anyhow!("invalid Kraken networks"))?;
        let mut methods = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = BTreeSet::new();
        for _ in 0..20 {
            let query = if let Some(ref cursor) = cursor {
                vec![("cursor", cursor.as_str())]
            } else {
                vec![("limit", "500")]
            };
            let page: Methods = self.request(credential, "/funding/v1/methods/withdraw", &query)?;
            methods.extend(page.methods);
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
            ensure!(
                seen.insert(cursor.clone()),
                "Kraken repeated a funding cursor"
            );
        }
        ensure!(
            cursor.is_none(),
            "too many funding methods; sync incomplete"
        );
        let mut addresses = Vec::new();
        let mut seen = BTreeSet::new();
        for _ in 0..4 {
            let query = if let Some(ref cursor) = cursor {
                vec![("cursor", cursor.as_str())]
            } else {
                vec![("limit", "500")]
            };
            let page: Addresses = self.request(credential, "/funding/v1/addresses", &query)?;
            addresses.extend(page.addresses);
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
            ensure!(
                seen.insert(cursor.clone()),
                "Kraken repeated an address cursor"
            );
        }
        ensure!(
            cursor.is_none() && addresses.len() <= 2000,
            "too many saved addresses; sync incomplete"
        );
        map_wallets(addresses, networks, methods)
    }

    pub(crate) fn balances(&mut self, credential: &Credential) -> Result<Vec<AccountBalance>> {
        let response: Envelope<BTreeMap<String, ExtendedBalance>> =
            self.request(credential, "/0/private/BalanceEx", &[])?;
        ensure!(
            response.error.is_empty(),
            "Kraken rejected the balance query; check Funds → Query permission and retry"
        );
        let balances = response.result.context("Kraken returned no balance data")?;
        ensure!(
            balances.len() <= 2000,
            "Kraken balance list exceeds size limit"
        );
        balances
            .into_iter()
            .map(|(asset, b)| {
                ensure!(
                    !asset.is_empty()
                        && asset.len() <= 32
                        && asset
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-')),
                    "invalid asset code in Kraken balances"
                );
                ensure!(
                    b.credit >= Decimal::ZERO
                        && b.credit_used >= Decimal::ZERO
                        && b.hold_trade >= Decimal::ZERO,
                    "invalid credit or held amount in Kraken balances"
                );
                let available = subtract(
                    subtract(add(b.balance, b.credit)?, b.credit_used)?,
                    b.hold_trade,
                )?;
                Ok(AccountBalance {
                    available_for_trading: (!asset.contains('.'))
                        .then(|| available.normalize().to_string()),
                    asset,
                    balance: b.balance.normalize().to_string(),
                    credit: b.credit.normalize().to_string(),
                    credit_used: b.credit_used.normalize().to_string(),
                    held_for_orders: b.hold_trade.normalize().to_string(),
                })
            })
            .collect()
    }
}

#[derive(Deserialize)]
struct ExtendedBalance {
    #[serde(deserialize_with = "exact_decimal")]
    balance: Decimal,
    #[serde(deserialize_with = "exact_decimal")]
    hold_trade: Decimal,
    #[serde(default, deserialize_with = "exact_decimal")]
    credit: Decimal,
    #[serde(default, deserialize_with = "exact_decimal")]
    credit_used: Decimal,
}

fn exact_decimal<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Decimal, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let text = match value {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => n.to_string(),
        _ => return Err(serde::de::Error::custom("invalid balance amount")),
    };
    Decimal::from_str_exact(&text).map_err(|_| serde::de::Error::custom("invalid balance amount"))
}

pub(crate) fn read(
    credential: Credential,
    kind: ReadKind,
    nonce: u64,
    cancelled: Arc<AtomicBool>,
    session: session::Shared,
) -> Result<ReadResult> {
    let mut reader =
        Reader::with_session("https://api.kraken.com".into(), nonce, cancelled, session)?;
    if kind == ReadKind::Key {
        reader.session.lock().unwrap().invalidate_inspection();
    }
    let info = reader.inspect(&credential)?;
    let wallets = if kind == ReadKind::Wallets {
        Some(reader.wallets(&credential)?)
    } else {
        None
    };
    let balances = if kind == ReadKind::Balances {
        Some(reader.balances(&credential)?)
    } else {
        None
    };
    Ok(ReadResult {
        info,
        wallets,
        balances,
    })
}

#[derive(Deserialize)]
struct Addresses {
    addresses: Vec<Address>,
    next_cursor: Option<String>,
}
#[derive(Deserialize)]
struct Address {
    address_id: String,
    name: Option<String>,
    verified: bool,
    scope: BTreeMap<String, String>,
    address_details: AddressDetails,
}
#[derive(Deserialize)]
struct AddressDetails {
    crypto: Option<CryptoAddress>,
}
#[derive(Deserialize)]
struct CryptoAddress {
    address: String,
    memo: Option<String>,
    tag: Option<String>,
}
#[derive(Deserialize)]
struct Networks {
    networks: Vec<Network>,
    network_groups: Vec<NetworkGroup>,
}
#[derive(Deserialize)]
struct Network {
    network_id: String,
    name: String,
}
#[derive(Deserialize)]
struct NetworkGroup {
    network_group_id: String,
    name: String,
    network_ids: Vec<String>,
}
#[derive(Deserialize)]
struct Methods {
    methods: Vec<Method>,
    next_cursor: Option<String>,
}
#[derive(Deserialize)]
struct Method {
    minimum_amount: Option<String>,
    maximum_amount: Option<String>,
    method_id: String,
    asset: Asset,
    network: Option<MethodNetwork>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
}
#[derive(Deserialize)]
struct MethodNetwork {
    network_id: String,
    network_name: String,
}

fn clean(value: &str, limit: usize) -> Result<String> {
    ensure!(
        value.len() <= limit && !value.chars().any(char::is_control),
        "invalid text in Kraken response"
    );
    Ok(value.into())
}
fn map_wallets(
    addresses: Vec<Address>,
    networks: Networks,
    methods: Vec<Method>,
) -> Result<Vec<Wallet>> {
    let mut result = Vec::new();
    let mut ids = BTreeSet::new();
    for address in addresses {
        // This page is for crypto destinations, not bank account details.
        let Some(crypto) = address.address_details.crypto else {
            continue;
        };
        ensure!(
            !crypto.address.is_empty() && !address.address_id.is_empty(),
            "missing withdrawal address or ID"
        );
        ensure!(
            ids.insert(address.address_id.clone()),
            "duplicate address IDs in Kraken response"
        );
        ensure!(address.scope.len() == 1, "ambiguous wallet network scope");
        let (scope, id) = address
            .scope
            .iter()
            .next()
            .context("missing wallet scope")?;
        let (network, matching): (String, Vec<&Method>) = match scope.as_str() {
            "method_id" => {
                let method = methods.iter().find(|m| m.method_id == *id);
                (
                    method
                        .and_then(|m| m.network.as_ref())
                        .map(|n| n.network_name.clone())
                        .unwrap_or_else(|| format!("Method {id}")),
                    method.into_iter().collect(),
                )
            }
            "network_id" => (
                networks
                    .networks
                    .iter()
                    .find(|n| n.network_id == *id)
                    .map(|n| n.name.clone())
                    .unwrap_or_else(|| format!("Network {id}")),
                methods
                    .iter()
                    .filter(|m| m.network.as_ref().is_some_and(|n| n.network_id == *id))
                    .collect(),
            ),
            "network_group_id" => {
                let group = networks
                    .network_groups
                    .iter()
                    .find(|g| g.network_group_id == *id);
                (
                    group
                        .map(|g| format!("{} (network group)", g.name))
                        .unwrap_or_else(|| format!("Network group {id}")),
                    methods
                        .iter()
                        .filter(|m| {
                            m.network.as_ref().is_some_and(|n| {
                                group.is_some_and(|g| g.network_ids.contains(&n.network_id))
                            })
                        })
                        .collect(),
                )
            }
            _ => bail!("unknown wallet scope; sync not applied"),
        };
        let assets: BTreeSet<_> = matching
            .iter()
            .map(|m| clean(&m.asset.name, 16))
            .collect::<Result<_>>()?;
        let memo = match (crypto.memo, crypto.tag) {
            (Some(m), Some(t)) => Some(format!(
                "Memo: {} · Tag: {}",
                clean(&m, 128)?,
                clean(&t, 128)?
            )),
            (Some(m), None) => Some(format!("Memo: {}", clean(&m, 128)?)),
            (None, Some(t)) => Some(format!("Tag: {}", clean(&t, 128)?)),
            _ => None,
        };
        result.push(Wallet {
            id: clean(&address.address_id, 128)?,
            name: clean(
                address.name.as_deref().unwrap_or("Unnamed destination"),
                128,
            )?,
            address: clean(&crypto.address, 512)?,
            memo,
            assets: assets.into_iter().collect(),
            network: clean(&network, 128)?,
            verified: address.verified,
            source: "kraken".into(),
            rule: None,
            methods: matching
                .iter()
                .filter_map(|m| {
                    m.network
                        .as_ref()
                        .map(|n| crate::live::model::FundingMethod {
                            id: m.method_id.clone(),
                            asset: crate::live::model::asset(&m.asset.name),
                            network: n.network_name.clone(),
                            minimum: m.minimum_amount.clone(),
                            maximum: m.maximum_amount.clone(),
                        })
                })
                .collect(),
        });
    }
    ensure!(
        serde_json::to_vec(&result)?.len() <= 2 * 1024 * 1024,
        "wallet list exceeds local size limit; sync not applied"
    );
    Ok(result)
}

fn private_rejection(operation: &str, error: &str) -> Option<&'static str> {
    Some(match error {
        "EAPI:Invalid key" => "API key rejected; check whether it is valid and enabled",
        "EAPI:Invalid signature" => {
            "authentication signature rejected; check the saved key and secret"
        }
        "EAPI:Invalid nonce" => "nonce rejected; check for other apps using this same API key",
        "EGeneral:Permission denied" if operation == "GetWebSocketsToken" => {
            "WebSocket authentication permission denied; check WebSocket interface and restrictions on this Kraken API key. REST monitoring is separate"
        }
        "EGeneral:Permission denied" => {
            "permission denied; check this API key's permissions and restrictions"
        }
        "EOrder:Insufficient funds" => "insufficient available funds",
        "EOrder:Order minimum not met" => "order size is below Kraken's minimum",
        "EOrder:Cost minimum not met" => "order value is below Kraken's minimum",
        "EOrder:Unknown order" => "order ID was not found",
        "EOrder:Invalid price" => "order price rejected",
        "EOrder:Rate limit exceeded" => "order rate limit reached",
        "EGeneral:Invalid arguments" => "request arguments rejected",
        value if value.starts_with("EGeneral:Invalid arguments:") => "request arguments rejected",
        _ => return None,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread,
    };

    pub(crate) fn credential() -> Credential {
        Credential {
            api_key: Secret("fixture-key".into()),
            api_secret: Secret(STANDARD.encode(b"fixture-only-secret")),
        }
    }
    pub(crate) fn key_info(permissions: &[&str]) -> Value {
        json!({"error":[], "result":{"permissions":permissions,"iban":"fixture-account","apiKey":"must-not-be-exported"}})
    }
    pub(crate) struct Http {
        pub method: String,
        pub uri: String,
        pub headers: BTreeMap<String, String>,
        pub body: String,
    }
    pub(crate) fn server(responses: Vec<(u16, Value)>) -> (String, thread::JoinHandle<Vec<Http>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = thread::spawn(move || {
            let mut requests = vec![];
            for (status, body) in responses {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "mock request never arrived");
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let parts: Vec<_> = line.split_whitespace().collect();
                let (method, uri) = (parts[0].to_string(), parts[1].to_string());
                let mut headers = BTreeMap::new();
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    let (name, value) = line.split_once(':').unwrap();
                    headers.insert(name.to_lowercase(), value.trim().to_string());
                }
                let len: usize = headers
                    .get("content-length")
                    .map(|n| n.parse().unwrap())
                    .unwrap_or(0);
                let mut body_bytes = vec![0; len];
                reader.read_exact(&mut body_bytes).unwrap();
                requests.push(Http {
                    method,
                    uri,
                    headers,
                    body: String::from_utf8(body_bytes).unwrap(),
                });
                let body = body.to_string();
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (origin, task)
    }
    fn reader(origin: String) -> Reader {
        Reader::new(origin, 100, Arc::new(AtomicBool::new(false))).unwrap()
    }

    #[test]
    fn signing_matches_krakens_published_authentication_vector() {
        let secret = Secret("kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==".into());
        let body =
            "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25";
        assert_eq!(
            signature(&secret, "/0/private/AddOrder", 1616492376594, body).unwrap(),
            "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ=="
        );
    }
    #[test]
    fn metadata_permissions_and_recent_history_are_cached_across_jobs() {
        let (origin, server) = server(vec![
            (200, json!({"error":[],"result":{"fixture":"pair"}})),
            (200, key_info(&["query-funds"])),
            (200, json!({"error":[],"result":{"closed":{}}})),
            (
                200,
                json!({"error":[],"result":{"closed":{"new":"receipt"}}}),
            ),
        ]);
        let session = session::Session::shared();
        let key = credential();
        for nonce in [100, 200] {
            let mut r = Reader::with_session(
                origin.clone(),
                nonce,
                Arc::new(AtomicBool::new(false)),
                session.clone(),
            )
            .unwrap();
            let pairs: serde_json::Value = r.public("AssetPairs").unwrap();
            assert_eq!(pairs["fixture"], "pair");
            r.inspect(&key).unwrap();
            r.closed_orders(&key).unwrap();
        }
        session.lock().unwrap().invalidate_orders();
        let mut r =
            Reader::with_session(origin, 300, Arc::new(AtomicBool::new(false)), session).unwrap();
        assert_eq!(r.closed_orders(&key).unwrap()["closed"]["new"], "receipt");
        assert_eq!(server.join().unwrap().len(), 4);
    }
    #[test]
    fn exchange_throttle_stops_other_jobs_and_does_not_retry_the_request() {
        let until = crate::model::now() + 180;
        let (origin, server) = server(vec![(
            200,
            json!({"error":[format!("EService: Throttled: {until}")]}),
        )]);
        let session = session::Session::shared();
        let mut r = Reader::with_session(
            origin,
            100,
            Arc::new(AtomicBool::new(false)),
            session.clone(),
        )
        .unwrap();
        assert!(
            r.private::<serde_json::Value>(&credential(), "OpenOrders", &[])
                .unwrap_err()
                .to_string()
                .contains("cooling down")
        );
        assert!(!session.lock().unwrap().ready());
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn paginated_wallet_sync_signs_queries_uses_cursor_alone_and_preserves_network_and_tag() {
        let (origin, task) = server(vec![
            (200, key_info(&["query-funds", "query-open-trades"])),
            (
                200,
                json!({"networks":[{"network_id":"xrp","name":"XRP"}], "network_groups":[]}),
            ),
            (
                200,
                json!({"methods":[{"method_id":"method-xrp", "asset":{"name":"XRP"},"network":{"network_id":"xrp","network_name":"XRP"}}], "next_cursor":"a+/ cursor"}),
            ),
            (200, json!({"methods":[]})),
            (
                200,
                json!({"addresses":[{"address_id":"wallet-one","name":"My wallet","verified":true,"scope":{"method_id":"method-xrp"},"address_details":{"crypto":{"address":"rFixtureAddress", "tag":"12345"}}}],"next_cursor":"second-page"}),
            ),
            (200, json!({"addresses":[]})),
        ]);
        let mut client = reader(origin);
        let credential = credential();
        let info = client.inspect(&credential).unwrap();
        assert_eq!(info.permissions, ["query-funds", "query-open-trades"]);
        assert_ne!(info.account_id, "fixture-account");
        let wallets = client.wallets(&credential).unwrap();
        assert_eq!(wallets.len(), 1);
        let wallet = &wallets[0];
        assert_eq!(wallet.address, "rFixtureAddress");
        assert_eq!(wallet.network, "XRP");
        assert_eq!(wallet.assets, ["XRP"]);
        assert_eq!(wallet.memo.as_deref(), Some("Tag: 12345"));
        assert!(wallet.verified && wallet.rule.is_none());
        let requests = task.join().unwrap();
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[0].uri, "/0/private/GetApiKeyInfo");
        assert_eq!(requests[0].body, "nonce=101");
        // Direction is a required path segment, including on cursor pages.
        assert_eq!(requests[2].uri, "/funding/v1/methods/withdraw?limit=500");
        assert_eq!(
            requests[3].uri,
            "/funding/v1/methods/withdraw?cursor=a%2B%2F+cursor"
        );
        assert_eq!(requests[5].uri, "/funding/v1/addresses?cursor=second-page");
        for (index, request) in requests.iter().enumerate() {
            let nonce = 101 + index as u64;
            assert_eq!(request.headers["api-key"], "fixture-key");
            assert_eq!(
                request.headers["api-sign"],
                signature(&credential.api_secret, &request.uri, nonce, &request.body).unwrap()
            );
            if index > 0 {
                assert_eq!(request.method, "GET");
                assert!(request.body.is_empty());
                assert_eq!(request.headers["api-nonce"], nonce.to_string());
            }
        }
    }

    #[test]
    fn http_errors_identify_the_failed_operation_without_exposing_response_or_query() {
        for (status, reason) in [
            (401, "access rejected"),
            (403, "access rejected"),
            (404, "endpoint not found"),
            (429, "rate limit reached"),
            (503, "service unavailable"),
        ] {
            let (origin, task) = server(vec![(status, json!({"message":"DO-NOT-EXPORT"}))]);
            let error = reader(origin)
                .request::<Value>(
                    &credential(),
                    "/funding/v1/methods/withdraw",
                    &[("cursor", "PRIVATE-CURSOR")],
                )
                .unwrap_err()
                .to_string();
            assert!(error.contains("withdrawal methods"));
            assert!(error.contains(&format!("HTTP {status}")));
            assert!(error.contains(reason));
            for private in ["DO-NOT-EXPORT", "PRIVATE-CURSOR", "fixture-key"] {
                assert!(!error.contains(private));
            }
            if status == 404 {
                assert!(!error.contains("permissions") && !error.contains("rate limit"));
            }
            task.join().unwrap();
        }
    }

    #[test]
    fn private_errors_identify_the_operation_without_leaking_or_reclassifying_unknown_writes() {
        for (operation, errors, result, rejected, expected) in [
            (
                "GetWebSocketsToken",
                json!(["EGeneral:Permission denied"]),
                Value::Null,
                true,
                "check WebSocket interface",
            ),
            (
                "GetWebSocketsToken",
                json!(["EAPI:Invalid nonce"]),
                Value::Null,
                true,
                "nonce rejected",
            ),
            (
                "AddOrder",
                json!(["EGeneral:Invalid arguments:DO-NOT-EXPORT"]),
                Value::Null,
                true,
                "request arguments rejected",
            ),
            (
                "AddOrder",
                json!(["EGeneral:Permission denied:DO-NOT-EXPORT"]),
                Value::Null,
                false,
                "unclassified error",
            ),
            (
                "AddOrder",
                json!(["EGeneral:Permission denied", "DO-NOT-EXPORT"]),
                Value::Null,
                false,
                "unclassified error",
            ),
            (
                "AddOrder",
                json!(["EGeneral:Permission denied"]),
                json!({"txid":"DO-NOT-EXPORT"}),
                false,
                "unclassified error",
            ),
        ] {
            let (origin, task) = server(vec![(200, json!({"error":errors,"result":result}))]);
            let error = reader(origin)
                .private::<Value>(&credential(), operation, &[])
                .unwrap_err();
            assert_eq!(error.is::<crate::live::transport::Rejected>(), rejected);
            let message = error.to_string();
            assert!(
                message.contains(operation) && message.contains(expected),
                "{message}"
            );
            assert!(!message.contains("DO-NOT-EXPORT") && !message.contains("fixture-key"));
            assert_eq!(task.join().unwrap().len(), 1);
        }
    }

    #[test]
    fn dangerous_permissions_are_rejected_and_authentication_errors_are_sanitized() {
        for (permissions, accepted) in [
            (vec!["query-funds"], true),
            (vec!["query-funds", "withdraw-funds"], true),
            (
                vec![
                    "query-funds",
                    "query-open-trades",
                    "query-closed-trades",
                    "modify-trades",
                    "close-trades",
                    "withdraw-funds",
                ],
                true,
            ),
            (vec!["query-open-trades"], false),
            (
                vec!["query-funds", "withdraw-funds", "add-withdraw-address"],
                false,
            ),
            (
                vec!["query-funds", "withdraw-funds", "update-withdraw-address"],
                false,
            ),
        ] {
            let (origin, task) = server(vec![(200, key_info(&permissions))]);
            assert_eq!(reader(origin).inspect(&credential()).is_ok(), accepted);
            task.join().unwrap();
        }
        let (origin, task) = server(vec![(
            200,
            json!({"error":["DO-NOT-EXPORT response text"]}),
        )]);
        let error = reader(origin)
            .inspect(&credential())
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains("DO-NOT-EXPORT"));
        task.join().unwrap();
    }

    #[test]
    fn endpoint_allowlist_cancellation_and_repeated_cursors_fail_closed() {
        let mut client = reader("http://127.0.0.1:1".into());
        for path in [
            "/0/private/Withdraw",
            "/0/private/AddOrder",
            "/funding/v1/withdrawals",
            "/funding/v1/methods",
            "/funding/v1/methods/deposit",
        ] {
            assert!(
                client
                    .request::<Value>(&credential(), path, &[])
                    .unwrap_err()
                    .to_string()
                    .contains("not read-only")
            );
        }
        client.cancelled.store(true, Ordering::Relaxed);
        assert!(
            client
                .inspect(&credential())
                .err()
                .unwrap()
                .to_string()
                .contains("cancelled")
        );
        let (origin, task) = server(vec![
            (200, json!({"networks":[],"network_groups":[]})),
            (200, json!({"methods":[]})),
            (200, json!({"addresses":[],"next_cursor":"loop"})),
            (200, json!({"addresses":[],"next_cursor":"loop"})),
        ]);
        assert!(
            reader(origin)
                .wallets(&credential())
                .unwrap_err()
                .to_string()
                .contains("repeated")
        );
        task.join().unwrap();
    }

    #[test]
    fn extended_balances_keep_exact_amounts_deduct_holds_and_separate_earn_buckets() {
        let body: Value = serde_json::from_str(
            r#"{"error":[],"result":{
            "ZUSD":{"balance":"1000.12","hold_trade":"300.10","credit":"25","credit_used":"5"},
            "USDC":{"balance":123.000000000000000001,"hold_trade":0.000000000000000001},
            "USDT.F":{"balance":"12.5","hold_trade":"0"},
            "USDG":{"balance":"0","hold_trade":"0"}
        }}"#,
        )
        .unwrap();
        let (origin, task) = server(vec![(200, body)]);
        let credential = credential();
        let balances = reader(origin).balances(&credential).unwrap();
        let find = |asset| balances.iter().find(|b| b.asset == asset).unwrap();
        assert_eq!(
            find("ZUSD").available_for_trading.as_deref(),
            Some("720.02")
        );
        assert_eq!(find("ZUSD").held_for_orders, "300.1");
        assert_eq!(find("USDC").balance, "123.000000000000000001");
        assert_eq!(find("USDC").available_for_trading.as_deref(), Some("123"));
        assert_eq!(find("USDT.F").available_for_trading, None);
        assert_eq!(find("USDG").available_for_trading.as_deref(), Some("0"));
        let requests = task.join().unwrap();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.uri, "/0/private/BalanceEx");
        assert_eq!(request.body, "nonce=101");
        assert_eq!(
            request.headers["api-sign"],
            signature(
                &credential.api_secret,
                "/0/private/BalanceEx",
                101,
                "nonce=101"
            )
            .unwrap()
        );
    }

    #[test]
    fn invalid_or_incomplete_balances_are_not_reported_as_available_funds() {
        for body in [
            json!({"error":["DO-NOT-EXPORT"]}),
            json!({"error":[]}),
            json!({"error":[],"result":{"ZUSD":{"balance":"100"}}}),
            json!({"error":[],"result":{"ZUSD":{"balance":"NaN","hold_trade":"0"}}}),
            json!({"error":[],"result":{"ZUSD":{"balance":"100","hold_trade":"-1"}}}),
        ] {
            let (origin, task) = server(vec![(200, body)]);
            let error = reader(origin)
                .balances(&credential())
                .unwrap_err()
                .to_string();
            assert!(!error.contains("DO-NOT-EXPORT"));
            task.join().unwrap();
        }
    }

    #[test]
    fn network_groups_are_explicit_and_fiat_addresses_are_not_imported() {
        let addresses: Addresses = serde_json::from_value(json!({"addresses":[
            {"address_id":"crypto", "name":"EVM", "scope":{"network_group_id":"evm"}, "verified":false,"address_details":{"crypto":{"address":"0xFixture","memo":"memo","tag":"tag"}}},
            {"address_id":"bank", "scope":{"method_id":"bank-method"}, "verified":true,"address_details":{"fiat":{"iban":"private-bank-details"}}}
        ]})).unwrap();
        let networks: Networks = serde_json::from_value(json!({"networks":[],"network_groups":[{"network_group_id":"evm","name":"EVM", "network_ids":["eth", "arb"]}]})).unwrap();
        let methods: Methods = serde_json::from_value(json!({"methods":[
            {"method_id":"eth-method","asset":{"name":"ETH"},"network":{"network_id":"eth","network_name":"Ethereum"}},
            {"method_id":"arb-method","asset":{"name":"USDC"},"network":{"network_id":"arb","network_name":"Arbitrum"}}
        ]})).unwrap();
        let wallets = map_wallets(addresses.addresses, networks, methods.methods).unwrap();
        assert_eq!(wallets.len(), 1);
        assert_eq!(wallets[0].network, "EVM (network group)");
        assert_eq!(wallets[0].assets, ["ETH", "USDC"]);
        assert_eq!(wallets[0].memo.as_deref(), Some("Memo: memo · Tag: tag"));
        assert!(!wallets[0].verified);
    }
}

use anyhow::{Context, Result};
use crossterm::{
    SynchronizedUpdate,
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyEventKind,
        KeyModifiers,
    },
    execute,
};
use ratatui::widgets::TableState;
use std::{
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};
use tokio::runtime::Handle;
use uuid::Uuid;

use crate::{
    ipc,
    model::{Request, Response, Snapshot, add, amount},
    order_sort::OrderSort,
};

mod mascot;
mod paint;
mod splash;
pub use paint::render;

const TITLES: [&str; 8] = [
    "Overview",
    "Fills",
    "Withdrawals",
    "Activity",
    "Wallets",
    "API Key",
    "Watch rules",
    "Orders",
];
const INTRO: Duration = Duration::from_millis(2400);

#[derive(Clone)]
struct Record {
    key: String,
    cells: Vec<String>,
    detail: Vec<(String, String)>,
    status: String,
}

impl Record {
    fn matches(&self, query: &str) -> bool {
        query.is_empty()
            || self.cells.iter().any(|s| s.to_lowercase().contains(query))
            || self
                .detail
                .iter()
                .any(|(_, s)| s.to_lowercase().contains(query))
    }
}

#[derive(Clone)]
enum Overlay {
    Help,
    Details(Record),
}

pub struct View {
    pub state: Option<Snapshot>,
    mascot: mascot::Mascot,
    tab: usize,
    tables: [TableState; 8],
    queries: [String; 8],
    order_sort: OrderSort,
    orders_descending: bool,
    show_cancelled_orders: bool,
    searching: bool,
    online: bool,
    received: Option<Instant>,
    notice: Option<(String, bool, Instant)>,
    connection_error: Option<String>,
    pending: bool,
    overlay: Option<Overlay>,
    overlay_scroll: u16,
    overlay_max_scroll: u16,
    page_size: usize,
    intro: Option<Instant>,
}

impl Default for View {
    fn default() -> Self {
        Self {
            state: None,
            mascot: Default::default(),
            tab: 0,
            tables: std::array::from_fn(|_| TableState::default().with_selected(0)),
            queries: Default::default(),
            order_sort: OrderSort::default(),
            orders_descending: false,
            show_cancelled_orders: false,
            searching: false,
            online: false,
            received: None,
            notice: None,
            connection_error: None,
            pending: false,
            overlay: None,
            overlay_scroll: 0,
            overlay_max_scroll: 0,
            page_size: 8,
            intro: None,
        }
    }
}

enum Input {
    None,
    Quit,
    Unlock,
    SetKey,
    EditRules,
    SetupTelegram,
    Send(Request),
}

impl View {
    fn account(&self) -> bool {
        self.state
            .as_ref()
            .is_some_and(|state| state.mode == "account")
    }
    fn locked(&self) -> bool {
        self.state.as_ref().is_some_and(|state| {
            matches!(
                state.vault.state,
                crate::vault::VaultState::Locked | crate::vault::VaultState::NotConfigured
            )
        })
    }
    fn connected(&self) -> bool {
        self.online
            && self
                .received
                .is_some_and(|at| at.elapsed() <= Duration::from_secs(5))
    }

    fn freshness(&self, tab: usize) -> Option<&crate::model::RefreshStatus> {
        if !self.account() {
            return None;
        }
        let refresh = &self.state.as_ref()?.account_status.refresh;
        match tab {
            0 => Some(&refresh.balances),
            4 | 6 => Some(&refresh.wallets),
            7 => Some(&refresh.orders),
            _ => None,
        }
    }

    fn selected(&self) -> usize {
        self.tables[self.tab].selected().unwrap_or(0)
    }

    fn records(&self, tab: usize) -> Vec<Record> {
        self.records_matching(tab, &self.queries[tab])
    }

    fn records_matching(&self, tab: usize, query: &str) -> Vec<Record> {
        let Some(state) = &self.state else {
            return vec![];
        };
        let records: Vec<_> = match tab {
            0 if self.account() => state.account_status.balances.iter().map(|b| Record {
                key: b.asset.clone(),
                cells: vec![b.asset.clone(), b.balance.clone(), b.held_for_orders.clone(),
                    b.available_for_trading.clone().unwrap_or_else(|| "See base asset".into())],
                detail: vec![field("Kraken asset", &b.asset), field("Balance", &b.balance),
                    field("Held for orders", &b.held_for_orders), field("Credit", &b.credit),
                    field("Credit used", &b.credit_used),
                    field("Available for trading", b.available_for_trading.as_deref().unwrap_or("Asset bucket; see base asset")),
                    field("Meaning", "Availability includes credit and deducts spot non-margin order holds. It is not a withdrawal quote. Earn/rewards buckets remain separate."),
                    field("Checked", &state.account_status.balances_updated_at.map(|at| format!("{} ago (cached)", age(state.observed_at, at))).unwrap_or_else(|| "Not checked".into())),
                ],
                status: "cached".into(),
            }).collect(),
            0 => state
                .assets
                .iter()
                .map(|a| Record {
                    key: a.rule.asset.clone(),
                    cells: vec![
                        a.rule.asset.clone(),
                        a.queued.clone(),
                        a.spendable.clone(),
                        asset_status(a.blocked.as_deref()),
                    ],
                    detail: vec![
                        field("Asset", &a.rule.asset),
                        field("Destination", &a.rule.destination),
                        field("Queued", &a.queued),
                        field("Spendable", &a.spendable),
                        field("Chunk", &a.rule.chunk),
                        field("Fee / transfer", &a.rule.fee),
                        field("Withdrawal minimum", &a.rule.minimum),
                        field("Keep on exchange", &a.rule.reserve),
                        field("Cooldown", &format!("{} seconds", a.rule.cooldown_seconds)),
                        field("Status", a.blocked.as_deref().unwrap_or("Ready")),
                    ],
                    status: a.blocked.clone().unwrap_or_else(|| "ready".into()),
                })
                .collect(),
            1 => state
                .fills
                .iter()
                .map(|f| Record {
                    key: f.id.clone(),
                    cells: vec![
                        f.asset.clone(),
                        f.amount.clone(),
                        age(state.observed_at, f.at),
                        f.id.clone(),
                    ],
                    detail: vec![
                        field("Fill ID", &f.id),
                        field("Asset", &f.asset),
                        field("Net received", &f.amount),
                        field("Recorded", &format!("{} ago", age(state.observed_at, f.at))),
                        field(
                            "Accounting",
                            "Net of trading fees. Duplicate fill IDs cannot add funds twice.",
                        ),
                    ],
                    status: String::new(),
                })
                .collect(),
            2 => state
                .withdrawals
                .iter()
                .map(|w| Record {
                    key: w.id.clone(),
                    cells: vec![
                        w.asset.clone(),
                        w.amount.clone(),
                        w.status.to_uppercase(),
                        age(state.observed_at, w.created_at),
                    ],
                    detail: vec![
                        field("Withdrawal ID", &w.id),
                        field("Status", &w.status.to_uppercase()),
                        field("Asset", &w.asset),
                        field("To destination", &w.amount),
                        field("Fee", &w.fee),
                        field("Destination", &w.destination),
                        field(
                            "Submitted",
                            &format!("{} ago", age(state.observed_at, w.created_at)),
                        ),
                        field(
                            "Last update",
                            &format!("{} ago", age(state.observed_at, w.updated_at)),
                        ),
                        field("Meaning", if self.account() { live_job_explanation(&w.status) } else { job_explanation(&w.status) }),
                        field("Review", if self.account() { "moby withdrawals review ID --json · Check Kraken before resolving unknown requests" } else { "moby demo resolve --help" }),
                    ],
                    status: w.status.clone(),
                })
                .collect(),
            4 => state.account_status.wallets.iter().map(|w| {
                let mut detail = vec![
                    field("Label", &w.name), field("Full address", &w.address),
                    field("Memo / tag", w.memo.as_deref().unwrap_or("None")),
                    field("Network", &w.network), field("Assets", &w.assets.join(", ")),
                    field("Kraken", if w.source == "paper" { "Simulated destination" } else if w.verified { "Verified by Kraken" } else { "Not verified" }),
                    field("Moby withdrawals", if w.rule.is_some() { "Paper rule only" } else if state.account_status.live.config.as_ref().is_some_and(|c|c.rules.iter().any(|r|r.enabled && r.destinations.iter().any(|d|d.wallet_id==w.id))) {"Watch rule configured"} else { "No watch rule" }),
                    field("Destination ID", &w.id),
                    field("Last sync", &state.account_status.wallets_updated_at.map(|at| format!("{} ago · cached", age(state.observed_at, at))).unwrap_or_else(|| "Paper data".into())),
                ];
                for method in &w.methods {detail.push(field(&format!("{} · {} method",method.asset,method.network),&method.id));}
                if let Some(config)=&state.account_status.live.config {
                    for rule in &config.rules {if rule.destinations.iter().any(|d|d.wallet_id==w.id) {detail.push(field("Live watch rule",&format!("{} · chunk {} · {}s cooldown · {}",rule.asset,rule.chunk,rule.cooldown_seconds,if rule.enabled {"enabled"}else{"disabled"})));}}
                }
                if let Some(rule) = &w.rule {
                    detail.extend([
                        field("Chunk", &rule.chunk), field("Withdrawal minimum", &rule.minimum),
                        field("Reserve", &rule.reserve), field("Fee", &rule.fee),
                        field("Cooldown", &format!("{} seconds", rule.cooldown_seconds)),
                    ]);
                }
                Record { key: w.id.clone(), cells: vec![w.name.clone(), w.assets.join(", "), w.network.clone(),
                    if w.source == "paper" { "Paper".into() } else if w.verified { "Verified".into() } else { "Unverified".into() }], detail, status: String::new() }
            }).collect(),
            5 => state.account_status.keys.iter().map(|k| {
                let status = if self.locked() { "Locked" } else if !k.saved { "Not set" } else if k.error.is_some() { "Needs attention" } else if k.checked_at.is_some() { "Checked" } else { "Not checked" };
                Record { key: "account".into(), cells: vec![k.label.clone(), status.into(), k.access()],
                    detail: vec![field("Account", &state.account), field("Status", status),
                        field("Access", &k.access()),
                        field("Purpose", "One encrypted Kraken key per account. The worker handles orders and configured withdrawals without exposing secrets."),
                        field("Permissions", &if k.permissions.is_empty() { "Not checked".into() } else { k.permissions.join(", ") }),
                        field("Last check", &k.checked_at.map(|at| format!("{} ago", age(state.observed_at, at))).unwrap_or_else(|| "Never".into())),
                        field("Result", k.error.as_deref().unwrap_or("E enters or replaces this key; C checks its permissions.")),
                        field("Telegram", &format!("{} · {} pending · {}", if state.account_status.telegram.enabled {"On"} else {"Off"}, state.account_status.telegram.pending, state.account_status.telegram.last_error.as_deref().unwrap_or("N sets up alerts; moby telegram --help for test/disable"))),
                        field("Storage", "Encrypted with your vault password. E enters or replaces your account key. Secrets are never shown here."),
                    ], status: status.into() }
            }).collect(),
            6 => state.account_status.live.config.as_ref().map(|c|c.rules.iter().map(|r| {
                let q=state.account_status.live.queues.get(&r.asset);
                let status=if !r.enabled {"Disabled"}else if state.paused {"Paused"}else {q.and_then(|q|q.blocked.as_deref()).unwrap_or("Watching")};
                Record {key:r.asset.clone(),cells:vec![r.asset.clone(),q.map(|q|q.amount.clone()).unwrap_or_else(||"0".into()),r.chunk.clone(),status.into()],status:status.into(),
                    detail:vec![field("Asset",&r.asset),field("Queued",q.map(|q|q.amount.as_str()).unwrap_or("0")),field("Gross chunk (includes fee)",&r.chunk),field("Withdrawal minimum (net)",&r.minimum),field("Minimum meaning","Amount delivered after withdrawal fees must meet this threshold and Kraken's current withdrawal minimum. Trading pairs have separate order minimums."),field("Keep on Kraken",&r.reserve),field("Cooldown seconds",&r.cooldown_seconds.to_string()),field("Maximum fee",&r.max_fee),field("Maximum fee percent",&r.max_fee_percent),field("Rolling 24h fee budget",r.daily_fee_budget.as_deref().unwrap_or("No cap")),field("Order types",&r.order_types.join(", ")),field("Sides",&r.sides.join(", ")),field("Pairs",&if r.pairs.is_empty(){"All".into()}else{r.pairs.join(", ")}),field("Order IDs",&if r.order_ids.is_empty(){"All matching orders, including external orders".into()}else{r.order_ids.join(", ")}),field("Destinations",&r.destinations.iter().map(|d|format!("{} · {} · {} {}",d.wallet_id,d.network,d.address,d.memo.as_deref().unwrap_or(""))).collect::<Vec<_>>().join("; ")),field("Status",status),field("Edit","P pauses, E adds/edits an asset rule; R resumes after reconciliation")],}
            }).collect()).unwrap_or_default(),
            7 => self.order_sort.sorted(&state.account_status.live.orders, self.orders_descending).into_iter().filter(|o|self.show_cancelled_orders || !o.is_cancelled()).map(|o|Record {
                key:o.id.clone(),cells:vec![o.pair.clone(),format!("{} {}",o.side,o.order_type),o.price.clone(),format!("{} / {}",o.filled,o.volume),o.status.clone()],status:o.status.clone(),
                detail:vec![field("Order ID",&o.id),field("Client ID",o.client_id.as_deref().unwrap_or("External order")),field("Pair",&o.pair),field("Side",&o.side),field("Type",&o.order_type),field("Volume",&o.volume),field("Filled",&o.filled),field("Price",&o.price),field("Status",&o.status),field("Agent commands","moby orders --help · place/amend/cancel through the unlocked worker")],
            }).collect(),
            _ => state
                .activity
                .iter()
                .map(|a| Record {
                    key: format!("{}:{}", a.at, a.message),
                    cells: vec![age(state.observed_at, a.at), a.message.clone()],
                    detail: vec![
                        field("When", &format!("{} ago", age(state.observed_at, a.at))),
                        field("Event", &a.message),
                    ],
                    status: String::new(),
                })
                .collect(),
        };
        let mut records = records;
        if self.account() {
            for record in &mut records {
                if tab == 2
                    && let Some(t) = state
                        .account_status
                        .live
                        .transfers
                        .iter()
                        .find(|t| t.id == record.key)
                {
                    record.detail.extend([
                        field("Gross debit", &t.gross),
                        field(
                            "Exchange receipt",
                            t.exchange_id.as_deref().unwrap_or("Not confirmed"),
                        ),
                        field(
                            "Transaction ID",
                            t.txid.as_deref().unwrap_or("Not available"),
                        ),
                        field("Network", &t.destination.network),
                        field("Memo/tag", t.destination.memo.as_deref().unwrap_or("None")),
                        field("Last error", t.error.as_deref().unwrap_or("None")),
                    ]);
                }
                if tab == 1
                    && let Some(t) = state
                        .account_status
                        .live
                        .trades
                        .iter()
                        .find(|t| t.id == record.key)
                {
                    record.detail.extend([
                        field("Order ID", &t.order_id),
                        field("Pair", &t.pair),
                        field("Side", &t.side),
                        field("Order type", &t.order_type),
                        field(
                            "Margin",
                            if t.margin {
                                "Ignored by withdrawal automation"
                            } else {
                                "Spot"
                            },
                        ),
                    ]);
                }
            }
        }
        let query = query.to_lowercase();
        records.into_iter().filter(|r| r.matches(&query)).collect()
    }

    fn receive(&mut self, result: std::result::Result<Response, String>, command: bool) {
        if command {
            self.pending = false;
        }
        match result {
            Ok(response) => {
                self.online = true;
                self.connection_error = None;
                if let Some(state) = response.state {
                    // Keep the selected record stable when new rows arrive above it.
                    let selected: Vec<_> = (0..TITLES.len())
                        .map(|tab| {
                            self.records(tab)
                                .get(self.tables[tab].selected().unwrap_or(0))
                                .map(|r| r.key.clone())
                        })
                        .collect();
                    self.state = Some(state);
                    self.received = Some(Instant::now());
                    for (tab, key) in selected.into_iter().enumerate() {
                        let rows = self.records(tab);
                        let index = key
                            .and_then(|key| rows.iter().position(|r| r.key == key))
                            .unwrap_or(0);
                        self.tables[tab].select(if rows.is_empty() { None } else { Some(index) });
                    }
                    // An open receipt remains pinned by ID, but its status stays current.
                    if let Some(Overlay::Details(record)) = &self.overlay {
                        self.overlay = self
                            .records_matching(self.tab, "")
                            .into_iter()
                            .find(|r| r.key == record.key)
                            .map(Overlay::Details);
                    }
                }
                if command || !response.ok {
                    self.notice = Some((response.message, !response.ok, Instant::now()));
                }
            }
            Err(error) => {
                self.online = false;
                self.connection_error = Some(error);
            }
        }
    }

    fn input(&mut self, key: KeyEvent) -> Input {
        if key.kind != KeyEventKind::Press {
            return Input::None;
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return Input::Quit;
        }
        // Consume the skip key so skipping the whale cannot also submit a demo fill.
        if self.intro.take().is_some() {
            return Input::None;
        }
        if self.overlay.is_some() {
            match key.code {
                KeyCode::Esc | KeyCode::Char('q' | '?') => self.overlay = None,
                KeyCode::Down | KeyCode::Char('j') => {
                    self.overlay_scroll = self
                        .overlay_scroll
                        .saturating_add(1)
                        .min(self.overlay_max_scroll)
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.overlay_scroll = self.overlay_scroll.saturating_sub(1)
                }
                KeyCode::PageDown => {
                    self.overlay_scroll = self
                        .overlay_scroll
                        .saturating_add(8)
                        .min(self.overlay_max_scroll)
                }
                KeyCode::PageUp => self.overlay_scroll = self.overlay_scroll.saturating_sub(8),
                KeyCode::Home => self.overlay_scroll = 0,
                KeyCode::End => self.overlay_scroll = self.overlay_max_scroll,
                _ => (),
            }
            return Input::None;
        }
        if self.searching {
            match key.code {
                KeyCode::Esc => {
                    self.queries[self.tab].clear();
                    self.searching = false;
                }
                KeyCode::Enter => self.searching = false,
                KeyCode::Backspace => {
                    self.queries[self.tab].pop();
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.queries[self.tab].clear()
                }
                KeyCode::Char(c)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    self.append_search(&c.to_string())
                }
                _ => (),
            }
            self.tables[self.tab] = TableState::default().with_selected(0);
            return Input::None;
        }
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            return Input::None;
        }
        let code = match key.code {
            KeyCode::Char(c) => KeyCode::Char(c.to_ascii_lowercase()),
            other => other,
        };
        let count = self.records(self.tab).len();
        match code {
            KeyCode::Char('q') => return Input::Quit,
            KeyCode::Char('u') if self.connected() => return Input::Unlock,
            KeyCode::Tab | KeyCode::Right => self.tab = (self.tab + 1) % TITLES.len(),
            KeyCode::BackTab | KeyCode::Left => {
                self.tab = (self.tab + TITLES.len() - 1) % TITLES.len()
            }
            KeyCode::Char(c @ '1'..='8') => self.tab = c as usize - '1' as usize,
            KeyCode::Char(c @ ('s' | 'o' | 'c')) if self.tab == 7 => {
                let selected = self.records(7).get(self.selected()).map(|r| r.key.clone());
                if c == 's' {
                    self.order_sort = self.order_sort.next();
                } else if c == 'c' {
                    self.show_cancelled_orders = !self.show_cancelled_orders;
                } else {
                    self.orders_descending = !self.orders_descending;
                }
                let records = self.records(7);
                let index = selected
                    .and_then(|id| records.iter().position(|r| r.key == id))
                    .unwrap_or(0);
                self.select(index, records.len());
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.select(self.selected().saturating_add(1), count)
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.select(self.selected().saturating_sub(1), count)
            }
            KeyCode::PageDown => self.select(self.selected().saturating_add(self.page_size), count),
            KeyCode::PageUp => self.select(self.selected().saturating_sub(self.page_size), count),
            KeyCode::Home => self.select(0, count),
            KeyCode::End => self.select(count.saturating_sub(1), count),
            KeyCode::Char('/') => self.searching = true,
            KeyCode::Esc => {
                self.queries[self.tab].clear();
                self.select(0, count);
            }
            KeyCode::Char('?') => {
                self.overlay = Some(Overlay::Help);
                self.overlay_scroll = 0;
            }
            KeyCode::Enter => {
                self.overlay = self
                    .records(self.tab)
                    .get(self.selected())
                    .cloned()
                    .map(Overlay::Details);
                self.overlay_scroll = 0;
            }
            KeyCode::Char('p' | 'r' | 'd' | 'e' | 'c' | 'f' | 'b' | 'n') if !self.connected() => {
                self.notice = Some((
                    "Waiting for a fresh worker connection. Controls are temporarily disabled."
                        .into(),
                    true,
                    Instant::now(),
                ))
            }
            KeyCode::Char('p' | 'r' | 'd' | 'e' | 'c' | 'f' | 'b' | 'n') if self.pending => (),
            KeyCode::Char('e' | 'c' | 'f' | 'r' | 'd' | 'b' | 'n') if self.locked() => {
                self.notice = Some((
                    "Vault locked. Press U to unlock for this worker session.".into(),
                    true,
                    Instant::now(),
                ));
            }
            KeyCode::Char('d') if self.account() => {
                self.notice = Some((
                    "Simulated fills are available only in the separate paper account: moby --demo."
                        .into(),
                    false,
                    Instant::now(),
                ));
            }
            KeyCode::Char('e' | 'c' | 'f' | 'b' | 'n') if !self.account() => {
                self.notice = Some(("Paper mode has no real keys or Kraken connection. Open moby without --demo to set up your account.".into(), false, Instant::now()));
            }
            KeyCode::Char('n') => return Input::SetupTelegram,
            KeyCode::Char('e') if self.tab == 6 => return Input::EditRules,
            KeyCode::Char('f') if self.tab == 7 => return Input::Send(Request::RefreshOrders),
            KeyCode::Char('e') if self.tab == 5 => return Input::SetKey,
            KeyCode::Char('c') if self.tab == 5 => return Input::Send(Request::CheckKey),
            KeyCode::Char('f') if self.tab == 4 => return Input::Send(Request::RefreshWallets),
            KeyCode::Char('b') if self.tab == 0 => return Input::Send(Request::RefreshBalances),
            KeyCode::Char('p') => return Input::Send(Request::Pause),
            KeyCode::Char('r') => return Input::Send(Request::Resume),
            KeyCode::Char('d') if self.tab == 0 => match self.demo_fill() {
                Ok(request) => return Input::Send(request),
                Err(error) => self.notice = Some((error.to_string(), true, Instant::now())),
            },
            _ => (),
        }
        Input::None
    }

    fn append_search(&mut self, text: &str) {
        let remaining = 128usize.saturating_sub(self.queries[self.tab].chars().count());
        self.queries[self.tab].extend(text.chars().filter(|c| !c.is_control()).take(remaining));
        self.tables[self.tab] = TableState::default().with_selected(0);
    }

    fn select(&mut self, index: usize, count: usize) {
        self.tables[self.tab].select(if count == 0 {
            None
        } else {
            Some(index.min(count - 1))
        });
    }

    fn demo_fill(&self) -> Result<Request> {
        let record = self
            .records(0)
            .get(self.selected())
            .cloned()
            .context("select an asset first")?;
        let asset = self
            .state
            .as_ref()
            .and_then(|s| s.assets.iter().find(|a| a.rule.asset == record.key))
            .context("asset unavailable")?;
        let chunk = amount(&asset.rule.chunk)?;
        let value = add(add(chunk, chunk)?, chunk)?;
        Ok(Request::DemoFill {
            id: format!("tui-{}", Uuid::new_v4()),
            asset: record.key,
            amount: value.normalize().to_string(),
        })
    }
}

struct TaskGuard(tokio::task::JoinHandle<()>);
impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct PasteGuard;
impl Drop for PasteGuard {
    fn drop(&mut self) {
        let _ = execute!(std::io::stdout(), DisableBracketedPaste);
    }
}

pub fn watch(directory: PathBuf, runtime: Handle, animate: bool, text_icons: bool) -> Result<()> {
    use std::io::IsTerminal;
    anyhow::ensure!(
        std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
        "watch requires an interactive terminal"
    );
    let (commands, mut command_rx) = tokio::sync::mpsc::channel::<Request>(8);
    let (results, result_rx) = mpsc::channel();
    let worker_directory = directory.clone();
    let _task = TaskGuard(runtime.spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let request = tokio::select! {
                _=interval.tick()=>Request::Status,
                request=command_rx.recv()=>match request {Some(r)=>r,None=>break},
            };
            let command = !matches!(request, Request::Status);
            let result = ipc::call(&worker_directory, &request)
                .await
                .map_err(|e| format!("{e:#}"));
            if results.send((result, command)).is_err() {
                break;
            }
        }
    }));
    let mut view = View::default();
    view.receive(
        runtime
            .block_on(ipc::call(&directory, &Request::Status))
            .map_err(|error| format!("{error:#}")),
        false,
    );
    let mut animate = animate;
    loop {
        let prompt = ratatui::run(|terminal| -> Result<Input> {
            if !text_icons {
                view.mascot = mascot::Mascot::from_terminal();
            }
            view.intro = animate.then(Instant::now);
            animate = false;
            execute!(std::io::stdout(), EnableBracketedPaste)?;
            let _paste = PasteGuard;
            loop {
                while let Ok((result, command)) = result_rx.try_recv() {
                    view.receive(result, command);
                }
                if view.intro.is_some_and(|at| at.elapsed() >= INTRO) {
                    view.intro = None;
                }
                if view.intro.is_none() {
                    view.mascot.finish_intro();
                }
                std::io::stdout()
                    .sync_update(|_| terminal.draw(|frame| render(frame, &mut view)))??;
                if !event::poll(Duration::from_millis(if view.intro.is_some() {
                    32
                } else {
                    100
                }))? {
                    continue;
                }
                let action = match event::read()? {
                    Event::Key(key) => view.input(key),
                    Event::Paste(text) if view.searching => {
                        view.append_search(&text);
                        Input::None
                    }
                    _ => Input::None,
                };
                match action {
                    Input::Quit => return Ok(Input::Quit),
                    Input::Unlock | Input::SetKey | Input::EditRules | Input::SetupTelegram => {
                        return Ok(action);
                    }
                    Input::None => (),
                    Input::Send(request) => match commands.try_send(request) {
                        Ok(()) => {
                            view.pending = true;
                            view.notice = None;
                        }
                        Err(_) => {
                            view.notice = Some((
                                "Worker busy. Try again after it responds.".into(),
                                true,
                                Instant::now(),
                            ))
                        }
                    },
                }
            }
        })?;
        if matches!(prompt, Input::Quit) {
            return Ok(());
        }
        // Leave raw/alternate-screen mode before hidden terminal input. The worker
        // continues independently; no password ever enters the dashboard model.
        let result = match prompt {
            Input::EditRules => crate::live::editor::edit(&directory, &runtime),
            Input::SetKey => runtime.block_on(crate::launch::set_key(&directory)),
            Input::SetupTelegram => runtime.block_on(crate::launch::setup_telegram(&directory)),
            _ => runtime.block_on(crate::launch::unlock(&directory)),
        };
        match result {
            Ok(response) => view.receive(Ok(response), true),
            Err(error) => view.notice = Some((error.to_string(), true, Instant::now())),
        }
    }
}

fn field(label: &str, value: &str) -> (String, String) {
    (label.into(), value.into())
}
fn age(now: i64, then: i64) -> String {
    let s = now.saturating_sub(then).max(0);
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m", s / 60)
    } else if s < 86400 {
        format!("{}h {}m", s / 3600, s % 3600 / 60)
    } else {
        format!("{}d {}h", s / 86400, s % 86400 / 3600)
    }
}
fn asset_status(status: Option<&str>) -> String {
    match status {
        Some("Waiting for fills / minimum") => "Waiting for fills".into(),
        Some("Balance / reserve") => "Reserve / balance".into(),
        Some(s) => s.into(),
        None => "Ready".into(),
    }
}
fn live_job_explanation(status: &str) -> &'static str {
    match status {
        "unknown" => {
            "Kraken has not confirmed the outcome. Further chunks for this asset are blocked; check its withdrawal history before resolving."
        }
        "held" => {
            "Kraken placed this withdrawal on hold. Further chunks for this asset wait for it to settle."
        }
        "pending" | "submitted" | "submitting" => {
            "Waiting for Kraken to confirm this withdrawal. The reserved amount cannot be submitted again."
        }
        "complete" => {
            "Kraken confirmed this withdrawal completed. Check the receipt for its transaction ID."
        }
        "not_sent" => {
            "Reviewed as never sent. The amount was restored to the queue; withdrawals stayed paused pending explicit resumption."
        }
        "failed" => {
            "Kraken reported failure. Review the receipt; this transfer is not automatically requeued."
        }
        "rejected" => {
            "The request was rejected before acceptance. Its reserved amount was returned to the queue."
        }
        _ => "Live Kraken withdrawal record.",
    }
}
fn job_explanation(status: &str) -> &'static str {
    match status {
        "unknown" => {
            "No confirmed outcome. Further chunks for this asset are blocked until reviewed. Do not assume it failed."
        }
        "held" => {
            "The simulated exchange is holding this transfer. Further chunks for this asset are blocked until it settles or is reviewed."
        }
        "pending" | "submitted" => {
            "Funds are reserved. Waiting for the simulated exchange to confirm completion."
        }
        "complete" => "The simulator confirmed completion. This is not a real on-chain transfer.",
        "failed" => {
            "No simulated transfer completed. Reserved funds were retained or released to the queue."
        }
        _ => "Simulated withdrawal record.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{engine::Engine, model::Fill};
    use ratatui::{Terminal, backend::TestBackend};

    fn connected() -> View {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), 1000).unwrap();
        let mut view = View::default();
        view.receive(
            Ok(Response {
                ok: true,
                message: "Current worker state".into(),
                state: Some(engine.snapshot(1000).unwrap()),
            }),
            false,
        );
        view
    }
    fn key(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
    }
    #[test]
    fn cancelled_orders_toggle_is_local_and_does_not_remove_history() {
        let mut view = connected();
        view.tab = 7;
        let state = view.state.as_mut().unwrap();
        state.mode = "account".into();
        state.vault.state = crate::vault::VaultState::Unlocked;
        state.account_status.live.orders = ["open", "closed", "canceled", "cancelled", "expired"]
            .into_iter()
            .map(|status| crate::live::model::Order {
                id: status.into(),
                pair: "BTC/USD".into(),
                side: "buy".into(),
                order_type: "limit".into(),
                volume: "1".into(),
                filled: "0".into(),
                price: "10".into(),
                status: status.into(),
                client_id: None,
            })
            .collect();
        assert_eq!(
            view.records(7)
                .iter()
                .map(|r| r.key.as_str())
                .collect::<Vec<_>>(),
            ["open", "closed", "expired"]
        );
        view.select(1, 3);
        // This is a local display control, available even while disconnected.
        view.online = false;
        assert!(matches!(view.input(key('c')), Input::None));
        assert_eq!(view.records(7).len(), 5);
        assert_eq!(view.records(7)[view.selected()].key, "closed");
        view.select(2, 5);
        assert_eq!(view.records(7)[view.selected()].key, "canceled");
        view.input(key('c'));
        assert_eq!(view.records(7).len(), 3);
        assert_eq!(view.records(7)[view.selected()].key, "open");
        assert_eq!(
            view.state
                .as_ref()
                .unwrap()
                .account_status
                .live
                .orders
                .len(),
            5
        );
        view.input(key('/'));
        view.input(key('c'));
        assert!(!view.show_cancelled_orders);
        assert_eq!(view.queries[7], "c");
        view.input(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        let mut terminal = Terminal::new(TestBackend::new(70, 35)).unwrap();
        terminal.draw(|frame| render(frame, &mut view)).unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        assert!(text.contains("Cancelled hidden (2)"));
    }

    #[test]
    fn order_sort_keeps_selection_through_sort_refresh_and_search() {
        let mut view = connected();
        view.tab = 7;
        let state = view.state.as_mut().unwrap();
        state.mode = "account".into();
        state.vault.state = crate::vault::VaultState::Unlocked;
        state.account_status.live.orders = [("b", "10"), ("a", "2")]
            .into_iter()
            .map(|(id, price)| crate::live::model::Order {
                id: id.into(),
                pair: "BTC/USD".into(),
                side: "buy".into(),
                order_type: "limit".into(),
                volume: "1".into(),
                filled: "0".into(),
                price: price.into(),
                status: "open".into(),
                client_id: None,
            })
            .collect();
        view.select(1, 2);
        for _ in 0..4 {
            assert!(matches!(view.input(key('s')), Input::None));
        }
        assert_eq!(view.order_sort, OrderSort::Price);
        assert_eq!(view.records(7)[view.selected()].key, "b");
        assert!(matches!(view.input(key('o')), Input::None));
        assert_eq!(view.records(7)[0].key, "b");
        assert_eq!(view.records(7)[view.selected()].key, "b");
        let mut state = view.state.clone().unwrap();
        state.account_status.live.orders[0].price = "0.5".into();
        state.account_status.live.orders.reverse();
        view.receive(
            Ok(Response {
                ok: true,
                message: "updated".into(),
                state: Some(state),
            }),
            false,
        );
        assert_eq!(view.records(7)[0].key, "a");
        assert_eq!(view.records(7)[view.selected()].key, "b");
        view.input(key('/'));
        view.input(key('s'));
        view.input(key('o'));
        assert_eq!(view.queries[7], "so");
        assert_eq!(view.order_sort, OrderSort::Price);
        assert!(view.orders_descending);
        view.input(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        for width in [70, 80, 120] {
            let mut terminal = Terminal::new(TestBackend::new(width, 35)).unwrap();
            terminal.draw(|frame| render(frame, &mut view)).unwrap();
            let text = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|c| c.symbol())
                .collect::<String>();
            assert!(
                text.contains("Price ↓"),
                "missing sort indicator at {width}"
            );
            assert!(text.contains("S sort by"));
            assert!(!text.contains("Tab /"));
        }
    }
    #[test]
    fn footer_counts_rules_and_separates_keyboard_shortcuts() {
        let mut view = connected();
        let state = view.state.as_mut().unwrap();
        state.mode = "account".into();
        state.vault.state = crate::vault::VaultState::Unlocked;
        state.assets.clear();
        view.tab = 6;
        let mut terminal = Terminal::new(TestBackend::new(120, 35)).unwrap();
        terminal.draw(|frame| render(frame, &mut view)).unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        assert!(text.contains("0 rules"));
        assert!(!text.contains("7 watch rules"));
        assert!(text.contains("N alerts"));
        assert!(text.contains("Q close view"));
        assert!(matches!(view.input(key('n')), Input::SetupTelegram));
    }

    #[test]
    fn single_account_key_controls_and_wallet_details_disappear_on_lock() {
        let mut view = connected();
        let state = view.state.as_mut().unwrap();
        state.mode = "account".into();
        state.vault.state = crate::vault::VaultState::Unlocked;
        state.assets.clear();
        state.account_status.keys = vec![crate::model::KeyStatus {
            label: "Kraken".into(),
            saved: true,
            checked_at: Some(1000),
            permissions: vec![
                "query-funds".into(),
                "modify-trades".into(),
                "withdraw-funds".into(),
            ],
            account_id: None,
            error: None,
        }];
        state.account_status.wallets.push(crate::model::Wallet {
            id: "fixture".into(),
            name: "My destination".into(),
            address: "full-fixture-address".into(),
            memo: Some("Tag: 123".into()),
            assets: vec!["XRP".into()],
            network: "XRP".into(),
            verified: true,
            source: "kraken".into(),
            rule: None,
            methods: vec![],
        });
        view.input(key('6'));
        view.input(key('/'));
        view.append_search("Kraken");
        view.input(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(view.records(5).len(), 1);
        assert_eq!(view.records(5)[0].cells[2], "Read / Orders / Withdrawals");
        assert!(matches!(view.input(key('e')), Input::SetKey));
        assert!(matches!(
            view.input(key('c')),
            Input::Send(Request::CheckKey)
        ));
        assert!(matches!(view.input(key('d')), Input::None));
        assert!(matches!(view.input(key('r')), Input::Send(Request::Resume)));
        view.input(key('5'));
        assert!(matches!(
            view.input(key('f')),
            Input::Send(Request::RefreshWallets)
        ));
        view.input(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let Some(Overlay::Details(record)) = &view.overlay else {
            panic!("missing wallet details")
        };
        assert!(
            record
                .detail
                .contains(&field("Full address", "full-fixture-address"))
        );
        assert!(
            record
                .detail
                .contains(&field("Moby withdrawals", "No watch rule"))
        );
        let mut state = view.state.clone().unwrap();
        state.vault.state = crate::vault::VaultState::Locked;
        state.account_status.wallets.clear();
        view.receive(
            Ok(Response {
                ok: true,
                message: "locked".into(),
                state: Some(state),
            }),
            false,
        );
        assert!(view.overlay.is_none());
        assert!(matches!(view.input(key('f')), Input::None));
        assert!(matches!(view.input(key('u')), Input::Unlock));
    }

    #[test]
    fn balances_show_real_holds_and_refresh_is_blocked_when_locked_or_stale() {
        let mut view = connected();
        let state = view.state.as_mut().unwrap();
        state.mode = "account".into();
        state.assets.clear();
        state.vault.state = crate::vault::VaultState::Unlocked;
        state.account_status.balances_updated_at = Some(1000);
        state
            .account_status
            .balances
            .push(crate::model::AccountBalance {
                asset: "USDC".into(),
                balance: "300".into(),
                credit: "0".into(),
                credit_used: "0".into(),
                held_for_orders: "200".into(),
                available_for_trading: Some("100".into()),
            });
        assert_eq!(view.records(0)[0].cells, ["USDC", "300", "200", "100"]);
        assert!(matches!(
            view.input(key('b')),
            Input::Send(Request::RefreshBalances)
        ));
        for (width, height) in [(120, 35), (80, 24), (70, 18)] {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            terminal.draw(|frame| render(frame, &mut view)).unwrap();
            let text: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|c| c.symbol())
                .collect();
            assert!(text.contains("USDC"));
        }
        view.online = false;
        assert!(matches!(view.input(key('b')), Input::None));
        view.online = true;
        view.state.as_mut().unwrap().vault.state = crate::vault::VaultState::Locked;
        assert!(matches!(view.input(key('b')), Input::None));
    }

    #[test]
    fn stale_exchange_data_stays_visible_even_with_a_connected_worker_and_active_refresh() {
        let mut view = connected();
        let state = view.state.as_mut().unwrap();
        state.mode = "account".into();
        state.vault.state = crate::vault::VaultState::Unlocked;
        state.account_status.busy = true;
        for fresh in [
            &mut state.account_status.refresh.balances,
            &mut state.account_status.refresh.orders,
            &mut state.account_status.refresh.wallets,
        ] {
            fresh.enabled = true;
            fresh.stale = true;
            fresh.refreshing = true;
            fresh.interval_seconds = 30;
        }
        for tab in [0, 4, 7] {
            view.tab = tab;
            let mut terminal = Terminal::new(TestBackend::new(110, 30)).unwrap();
            terminal.draw(|frame| render(frame, &mut view)).unwrap();
            let text: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|c| c.symbol())
                .collect();
            assert!(text.contains("WORKER CONNECTED"));
            assert!(text.contains("STALE"));
            assert!(text.contains("Retrying automatically"));
        }
    }

    #[test]
    fn all_account_views_render_at_supported_sizes_without_simulated_balances() {
        let mut view = connected();
        view.state.as_mut().unwrap().mode = "account".into();
        view.state.as_mut().unwrap().assets.clear();
        for (width, height) in [(120, 35), (80, 24), (70, 18)] {
            for tab in 0..TITLES.len() {
                view.tab = tab;
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal.draw(|frame| render(frame, &mut view)).unwrap();
                let text: String = terminal
                    .backend()
                    .buffer()
                    .content
                    .iter()
                    .map(|c| c.symbol())
                    .collect();
                assert!(
                    text.contains("ACCOUNT"),
                    "account badge hidden at {width}x{height}"
                );
                assert!(text.contains("Key"));
                assert!(!text.contains("RUNNING"));
                assert!(!text.contains("BTC"));
            }
        }
    }

    #[test]
    fn locked_view_shows_unlock_action_and_blocks_mutations() {
        let mut view = connected();
        view.state.as_mut().unwrap().vault.state = crate::vault::VaultState::Locked;
        assert!(matches!(view.input(key('r')), Input::None));
        assert!(matches!(view.input(key('d')), Input::None));
        assert!(matches!(view.input(key('p')), Input::Send(Request::Pause)));
        assert!(matches!(view.input(key('u')), Input::Unlock));
        let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
        terminal.draw(|frame| render(frame, &mut view)).unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(text.contains("LOCKED"));
        assert!(text.contains("U unlock"));
        assert!(!text.contains("RUNNING"));
        view.input(key('/'));
        assert!(matches!(view.input(key('u')), Input::None));
    }

    #[test]
    fn overlays_search_and_whale_skip_cannot_trigger_controls() {
        let mut view = connected();
        view.intro = Some(Instant::now());
        assert!(matches!(view.input(key('r')), Input::None));
        assert!(view.intro.is_none());
        view.input(key('?'));
        assert!(matches!(view.input(key('r')), Input::None));
        assert!(view.overlay.is_some());
        view.input(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        view.input(key('/'));
        for c in "rpd".chars() {
            assert!(matches!(view.input(key(c)), Input::None));
        }
        assert_eq!(view.queries[0], "rpd");
        view.input(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(matches!(view.input(key('r')), Input::Send(Request::Resume)));
    }

    #[test]
    fn stale_data_and_pending_commands_disable_mutations() {
        let mut view = connected();
        view.received = Some(Instant::now() - Duration::from_secs(6));
        assert!(matches!(view.input(key('r')), Input::None));
        view.received = Some(Instant::now());
        view.pending = true;
        assert!(matches!(view.input(key('d')), Input::None));
        view.receive(
            Ok(Response {
                ok: true,
                message: "Current worker state".into(),
                state: None,
            }),
            false,
        );
        assert!(view.pending);
        view.receive(
            Ok(Response {
                ok: true,
                message: "Paused".into(),
                state: None,
            }),
            true,
        );
        assert!(!view.pending);
    }

    #[test]
    fn filtered_selection_targets_the_visible_asset_and_paste_cannot_inject_keys() {
        let mut view = connected();
        view.input(key('/'));
        view.append_search("ETH\n\u{1b}");
        assert_eq!(view.records(0).len(), 1);
        view.input(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let Input::Send(Request::DemoFill { asset, .. }) = view.input(key('d')) else {
            panic!("expected demo fill")
        };
        assert_eq!(asset, "ETH");
        view.append_search(&"x".repeat(200));
        assert_eq!(view.queries[0].chars().count(), 128);
    }

    #[test]
    fn selection_tracks_fill_identity_when_history_updates() {
        let mut view = connected();
        view.tab = 1;
        let state = view.state.as_mut().unwrap();
        state.fills = vec![Fill {
            id: "old".into(),
            asset: "BTC".into(),
            amount: "1".into(),
            at: 1000,
        }];
        let mut next = state.clone();
        next.fills.insert(
            0,
            Fill {
                id: "new".into(),
                asset: "BTC".into(),
                amount: "2".into(),
                at: 1001,
            },
        );
        view.receive(
            Ok(Response {
                ok: true,
                message: "Current worker state".into(),
                state: Some(next),
            }),
            false,
        );
        assert_eq!(view.records(1)[view.selected()].key, "old");
        view.input(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
        assert_eq!(view.records(1)[view.selected()].key, "new");
    }

    #[test]
    fn receipt_keeps_updating_when_a_status_filter_no_longer_matches() {
        let mut view = connected();
        view.tab = 2;
        view.queries[2] = "pending".into();
        view.state
            .as_mut()
            .unwrap()
            .withdrawals
            .push(crate::model::Withdrawal {
                id: "receipt".into(),
                asset: "BTC".into(),
                amount: "0.001".into(),
                fee: "0.00001".into(),
                destination: "Demo wallet".into(),
                status: "pending".into(),
                created_at: 1000,
                updated_at: 1000,
            });
        view.input(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let mut next = view.state.clone().unwrap();
        next.withdrawals[0].status = "complete".into();
        view.receive(
            Ok(Response {
                ok: true,
                message: "Current worker state".into(),
                state: Some(next),
            }),
            false,
        );
        assert!(view.records(2).is_empty());
        let Some(Overlay::Details(record)) = &view.overlay else {
            panic!("receipt closed unexpectedly")
        };
        assert_eq!(record.status, "complete");
    }

    #[test]
    fn full_details_can_scroll_to_destination_and_help_captures_controls() {
        let mut view = connected();
        view.input(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let mut terminal = Terminal::new(TestBackend::new(70, 18)).unwrap();
        terminal.draw(|f| render(f, &mut view)).unwrap();
        assert!(view.overlay_max_scroll > 0);
        view.input(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
        assert_eq!(view.overlay_scroll, view.overlay_max_scroll);
        terminal.draw(|f| render(f, &mut view)).unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        assert!(text.contains("Cooldown"));
        assert!(text.contains("Paused"));
    }
    #[test]
    fn watch_rules_and_orders_are_visible_and_edit_controls_respect_lock_and_overlays() {
        let mut view = connected();
        let state = view.state.as_mut().unwrap();
        state.mode = "account".into();
        state.vault.state = crate::vault::VaultState::Unlocked;
        state.account_status.live.config = Some(crate::live::tests::config());
        state.account_status.live.orders = vec![crate::live::model::Order {
            id: "order-1".into(),
            pair: "BTC/USDC".into(),
            side: "buy".into(),
            order_type: "market".into(),
            volume: "1".into(),
            filled: "1".into(),
            price: "0".into(),
            status: "closed".into(),
            client_id: None,
        }];
        view.input(key('7'));
        assert_eq!(view.records(6).len(), 2);
        assert!(matches!(view.input(key('e')), Input::EditRules));
        view.input(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(view.input(key('r')), Input::None));
        view.input(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        view.input(key('8'));
        assert_eq!(view.records(7).len(), 1);
        assert!(matches!(
            view.input(key('f')),
            Input::Send(Request::RefreshOrders)
        ));
        for width in [70, 80, 110] {
            let mut terminal = Terminal::new(TestBackend::new(width, 24)).unwrap();
            terminal.draw(|f| render(f, &mut view)).unwrap();
            let text = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|c| c.symbol())
                .collect::<String>();
            assert!(text.contains("8 Orders"));
            assert!(text.contains("BTC/USDC"));
        }
        view.state.as_mut().unwrap().vault.state = crate::vault::VaultState::Locked;
        view.input(key('7'));
        assert!(matches!(view.input(key('e')), Input::None));
    }
}

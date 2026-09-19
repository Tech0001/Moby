use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Cell, Clear, Gauge, Paragraph, Row, Table, Tabs, Wrap},
};
use rust_decimal::{Decimal, prelude::ToPrimitive};
use std::time::Duration;

use super::{INTRO, Overlay, Record, TITLES, View, age, splash};
use crate::model::{AssetStatus, add, amount};

pub(super) const AQUA: Color = Color::Rgb(94, 214, 204);
pub(super) const GOLD: Color = Color::Rgb(228, 188, 99);
pub(super) const DIM: Color = Color::Rgb(136, 155, 176);
pub(super) const BACKGROUND: Color = Color::Rgb(12, 20, 32);
pub(super) const WHITE: Color = Color::Rgb(224, 234, 245);
const PANEL: Color = Color::Rgb(17, 28, 43);
const BORDER: Color = Color::Rgb(43, 62, 84);
const RED: Color = Color::Rgb(249, 128, 127);

fn panel(title: impl Into<String>) -> Block<'static> {
    Block::default()
        .title(format!(" {} ", title.into()))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(BORDER))
        .style(Style::default().bg(PANEL).fg(WHITE))
}
fn color(status: &str) -> Color {
    if status.contains("unknown") || status.contains("held") {
        GOLD
    } else if status == "failed" {
        RED
    } else if matches!(status, "complete" | "ready" | "Ready") {
        AQUA
    } else if status.contains("pending") || status.contains("submitted") {
        Color::LightBlue
    } else {
        DIM
    }
}
fn label(value: impl Into<String>, color: Color) -> Span<'static> {
    Span::styled(value.into(), Style::default().fg(color))
}

pub fn render(frame: &mut Frame, view: &mut View) {
    let area = frame.area();
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(WHITE)),
        area,
    );
    if let Some(start) = view.intro {
        splash::draw(
            frame,
            start.elapsed().as_secs_f64() / INTRO.as_secs_f64(),
            &mut view.mascot,
        );
        return;
    }
    if area.width < 70 || area.height < 18 {
        frame.render_widget(
            Paragraph::new(
                "MOBY\nResize to at least 70 × 18.\nQ detaches; the worker stays running.",
            )
            .wrap(Wrap { trim: false }),
            area,
        );
        return;
    }
    let areas = Layout::vertical([
        Constraint::Length(if area.height >= 22 { 3 } else { 2 }),
        Constraint::Length(2),
        Constraint::Length(3),
        Constraint::Min(4),
        Constraint::Length(1),
        Constraint::Length(2),
    ])
    .horizontal_margin(1)
    .split(area);
    header(frame, areas[0], view);
    frame.render_widget(
        Tabs::new(
            (if area.width < 110 {
                &[
                    "Home", "Fills", "Sends", "Log", "Wallets", "Key", "Rules", "Orders",
                ]
            } else {
                &TITLES
            })
            .iter()
            .enumerate()
            .map(|(i, s)| format!("{} {}", i + 1, s)),
        )
        .select(view.tab)
        .divider(" ")
        .padding("", if area.width < 80 { "" } else { " " })
        .highlight_style(
            Style::default()
                .fg(AQUA)
                .bg(PANEL)
                .add_modifier(Modifier::BOLD),
        )
        .style(Style::default().fg(DIM)),
        areas[1],
    );
    summary(frame, areas[2], view);
    if view.tab == 0 {
        overview(frame, areas[3], view);
    } else {
        listing(frame, areas[3], view);
    }
    feedback(frame, areas[4], view);
    footer(frame, areas[5], view);
    if view.overlay.is_some() {
        overlay(frame, view);
    }
}

fn header(frame: &mut Frame, area: Rect, view: &View) {
    let halves = Layout::horizontal([Constraint::Min(38), Constraint::Length(26)]).split(area);
    let brand = Layout::horizontal([
        Constraint::Length(if area.height >= 3 { 14 } else { 10 }),
        Constraint::Min(24),
    ])
    .spacing(1)
    .split(halves[0]);
    view.mascot.draw(frame, brand[0]);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled(
                    " MOBY ",
                    Style::default().fg(GOLD).add_modifier(Modifier::BOLD),
                ),
                label(format!("v{}  ", env!("CARGO_PKG_VERSION")), DIM),
                Span::styled(
                    if view.account() {
                        " ACCOUNT "
                    } else {
                        " PAPER "
                    },
                    Style::default().fg(GOLD).bg(PANEL),
                ),
            ]),
            Line::from(label(
                format!(
                    "{} · {}",
                    view.state
                        .as_ref()
                        .map(|s| s.account.as_str())
                        .unwrap_or("Connecting"),
                    if view.account() {
                        "live account"
                    } else {
                        "simulated funds"
                    }
                ),
                DIM,
            )),
        ]),
        brand[1],
    );
    let link = if view.connected() {
        "● WORKER CONNECTED"
    } else if view.received.is_some() {
        "○ DISCONNECTED · STALE"
    } else {
        "○ CONNECTING TO WORKER"
    };
    let since = view
        .received
        .map(|at| {
            format!(
                "{} · {}s ago ",
                if view.locked() {
                    "LOCKED · U unlock"
                } else if view.account() {
                    "Vault unlocked"
                } else {
                    "Paper account"
                },
                at.elapsed().as_secs()
            )
        })
        .unwrap_or_else(|| "retrying automatically ".into());
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(label(link, if view.connected() { AQUA } else { GOLD })),
            Line::from(label(since, DIM)),
        ])
        .alignment(Alignment::Right),
        halves[1],
    );
}

fn summary(frame: &mut Frame, area: Rect, view: &View) {
    let cards = Layout::horizontal([Constraint::Percentage(25); 4])
        .spacing(1)
        .split(area);
    let Some(state) = &view.state else {
        for (rect, title) in
            cards
                .iter()
                .zip(["Withdrawals", "Queued assets", "In flight", "Needs review"])
        {
            frame.render_widget(
                Paragraph::new(" —")
                    .style(Style::default().fg(DIM))
                    .block(panel(title)),
                *rect,
            );
        }
        return;
    };
    if view.account() {
        let live = &state.account_status.live;
        for (rect, (title, value)) in cards.iter().zip([
            (
                "Withdrawals",
                if view.locked() {
                    "LOCKED".into()
                } else if state.paused {
                    "PAUSED".into()
                } else if let Some(timer) = state
                    .withdrawal_cooldown
                    .as_ref()
                    .filter(|timer| timer.remaining(state.observed_at) > 0)
                {
                    format!("WAIT {}s · all", timer.remaining(state.observed_at))
                } else {
                    "RUNNING".into()
                },
            ),
            (
                "WebSocket",
                if live.config.is_none() {
                    "Not configured".into()
                } else {
                    live.websocket.clone()
                },
            ),
            (
                if live.config.is_none() {
                    "Account data"
                } else {
                    "REST catch-up"
                },
                if live.config.is_none() {
                    let refresh = &state.account_status.refresh;
                    if refresh.balances.stale || refresh.orders.stale || refresh.wallets.stale {
                        "STALE / loading".into()
                    } else {
                        "Auto refresh".into()
                    }
                } else if live.rest_error.is_some() {
                    "Needs attention".into()
                } else {
                    live.rest_updated_at
                        .map(|at| format!("{} ago", age(state.observed_at, at)))
                        .unwrap_or_else(|| "Waiting".into())
                },
            ),
            (
                "Transfers",
                format!(
                    "{} active · {} review",
                    live.transfers.iter().filter(|t| t.active()).count(),
                    live.transfers
                        .iter()
                        .filter(|t| matches!(t.status.as_str(), "unknown" | "held"))
                        .count()
                ),
            ),
        ]) {
            frame.render_widget(
                Paragraph::new(format!(" {value}"))
                    .style(Style::default().fg(AQUA))
                    .block(panel(title)),
                *rect,
            );
        }
        return;
    }
    let pending = state
        .withdrawals
        .iter()
        .filter(|w| {
            matches!(
                w.status.as_str(),
                "pending" | "submitted" | "held" | "unknown"
            )
        })
        .count();
    let review = state
        .withdrawals
        .iter()
        .filter(|w| matches!(w.status.as_str(), "held" | "unknown"))
        .count();
    let queued = state
        .assets
        .iter()
        .filter(|a| amount(&a.queued).is_ok_and(|n| n > Decimal::ZERO))
        .count();
    let status = if !view.connected() {
        "STALE"
    } else if view.locked() {
        "LOCKED"
    } else if state.paused {
        "PAUSED"
    } else {
        "RUNNING"
    };
    for (i, (title, value, tint)) in [
        (
            "Withdrawals",
            status.to_string(),
            if view.connected() && !state.paused && !view.locked() {
                AQUA
            } else {
                GOLD
            },
        ),
        (
            "Queued assets",
            format!("{queued} / {}", state.assets.len()),
            WHITE,
        ),
        (
            "In flight",
            format!("{pending} / 2"),
            if pending > 0 { AQUA } else { DIM },
        ),
        (
            "Needs review",
            if review == 0 {
                "None".into()
            } else {
                review.to_string()
            },
            if review > 0 { GOLD } else { DIM },
        ),
    ]
    .into_iter()
    .enumerate()
    {
        frame.render_widget(
            Paragraph::new(format!(" {value}"))
                .style(Style::default().fg(tint).add_modifier(Modifier::BOLD))
                .block(panel(title)),
            cards[i],
        );
    }
}

fn overview(frame: &mut Frame, area: Rect, view: &mut View) {
    if view.account() {
        if view
            .state
            .as_ref()
            .is_some_and(|s| s.account_status.balances_updated_at.is_some())
        {
            let rows = Layout::vertical([Constraint::Length(2), Constraint::Min(3)]).split(area);
            let state = view.state.as_ref().unwrap();
            let updated = state.account_status.balances_updated_at.unwrap();
            let fresh = &state.account_status.refresh.balances;
            frame.render_widget(Paragraph::new(format!(
                " {} · checked {} ago · auto {}s · B refresh now\n Availability includes credit; spot non-margin holds only. Not a withdrawal quote.",
                fresh.label(), age(state.observed_at, updated), fresh.interval_seconds)).style(Style::default().fg(if fresh.stale { GOLD } else { DIM })), rows[0]);
            let records = view.records(0);
            records_table(frame, rows[1], view, &records);
            return;
        }
        let rows = Layout::vertical([
            Constraint::Min(5),
            Constraint::Length(if area.height >= 14 { 6 } else { 0 }),
        ])
        .split(area);
        let mut lines = vec![
            Line::from(label("Set up your Kraken account", AQUA)),
            Line::from("Unlocked accounts refresh balances and orders automatically every 30s."),
            Line::from("6 API Key → E enters your account key; C checks permissions."),
            Line::from("            Read and write permissions use the same key."),
            Line::from("5 Wallets refreshes automatically every 5 minutes; F refreshes now."),
            Line::from("           Enter shows the full address, network and memo/tag."),
            Line::from(""),
            Line::from("7 Watch rules → E configures fills, destinations, chunks and cooldowns."),
            Line::from(
                "P pauses withdrawals; account data keeps updating. R resumes configured rules.",
            ),
            Line::from("moby --demo opens a separate paper account with simulated funds."),
            Line::from("moby --account NAME opens another Kraken account profile."),
        ];
        if let Some(state) = &view.state {
            if let Some(at) = state.account_status.wallets_updated_at {
                lines.push(Line::from(label(
                    format!(
                        "Wallet cache refreshed {} ago; F refreshes it on the Wallets page.",
                        age(state.observed_at, at)
                    ),
                    DIM,
                )));
            }
            if let Some(error) = &state.account_status.sync_error {
                lines.push(Line::from(label(error, RED)));
            }
        }
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: false })
                .block(panel("Account setup")),
            rows[0],
        );
        if rows[1].height > 0 {
            activity(frame, rows[1], view);
        }
        return;
    }
    let records = view.records(0);
    let selected = records.get(view.selected()).cloned();
    let asset = selected
        .as_ref()
        .and_then(|r| {
            view.state
                .as_ref()?
                .assets
                .iter()
                .find(|a| a.rule.asset == r.key)
        })
        .cloned();
    let wide = area.width >= 108 && area.height >= 13;
    if wide {
        let columns = Layout::horizontal([Constraint::Percentage(62), Constraint::Min(34)])
            .spacing(1)
            .split(area);
        let rows = Layout::vertical([
            Constraint::Length((records.len() as u16 + 4).clamp(6, 10)),
            Constraint::Min(5),
        ])
        .spacing(1)
        .split(columns[0]);
        records_table(frame, rows[0], view, &records);
        activity(frame, rows[1], view);
        let right = Layout::vertical([Constraint::Length(12), Constraint::Min(0)])
            .spacing(1)
            .split(columns[1]);
        asset_panel(frame, right[0], asset.as_ref(), view);
        if right[1].height >= 4 {
            recent_transfers(frame, right[1], view);
        }
    } else {
        let table_height = (records.len() as u16 + 4)
            .clamp(5, 9)
            .min(area.height.saturating_sub(3));
        let detail_height = if area.height >= 17 {
            9
        } else if area.height >= 12 {
            6
        } else {
            3
        };
        let rows = Layout::vertical([
            Constraint::Length(table_height),
            Constraint::Length(detail_height),
            Constraint::Min(0),
        ])
        .split(area);
        records_table(frame, rows[0], view, &records);
        asset_panel(frame, rows[1], asset.as_ref(), view);
        if rows[2].height >= 4 {
            activity(frame, rows[2], view);
        }
    }
}

fn listing(frame: &mut Frame, area: Rect, view: &mut View) {
    let records = view.records(view.tab);
    let selected = records.get(view.selected()).cloned();
    if area.width >= 108 {
        let cols = Layout::horizontal([Constraint::Percentage(62), Constraint::Min(34)])
            .spacing(1)
            .split(area);
        records_table(frame, cols[0], view, &records);
        detail_panel(frame, cols[1], selected.as_ref());
    } else {
        let rows = Layout::vertical([
            Constraint::Min(4),
            Constraint::Length(if area.height >= 12 { 5 } else { 0 }),
        ])
        .split(area);
        records_table(frame, rows[0], view, &records);
        if rows[1].height > 0 {
            detail_panel(frame, rows[1], selected.as_ref());
        }
    }
}

fn records_table(frame: &mut Frame, area: Rect, view: &mut View, records: &[Record]) {
    let parts = Layout::vertical([Constraint::Length(1), Constraint::Min(2)]).split(area);
    let query = &view.queries[view.tab];
    let filter = if view.searching {
        let visible = area.width.saturating_sub(34) as usize;
        let tail: String = query
            .chars()
            .rev()
            .take(visible)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!(
            " / {}{tail}▏  · Enter keep · Esc clear",
            if query.chars().count() > visible {
                "…"
            } else {
                ""
            }
        )
    } else if !query.is_empty() {
        format!(" / {query}  · Esc clear")
    } else {
        format!(" {}  · / search  · Enter details", TITLES[view.tab])
    };
    let filter = if view.tab == 7 && !view.searching {
        let cancelled = view
            .state
            .as_ref()
            .map(|s| {
                s.account_status
                    .live
                    .orders
                    .iter()
                    .filter(|o| o.is_cancelled())
                    .count()
            })
            .unwrap_or(0);
        let title = if query.is_empty() {
            "Orders · / search".to_owned()
        } else {
            format!("/ {query} · Esc clear")
        };
        format!(
            " {title} · {} {} · Cancelled {} ({cancelled})",
            view.order_sort.label(),
            if view.orders_descending { "↓" } else { "↑" },
            if view.show_cancelled_orders {
                "shown"
            } else {
                "hidden"
            }
        )
    } else {
        filter
    };
    frame.render_widget(
        Paragraph::new(filter).style(Style::default().fg(if view.searching { AQUA } else { DIM })),
        parts[0],
    );
    let area = parts[1];
    let title = if view.tab == 0 && view.account() {
        "Kraken balances"
    } else if view.tab == 0 {
        "Assets"
    } else if view.tab == 2 {
        "Transfers · active first"
    } else {
        TITLES[view.tab]
    };
    let chosen = if records.is_empty() {
        0
    } else {
        view.selected().min(records.len() - 1) + 1
    };
    let freshness = view.freshness(view.tab);
    let title = freshness
        .map(|f| format!("{title} · {}", f.label()))
        .unwrap_or_else(|| title.into());
    let mut block = panel(format!("{title}  {chosen}/{}", records.len()));
    if freshness.is_some_and(|f| f.stale) {
        block = block.border_style(Style::default().fg(GOLD));
    }
    if records.is_empty() {
        let empty = if !query.is_empty() {
            "No matches. Esc clears the filter."
        } else if view.state.is_none() {
            "Waiting for the worker…"
        } else {
            match view.tab {
                0 if view.account() => {
                    "No balances loaded yet. The unlocked worker refreshes automatically; B refreshes now."
                }
                4 if view.locked() => "Unlock with U to view your saved destinations.",
                4 if view.account() => {
                    "No crypto destinations loaded. Set your key on 6 API Key; the unlocked worker refreshes automatically. Add or verify addresses on Kraken."
                }
                5 if !view.account() => {
                    "Paper mode does not store keys or contact Kraken. Run moby without --demo to set up your real account."
                }
                1 | 2 if view.account() => {
                    "Configure 7 Watch rules to monitor future fills. Withdrawals start only after R resumes them."
                }
                1 => "No fills yet. On Overview, select an asset and press D to simulate a fill.",
                2 => "No transfers yet. Queued funds will move in chunks after you resume.",
                6 => {
                    "No watch rules yet. Press E to choose an asset, rotating wallets, chunk size and cooldown. Save, then R enables withdrawals for matching fills."
                }
                7 => {
                    "No orders loaded. Open and recent closed orders refresh automatically; F refreshes now. CLI: moby orders --help."
                }
                _ => "No activity yet.",
            }
        };
        frame.render_widget(
            Paragraph::new(empty)
                .wrap(Wrap { trim: false })
                .block(block)
                .style(Style::default().fg(DIM)),
            area,
        );
        return;
    }
    let (headers, widths): (Vec<&str>, Vec<Constraint>) = match view.tab {
        0 if view.account() => (
            vec!["Asset", "Balance", "Held for orders", "Available"],
            vec![
                Constraint::Length(12),
                Constraint::Percentage(29),
                Constraint::Percentage(25),
                Constraint::Min(16),
            ],
        ),
        0 => (
            vec!["Asset", "Queued", "Spendable", "State"],
            vec![
                Constraint::Length(7),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Min(17),
            ],
        ),
        1 => (
            vec!["Asset", "Net received", "Age", "Fill ID"],
            vec![
                Constraint::Length(7),
                Constraint::Percentage(26),
                Constraint::Length(7),
                Constraint::Min(16),
            ],
        ),
        2 => (
            vec!["Asset", "Amount", "State", "Age"],
            vec![
                Constraint::Length(7),
                Constraint::Percentage(32),
                Constraint::Min(12),
                Constraint::Length(8),
            ],
        ),
        4 => (
            vec!["Label", "Assets", "Network", "Kraken"],
            vec![
                Constraint::Percentage(27),
                Constraint::Percentage(20),
                Constraint::Min(12),
                Constraint::Length(10),
            ],
        ),
        5 => (
            vec!["Key", "Status", "Access"],
            vec![
                Constraint::Length(8),
                Constraint::Length(16),
                Constraint::Min(14),
            ],
        ),
        6 => (
            vec!["Asset", "Queued", "Gross chunk", "State"],
            vec![
                Constraint::Length(8),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Min(14),
            ],
        ),
        7 => (
            vec!["Pair", "Side / type", "Price", "Filled / size", "State"],
            vec![
                Constraint::Percentage(17),
                Constraint::Percentage(25),
                Constraint::Percentage(17),
                Constraint::Percentage(26),
                Constraint::Min(8),
            ],
        ),
        _ => (
            vec!["Age", "Event"],
            vec![Constraint::Length(8), Constraint::Min(20)],
        ),
    };
    let tab = view.tab;
    let rows = records.iter().map(|r| {
        Row::new(
            r.cells
                .iter()
                .enumerate()
                .map(|(i, value)| {
                    let numeric = match tab {
                        0 => matches!(i, 1 | 2),
                        1 | 2 => i == 1,
                        7 => matches!(i, 2 | 3),
                        _ => false,
                    };
                    let cell = Cell::from(Line::from(value.clone()).alignment(if numeric {
                        Alignment::Right
                    } else {
                        Alignment::Left
                    }));
                    if i == 0 && tab != 3 {
                        cell.style(Style::default().fg(AQUA).add_modifier(Modifier::BOLD))
                    } else if (tab == 0 && i == 3) || (tab == 2 && i == 2) {
                        cell.style(Style::default().fg(color(&r.status)))
                    } else {
                        cell
                    }
                })
                .collect::<Vec<_>>(),
        )
    });
    view.page_size = area.height.saturating_sub(3).max(1) as usize;
    view.select(view.selected(), records.len());
    let table = Table::new(rows, widths)
        .header(Row::new(headers).style(Style::default().fg(DIM)))
        .block(block)
        .highlight_symbol("› ")
        .column_spacing(2)
        .row_highlight_style(Style::default().bg(Color::Rgb(27, 48, 62)))
        .style(Style::default().fg(WHITE));
    frame.render_stateful_widget(table, area, &mut view.tables[view.tab]);
}

fn asset_panel(frame: &mut Frame, area: Rect, asset: Option<&AssetStatus>, view: &View) {
    let Some(asset) = asset else {
        frame.render_widget(
            Paragraph::new("Select an asset to inspect its withdrawal rule.")
                .wrap(Wrap { trim: false })
                .block(panel("Selected asset")),
            area,
        );
        return;
    };
    let title = format!("{} → {}", asset.rule.asset, asset.rule.destination);
    let block = panel(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 {
        return;
    }
    if area.height <= 4 {
        frame.render_widget(
            Paragraph::new(format!(
                "Chunk {} · fee {} · Enter for full rule",
                asset.rule.chunk, asset.rule.fee
            ))
            .style(Style::default().fg(DIM)),
            inner,
        );
        return;
    }
    let vertical = Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).split(inner);
    let target = amount(&asset.rule.chunk)
        .and_then(|n| add(n, amount(&asset.rule.fee)?))
        .ok();
    let queued = amount(&asset.queued).unwrap_or(Decimal::ZERO);
    let ratio = target
        .and_then(|total| queued.checked_div(total))
        .and_then(|n| n.to_f64())
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    let gauge_text = format!(
        "{} / {} {}",
        asset.queued,
        target
            .map(|v| v.normalize().to_string())
            .unwrap_or_else(|| "—".into()),
        asset.rule.asset
    );
    frame.render_widget(
        Gauge::default()
            .ratio(ratio)
            .label(gauge_text)
            .gauge_style(Style::default().fg(AQUA).bg(BACKGROUND))
            .block(
                Block::default().title(Span::styled("Full chunk + fee", Style::default().fg(DIM))),
            ),
        vertical[0],
    );
    let mut lines = vec![
        Line::from(vec![
            label("Chunk  ", DIM),
            label(&asset.rule.chunk, WHITE),
            label("   Fee  ", DIM),
            label(&asset.rule.fee, WHITE),
        ]),
        Line::from(vec![
            label("Reserve  ", DIM),
            label(&asset.rule.reserve, WHITE),
            label("   Cooldown  ", DIM),
            label(
                format!(
                    "{}s",
                    view.state
                        .as_ref()
                        .and_then(|s| s.withdrawal_cooldown_seconds)
                        .unwrap_or(0)
                ),
                WHITE,
            ),
        ]),
    ];
    if area.height >= 9 {
        lines.push(Line::from(vec![
            label("Minimum  ", DIM),
            label(&asset.rule.minimum, WHITE),
        ]));
        lines.push(Line::from(""));
        let note = if !view.connected() {
            "Last known amounts. Waiting for a fresh worker snapshot."
        } else if view.locked() {
            "Vault locked. U unlocks; no new withdrawals can start."
        } else if view.state.as_ref().is_some_and(|s| s.paused) {
            "Paused. Fills still accumulate; R checks balances and resumes."
        } else {
            "Smaller final chunks can send once the minimum and fee are covered."
        };
        lines.push(Line::from(label(note, DIM)));
        if area.height >= 13 {
            lines.push(Line::from(""));
            lines.push(Line::from(label(
                "D simulates a fill · Enter opens the full rule",
                AQUA,
            )));
        }
    }
    frame.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }),
        vertical[1],
    );
}

fn activity(frame: &mut Frame, area: Rect, view: &View) {
    let lines = view
        .state
        .as_ref()
        .map(|s| {
            s.activity
                .iter()
                .take(area.height.saturating_sub(2) as usize)
                .map(|a| {
                    Line::from(vec![
                        label(format!("{:>5}  ", age(s.observed_at, a.at)), DIM),
                        label(&a.message, WHITE),
                    ])
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    frame.render_widget(
        Paragraph::new(lines).block(panel("Recent activity · 4 opens full history")),
        area,
    );
}

fn recent_transfers(frame: &mut Frame, area: Rect, view: &View) {
    let mut lines = Vec::new();
    if let Some(state) = &view.state {
        for job in state
            .withdrawals
            .iter()
            .take(area.height.saturating_sub(2) as usize / 2)
        {
            lines.push(Line::from(vec![label(
                format!("{}  {}", job.asset, job.amount),
                WHITE,
            )]));
            lines.push(Line::from(vec![
                label(
                    format!("{}  ", job.status.to_uppercase()),
                    color(&job.status),
                ),
                label(age(state.observed_at, job.created_at), DIM),
            ]));
        }
    }
    if lines.is_empty() {
        lines.push(Line::from(label("No transfers yet.", DIM)));
        lines.push(Line::from(label("D adds a fill; R resumes.", DIM)));
    }
    frame.render_widget(
        Paragraph::new(lines).block(panel("Transfers · 3 opens history")),
        area,
    );
}

fn detail_lines(record: &Record) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for (key, value) in &record.detail {
        lines.push(Line::from(label(key, DIM)));
        lines.push(Line::from(label(
            value,
            if key == "Status" {
                color(&record.status)
            } else {
                WHITE
            },
        )));
        lines.push(Line::from(""));
    }
    lines
}

fn detail_panel(frame: &mut Frame, area: Rect, record: Option<&Record>) {
    let block = panel("Selected row · Enter for full details");
    let Some(record) = record else {
        frame.render_widget(
            Paragraph::new("Select a row to inspect it.")
                .style(Style::default().fg(DIM))
                .block(block),
            area,
        );
        return;
    };
    let lines = if area.height <= 5 {
        record
            .detail
            .iter()
            .take(2)
            .map(|(key, value)| {
                Line::from(vec![label(format!("{key}  "), DIM), label(value, WHITE)])
            })
            .collect()
    } else {
        detail_lines(record)
    };
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .block(block),
        area,
    );
}

fn feedback(frame: &mut Frame, area: Rect, view: &View) {
    let (text, tint) = if view.pending {
        ("Sending request to worker…".into(), GOLD)
    } else if !view.connected() {
        (
            if view.state.is_some() {
                "Reconnecting automatically. Displayed amounts are stale; actions are disabled."
                    .into()
            } else {
                view.connection_error
                    .clone()
                    .unwrap_or_else(|| "Connecting… Run moby to start or reconnect.".into())
            },
            GOLD,
        )
    } else if let Some((message, error, _)) = view
        .notice
        .as_ref()
        .filter(|(_, _, at)| at.elapsed() < Duration::from_secs(8))
    {
        (message.clone(), if *error { RED } else { AQUA })
    } else if view.locked() {
        (
            "Vault locked. Press U to unlock; new withdrawals are blocked.".into(),
            GOLD,
        )
    } else if view.account() {
        let status = &view.state.as_ref().unwrap().account_status;
        if let Some(error) = status
            .balances_error
            .as_ref()
            .or(status.sync_error.as_ref())
            .or(status.live.rest_error.as_ref())
            .or(status.live.orders_error.as_ref())
        {
            (
                format!(
                    "Kraken refresh failed; last known data shown. Retrying automatically. {error}"
                ),
                RED,
            )
        } else if view
            .freshness(view.tab)
            .is_some_and(|f| f.stale && f.enabled)
        {
            ("STALE / loading — waiting for a successful Kraken refresh. Retrying automatically.".into(), GOLD)
        } else if status.busy {
            (
                "Refreshing Kraken automatically… you can keep using the dashboard.".into(),
                DIM,
            )
        } else {
            (
                format!(
                    "{} rules · {} fills · {} completed · {} · Telegram {}",
                    status
                        .live
                        .config
                        .as_ref()
                        .map(|c| c.rules.len())
                        .unwrap_or(0),
                    view.state.as_ref().unwrap().fill_count,
                    view.state.as_ref().unwrap().completed_count,
                    if view.state.as_ref().unwrap().paused {
                        "withdrawals paused"
                    } else {
                        "watching for fills"
                    },
                    if status.telegram.last_error.is_some() {
                        "needs attention"
                    } else if status.telegram.enabled {
                        "on"
                    } else {
                        "off"
                    }
                ),
                DIM,
            )
        }
    } else if let Some(state) = &view.state {
        (
            format!(
                "{} fills · {} completed · worker up {} · {}",
                state.fill_count,
                state.completed_count,
                age(state.observed_at, state.started_at),
                if state.paused {
                    "paused; fills still monitored"
                } else {
                    "watching for fills"
                }
            ),
            DIM,
        )
    } else {
        (String::new(), DIM)
    };
    frame.render_widget(Paragraph::new(text).style(Style::default().fg(tint)), area);
}

fn footer(frame: &mut Frame, area: Rect, view: &View) {
    let lines = if view.searching {
        vec![
            " Type to filter · Enter keeps filter · Esc clears · Ctrl-U clears text",
            " Paste supported · search only affects this view",
        ]
    } else {
        vec![
            " ←→ / 1–8 switch views   ↑↓ select   / search   Enter details   ? help",
            if view.locked() {
                " U unlock   Q detach · worker stays running"
            } else if view.account() && view.tab == 5 {
                " E enter / replace key   C check permissions   Q detach"
            } else if view.account() && view.tab == 4 {
                " F sync from Kraken   Enter full address / network / memo   Q detach"
            } else if view.account() && view.tab == 6 {
                " E add/edit rule   P pause   R enable withdrawals   N alerts   Q close view"
            } else if view.account() && view.tab == 7 {
                " S sort by   O reverse   C cancelled   F refresh   Q detach"
            } else if view.account() {
                " P pause   R enable withdrawals   N alerts   Q close view (worker stays on)"
            } else if view.tab == 0 {
                " P pause   R resume   D demo fill   Q detach · worker stays running"
            } else {
                " P pause   R resume   PgUp/PgDn scroll   Q detach · worker stays running"
            },
        ]
    };
    frame.render_widget(
        Paragraph::new(
            lines
                .into_iter()
                .map(|s| Line::from(label(s, DIM)))
                .collect::<Vec<_>>(),
        ),
        area,
    );
}

fn overlay(frame: &mut Frame, view: &mut View) {
    let area = frame.area();
    let width = area.width.saturating_sub(4).min(82);
    let height = area.height.saturating_sub(2).min(30);
    let popup = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    let (title, lines) = match view.overlay.as_ref().unwrap() {
        Overlay::Details(record) => (
            if view.account() {
                "Details · account"
            } else {
                "Details · simulated data"
            },
            detail_lines(record),
        ),
        Overlay::Help => (
            "Keyboard & behavior",
            vec![
                Line::from(label("NAVIGATION", AQUA)),
                Line::from("← / → or 1–8               Switch views"),
                Line::from("↑ / ↓ or J / K             Select a row"),
                Line::from("Page Up / Down · Home / End Scroll / jump"),
                Line::from("Enter                      Inspect the full selected record"),
                Line::from("/                          Search the current view"),
                Line::from("Esc                        Clear a filter or close a panel"),
                Line::from(""),
                Line::from(label("CONTROLS", AQUA)),
                Line::from("P     Pause withdrawals; monitoring and submitted jobs continue"),
                Line::from("R     Reconcile balances, then resume configured withdrawals"),
                Line::from("D     Simulate a fill for the selected Overview asset"),
                Line::from("E / C Enter the account key / check permissions (API Key page)"),
                Line::from("F     Refresh Kraken destinations using account key (Wallets page)"),
                Line::from("B     Refresh Kraken balances and spot-order holds (Overview)"),
                Line::from("E     Add/edit rules on 7 Watch rules (pause first)"),
                Line::from("F     Refresh orders on 8 Orders"),
                Line::from("S / O Change sort field / reverse direction on 8 Orders"),
                Line::from("C     Show/hide cancelled orders on 8 Orders (hidden by default)"),
                Line::from("U     Unlock the vault after locking or a worker restart"),
                Line::from("Q     Close this view; keep the background worker running"),
                Line::from("CLI   moby --help lists flags and commands; moby stop ends the worker"),
                Line::from(""),
                Line::from(label("SEPARATE ACCOUNT AND PAPER PROFILES", AQUA)),
                Line::from(
                    "The dashboard and CLI see the same queue. Held and unknown jobs block further chunks for their asset until reviewed.",
                ),
                Line::from(
                    "Account automation uses saved watch rules and verified destinations. Paper mode never loads keys or contacts Kraken.",
                ),
                Line::from(""),
                Line::from(
                    "Search and this panel capture keys. No withdrawal controls run underneath them.",
                ),
                Line::from("Use watch --no-animation to skip the whale at launch."),
            ],
        ),
    };
    frame.render_widget(Clear, popup);
    let block = panel(title).border_style(Style::default().fg(AQUA));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);
    let sections = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).split(inner);
    let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
    view.overlay_max_scroll = paragraph
        .line_count(sections[0].width)
        .saturating_sub(sections[0].height as usize)
        .min(u16::MAX as usize) as u16;
    view.overlay_scroll = view.overlay_scroll.min(view.overlay_max_scroll);
    frame.render_widget(paragraph.scroll((view.overlay_scroll, 0)), sections[0]);
    frame.render_widget(
        Paragraph::new(format!(
            " Esc close · ↑↓ scroll   {}/{}",
            view.overlay_scroll, view.overlay_max_scroll
        ))
        .style(Style::default().fg(DIM)),
        sections[1],
    );
}

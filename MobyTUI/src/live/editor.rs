//! Human-facing rule editor. The same validated request is available to agents as JSON.
use super::{model::*, store::minimum_for_destinations};
use crate::{
    ipc, launch,
    model::{Request, Response, amount, positive},
};
use anyhow::{Context, Result, bail, ensure};
use crossterm::{
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEventKind,
        KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode},
};
use rust_decimal::Decimal;
use std::{
    io::{Write, stdout},
    path::Path,
};
use tokio::runtime::Handle;
fn prompt(label: &str, default: &str) -> Result<String> {
    enable_raw_mode()?;
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = execute!(stdout(), DisableBracketedPaste);
            let _ = disable_raw_mode();
            let _ = writeln!(stdout());
        }
    }
    let _guard = Guard;
    execute!(stdout(), EnableBracketedPaste)?;
    // Make input ready before showing the prompt so fast typing/paste cannot
    // arrive in canonical mode and lose the Enter key during the transition.
    print!("{label} [{}]: ", default);
    stdout().flush()?;
    let mut value = String::new();
    loop {
        match event::read()? {
            Event::Key(k) if k.kind != KeyEventKind::Release => match k.code {
                KeyCode::Esc => bail!("Rule editing cancelled; nothing saved"),
                KeyCode::Char('c' | 'd') if k.modifiers.contains(KeyModifiers::CONTROL) => {
                    bail!("Rule editing cancelled; nothing saved")
                }
                KeyCode::Enter => {
                    return Ok(if value.is_empty() {
                        default.into()
                    } else {
                        value
                    });
                }
                KeyCode::Backspace => {
                    if value.pop().is_some() {
                        print!("\x08 \x08");
                    }
                }
                KeyCode::Char(c)
                    if !k
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                        && !c.is_control()
                        && value.len() < 4096 =>
                {
                    value.push(c);
                    print!("{c}");
                }
                _ => (),
            },
            Event::Paste(p) => {
                for c in p.chars().filter(|c| !c.is_control()) {
                    if value.len() < 4096 {
                        value.push(c);
                        print!("{c}");
                    }
                }
            }
            _ => (),
        }
        stdout().flush()?;
    }
}
fn list(s: String) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn prompt_amount(label: &str, default: &str, minimum: Decimal, nonzero: bool) -> Result<String> {
    loop {
        let value = prompt(label, default)?;
        let parsed = if nonzero {
            positive(&value)
        } else {
            amount(&value)
        };
        match parsed {
            Ok(amount) if amount >= minimum => return Ok(amount.normalize().to_string()),
            Ok(_) => println!("Enter at least {minimum}. Nothing has been saved."),
            Err(error) => println!("{error}. Nothing has been saved."),
        }
    }
}

pub fn edit(directory: &Path, runtime: &Handle) -> Result<Response> {
    launch::require_terminal()?;
    let response = runtime.block_on(ipc::successful(directory, &Request::Status))?;
    let state = response.state.context("missing worker state")?;
    ensure!(
        state.mode == "account",
        "watch rules are for real account profiles; paper mode uses moby plan"
    );
    ensure!(
        state.paused,
        "pause withdrawals with P before editing rules"
    );
    ensure!(
        !state.account_status.refresh.wallets.stale,
        "Kraken wallet data is stale; wait for automatic refresh before editing"
    );
    let mut config = state.account_status.live.config.unwrap_or(Config {
        schema_version: 2,
        cooldown_seconds: 60,
        account: state.account,
        poll_seconds: 30,
        max_inflight: 2,
        websocket: true,
        rules: vec![],
    });
    println!("Moby watch rules — Escape cancels. Blank input keeps the value in brackets.");
    println!("Amounts are in the received asset. Chunks INCLUDE the withdrawal fee.");
    println!(
        "Buy BTC/USD receives BTC; sell BTC/USDC receives USDC. Fiat USD is not converted to crypto."
    );
    println!(
        "Existing rules: {}",
        config
            .rules
            .iter()
            .map(|r| r.asset.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    let symbol = prompt("Asset received from fills (e.g. BTC, USDC)", "")?.to_uppercase();
    let old = config.rules.iter().find(|r| r.asset == symbol).cloned();
    let choices: Vec<_> = state
        .account_status
        .wallets
        .iter()
        .filter(|w| w.verified && w.source == "kraken")
        .flat_map(|w| {
            w.methods
                .iter()
                .filter(|m| m.asset == symbol)
                .map(move |m| (w, m))
        })
        .collect();
    ensure!(
        !choices.is_empty(),
        "no verified {symbol} destinations; sync Wallets with F first"
    );
    println!("\nVerified destinations for {symbol}:");
    for (i, (w, m)) in choices.iter().enumerate() {
        println!(
            "{}: {} · {} · {} {} · Kraken withdrawal minimum: {} {}",
            i + 1,
            w.name,
            m.network,
            w.address,
            w.memo.as_deref().unwrap_or(""),
            m.minimum.as_deref().unwrap_or("unavailable"),
            symbol
        );
    }
    let defaults = old
        .as_ref()
        .map(|r| {
            r.destinations
                .iter()
                .filter_map(|d| {
                    choices
                        .iter()
                        .position(|(w, m)| w.id == d.wallet_id && m.id == d.method_id)
                        .map(|i| (i + 1).to_string())
                })
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let selected = list(prompt(
        "Destination numbers, comma separated (rotate after each chunk)",
        &defaults,
    )?);
    let destinations = selected
        .iter()
        .map(|n| -> Result<Destination> {
            let index = n
                .parse::<usize>()?
                .checked_sub(1)
                .context("destination numbers start at 1")?;
            let (w, m) = choices.get(index).context("destination not listed")?;
            Ok(Destination {
                wallet_id: w.id.clone(),
                method_id: m.id.clone(),
                address: w.address.clone(),
                memo: w.memo.clone(),
                network: m.network.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let kraken_minimum =
        minimum_for_destinations(&symbol, &destinations, &state.account_status.wallets)?;
    println!(
        "Kraken withdrawal minimum for the selected destinations: {kraken_minimum} {symbol} (last wallet sync)."
    );
    println!(
        "This is a withdrawal limit; trading pairs have separate order minimums. When rotating destinations, the highest withdrawal minimum applies."
    );
    println!(
        "Moby requires the amount delivered after withdrawal fees to meet the withdrawal minimum. Leave room for fees in the gross chunk."
    );
    let enabled = prompt(
        "Watch enabled? yes/no",
        if old.as_ref().is_none_or(|r| r.enabled) {
            "yes"
        } else {
            "no"
        },
    )?;
    ensure!(enabled == "yes" || enabled == "no", "enter yes or no");
    let types = prompt(
        "Order types, comma separated",
        &old.as_ref()
            .map(|r| r.order_types.join(","))
            .unwrap_or_else(|| ORDER_TYPES.join(",")),
    )?;
    let sides = prompt(
        "Sides, buy and/or sell",
        &old.as_ref()
            .map(|r| r.sides.join(","))
            .unwrap_or_else(|| "buy,sell".into()),
    )?;
    let pairs = prompt(
        "Pairs BASE/QUOTE, comma separated; * means all",
        &old.as_ref()
            .filter(|r| !r.pairs.is_empty())
            .map(|r| r.pairs.join(","))
            .unwrap_or_else(|| "*".into()),
    )?;
    let ids = prompt(
        "Order IDs, comma separated; * means all",
        &old.as_ref()
            .filter(|r| !r.order_ids.is_empty())
            .map(|r| r.order_ids.join(","))
            .unwrap_or_else(|| "*".into()),
    )?;
    let minimum_default = old
        .as_ref()
        .map(|r| amount(&r.minimum))
        .transpose()?
        .unwrap_or(kraken_minimum)
        .max(kraken_minimum)
        .normalize()
        .to_string();
    let minimum = prompt_amount(
        "Withdrawal minimum after fees (Enter accepts; you may raise it)",
        &minimum_default,
        kraken_minimum,
        false,
    )?;
    let chunk = prompt_amount(
        "Maximum gross amount per chunk (includes fee)",
        old.as_ref().map(|r| r.chunk.as_str()).unwrap_or(""),
        amount(&minimum)?,
        true,
    )?;
    let reserve = prompt(
        "Amount to leave on Kraken",
        old.as_ref().map(|r| r.reserve.as_str()).unwrap_or("0"),
    )?;
    let max_fee = prompt(
        "Maximum fee per chunk, in asset units",
        old.as_ref().map(|r| r.max_fee.as_str()).unwrap_or(""),
    )?;
    let max_fee_percent = prompt(
        "Maximum fee as percent of chunk",
        old.as_ref()
            .map(|r| r.max_fee_percent.as_str())
            .unwrap_or("1"),
    )?;
    let budget = prompt(
        "Rolling 24-hour fee budget in asset units; * means no cap",
        old.as_ref()
            .and_then(|r| r.daily_fee_budget.as_deref())
            .unwrap_or("*"),
    )?;
    let cooldown = prompt(
        "Account cooldown between all withdrawals, seconds",
        &config.cooldown_seconds.to_string(),
    )?;
    config.cooldown_seconds = cooldown.parse()?;
    let rule = WatchRule {
        asset: symbol.clone(),
        enabled: enabled == "yes",
        destinations,
        order_types: list(types),
        sides: list(sides),
        pairs: if pairs == "*" { vec![] } else { list(pairs) },
        order_ids: if ids == "*" { vec![] } else { list(ids) },
        chunk,
        minimum,
        reserve,
        max_fee,
        max_fee_percent,
        daily_fee_budget: if budget == "*" { None } else { Some(budget) },
    };
    rule.validate()?;
    if let Some(existing) = config.rules.iter_mut().find(|r| r.asset == symbol) {
        *existing = rule;
    } else {
        config.rules.push(rule);
    }
    let digest = config.digest()?;
    println!(
        "\nReview the complete watch configuration:\n{}",
        serde_json::to_string_pretty(&config)?
    );
    ensure!(
        prompt(
            "Type save to store these rules; withdrawals stay paused",
            ""
        )? == "save",
        "Nothing saved"
    );
    runtime.block_on(ipc::successful(
        directory,
        &Request::ConfigureWatch { config, digest },
    ))
}

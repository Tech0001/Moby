use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use moby_tui::{
    ipc, launch,
    model::{Outcome, Plan, Request, Resolution},
    profile::{Mode, Profile},
    tui,
};
use std::{
    io::{self, Write},
    path::PathBuf,
};

#[derive(Parser)]
#[command(
    name = "moby",
    version,
    about = "Watch Kraken order fills and withdraw received assets in chunks to your wallets",
    after_help = "Run moby with no command to start or reconnect and open the dashboard.\nAccount launch sets a vault password; worker restarts require unlocking.\nUse --demo for an isolated paper account without real credentials.\nQ closes the dashboard; moby stop ends the background worker.\n\nExamples:\n  moby\n  moby --no-animation\n  moby status --json\n  moby --help\n  moby key --help\n  moby --account second\n  moby accounts\n  moby wallets --help\n  moby config --help\n  moby telegram --help\n  moby --demo"
)]
struct Args {
    /// Data root containing separate account/ and paper/ profiles.
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    /// Named Kraken account profile; each has a separate vault, worker and paper data.
    #[arg(long, global = true, default_value = "main")]
    account: String,
    /// Open the isolated paper account; never loads real credentials.
    #[arg(long, global = true)]
    demo: bool,
    /// Machine-readable output, including errors. Amounts are always strings.
    #[arg(long, global = true)]
    json: bool,
    /// Skip the whale launch animation.
    #[arg(long, global = true)]
    no_animation: bool,
    /// Use text artwork instead of terminal image graphics.
    #[arg(long, global = true)]
    text_icons: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the selected worker until Ctrl-C; withdrawals start paused.
    Run,
    /// Open the dashboard (alias for plain moby); start/unlock as needed.
    Watch,
    /// Start the background worker without opening the TUI or unlocking it.
    Start,
    /// Stop the worker, save progress and forget unlocked credentials.
    Stop,
    /// Lock credentials, pause withdrawals and disconnect monitoring.
    Lock,
    /// Start if needed and unlock interactively, without opening the dashboard.
    Unlock,
    /// Set or check this account's encrypted Kraken API key.
    #[command(name = "key")]
    Keys {
        #[command(subcommand)]
        command: Option<KeysCommand>,
    },
    /// List saved withdrawal destinations or refresh them from Kraken.
    Wallets {
        #[command(subcommand)]
        command: Option<WalletsCommand>,
    },
    /// List cached Kraken balances or refresh balances and spot-order holds.
    Balances {
        #[command(subcommand)]
        command: Option<WalletsCommand>,
    },
    /// View, edit or apply live withdrawal watch rules. Applying leaves withdrawals paused.
    Config {
        #[command(subcommand)]
        command: Option<ConfigCommand>,
    },
    /// View orders or submit a reviewed place/amend/cancel request through the worker.
    Orders {
        #[command(subcommand)]
        command: Option<OrdersCommand>,
        /// Sort cached orders; status shows active orders first.
        #[arg(long, value_enum, default_value = "status", global = true)]
        sort: moby_tui::order_sort::OrderSort,
        /// Reverse the selected order sort.
        #[arg(long, global = true)]
        descending: bool,
        /// Include cancelled orders, hidden by default. Does not cancel anything.
        #[arg(long, visible_alias = "show-canceled", global = true)]
        show_cancelled: bool,
    },
    /// View transfer receipts or attach a verified exchange ID to an uncertain submission.
    Withdrawals {
        #[command(subcommand)]
        command: Option<WithdrawalsCommand>,
    },
    /// Optional Telegram alerts; bot token stays in the encrypted vault.
    Telegram {
        #[command(subcommand)]
        command: Option<TelegramCommand>,
    },
    /// List local account profile names without starting a worker.
    Accounts,
    /// Read the running worker's state.
    Status,
    /// Pause withdrawals; account fill monitoring continues.
    Pause,
    /// Reconcile balances, then enable configured withdrawals.
    Resume,
    /// Validate or apply a reviewed paper withdrawal plan.
    Plan {
        #[command(subcommand)]
        command: PlanCommand,
    },
    /// Open the paper account or inject simulated events into it.
    Demo {
        #[command(subcommand)]
        command: Option<DemoCommand>,
    },
    /// Clear queued amounts while paused, using queue_digest from a fresh status.
    ClearQueue {
        #[arg(long)]
        confirm: String,
    },
}

#[derive(Subcommand)]
enum ConfigCommand {
    Show,
    /// Change one asset's shared cooldown while paused; use config_digest from status.
    Cooldown {
        asset: String,
        #[arg(value_parser = clap::value_parser!(u64).range(1..=86400))]
        seconds: u64,
        #[arg(long)]
        expect: String,
    },
    /// Interactive rule editor; Escape cancels without saving.
    Edit,
    /// Validate locally; no Kraken requests or worker changes.
    Validate {
        file: PathBuf,
    },
    /// Save exactly the reviewed rules. Use the digest from validate.
    Apply {
        file: PathBuf,
        #[arg(long)]
        confirm: String,
    },
}
#[derive(Subcommand)]
enum OrdersCommand {
    List,
    Sync,
    /// Check order format locally; does not check Kraken minimums or available funds.
    Validate {
        file: PathBuf,
    },
    /// Send reviewed instructions once. Reuse request_id when checking/retrying IPC.
    Submit {
        file: PathBuf,
        #[arg(long)]
        confirm: String,
    },
}
#[derive(Subcommand)]
enum WithdrawalsCommand {
    List,
    /// Read an uncertain receipt and obtain its review digest; no exchange request.
    Review {
        id: String,
    },
    /// Only after checking Kraken history: restore a request that was never sent.
    Resolve {
        id: String,
        #[arg(long)]
        confirm: String,
        /// Explicitly attest that you checked Kraken and no withdrawal was sent.
        #[arg(long, required = true)]
        not_sent: bool,
    },
    /// Link an uncertain local transfer to its Kraken receipt; never resubmits it.
    Attach {
        id: String,
        exchange_id: String,
    },
}
#[derive(Subcommand)]
enum TelegramCommand {
    Status,
    /// Enter bot token and numeric chat ID through hidden terminal prompts.
    Setup,
    /// Send one test notification; never makes a withdrawal.
    Test,
    Enable,
    Disable,
}
fn read_json<T: serde::de::DeserializeOwned>(file: &std::path::Path) -> Result<T> {
    use std::io::Read;
    let mut input = String::new();
    std::fs::File::open(file)?
        .take(65537)
        .read_to_string(&mut input)?;
    ensure!(input.len() <= 65536, "JSON file exceeds size limit");
    serde_json::from_str(&input).context("invalid JSON; monetary amounts must be strings")
}

#[derive(Subcommand)]
enum KeysCommand {
    List,
    /// Enter one Kraken key and secret through hidden terminal prompts.
    Set,
    /// Check permissions using a read-only Kraken request.
    Check,
    /// Remove this account's saved Kraken key.
    Remove,
}
#[derive(Subcommand)]
enum WalletsCommand {
    List,
    Sync,
}

#[derive(Subcommand)]
enum PlanCommand {
    /// Check a plan locally and show its SHA-256 digest; no state changes.
    Validate { file: PathBuf },
    /// Apply exactly the reviewed plan; worker must be paused with no active jobs.
    Apply {
        file: PathBuf,
        #[arg(long)]
        confirm: String,
    },
}

#[derive(Subcommand)]
enum DemoCommand {
    /// Simulate net received assets. Reuse the ID when retrying a request.
    Fill {
        #[arg(long)]
        id: String,
        #[arg(long)]
        asset: String,
        #[arg(long)]
        amount: String,
    },
    /// Change simulated spendable funds, e.g. after a manual sale or withdrawal.
    Balance {
        #[arg(long)]
        asset: String,
        #[arg(long)]
        amount: String,
    },
    /// Set the next simulated withdrawal result to exercise recovery.
    Outcome {
        #[arg(value_enum)]
        outcome: Outcome,
    },
    /// Manually settle a held/unknown simulated transfer.
    Resolve {
        id: String,
        #[arg(value_enum)]
        resolution: Resolution,
    },
}

fn read_plan(file: &std::path::Path) -> Result<Plan> {
    use std::io::Read;
    let mut input = String::new();
    std::fs::File::open(file)?
        .take(65537)
        .read_to_string(&mut input)?;
    ensure!(input.len() <= 65536, "plan file is too large");
    let plan: Plan = serde_json::from_str(&input)
        .context("invalid plan JSON; amounts must be quoted strings")?;
    plan.validate()?;
    Ok(plan)
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let json = args.json;
    if let Err(error) = execute(args).await {
        if json {
            let _ = writeln!(
                io::stdout(),
                "{}",
                serde_json::json!({"ok":false,"message":format!("{error:#}")})
            );
        } else {
            eprintln!("Error: {error:#}");
        }
        std::process::exit(1);
    }
}

async fn execute(args: Args) -> Result<()> {
    let root = match args.state_dir {
        Some(path) => path,
        None => Profile::default_root()?,
    };
    let mut command = args.command.unwrap_or(Command::Watch);
    let mode = if args.demo || matches!(command, Command::Demo { .. }) {
        Mode::Paper
    } else {
        Mode::Account
    };
    if matches!(command, Command::Demo { command: None }) {
        command = Command::Watch;
    }
    let profile = Profile::named(root, mode, args.account)?;
    let directory = profile.directory.clone();
    let live_view = match &command {
        Command::Config { .. } => Some("config"),
        Command::Orders { .. } => Some("orders"),
        Command::Withdrawals { .. } => Some("withdrawals"),
        Command::Telegram { .. } => Some("telegram"),
        _ => None,
    };
    let balances_command = matches!(command, Command::Balances { .. });
    let order_sort = match &command {
        Command::Orders {
            sort,
            descending,
            show_cancelled,
            ..
        } => (*sort, *descending, *show_cancelled),
        _ => (moby_tui::order_sort::OrderSort::default(), false, false),
    };
    match command {
        Command::Accounts => {
            let names = Profile::list(&profile.root)?;
            if args.json {
                println!("{}", serde_json::json!({"ok":true,"accounts":names}));
            } else {
                for name in names {
                    println!("{name}{}", if name == "main" { " (default)" } else { "" });
                }
            }
            return Ok(());
        }
        Command::Watch => {
            ensure!(
                !args.json,
                "moby opens a terminal interface; use status --json for automation"
            );
            launch::require_terminal()?;
            launch::ensure_running(&profile).await?;
            launch::unlock(&directory).await?;
            let runtime = tokio::runtime::Handle::current();
            return tokio::task::spawn_blocking(move || {
                tui::watch(directory, runtime, !args.no_animation, args.text_icons)
            })
            .await?;
        }
        Command::Start => {
            return print_response(launch::ensure_running(&profile).await?, args.json);
        }
        Command::Unlock => {
            ensure!(
                !args.json,
                "unlock requires hidden terminal input; check status --json afterwards"
            );
            launch::require_terminal()?;
            launch::ensure_running(&profile).await?;
            return print_response(launch::unlock(&directory).await?, false);
        }
        _ => (),
    }
    let request = match command {
        Command::Run => {
            ensure!(
                !args.json,
                "run is a foreground process; use status --json from another terminal"
            );
            return ipc::run(&profile).await;
        }
        Command::Watch | Command::Start | Command::Unlock | Command::Accounts => unreachable!(),
        Command::Stop => Request::Stop,
        Command::Lock => Request::VaultLock,
        Command::Keys { command } => match command.unwrap_or(KeysCommand::List) {
            KeysCommand::List => Request::Status,
            KeysCommand::Check => Request::CheckKey,
            KeysCommand::Remove => Request::RemoveKey,
            KeysCommand::Set => {
                ensure!(
                    mode == Mode::Account,
                    "paper mode does not use real keys; open moby without --demo"
                );
                ensure!(!args.json, "key setup requires hidden terminal input");
                launch::require_terminal()?;
                launch::ensure_running(&profile).await?;
                return print_response(launch::set_key(&directory).await?, false);
            }
        },
        Command::Wallets { command } => match command.unwrap_or(WalletsCommand::List) {
            WalletsCommand::List => Request::Status,
            WalletsCommand::Sync => Request::RefreshWallets,
        },
        Command::Balances { command } => {
            ensure!(
                mode == Mode::Account,
                "balances reads a Kraken account; paper balances are in --demo status"
            );
            match command.unwrap_or(WalletsCommand::List) {
                WalletsCommand::List => Request::Status,
                WalletsCommand::Sync => Request::RefreshBalances,
            }
        }
        Command::Config { command } => match command.unwrap_or(ConfigCommand::Show) {
            ConfigCommand::Show => Request::Status,
            ConfigCommand::Cooldown {
                asset,
                seconds,
                expect,
            } => {
                ensure!(
                    mode == Mode::Account,
                    "cooldown editing requires an account profile"
                );
                Request::SetCooldown {
                    asset: asset.to_ascii_uppercase(),
                    seconds,
                    expected_config: expect,
                }
            }
            ConfigCommand::Edit => {
                ensure!(!args.json, "interactive editing needs a terminal");
                let directory = directory.clone();
                let runtime = tokio::runtime::Handle::current();
                let response = tokio::task::spawn_blocking(move || {
                    moby_tui::live::editor::edit(&directory, &runtime)
                })
                .await??;
                return print_response(response, false);
            }
            ConfigCommand::Validate { file } => {
                let config: moby_tui::live::Config = read_json(&file)?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &serde_json::json!({"ok":true,"digest":config.digest()?,"config":config})
                    )?
                );
                return Ok(());
            }
            ConfigCommand::Apply { file, confirm } => Request::ConfigureWatch {
                config: read_json(&file)?,
                digest: confirm,
            },
        },
        Command::Orders { command, .. } => match command.unwrap_or(OrdersCommand::List) {
            OrdersCommand::List => Request::Status,
            OrdersCommand::Sync => Request::RefreshOrders,
            OrdersCommand::Validate { file } => {
                let order: moby_tui::live::OrderCommand = read_json(&file)?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &serde_json::json!({"ok":true,"validation_scope":"local_format_only","exchange_checked":false,"note":"Only request format checked; Kraken trading limits and available funds are not checked here.","digest":order.digest()?,"order":order})
                    )?
                );
                return Ok(());
            }
            OrdersCommand::Submit { file, confirm } => Request::SubmitOrder {
                order: read_json(&file)?,
                digest: confirm,
            },
        },
        Command::Withdrawals { command } => match command.unwrap_or(WithdrawalsCommand::List) {
            WithdrawalsCommand::List => Request::Status,
            WithdrawalsCommand::Review { id } => {
                let response = ipc::successful(&directory, &Request::Status).await?;
                let state = response.state.context("missing worker snapshot")?;
                ensure!(
                    state.mode == "account",
                    "use demo resolve for paper transfers"
                );
                let transfer = state
                    .account_status
                    .live
                    .transfers
                    .iter()
                    .find(|t| t.id == id)
                    .context("withdrawal not visible; unlock and check the ID")?;
                ensure!(
                    transfer.status == "unknown" && transfer.exchange_id.is_none(),
                    "this withdrawal does not need a not-sent review"
                );
                let digest = moby_tui::live::model::digest(transfer)?;
                if args.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(
                            &serde_json::json!({"ok":true,"account":state.account,"transfer":transfer,"digest":digest,"earliest_resolution_at":transfer.created_at+120,"requires":"Pause withdrawals and explicitly confirm in Kraken history that this request was never sent. A missing response alone is not proof."})
                        )?
                    );
                } else {
                    println!("{}", serde_json::to_string_pretty(transfer)?);
                    println!(
                        "Review digest: {digest}\nCheck Kraken withdrawal history. Only if you confirm it was never sent, pause Moby and use withdrawals resolve --help. Resolution leaves withdrawals paused."
                    );
                }
                return Ok(());
            }
            WithdrawalsCommand::Resolve {
                id,
                confirm,
                not_sent,
            } => Request::ResolveWithdrawalNotSent {
                id,
                digest: confirm,
                confirmed: not_sent,
            },
            WithdrawalsCommand::Attach { id, exchange_id } => {
                Request::AttachWithdrawalReceipt { id, exchange_id }
            }
        },
        Command::Telegram { command } => match command.unwrap_or(TelegramCommand::Status) {
            TelegramCommand::Status => Request::Status,
            TelegramCommand::Enable => Request::EnableTelegram { enabled: true },
            TelegramCommand::Disable => Request::EnableTelegram { enabled: false },
            TelegramCommand::Test => Request::TestTelegram,
            TelegramCommand::Setup => {
                ensure!(
                    mode == Mode::Account,
                    "paper mode does not store Telegram credentials or send messages"
                );
                ensure!(!args.json, "Telegram setup requires hidden terminal input");
                launch::require_terminal()?;
                launch::ensure_running(&profile).await?;
                return print_response(launch::setup_telegram(&directory).await?, false);
            }
        },
        Command::Status => Request::Status,
        Command::Pause => Request::Pause,
        Command::Resume => Request::Resume,
        Command::ClearQueue { confirm } => Request::ClearQueue { digest: confirm },
        Command::Plan {
            command: PlanCommand::Validate { file },
        } => {
            let plan = read_plan(&file)?;
            let value =
                serde_json::json!({"ok":true,"mode":"paper","digest":plan.digest()?,"plan":plan});
            println!("{}", serde_json::to_string_pretty(&value)?);
            return Ok(());
        }
        Command::Plan {
            command: PlanCommand::Apply { file, confirm },
        } => Request::ApplyPlan {
            plan: read_plan(&file)?,
            digest: confirm,
        },
        Command::Demo { command } => match command.expect("paper dashboard handled above") {
            DemoCommand::Fill { id, asset, amount } => Request::DemoFill { id, asset, amount },
            DemoCommand::Balance { asset, amount } => Request::DemoBalance { asset, amount },
            DemoCommand::Outcome { outcome } => Request::DemoOutcome { outcome },
            DemoCommand::Resolve { id, resolution } => Request::DemoResolve { id, resolution },
        },
    };
    let response = ipc::call(&directory, &request).await?;
    if let Some(view) = live_view {
        let state = response.state.as_ref();
        let live = state.map(|s| &s.account_status.live);
        let payload = match view {
            "config" => {
                serde_json::json!({"config":live.and_then(|l|l.config.as_ref()),"digest":live.and_then(|l|l.config_digest.as_ref()),"queues":live.map(|l|&l.queues),"monitoring_since":live.and_then(|l|l.monitoring_since)})
            }
            "orders" => {
                let orders = live.map(|l| {
                    order_sort
                        .0
                        .sorted(&l.orders, order_sort.1)
                        .into_iter()
                        .filter(|o| order_sort.2 || !o.is_cancelled())
                        .collect::<Vec<_>>()
                });
                let hidden_cancelled = live.map(|l| {
                    l.orders
                        .iter()
                        .filter(|o| !order_sort.2 && o.is_cancelled())
                        .count()
                });
                serde_json::json!({"orders":orders,"show_cancelled":order_sort.2,"hidden_cancelled_count":hidden_cancelled,"updated_at":live.and_then(|l|l.orders_updated_at),"error":live.and_then(|l|l.orders_error.as_ref()),"receipts":live.map(|l|&l.order_receipts),"freshness":state.map(|s|&s.account_status.refresh.orders),"stale":state.is_none_or(|s|s.account_status.refresh.orders.stale)})
            }
            "telegram" => serde_json::json!(state.map(|s| &s.account_status.telegram)),
            _ => serde_json::json!({"transfers":live.map(|l|&l.transfers)}),
        };
        println!(
            "{}",
            serde_json::to_string_pretty(
                &serde_json::json!({"ok":response.ok,"message":response.message,"account":state.map(|s|&s.account),"mode":state.map(|s|&s.mode),"paused":state.map(|s|s.paused),"busy":state.map(|s|s.account_status.busy),"data":payload})
            )?
        );
        if !response.ok {
            std::process::exit(1);
        }
        Ok(())
    } else if balances_command {
        print_balances(response, args.json)
    } else {
        print_response(response, args.json)
    }
}

fn print_balances(response: moby_tui::model::Response, json: bool) -> Result<()> {
    let state = response.state.as_ref();
    let data = state.map(|s| &s.account_status);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok":response.ok, "message":response.message,
                "account":state.map(|s| &s.account), "mode":state.map(|s| &s.mode),
                "vault_state":state.map(|s| &s.vault.state),
                "refreshing":data.map(|s| s.refresh.balances.refreshing), "updated_at":data.and_then(|s| s.balances_updated_at),
                "stale":data.is_none_or(|s|s.refresh.balances.stale), "freshness":data.map(|s|&s.refresh.balances),
                "error":data.and_then(|s| s.balances_error.as_ref()),
                "balances":data.map(|s| &s.balances),
                "availability_note":"Includes credit; holds cover spot non-margin orders only. Not a withdrawal quote. Suffixed buckets are separate."
            }))?
        );
    } else {
        println!("{}", response.message);
        if let (Some(state), Some(data)) = (state, data) {
            println!("Account {} | vault {:?}", state.account, state.vault.state);
            println!(
                "{} · automatic refresh every {}s while unlocked",
                data.refresh.balances.label(),
                data.refresh.balances.interval_seconds
            );
            if let Some(at) = data.balances_updated_at {
                println!(
                    "Cached balances checked at {at} (Unix seconds). Availability includes credit; spot non-margin holds only. Not a withdrawal quote."
                );
                for b in &data.balances {
                    println!(
                        "{} | balance {} | held {} | available {}",
                        b.asset,
                        b.balance,
                        b.held_for_orders,
                        b.available_for_trading
                            .as_deref()
                            .unwrap_or("asset bucket; see base asset")
                    );
                }
            } else {
                println!(
                    "No visible balance snapshot. Unlock Moby; balances refresh automatically."
                );
            }
            if let Some(error) = &data.balances_error {
                println!("Balance sync failed; shown balances are cached: {error}");
            }
            if data.busy {
                println!("Refresh in progress; run moby balances again when it finishes.");
            }
        }
    }
    if !response.ok {
        std::process::exit(1);
    }
    Ok(())
}

fn print_response(response: moby_tui::model::Response, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(&response)?);
    } else {
        println!("{}", response.message);
        if let Some(state) = response.state {
            println!(
                "Vault: {:?} | Credentials: {}",
                state.vault.state,
                if state.vault.credentials.is_empty() {
                    "none visible".into()
                } else {
                    state.vault.credentials.join(", ")
                }
            );
            println!(
                "Moby {} | {} | account {} | {} | {} fills | {} completed",
                state.version,
                state.mode.to_uppercase(),
                state.account,
                if matches!(
                    state.vault.state,
                    moby_tui::vault::VaultState::Locked
                        | moby_tui::vault::VaultState::NotConfigured
                ) {
                    "LOCKED"
                } else if state.paused {
                    "PAUSED"
                } else {
                    "RUNNING"
                },
                state.fill_count,
                state.completed_count
            );
            for key in state.account_status.keys {
                println!(
                    "{} key: {} | {}",
                    key.label,
                    if key.saved {
                        "saved"
                    } else {
                        "not set / locked"
                    },
                    key.error.as_deref().unwrap_or(if key.checked_at.is_some() {
                        "checked"
                    } else {
                        "not checked"
                    })
                );
            }
            for wallet in state.account_status.wallets {
                println!(
                    "{} | {} | {} | {} | {}",
                    wallet.name,
                    wallet.assets.join(", "),
                    wallet.network,
                    if wallet.verified {
                        "Kraken verified"
                    } else {
                        "not verified / paper"
                    },
                    wallet.address
                );
            }
            if let Some(error) = state.account_status.sync_error {
                println!("Wallet sync: {error}");
            }
            if let Some(at) = state.account_status.balances_updated_at {
                println!(
                    "Cached Kraken balances checked at {at} (Unix seconds). Availability includes credit; spot non-margin order holds only. Not a withdrawal quote."
                );
                for balance in state.account_status.balances {
                    println!(
                        "{} | balance {} | held {} | credit {} | credit used {} | available {}",
                        balance.asset,
                        balance.balance,
                        balance.held_for_orders,
                        balance.credit,
                        balance.credit_used,
                        balance
                            .available_for_trading
                            .as_deref()
                            .unwrap_or("asset bucket; see base asset")
                    );
                }
            } else if state.mode == "account" {
                println!(
                    "Balances not loaded / locked. Use moby balances sync to refresh after unlocking."
                );
            }
            if let Some(error) = state.account_status.balances_error {
                println!("Balance sync failed; any shown balances are cached: {error}");
            }
            for asset in state.assets {
                println!(
                    "{:<8} queued {:>14}  spendable {:>14}  {}",
                    asset.rule.asset,
                    asset.queued,
                    asset.spendable,
                    asset.blocked.as_deref().unwrap_or("Ready")
                );
            }
        }
    }
    if !response.ok {
        std::process::exit(1);
    }
    Ok(())
}

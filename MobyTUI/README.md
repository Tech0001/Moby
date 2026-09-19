# MobyTUI

**Let your orders fill while Moby watches.** Moby monitors Kraken trades and sends the assets you receive to your own approved wallets, in chunks with a cooldown and rotating destinations. Use the terminal dashboard yourself or ask a local AI agent to work through Moby's command line.

The command is **`moby`**. Linux releases contain a compiled executable: **you do not need Rust, Node.js, Docker, or a repository checkout to run it.** The desktop app, [MobyGUI](../MobyGUI/), is separate.

[Install](#install-on-linux) · [First setup](#first-time-setup) · [Daily use](#daily-use) · [Full user guide](USER_GUIDE.md) · [Agent guide](AGENT_GUIDE.md)

## Install on Linux

On [GitHub Releases](https://github.com/GodsWildOnes/Moby/releases), choose a **MobyTUI** release (tag `tui-v…`), not a desktop release. Download the archive for your computer and its matching `.sha256` file:

| `uname -m` reports | Download |
| --- | --- |
| `x86_64` (most Intel/AMD PCs) | `moby-tui-vVERSION-linux-x86_64.tar.gz` |
| `aarch64` (64-bit ARM) | `moby-tui-vVERSION-linux-aarch64.tar.gz` |

The executable is statically linked; separate SQLite and OpenSSL libraries are not needed. You need a Linux terminal and internet access to Kraken. If the repository is private, GitHub access is required to download releases.

For example, after downloading the **v0.2.8 x86_64** files into the same directory:

```sh
sha256sum -c moby-tui-v0.2.8-linux-x86_64.tar.gz.sha256
tar -xzf moby-tui-v0.2.8-linux-x86_64.tar.gz
cd moby-tui-v0.2.8-linux-x86_64
install -Dm755 moby "$HOME/.local/bin/moby"
export PATH="$HOME/.local/bin:$PATH"
moby --version
moby
```

Use the filenames for your version and architecture. Continue only if the checksum reports `OK`. If `moby` is not found in a new terminal, add the `export PATH=…` line to your shell's startup file, such as `~/.bashrc` or `~/.zshrc`.

The archive includes these guides and generic examples. You can also run `./moby` without installing it. First launch creates your own local data; packages contain no account, API key, wallet selection, or withdrawal rules.

## Try it without an account

```sh
moby --demo
```

Select an asset, press **D** to simulate a fill, then **R** to simulate withdrawals. Paper mode has its own database and never loads real credentials or changes your live account. **Q** closes the dashboard; `moby --demo stop` stops the paper worker.

## First-time setup

### 1. Create your password

Run `moby`. It starts the background worker, asks you to create and confirm a vault password of at least **8 characters**, then opens the dashboard with account-setup directions. There is no password recovery.

**Withdrawals start paused.** Creating a password or entering a key does not enable them. Enter secrets directly into Moby's hidden terminal prompts, never into an AI chat.

### 2. Enter one Kraken API key

Create a dedicated key in Kraken. For the full workflow, enable:

| Kraken setting | Enable |
| --- | --- |
| Funds | Query, Withdraw |
| Orders and trades | Query open orders & trades; Query closed orders & trades; Create & modify orders; Cancel & close orders |
| Data | Query ledger entries |
| WebSocket interface | On |

Leave Deposit, Earn, Export data and withdrawal address-management permissions off. Ledger access reconciles what a fill actually credited and its fees. WebSocket provides prompt fill events; REST catches up after interruptions and reconciles them. Enabling WebSocket does not disable REST.

In Moby, press **6**, then **E** to enter the key and secret. Press **C** to check permissions. Balances, orders and saved destinations refresh automatically while unlocked. One key supports both reads and writes.

### 3. Check your wallets

Add and approve crypto withdrawal addresses **on Kraken**, with the correct network and memo/tag. Open **5 Wallets** in Moby, wait for the refresh, and press **Enter** to inspect a destination. **F** requests a refresh if needed.

This page lists saved withdrawal destinations, not wallet private keys or bank accounts. Listing a wallet does not enable withdrawals to it.

### 4. Configure a watch rule

While paused, open **7 Rules**, press **E**, and follow the prompts. Review the configuration before saving.

| Setting | Meaning |
| --- | --- |
| Received asset | A BTC/USDC **buy** receives BTC; a **sell** receives USDC |
| Destinations | Approved wallets in your chosen rotation order |
| Filters | Order types, buy/sell sides, optional pairs or order IDs |
| Chunk | Maximum debit per withdrawal, **including fees**, in asset units |
| Withdrawal minimum | Taken from Kraken; the amount delivered **after fees** must meet it |
| Cooldown | Wait between chunks, in seconds |
| Reserve | Amount to keep on Kraken |
| Fee limits | Maximum fee in asset units and as a percentage; optional rolling 24-hour budget |

Rules can match orders placed outside Moby. Existing open orders do not need to be recreated. Initial setup watches future fills, not old purchases or deposits. Partial fills accumulate until a withdrawal can meet the minimum and fee limits.

Kraken synthetic spot fills reported as explicit `BASE/QUOTE` names can also be monitored when both assets are known and their settlement ledgers verify the received amount and fees. This handling is tested with offline fixtures. Moby does not place synthetic orders or monitor assets held in a separate DEX wallet.

A sell into **USD** receives fiat; Moby does not convert it to crypto or send it to a bank. Trading minimums are separate from withdrawal minimums. Smaller withdrawals still incur fees and can still be held by Kraken.

### 5. Optionally enable Telegram

Press **N** and enter your bot token and chat ID. `moby telegram test` sends a test message. Alerts cover accepted/completed withdrawals and problems; completion notices may be grouped for about a minute. Telegram does not accept trading commands. [Telegram details](USER_GUIDE.md#optional-telegram-alerts).

### 6. Resume when ready

Press **R**. Moby reconciles fills and balances, then sends eligible chunks. Watch **2 Fills**, **3 Sends**, and **4 Log**; **Enter** shows details. A pending withdrawal is not yet complete.

Keep the computer awake and online. Pausing stops new automatic withdrawals while monitoring continues. Closing the dashboard does **not** pause or stop the worker.

## Daily use

| Action | Command or key |
| --- | --- |
| Start or reopen | `moby` |
| Change pages / select rows | Left/right arrows / up/down arrows; **1–8** selects a page |
| Details / search / help | **Enter** / **/** / **?** |
| Pause / resume withdrawals | **P** / **R**, or `moby pause` / `moby resume` |
| Close dashboard, keep monitoring | **Q** |
| Lock credentials and pause monitoring | `moby lock` |
| Stop background worker | `moby stop` |
| Another Kraken account | `moby --account second` |
| Command help | `moby --help`; subcommands also accept `--help` |

Reopening an unlocked worker needs no password. After a reboot, worker restart or lock, unlock again; **withdrawals require Resume again**. Workers do not start at boot or run while the computer sleeps. Rules, queues and fill history persist, and Moby catches up after reconnecting.

Tmux is optional. To keep the dashboard in tmux, run `tmux new-session -s moby moby`, detach with **Ctrl-B, D**, and return with `tmux attach -t moby`. [Foreground worker operation](USER_GUIDE.md#start) is also available.

Do not run the GUI and TUI as separate active withdrawal engines for the same Kraken account. They use separate data and do not coordinate submissions.

## Let an agent help

Give your local agent [AGENT_GUIDE.md](AGENT_GUIDE.md) and tell it which account to use. You unlock Moby yourself; the agent communicates with the running worker without needing your key or password.

For example: “Read Moby's agent guide, then show my open orders and explain my withdrawal rules. Don't change anything.”

```sh
moby --account main status --json
moby --account main balances --json
moby --account main orders --json
moby --account main config --json
moby --account main withdrawals --json
```

Agents can prepare rules and order requests for review. Order placement, amendment and cancellation are separate from the withdrawal pause control. Execution also depends on the agent's own permissions and policies.

## Updates, backups, and troubleshooting

To update, pause and stop each running profile, install the new executable, then run `moby`, unlock, review status and resume. Replacing a binary does not replace an already running worker. Repeat for named accounts; stop a running paper worker with `moby --demo stop` too.

Data normally lives in `~/.local/state/moby-tui` (or `$XDG_STATE_HOME/moby-tui`). Back up the whole directory with all its workers stopped. Keys are encrypted in the vault; the private SQLite database holds rules, addresses and history. Keep your password separately. [Storage details](USER_GUIDE.md#password-and-storage).

| Symptom | Check |
| --- | --- |
| No wallets | Approved Kraken addresses, key permissions, Wallets refresh status |
| Fill queued but not sent | Pause state, minimum **after fees**, fee caps, reserve, cooldown, active/uncertain transfers; inspect Rules and Sends |
| WebSocket authentication fails | Enable the key's WebSocket interface; read the full Log event |
| Data marked stale | Connection, unlock state, last refresh error; stale data is not an empty account |
| Graphics look wrong | Use `moby --text-icons`; `--no-animation` skips the launch animation |
| Transfer unknown | Check Kraken history and [recovery instructions](USER_GUIDE.md#uncertain-withdrawals); do not blindly retry |

## Build from source (optional)

Developers need Rust 1.90+ and a C compiler for bundled SQLite. From the repository root:

```sh
cargo build --release --locked -p moby-tui
./target/release/moby
# Or install into Cargo's bin directory:
cargo install --path MobyTUI --locked
```

[RELEASING.md](RELEASING.md) covers packaging; [USER_GUIDE.md](USER_GUIDE.md) covers detailed behavior and development checks. Automated tests use offline fixtures. One user-run market buy and automatic withdrawal has completed on Kraken; that is not a long-running reliability test.

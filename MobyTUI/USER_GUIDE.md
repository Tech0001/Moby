# MobyTUI reference guide

New here? Start with the [installation and setup walkthrough](README.md). This guide covers the complete command interface, recovery, storage and implementation details.

Paths beginning with `examples/` in CLI commands are relative to this guide's directory: `MobyTUI/` in a checkout, or the extracted release directory. Build and development commands run from the repository root.

A Linux app built with Rust and Ratatui. The terminal command is **`moby`**. A persistent local worker serves the dashboard and a JSON CLI that a local coding agent can use without receiving your API credentials.

**Account mode monitors Kraken fills and can withdraw the received assets using reviewed watch rules. It also supports order placement, amendment and cancellation through the agent CLI. Withdrawals start paused and require explicit Resume.** Paper mode simulates fills and chunked withdrawals without loading real credentials or contacting an exchange. The desktop application in [`MobyGUI`](../MobyGUI/) is separate.

## Start

Build from the repository root with Rust 1.90+ and a C compiler for bundled SQLite:

```sh
cargo build --release --locked -p moby-tui
./target/release/moby
```

Install from source with `cargo install --path MobyTUI --locked`. Users of a prebuilt Linux executable do **not** need Rust installed.

```sh
moby                    # configured account; create/unlock vault, open dashboard
moby --demo             # separate paper account; no password or real keys
moby demo               # alias for the paper dashboard
moby --help             # -h; subcommands also have --help
moby --version          # -V
moby --no-animation     # skip the swimming whale
moby --text-icons       # use text artwork
moby status --json      # account worker
moby --demo status --json # paper worker
moby lock               # lock the account and cancel outstanding refreshes
moby unlock             # unlock without opening the dashboard
moby stop               # stop the account worker
moby --demo stop        # stop the paper worker
```

Plain `moby` starts a background account worker if necessary, asks you to create or unlock its vault, and opens the dashboard. Q or closing the terminal leaves the worker running. Reopening an already unlocked worker needs no password. A reboot, worker restart, or explicit lock requires unlocking again. Workers do not start automatically at boot and cannot run while the computer is shut down or suspended.

`moby watch` is an alias for `moby`. `moby start --json` starts the account worker without prompting or opening the dashboard. `moby --demo start --json` starts the paper worker. Both profiles can run at once; each has its own worker, socket, database and history.

Additional Kraken accounts use named profiles:

```sh
moby --account second                 # set up or reopen another account
moby --account second key set         # enter that account's single key
moby --account second status --json
moby --account second --demo          # that account's separate paper profile
moby --account second stop
moby accounts                        # list profile names; starts no workers
```

`main` is the default and keeps the existing account data location. Each named account has its own vault/password, worker, wallet cache and paper data. Unlock each account once per worker session. Account names use 1–24 lowercase letters, digits, hyphens or underscores, starting with a letter. Names are local labels; use a different profile for each Kraken account and enter that account's key. Keep `--account NAME` on every command for that account. The TUI header and JSON `state.account` show the selected name; opening another profile does not switch an existing dashboard or stop its worker.

For optional foreground/tmux operation, stop that profile's background worker first:

```sh
moby --demo stop
tmux new-session -s moby-paper 'moby --demo run'
# Ctrl-B, D detaches tmux; Ctrl-C in the worker stops it.
moby --demo
```

## One Kraken key per account

Open **6 API Key** and press **E** to enter or replace the account's key and secret through hidden prompts. Press **C** to check permissions. One key handles both reads and writes; the page shows the access Kraken reports. Saving a key does not contact Kraken or activate live operations.

For the trading and withdrawal workflow, enable these permissions on the **same key**:

- Funds → Query and Withdraw.
- Orders and trades → Query open orders & trades, Query closed orders & trades, Create & modify orders, Cancel & close orders.
- Data → Query ledger entries, for settlement-ledger reconciliation.
- WebSocket interface → On, for live fill monitoring alongside REST recovery.

Leave Deposit, Earn, Export data and withdrawal address-management permissions off. Saving a key or syncing wallets does not activate withdrawal automation; configure rules and explicitly resume it. Wallet sync requires Funds → Query; a read-only key also works, and the permission display shows its limited access. Use a dedicated key for each Kraken account; sharing keys with other applications can cause nonce conflicts.

```sh
moby key set
moby key check --json
moby key list --json
moby key remove
```

An unlocked account refreshes balances and orders automatically about every **30 seconds**, and saved wallets/funding minimums every **5 minutes**, even with no watch rules or while withdrawals are paused. Unlocking, restarting then unlocking, or changing the key schedules an immediate refresh of all three. Jobs share one serialized, paced request stream with a conservative per-account token budget; a slow request can delay the next refresh. Kraken throttling pauses all request types for that account. Trading-pair and network descriptions and successful permission checks are cached for an hour; recent closed orders are cached for up to two minutes, invalidated on fills, reconnects, local order writes and explicit order refresh. Open orders and balances retain the 30-second cadence. Fresh destination, minimum, limit and fee checks remain part of preparing a withdrawal. Successful fill reconciliation also refreshes balances/orders, avoiding redundant polls. Failed reads retain the last known data, mark it stale, and retry with backoff from 15 seconds to 5 minutes. Pausing withdrawals leaves reads running; locking stops them.

Manual checks and refreshes are asynchronous and queue behind current work. A successful command receipt means the refresh was **queued**, not completed. Inspect timestamps, errors and `state.account_status.refresh.{balances,orders,wallets}`. Each freshness object exposes `enabled`, `stale`, `refreshing`, `interval_seconds` and `next_refresh_at`; queued refreshes count as refreshing. Data is stale until successfully checked in the current unlock session, on a failed refresh, or after two refresh intervals without success. The TUI marks stale data even when its connection to the local worker is healthy. Key checks expose `error`, `checked_at` and `permissions`. Locking or replacing a key cancels the refresh and discards its result. A restarted worker remains paused after unlocking until you explicitly resume withdrawals.

## Wallet destinations

**5 Wallets** lists saved **crypto withdrawal destinations**, not private wallet keys or orders. These refresh automatically while unlocked; press **F** to request an immediate refresh. **Enter** opens full details:

- Label, full address, asset(s), network and memo/tag.
- Whether Kraken reports the destination as verified.
- The last successful sync time and Moby's withdrawal setting.
- In paper mode, the simulated destination's chunk, fee, minimum, reserve and cooldown.

Imported destinations have no watch rule until you select them in **7 Watch rules**. The wallet details list matching rules and funding-method IDs. Kraken verification is separate from enabling automation in Moby. Network groups are identified explicitly; they are not treated as a single network. Add or approve destinations through Kraken. Bank account destinations are excluded from this page.

```sh
moby wallets sync --json
moby wallets list --json
```

Sync uses Kraken's [List Funding Addresses](https://docs.kraken.com/api-reference/funding-beta/list-funding-addresses), [Methods](https://docs.kraken.com/api-reference/funding-beta/list-funding-methods) and [Networks](https://docs.kraken.com/api-reference/funding-beta/list-funding-networks) APIs. [Get API Key Info](https://docs.kraken.com/api-reference/account-data/get-api-key-info) checks permissions. Wallet sync follows pagination and applies a complete wallet list at once. It never calls the legacy address endpoint that requires withdrawal permission.

## Account balances and agent queries

Press **B on Overview** to refresh balances, then select a row and press **Enter** for credit and held-amount details. An agent can use the same unlocked worker:

```sh
moby --account main balances sync --json
moby --account main balances --json
```

Sync queues an asynchronous read-only request; periodic refresh requires no command. When explicitly refreshing, wait for a newer successful timestamp; `refreshing: false` alone is not evidence of success. Before reporting funds, require `mode: "account"`, the expected `account`, `vault_state: "unlocked"`, `stale: false`, a non-null `updated_at`, and a null `error`. A failed refresh preserves the previous timestamp and balances; locked or never-refreshed accounts are not evidence of zero funds. The balance command returns balances and freshness metadata without wallet addresses or credentials. Full status also exposes the cache in `state.account_status.balances`.

Kraken's [Extended Balance](https://docs.kraken.com/api-reference/account-data/get-extended-balance) requires Funds → Query and reports balance, credit, credit used and holds for spot non-margin orders. Trading availability is `balance + credit - credit_used - hold_trade`; it is not a withdrawal quote and may include credit. Amounts remain exact decimal strings. Kraken asset codes are preserved, including `ZUSD` for USD. Suffixed Earn/rewards buckets remain separate with no availability claim; do not add them to base balances as unused cash. Balances never trigger orders or withdrawals.

## Configure fill-triggered withdrawals

In the TUI, wait for **5 Wallets** to finish its automatic refresh, then open **7 Watch rules → E**. The editor asks for the asset received from a fill, verified destination(s), order types, buy/sell sides, optional pairs/order IDs, gross chunk size, minimum, reserve, fee caps, optional rolling 24-hour fee budget and the shared account cooldown. It fills the minimum from the selected network's Kraken funding method using the last wallet sync. When rotating destinations, it uses the highest minimum; a higher previously configured threshold is retained. Press Enter to accept it or enter a higher value. Undersized amounts are rejected immediately so you can correct them without restarting the editor. A missing Kraken minimum blocks setup until a successful wallet sync supplies it. It displays the complete configuration before saving. **P** pauses and **R** resumes withdrawals. The worker continues monitoring while paused.

Each asset has one rule. Empty `pairs` and `order_ids` lists match all orders satisfying the other filters, including orders placed outside Moby. Market, limit, stop-loss, take-profit and trailing variants are supported for monitoring, as are iceberg fills. Margin trades are excluded. Buys receive the base asset; sells receive the quote asset. For example, a BTC/USD buy credits BTC and a BTC/USDC sell credits USDC. A BTC/USD sell receives fiat USD: Moby does not silently convert it to a stablecoin or send fiat to a crypto wallet. Each partial fill is accounted separately using its settlement ledgers, including the actual fee currency. Deposits and pre-existing balances do not create withdrawal requests.

Each watch rule supports up to 64 verified destinations, visited in the configured rotation order.

One account-wide cooldown spaces **every withdrawal**, across all assets, orders and rotating wallets. With 60 seconds configured, a BTC attempt makes USDC, XLM and every other asset wait too. Attempts are serialized before dispatch; the full interval starts after the exchange request returns, so network delays cannot shorten it. Each asset still has its own queue and at most one active transfer. Different named account profiles remain independent.

The timer survives restarts, new fills, queue clearing and rule removal. Existing v1 configurations are upgraded to schema v2 with a single `cooldown_seconds` at the configuration's top level, choosing the longest previous asset cooldown. Existing queues and monitoring cursors are preserved. New configurations must use v2; cooldowns no longer belong inside individual rules.

To change only timing, pause withdrawals and let active sends settle, then use the Omarchy dropdown's **Rules → Set Cooldown** button. Agents can use `moby config cooldown 120 --expect CONFIG_DIGEST --json`, taking `CONFIG_DIGEST` from a fresh `state.account_status.live.config_digest` in `moby status --json`. The worker rejects stale edits. `state.withdrawal_cooldown_seconds` is the shared setting; `state.withdrawal_cooldown` reports its source asset, start time and deadline. This timing-only change preserves the fill boundary, queues, last send time and wallet rotation, and leaves withdrawals paused.

Synthetic spot fills reported by Kraken as explicit `BASE/QUOTE` pairs (for example `XLM/USDC`) do not need a native market listing. Both assets must be known, and the referenced trade ledgers must verify the assets, direction, amounts and fees before Moby queues anything. This is tested with offline fixtures; it does not enable synthetic order placement or monitoring of a separate DEX wallet.

**Withdrawal minimums and trading minimums are separate.** A watch rule's minimum controls withdrawals to a wallet; it does not tell you how much Kraken requires for a buy or sell on a particular pair. Moby requires the net amount delivered after withdrawal fees to meet the rule and network minimums. A small partial fill can remain queued until more matching fills cover that amount and the fee.

For an agent or file-based setup:

```sh
moby config --json
moby config edit
moby config validate examples/watch-config.json --json
moby pause
moby config apply reviewed-rules.json --confirm REVIEWED_DIGEST
moby resume
```

The example contains placeholder wallet/method/address values; copy actual values from a reviewed `wallets list --json` response. Configuration is tied to the selected account and key. Application requires a paused worker, no active transfers, and matching verified destinations from fresh wallet data. Both `minimum` and `chunk` must cover the highest synced Kraken minimum for the selected destinations; this also applies to agent/JSON requests. `config validate` checks the file locally; the worker checks Kraken metadata when applying it. It leaves withdrawals paused. Editing rules establishes a new boundary for crediting future fills; already queued amounts remain visible. Changing or removing a key requires pausing, clearing the reviewed queue and resolving active/uncertain operations first.

**Live `chunk` is the gross debit INCLUDING the withdrawal fee.** `minimum`, `reserve`, `max_fee` and optional `daily_fee_budget` are also in units of the selected asset; the budget covers the preceding rolling 24 hours, so UTC midnight does not reset the allowance. `max_fee_percent` is a percentage of the gross chunk. Unlike the GUI, this build uses asset-denominated chunks/budgets, not USD price conversions. Multiple saved destinations rotate after each attempt. Global concurrency is configurable from 1–4, with at most one active withdrawal per asset.

Before each withdrawal, Moby refreshes and verifies the pinned saved address, memo/tag, asset and network; obtains current method minimum/maximum and withdrawable balance/limits; preserves the reserve; and requests a pinned fee quote. Both gross and net must meet the configured/funding minimum. Leave room for fees above the minimum when choosing a gross chunk: passing setup checks does not guarantee the net amount will qualify at execution time. A fee or balance block is shown on the rule and retried with backoff. Small transfers may still be held by Kraken and incur fees.

The worker persists fill identities, queues, history cursors and submission intents in SQLite. WebSocket `ownTrades` records executions immediately, reconnects with fresh tokens and detects missing sequence numbers or heartbeats. REST performs paginated catch-up and verifies settlement ledgers before crediting funds. If REST is unavailable, WebSocket events remain pending evidence; withdrawals wait for REST reconciliation. This is complementary recovery, not two independent withdrawal transports.

First configuration begins with future fills. After a disconnect, lock or worker restart, catch-up continues from the persisted cursor, including fills during the gap; it never imports the account's entire old trading history. Withdrawals wait until catch-up reaches the present. On Resume, sales and manual withdrawals reduce the queue to actual owned funds. Temporary order holds delay withdrawals without erasing the queue. No new submissions start while paused or locked, but a request already dispatched can still complete.

```sh
moby withdrawals --json
# After independently identifying an uncertain transfer on Kraken:
moby withdrawals attach LOCAL_WITHDRAWAL_ID KRAKEN_WITHDRAWAL_ID
```

Pending/held/unknown transfers occupy their asset's slot. A timeout or crash during submission becomes **unknown**, never an automatic retry. Attaching a receipt triggers verification of its asset, amount, destination and method; Moby never guesses by matching similar amounts. Confirmed failed transfers are retained for review and are not automatically requeued. A paused `clear-queue --confirm DIGEST` uses `state.queue_digest`, requires no active transfers, and prevents delayed older fills from restoring cleared funds.

## Order management through the worker

**8 Orders** automatically refreshes open and recent closed orders; **F** requests a refresh now. New placements and amendments require fresh balance and order data. Cancellations and lookups of already recorded request IDs remain available when cached data is stale. The CLI exposes the same cache and durable command receipts. Order writes are explicit and independent of the automatic-withdrawal pause control.

```sh
moby orders sync --json
moby orders --json
moby orders validate examples/order-request.json --json
moby orders submit reviewed-order.json --confirm REVIEWED_DIGEST --json
```

`validate` is entirely local: it does not call Kraken's order-validation endpoint. Inspect pair, side, type, quantity and prices before submitting. The example is illustrative, not a suggested trade. The JSON envelope contains `request_id`, `account`, and an `order` object. Place supports market, limit, stop/take-profit and trailing variants; iceberg placement is not exposed. No margin/leverage flags are accepted. `price2` is required for conditional limit orders; trailing triggers use signed offsets. Use `{"action":"amend","order_id":"…","volume":"…","limit_price":"…","trigger_price":null}` or `{"action":"cancel","order_id":"…"}` for other actions.

A request ID is 1–18 letters, digits or hyphens. Reusing an ID with identical instructions returns the existing receipt; changing instructions under the same ID fails. A lost response never resubmits an order. Unknown placement receipts can recover from an observed `cl_ord_id` in refreshed order history. An unresolved order outcome blocks further order writes; inspect Kraken activity rather than sending another ID. `accepted` means Kraken accepted the request, not that an order filled or a cancellation beat a fill.

`moby orders validate` checks the request format locally. Its JSON reports `validation_scope: "local_format_only"` and `exchange_checked: false`; success does not mean an order meets Kraken's trading minimums or available balance. Before sending a placement, the worker checks Kraken market metadata, including the minimum order quantity. A below-minimum request reports the pair, required quantity, and requested quantity without sending an order. Exchange acceptance and fill confirmation still require checking the resulting receipt and order.

## Uncertain withdrawals

A timeout is not proof that Kraken rejected a withdrawal. Moby records it as `unknown`, blocks further chunks for that asset, and never resends it automatically. A known reference can be linked with `moby withdrawals attach LOCAL_ID KRAKEN_ID`; the worker then verifies the receipt against the pinned asset, destination, method and amount.

If you check Kraken's withdrawal history and explicitly confirm that no withdrawal was sent:

```sh
moby pause
moby withdrawals review LOCAL_ID --json
# After checking Kraken, use the digest returned by review:
moby withdrawals resolve LOCAL_ID --not-sent --confirm REVIEW_DIGEST --json
```

Resolution requires an unlocked, paused account, a matching review digest, no exchange reference, no in-flight Kraken job, and at least two minutes since submission. It restores the queued amount exactly once, records the decision and leaves withdrawals paused. Resume reconciles against current funds before any further withdrawal. Do not use this merely because a receipt is missing or delayed.

Pending receipts are checked every 10 seconds initially, then 30 seconds after the first minute, and 120 seconds after six minutes. Status changes trigger reconciliation; unchanged pending results do not. Requests with no exchange reference await review rather than repeatedly downloading history they cannot match. Eligible assets take turns without a priority setting; destinations continue rotating within each rule.

## Optional Telegram alerts

Press **N** or run `moby telegram setup`. Create a bot with Telegram's **@BotFather**, start a conversation with that bot, and enter its token and your numeric chat ID through the hidden prompts. The token is encrypted in the account vault and never appears in JSON status. Setup enables future alerts; it does not send a test or activate withdrawals.

```sh
moby telegram setup
moby telegram test             # explicitly sends one test message
moby telegram status --json    # delivery status, never the token
moby telegram disable
moby telegram enable
```

Alerts cover withdrawal acceptance, completion, holds, uncertain/failed requests, monitoring problems lasting five minutes, recovery, and transfers/queues waiting unusually long. Start messages are limited to one per asset per five-minute burst; completions wait a minute and are grouped. A persistent outbox retries delivery with backoff and respects Telegram retry delays. A timeout after Telegram accepts a message can still produce a duplicate notification; notifications never cause a withdrawal retry. Delivery errors appear in `account_status.telegram`, the footer, and API Key details. Delivery pauses while the vault is locked. Changing the recipient or disabling alerts clears pending messages. Paper mode cannot store Telegram credentials or send messages.

Kraken pacing follows its [REST rate-limit guidance](https://docs.kraken.com/exchange/guides/rest/ratelimits); Telegram uses the outbound [sendMessage API](https://core.telegram.org/bots/api#sendmessage). Moby does not accept trading commands from Telegram.

## Dashboard controls

| Key | Action |
| --- | --- |
| ← / →, 1–8 | Overview, Fills, Withdrawals, Activity, Wallets, API Key, Watch rules, Orders |
| ↑ / ↓ or K / J | Select a row |
| Page Up / Down, Home / End | Scroll or jump |
| Enter | Full, scrollable details for the selected row |
| / | Search the current view; terminal paste works |
| Enter / Esc while searching | Keep / clear filter; Ctrl-U clears text |
| E / C on API Key | Enter or replace / check the account key |
| F on Wallets | Refresh destinations from Kraken (account only) |
| B on Overview | Refresh balances and spot-order holds (account only) |
| U | Unlock the account vault |
| N | Set up optional encrypted Telegram alerts (account only) |
| D on Overview | Simulate a fill for the selected asset (paper only) |
| P / R | Pause withdrawals / reconcile and resume configured withdrawals |
| E on Watch rules | Add or edit an asset rule (pause first) |
| F on Orders | Refresh open and recent closed orders |
| S / O on Orders | Cycle sort field / reverse direction |
| C on Orders | Show/hide cancelled orders; hidden by default |
| ? / Esc | Open / close help |
| Q / Ctrl-C | Detach dashboard; worker stays running |

Orders initially show active orders first. **S** cycles through state, pair, side, type, price, size and filled amount; **O** reverses the direction. The selected order stays selected when sorting or receiving fresh data. Prices and quantities sort numerically. Agents can use `moby orders --sort price --descending --json` to sort the same cached order list without making extra Kraken requests.

Cancelled orders are hidden by default. **C** shows/hides them; the indicator shows how many cancelled orders are in the cached list. This only filters the display and never cancels an order or removes history. Agents can include them with `moby orders --show-cancelled --json`; `data.hidden_cancelled_count` reports how many were excluded. Completed and expired orders remain visible.

Search and overlays capture keys so controls cannot run underneath them. Disconnected snapshots are marked stale and actions are disabled until a fresh worker connection returns. A network check does not freeze the dashboard.

Activity errors identify the failed operation. For a `GetWebSocketsToken` permission denial, check that the key's **WebSocket interface** is enabled in Kraken and review its restrictions; a nonce rejection is a separate authentication problem. Failed WebSocket authentication does not stop REST fill reconciliation. Select an activity row and press **Enter** to read the full message. Error text uses known error categories without exposing keys or raw exchange responses.

The swimming whale and header mascot use the Moby logo in Ghostty, Kitty and Foot when pixel dimensions are available. Other terminals, tmux/screen and `NO_COLOR` use text artwork. Any key skips the launch animation without triggering an action. Artwork is embedded in the executable.

## Paper account

`moby --demo` never opens the account vault or account database. It has separate rules, pause state, balances, fills, history and simulated destinations. Paper activity cannot modify the configured account. Key entry, key checks, Kraken sync, live watch rules and live order requests are rejected in this mode, including over IPC.

The paper worker initially starts paused with zero balances and BTC, ETH and USDC rules. Select an asset and press **D** to add a fill, then **R** to simulate withdrawals. Default transfers settle after about three seconds with a five-second cooldown shared by all assets. Timings and fees are fixtures, not exchange quotes.

```sh
moby --demo pause --json
moby demo fill --id sample-001 --asset BTC --amount 0.003 --json
moby --demo resume --json
```

`demo` subcommands always target paper, even without `--demo`. Other commands need `--demo` to select that profile. Fills represent **net received assets after trading fees**. Partial fills need distinct IDs. Retrying the same ID and contents is safe; changed contents fail. A timeout does not prove an action was rejected.

Review chunk sizes and the account cooldown in [`examples/demo-plan.json`](examples/demo-plan.json). Amounts remain quoted decimal strings. `chunk` is the recipient amount, `fee` is extra, `minimum` is the smallest recipient amount, and `reserve` stays on the simulated exchange.

```sh
moby --demo plan validate examples/demo-plan.json --json
moby --demo pause
moby --demo plan apply examples/demo-plan.json --confirm REVIEWED_DIGEST
moby --demo resume
```

Review the printed rules and full digest before applying. Application requires a paused worker with no active, held or unknown jobs, and leaves it paused. The digest detects changes between review and application; it is not an authentication boundary against processes running as you.

Exercise manual-sale reconciliation or uncertain outcomes:

```sh
moby --demo pause
moby demo balance --asset BTC --amount 0
moby --demo resume

moby --demo pause
moby demo outcome unknown
moby --demo resume
moby --demo status --json
moby --demo pause
moby demo resolve WITHDRAWAL_ID complete
# Or release a simulated transfer that never happened:
moby demo resolve WITHDRAWAL_ID not-sent
```

The queue is reduced to simulated spendable funds before more withdrawals. Increasing balance alone does not create a fill. `demo outcome` accepts `complete`, `held`, `unknown` and `rejected`. Held/unknown jobs block that asset and consume a global slot. Rejections retain funds and respect cooldowns. Submitted paper transfers settle even while paused.

To discard queued amounts, pause, settle or resolve active jobs, and use the fresh `state.queue_digest` from `moby --demo status --json`:

```sh
moby --demo clear-queue --confirm REVIEWED_QUEUE_DIGEST
```

Clearing retains balances, fill IDs and history; old fills cannot be replayed. Simulator resolutions are not evidence about a real exchange transfer.

## Password and storage

The first **account** launch creates an encrypted vault with an **8-character minimum** password. There is no password recovery. Enter credentials directly in the terminal, never in an AI chat. There are no secret flags, environment inputs, piped secret inputs or secret-export commands. API-key output only exposes labels and permission-check metadata. Balances, labels and wallet details are hidden while locked.

The vault uses Argon2id (64 MiB, three passes, one lane, random 16-byte salt) and XChaCha20-Poly1305 (fresh random 24-byte nonce per save). The password and derived key are never stored. Saves publish atomically, files are private, secret buffers are zeroized on normal drop, and Linux core dumps are disabled in the worker and password-entry client. An unlocked worker keeps usable credentials in memory. This does not isolate it from unrestricted code running as the same OS user or root.

Default data root: `$XDG_STATE_HOME/moby-tui`, or `~/.local/state/moby-tui`.

```text
moby-tui/
├── account/                  # main account: encrypted vault and wallet cache
├── paper/                    # main paper simulation; no vault
└── accounts/second/
    ├── account/              # second account
    └── paper/                # second paper simulation; no vault
```

Each profile has `profile.mode`, `state.sqlite3` (plus WAL/SHM), `worker.sock`, `worker.lock`, and a startup/shutdown `worker.log` for detached launches. Only `account/` has `vault.json`. Balances, wallet addresses and permission-check results are cached in the private account SQLite file; the database is not encrypted. API credentials are stored only in the encrypted vault.

Use `--state-dir /short/private/root` on every command for a custom root; Moby selects `account/` or `paper/` within the chosen account profile. Directories must belong to you and have mode `0700`. Database, socket, vault and lock files are private. A second worker cannot take over an active profile. Moby refuses mode-mismatched databases and non-socket files at `worker.sock`.

No GUI data or credentials are imported.

Pause state, fill deduplication and paper history survive restart. Interrupted submissions without receipts become `unknown`. Snapshots contain up to 100 fills, 100 withdrawals and 100 activity events; complete fill/withdrawal history remains in SQLite. Stop the account and paper workers for **every named profile** before backing up the entire root; a live SQLite file alone may omit its WAL.

## Agents and remaining scope

Agents use the same local CLI/worker as the dashboard; see [AGENT_GUIDE.md](AGENT_GUIDE.md). Most JSON responses contain `ok`, `message` and a snapshot; the balance command returns a compact balance/freshness result described above. Monetary amounts are decimal strings. Runtime errors return `ok: false` and exit status 1; CLI syntax errors use Clap's standard usage output. No MCP server is needed.

The worker holds credentials and returns structured results to both agent and dashboard. Agents must respect the user's trading instructions, account selection and amounts; a review digest detects changed instructions and is not a substitute for authorization. Read [AGENT_GUIDE.md](AGENT_GUIDE.md) before automation.

This version's live path is covered by local mock HTTP/WebSocket data, isolated worker tests and a terminal smoke test. A user-run market buy and automatic withdrawal has completed on Kraken, including notification delivery; this is not a long-running exchange soak test. Optional Telegram alerts, chunked withdrawals and recovery are implemented and covered by fixtures. USD-valued sizing and GUI multi-exchange support are intentionally outside this version.

## Development

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
unshare -Urn sh -c 'ip link set lo up && cargo test --offline --workspace --locked'
cargo build --release --locked -p moby-tui
unshare -Urn sh -c 'ip link set lo up && python3 MobyTUI/scripts/smoke-launch.py target/release/moby'
```

`profile.rs` separates named accounts and their paper data. `account.rs` coordinates serialized jobs and account caches, `kraken.rs` signs bounded HTTP requests with shared pacing in `kraken/session.rs`, `notifications.rs` manages the Telegram outbox, `live/` holds watch rules, durable accounting, REST operations, WebSocket recovery and the rule editor, `engine.rs` the paper simulator, `storage.rs` SQLite, `vault.rs` encryption, `launch.rs` startup/hidden prompts, `ipc.rs` worker transport, `main.rs` CLI and `tui.rs` dashboard. Tests use mock API responses and disposable credentials, not real Kraken accounts. The Linux network namespace permits loopback fixtures and has no route to Kraken. Never use real keys, real profiles or production order-validation calls for development tests. Protocol 8 (Telegram and uncertain-withdrawal review) and account database schema 2 require restarting the old worker to load this version; paper database schema remains 1.

Artwork comes from `MobyGUI/src/ui/components/ui/WhaleIcon.tsx`. Regenerate it with `node MobyTUI/scripts/render-whale.mjs` after changing that vector logo (requires GUI development dependencies).

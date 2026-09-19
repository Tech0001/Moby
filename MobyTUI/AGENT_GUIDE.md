# Using MobyTUI from an agent

Use Moby's CLI to communicate with its running worker. The worker holds the Kraken key; agents do not need it. Never inspect vault files, edit account SQLite, intercept prompts, ask for credentials in chat, or run a separate exchange client using the user's key.

The primary task is **wait for matching order fills → queue the received asset → withdraw chunks with cooldowns and rotating approved wallets**. Setting up existing orders does not require placing or modifying an order. Keep defaults for polling/concurrency unless the user has a specific need; do not add USD sizing, wallet caps or priority settings.

For setup, establish the received asset, optional order/pair/type/side filters, approved destinations (in rotation order), chunk amount, reserve and fee caps, plus one account-wide cooldown. Read current wallet metadata from the worker, prepare a configuration, validate it locally, explain the rule in plain language, and apply/resume only within the user's authorization. Use schema v2 with one top-level `cooldown_seconds`, never per-rule cooldowns. For timing-only changes, use `moby config cooldown SECONDS --expect CONFIG_DIGEST --json` while paused, with `CONFIG_DIGEST` from fresh status. Use `moby config --help` and `examples/watch-config.json` for the exact format. The user enters secrets through their own terminal prompts; an agent needs none of them.

A buy of BTC/USD receives BTC. A sell of BTC/USDC receives USDC. A sell of BTC/USD receives fiat USD, which cannot be sent to a crypto wallet by this app. Do not assume permission to convert proceeds or change the user's order pair.

Read commands use the worker's cache and never trigger Kraken requests. Avoid repeatedly running `sync`; the worker refreshes automatically. If an explicit refresh is needed, request it once and read status at a reasonable interval until its timestamp advances. Rate-limit cooldowns apply across account operations. Keep reported stale data clearly labeled.

1. Keep `--state-dir` and `--account NAME` consistent. `main` is the default. `moby accounts --json` lists profiles without starting one. Check the returned account and mode before acting. `--demo` is an isolated paper profile and never accesses real credentials.
2. Read `status --json`. An unavailable/locked worker or absent snapshot is not an empty account. The user unlocks in their terminal with `moby` or `moby unlock`. Never ask for their password in chat. Q detaches the TUI; `stop` ends the worker and forgets unlocked secrets.
3. `key list` exposes permission metadata, not secrets. Key checks, balances, wallets and order sync are asynchronous. `ok:true` means the worker queued a request; it does not prove exchange success. Balances/orders refresh automatically about every 30 seconds and wallets every 5 minutes while unlocked, even when withdrawals are paused or unconfigured. Verify freshness timestamps, errors and final receipts. Cached information is not an authorization to trade.
4. Order placement, amendment, cancellation and withdrawal automation affect real funds. Follow the user's specific instructions. Preserve exact decimal strings, intended account, destination/network/memo, side, pair, quantity and price. `validate` is local; submitting a reviewed digest is an explicit exchange write. Do not run even Kraken's validation-only endpoint as a development test.
5. Apply watch configurations only after reviewing them against the user's wishes and current verified wallet metadata. Applying requires a paused worker and leaves withdrawals paused. `resume` explicitly arms automation after reconciliation. `pause` stops new automatic withdrawals; it does not disable separately requested order writes. `lock` pauses withdrawals and disconnects exchange monitoring.
6. Never treat pending/held/unknown transfers as complete, and never retry an unknown write under a new ID. Reuse the same order `request_id` and payload when retrying IPC. Read durable receipts after timeouts. Unknown placements may be recovered by their client ID in refreshed open/recent closed orders; other unresolved outcomes require review of Kraken activity.

```sh
moby --account main status --json
moby --account main balances --json
moby --account main wallets list --json
moby --account main orders --json
moby --account main orders --sort price --descending --json
moby --account main orders --show-cancelled --json
moby --account main config --json
moby --account main withdrawals --json
```

Balances use a compact response with `account`, `mode`, `vault_state`, `refreshing`, `updated_at`, `error` and `balances`. Require `stale:false` before describing balances as current. After requesting a refresh, require a newer successful timestamp; `refreshing:false` alone is not success. Full status exposes `account_status.refresh` for balances, orders and wallets; each includes stale/refreshing flags, refresh interval and next due time. Restart/unlock requires fresh reads even if recent cached data exists. `available_for_trading` includes credit and subtracts spot non-margin order holds; it is not withdrawable cash. Report credit separately. Keep suffixed Earn/rewards buckets separate and preserve Kraken asset codes (`ZUSD` is USD).

Orders and withdrawals return a `data` object. Orders have `orders`, `updated_at`, `error` and `receipts`. Orders expose `data.stale` and `data.freshness` as well. New order placements and amendments require fresh balances/orders; cancellation and idempotent receipt lookups still work with stale cached data. Writes are represented by receipts containing the original request, digest, status and exchange ID. A successful command receipt only schedules the write. `accepted` is exchange acceptance, not order execution. Order lists include open and recent closed orders, not an exhaustive historical export. An unknown placement outside this history window remains blocked for manual review.

```sh
moby orders validate reviewed-order.json --json
moby orders submit reviewed-order.json --confirm REVIEWED_DIGEST --json
```

Order lists hide cancelled orders by default; `data.hidden_cancelled_count` reports the omitted count. Use `orders --show-cancelled --json` when reviewing cancellations or recent history. This is a display filter; stored orders and command receipts remain intact.

Trading and withdrawal minimums are separate: the order pair defines minimum order quantity/value, while a wallet funding method defines its withdrawal minimum. Never use a watch rule's minimum as a suggested buy size. `orders validate` checks only local request format (`validation_scope: "local_format_only"`, `exchange_checked: false`); it does not check Kraken limits or funds. The worker checks market metadata before placing an order. The net withdrawal after fees must separately cover both the rule and network minimums.

Order files have `request_id`, `account`, and a nested `order` object:

```json
{
  "request_id": "user-request-001",
  "account": "main",
  "order": {
    "action": "cancel",
    "order_id": "USER_SPECIFIED_KRAKEN_ORDER_ID"
  }
}
```

`request_id` is 1–18 letters, digits or hyphens. See `examples/order-request.json` for placement, and `moby orders --help`. The digest detects changes after review; it is not a permission system.

Watch rules select **received assets**, not orders attached to wallets: buys receive base assets and sells receive quote assets. Optional side/type/pair/order-ID filters restrict which fills credit a queue. Empty pair/ID lists match all otherwise eligible orders, including external ones. Settlement-ledger debits still reduce previously queued assets when an excluded trade sells them. Margin trades, deposits and pre-existing balances do not create withdrawal credits.

```sh
moby config validate reviewed-rules.json --json
moby pause
moby config apply reviewed-rules.json --confirm REVIEWED_DIGEST --json
# Only when the user wants automatic withdrawals active:
moby resume
```

Each destination pins the verified wallet ID, funding-method ID, network, full address and memo/tag from `wallets list`; never guess these values. Live chunks are **gross, including fees**, in asset units. Minimum, reserve, maximum fee and optional `daily_fee_budget` also use asset units; the budget now covers a rolling 24 hours, not a UTC calendar day. Use the matching funding method's `minimum` from a successful wallet sync: both rule `minimum` and `chunk` must cover the highest minimum across the selected destinations. Missing/invalid minimums block configuration. Leave room for fees in the gross chunk; current limits and net amounts are rechecked before each withdrawal. Local `config validate` cannot check Kraken metadata; applying through the worker does. Paper plans instead specify a net recipient chunk and a separate simulated fee. Do not mix these models. Unknown/held transfers block their asset; the worker never resends an uncertain submission. A verified exchange receipt can be attached with `withdrawals attach LOCAL_ID KRAKEN_ID`; attachment does not resend or waive matching checks. Failed transfers are not automatically requeued.

Monitoring begins with future fills after initial configuration. REST catches gaps from its persisted cursor, including downtime, while WebSocket supplies immediate execution evidence. Ledgers must reconcile before withdrawal. Changing rules starts a new credit boundary; existing queued funds remain explicit. While paused, sells/manual withdrawals reduce queued funds. Order holds delay execution without erasing the queue. Clearing requires pause, no active transfers and a current `queue_digest` from status; old delayed fills cannot restore cleared funds.

Protocol **8** adds Telegram delivery status and guarded uncertain-withdrawal recovery alongside automatic account refresh; account DB schema is **2**. Each profile has its own worker, vault and paper state. `moby start` starts locked; workers always restart with withdrawals paused. They refresh account data after unlock with no withdrawal rules required. Fill reconciliation and automated withdrawals still require configured rules. An unlocked worker requires no password per operation. The Unix socket authenticates the OS user, not the identity of an agent; unrestricted same-user code remains inside that trust boundary.

For development, use disposable profiles, fixture keys and mock responses. Run tests in a network namespace with loopback only. **Do not test orders, withdrawals or order validation against live Kraken.** One user-run market buy and automatic withdrawal has completed on Kraken; broad live validation and soak testing remain outstanding. Telegram is optional and outbound only; use the worker commands below. USD-valued sizing is intentionally omitted.

## Telegram and uncertain-request review

`moby telegram status --json` exposes only configuration/delivery status. The user sets the token through `moby telegram setup` or **N** in the TUI; never ask them to paste it into chat, a shell argument, or a config file. `telegram test` sends a real message, so use it only when requested. `telegram disable` stops alerts; `telegram enable` uses the saved encrypted configuration. These commands do not enable withdrawals. Paper mode never sends messages.

For an uncertain withdrawal, first check `moby withdrawals --json`. `withdrawals attach LOCAL_ID KRAKEN_ID` links a known reference for worker verification. If the user has checked Kraken history and explicitly confirmed that no withdrawal was sent, pause and run `withdrawals review LOCAL_ID --json`, then `withdrawals resolve LOCAL_ID --not-sent --confirm REVIEW_DIGEST --json`. A timeout, absent reference or empty history query is not sufficient evidence. Never invent that confirmation. The worker requires a current digest, no exchange reference and a two-minute minimum wait, restores credit at most once, and remains paused; resumption still reconciles actual funds. Do not edit the SQLite database to unblock a queue.

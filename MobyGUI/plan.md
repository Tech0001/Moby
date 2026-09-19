Below is the full updated handoff spec with the **only change** being a simplified **Secrets Handling** section (no unlock-to-run, no extra key complexity). Everything else is kept as-is.

---

Below is the updated handoff spec with the changes we discussed (multi-instance “buddy hosted” on one VPS w/ subdomains + UI login + start/stop semantics + withdrawal status polling strategy + rate-limit friendly polling).

⸻

## Project: Moby (Node/TS)

### Goal
Build a self-hosted Node.js + TypeScript daemon that monitors a user’s Kraken spot account for executed trades and automatically withdraws the newly received asset to pre-saved Kraken withdrawal addresses, using:
- coin-specific chunking
- round-robin wallet rotation per asset
- priority scheduling (e.g., BTC first, then ETH, then FLR)
- robust retry/backoff for delays/holds/outages
- start/stop toggle (disable withdrawals without killing the process)

### Deployment modes
- Local (default): run on the user’s machine (24/7 optional).
- Buddy-hosted (shared VPS, multiple instances): run one isolated instance per person (one Docker stack per buddy), each reachable via their own subdomain (e.g., `alice.domain.com`, `bob.domain.com`).
  - This is not a multi-tenant service; it’s multiple single-user instances behind a reverse proxy.

### Non-goals
- Do not place or cancel orders (unless explicitly enabled later).
- Do not attempt to bypass compliance or “avoid flags.” We just handle normal delays/holds safely.
- Do not add/edit Kraken withdrawal addresses via API in the critical path. User pre-configures them in Kraken UI.
- Do not expose Docker control to the UI (start/stop is internal, not container control).

⸻

## Key Behavioral Rules

### Trigger rule (what causes withdrawals)
- Only act on actual executions/fills (including partial fills).
- Only executions belonging to allowed order types:
  - limit, take_profit, take_profit_limit (configurable allowlist)

### What gets withdrawn
For each fill on a pair BASE/QUOTE:
- If BUY: user receives BASE → sweep BASE
- If SELL: user receives QUOTE → sweep QUOTE
- Sweep the filled portion only (net received), accumulated over time.

### Withdrawal destination constraint (important)
- Withdrawals must use Kraken pre-saved withdrawal “keys” (address book entries).
- App should only allow selecting from (or matching) saved keys that the user has already confirmed in Kraken.
- Optional safety rule: enforce a key name prefix filter (e.g., only keys starting with `COLD_`) to avoid accidental use of the wrong destination.

### Chunking rule
- Per-asset chunk policy (fixed-coin or USD-based).
- Use Kraken constraints (min/fee) via WithdrawInfo to clamp amounts.
- Only attempt withdrawals when pendingSweep >= sweepThreshold.
- Enforce:
  - reserve (leave dust)
  - maxPerWithdraw
  - cooldownSeconds per asset
  - perWalletCap (optional; skip wallets that exceed cap)

### Wallet rotation (round-robin)
- Each asset has a list of Kraken withdrawal address keys (pre-saved).
- Maintain rrIndex per asset.
- Choose destination key = walletKeys[rrIndex].
- Advance rrIndex only after a withdrawal request is successfully submitted.

### Priority scheduling
- Assets have priority numbers (lower = higher priority).
- Scheduler always picks the highest-priority eligible asset first.
- Global concurrency caps:
  - maxInflightWithdrawals overall
  - perAssetMaxInflight = 1

### Start/Stop behavior (UI toggle)
- “Stop” should disable withdrawals (and optionally pause WS listening), but keep the instance running.
- “Start” re-enables the scheduler/withdraw workers.
- This must be an internal flag (DB/config), not a Docker start/stop.

### Failure/chaos handling
- Withdrawals are asynchronous jobs:
  - submit → status poll → complete
- Implement:
  - exponential backoff on failures
  - circuit breaker per asset (pause after N consecutive failures)
  - retry queue (do not spam)
- If Kraken/chain is congested:
  - keep jobs queued, retry later, alert user.

⸻

## Required Kraken API Key Settings (User Side)

Enable permissions:
- Funds: Query
- Funds: Withdraw
- Orders & Trades: Query closed orders & trades (optionally open)

Enable WebSocket interface for real-time fills (private feed).

Optional:
- IP restriction (recommended when running on a stable IP / VPS)

App uses:
- Private WebSocket for fills
- REST for withdraw + withdraw info + withdraw status (+ optional reconciliation endpoints)

⸻

## Architecture Overview

### Components (modules)
1. Config Loader
   - reads config from SQLite (migrates legacy config.yaml once)
   - validates schema (zod)

2. Kraken Clients
   - KrakenWsClient (private auth + subscribe to executions/ownTrades)
   - KrakenRestClient (signed REST requests)

3. Web UI + API (per instance)
   - login/auth (simple local auth)
   - config editor (assets, chunking, priorities, wallet keys)
   - “Test Kraken connection”
   - start/stop toggle
   - status page (pending sweep amounts, in-flight jobs, last errors)

4. Event Normalizer
   - convert WS events into internal FillEvent
   - apply allowlist for order types

5. Fill Processor
   - determine received asset (base vs quote) based on side
   - compute net received
     - preferred: use trade detail fields if provided
     - if ambiguous: reconcile via REST “trade history/ledger” or balance delta
   - persist as pendingSweep[asset] += netReceived

6. SQLite Ledger
   - durable state so restarts don’t double-withdraw
   - stores:
     - pending amounts
     - rr indices
     - withdrawal jobs + status
     - backoff/circuit state
     - enabled/disabled flag

7. Sweeper Scheduler
   - runs loop every 1–5s or “wake on new fill”
   - selects eligible assets by priority and starts withdrawals up to concurrency limits
   - respects enabled flag (start/stop)

8. Withdrawal Worker
   - computes chunk amount
   - preflights with WithdrawInfo (min/fee)
   - calls Withdraw
   - creates WithdrawalJob
   - updates pending/rrIndex only after successful submission

9. Status Poller
   - polls WithdrawStatus for submitted jobs
   - marks complete/failed/held
   - on failure/held: backoff + alert + (optionally) return amount to pending

10. Alerts/Observability
   - console logs + optional webhook/email
   - emit “stuck withdrawal > X minutes” warnings

⸻

## Secrets Handling (important)
- The app runs autonomously while the VPS/local machine is on. No “unlock-to-run”.
- Users will paste their Kraken API key + secret into the UI.
- Store the API key/secret locally in the instance (SQLite or a local config file). Keep it simple.
- Never log secrets.
- Provide UI actions:
  - Set/Update API Keys
  - Delete API Keys (wipe from the instance)
- Operational assumption:
  - This is used during active windows (e.g., volatility). When done, users can stop the instance and/or delete the key in Kraken.

⸻

## Buddy-Hosted VPS Mode (multiple buddies, one VPS)

### Model
- One isolated instance per buddy (separate compose project + separate volumes).
- Reverse proxy routes subdomains:
  - alice.domain.com → Alice instance UI/API
  - bob.domain.com → Bob instance UI/API

### Reverse proxy
- Use Traefik or Caddy to terminate HTTPS and route by Host header.
- DNS: wildcard *.domain.com → VPS IP (or individual A records).

### Isolation requirements
- separate Docker network per instance
- separate volumes per instance (SQLite/config/logs)
- do not share DB across buddies
- containers run as non-root, minimal privileges

⸻

## Data Model (SQLite tables)

### asset_state
- asset TEXT PRIMARY KEY
- pending_amount REAL NOT NULL
- rr_index INTEGER NOT NULL
- last_withdraw_at INTEGER (unix ms)
- consecutive_failures INTEGER NOT NULL
- backoff_until INTEGER (unix ms)

### withdrawal_jobs
- id TEXT PRIMARY KEY (uuid)
- asset TEXT
- method TEXT
- dest_key TEXT
- amount REAL
- status TEXT (submitted|pending|complete|failed|held)
- kraken_ref TEXT (withdraw ref if provided)
- created_at INTEGER
- updated_at INTEGER
- last_error TEXT

### fill_events (optional but useful)
- id TEXT PRIMARY KEY (trade id / composite)
- order_id TEXT
- pair TEXT
- side TEXT
- order_type TEXT
- net_received_asset TEXT
- net_received_amount REAL
- ts INTEGER

### app_state
- key TEXT PRIMARY KEY
- value TEXT
- includes: enabled flag, schema version, etc.

⸻

## Config Schema (example)

```yaml
global:
  enabledOnBoot: false
  maxInflightWithdrawals: 2
  perAssetMaxInflight: 1
  schedulerTickMs: 1000
  backoffSeconds: [15, 30, 60, 120, 300, 600]
  allowedOrderTypes: ["limit", "take_profit", "take_profit_limit"]

polling:
  withdrawStatus:
    fastSeconds: 10
    fastCount: 6
    mediumSeconds: 30
    mediumCount: 10
    slowSeconds: 120
    stuckMinutes: 30

assets:
  BTC:
    priority: 1
    method: "Bitcoin"
    walletKeys: ["BTC_COLD_01","BTC_COLD_02","BTC_COLD_03"]
    sweepThresholdCoin: 0.001
    reserveCoin: 0.0002
    cooldownSeconds: 45
    chunk:
      mode: fixedCoin
      amount: 0.005
      max: 0.05
    perWalletCapUsd: 5000

  ETH:
    priority: 2
    method: "Ethereum"
    walletKeys: ["ETH_COLD_01","ETH_COLD_02"]
    sweepThresholdUsd: 300
    reserveCoin: 0.02
    cooldownSeconds: 60
    chunk:
      mode: usd
      targetUsd: 800
      maxUsd: 2500
```

⸻

## Core Algorithms (pseudocode)

### On Fill Event
```
if !enabled: (optional) still record fills; just don't withdraw
if orderType not in allowedOrderTypes: return

receivedAsset = (side == BUY) ? base : quote
netReceived = computeNetReceived(fillEvent)

db.asset_state[receivedAsset].pending_amount += netReceived
wakeScheduler()
```

### Scheduler Tick
```
if !enabled: return

eligibleAssets = assets sorted by priority where:
  pending_amount >= sweepThreshold
  now >= backoff_until
  now - last_withdraw_at >= cooldownSeconds
  inflight(asset) < perAssetMaxInflight
  globalInflight < maxInflightWithdrawals

for asset in eligibleAssets:
  startWithdrawal(asset)
```

### Start Withdrawal
```
destKey = walletKeys[rr_index]

amount = computeChunkAmount(asset, pending_amount, priceIfNeeded)
amount = clampWithWithdrawInfo(asset, method, destKey, amount)

if amount < minAllowed: return

submit Withdraw(asset, method, destKey, amount)

on success:
  pending_amount -= amount
  rr_index = (rr_index + 1) % walletKeys.length
  last_withdraw_at = now
  create withdrawal_job(status=submitted)
on failure:
  consecutive_failures++
  backoff_until = now + backoffSeconds[min(consecutive_failures, ...)]
```

⸻

## Withdrawal Status Polling (why + how)

### Why poll /private/WithdrawStatus
- Withdraw success = request accepted, not necessarily broadcast on-chain
- status polling is required to:
  - detect completion vs hold vs failure
  - collect txid when it appears (if/when available)
  - sequence chunk withdrawals safely (1 in-flight per asset)

### Polling schedule (rate-limit friendly)
Per tick, do one status fetch and reconcile all jobs (don’t poll per job):
- 10s × 6 (first minute)
- 30s × 10 (next ~5 minutes)
- then every 60–180s until terminal

If held/failed: stop rapid polling, backoff, alert.

⸻

## Rate-limit guidance (implementation requirement)
- Implement a global REST limiter (token bucket).
- Prefer WS for fills; REST used mainly for:
  - WithdrawInfo
  - Withdraw
  - WithdrawStatus (batched polling)
  - occasional reconciliation

⸻

## Repo Structure (suggested)

```
src/
  config/
    loadConfig.ts
    schema.ts
  kraken/
    restClient.ts
    wsClient.ts
    sign.ts
  web/
    server.ts
    auth.ts
    routes.ts
    ui/ (minimal frontend)
  domain/
    types.ts
    fillProcessor.ts
    chunking.ts
    rrSelector.ts
    scheduler.ts
    withdrawWorker.ts
    statusPoller.ts
  db/
    sqlite.ts
    migrations.ts
    repositories.ts
  app.ts
```

⸻

## Testing Plan
- Unit tests:
  - received asset selection (base/quote)
  - chunking math (fixedCoin + USD)
  - round-robin pointer rules
  - scheduler eligibility + priority + enabled flag
  - polling schedule logic
- Integration tests (mock Kraken):
  - WS fill stream → pending increments
  - REST withdraw submission → job creation
  - status polling transitions
- Dry-run mode:
  - logs intended withdrawals without submitting

⸻

**Instruction to other AI:** Generate the TS skeleton + config schema + SQLite migrations + mocked Kraken clients first, then add the web UI (login + config + start/stop) and the batched WithdrawStatus polling.

# Moby

Moby is a self-hosted daemon with an Electron shell that monitors exchange activity and auto-withdraws funds based on your configuration.

## Configuration and data paths

- **Config**: persisted in the app database (no config.yaml). On first run, defaults are written into the DB. A legacy `config.yaml` will be migrated into the DB once if present.
- **Encryption key**: stored in `.env` inside the app data directory. This holds `MOBY_ENCRYPTION_KEY`, which is required to decrypt stored API keys. Back it up. You can override the path with `ENV_FILE_PATH` if needed.
- **Database**: stored as `moby.db` in the app data directory by default. Override with `DB_PATH`.
- **App data directory**: defaults to `MOBY_DATA_PATH` if set; otherwise Electron’s `app.getPath('userData')` (e.g., `~/Library/Application Support/Moby` on macOS) or `DATA_DIR`/current working directory in non-Electron environments.

## Scripts (development)

- `npm run dev` — run the server in watch mode.
- `npm run dev:ui` — run the Vite UI in dev mode.
- `npm run build` — build server and UI.
- `npm run electron:dev` — build and run Electron locally.
- `npm run electron:build:mac` — build a macOS app bundle.



 1. For x64 build (under Rosetta):

     rm -rf node_modules
     arch -x86_64 npm ci
     arch -x86_64 npm run build
     arch -x86_64 npm run electron:build:mac -- --x64
     Grab release/Moby-<version>-x64.dmg.
  2. To go back to Apple Silicon builds:

     rm -rf node_modules
     npm ci
     npm run build
     npm run electron:build:mac -- --arm64
     Grab the arm64 dmg.
## Reliability update (1.3.1)

This desktop build keeps the 1.3.0 database, encrypted credentials, configured assets, and wallet management features. The desktop server binds to the loopback interface and keeps a stable URL so browser preferences persist. Active UI sessions renew while polling, expired sessions return to login, and interrupted requests time out and retry. Kraken subscriptions use heartbeat and subscription deadlines, fresh tokens, sequence-gap recovery, and REST catch-up.

New fills are monitored from the start of each app run. Reconnect catch-up is limited to that run; trades from periods when the app was closed are not automatically swept. Existing pending amounts and withdrawals survive restarts. Stop pauses submissions while fill monitoring continues. An explicit pause survives restarts and overrides **enabled on boot**. Otherwise, automatic startup requires successful history and balance checks first. Existing allowed order types are preserved; enable market orders in Configuration if desired.

Withdrawals reserve their amount and a persistent job before submission. A lost response or interrupted submission becomes **unknown**, holds its reservation, and pauses that asset until reviewed. The Status tab lets you link a matching exchange reference or explicitly confirm that no withdrawal was sent. Held jobs remain in the polling queue. Confirmed cancellations release funds once. Unclassified submission failures remain reserved; an accepted withdrawal reported failed requires investigation.

Configured chunk sizes, network checks, minimums, cooldowns, inflight limits, and cumulative per-wallet caps apply before submitting. Optional coin and USD wallet caps are editable in each asset dialog and cover Moby's recorded withdrawals, including outstanding requests. Missing prices cannot bypass a USD cap. Kraken submissions include the quoted fee ceiling. A dry run never submits or reserves a transfer.

Small chunks are not a guarantee against exchange holds. Each withdrawal has its own fee and minimum, so splitting can increase fees. The legacy fee-based size cap is retained as an additional upper bound; it is not evidence that an exchange will avoid reviewing a transfer.

### Telegram

Open **Notifications**, create a bot with [@BotFather](https://t.me/BotFather), and paste its token. Send `/start` to your bot, click **Find my chat**, and select your private chat. Save and use **Send test message**, then enable automatic alerts. You can enter a numeric chat ID or a channel username manually.

Alerts include the first accepted chunk in a burst, completion summaries grouped by exchange and asset over roughly one minute, and prompt held/failed/cancelled/unknown alerts. Completion means the exchange reports completion; wallet receipt is not independently checked. Notification delivery never resubmits a withdrawal. Alerts and their retry state survive restarts. Telegram rate limits are respected. A lost Telegram response can result in a duplicate alert on retry.

Enabling starts with future status changes. Disabling or changing the recipient/token clears queued events. Moby must be running and online to send alerts. The bot token uses the same encryption mechanism as API credentials and is never returned by the API. Back up `moby.db` and `.env` together.

### Build and verify

Use Node 22 (`.nvmrc`). `npm run test:run` rebuilds native modules for Node before running regression tests. `npm run build` creates clean `dist/ui` and `dist/server` directories. `npm run test:smoke` starts the production server with an empty temporary profile and verifies UI serving and authentication. `npm run electron:build:linux -- --publish never` builds the desktop release and rebuilds native modules for Electron.

Tests cover withdrawal races, uncertainty, cancellations, caps, stop/dry-run behavior, fill deduplication across exchanges, restart boundaries, balance-reconciliation races, session renewal, UI recovery, Telegram queuing, and manual withdrawal review. No tests use live exchange credentials or send real withdrawals.

### Remaining work

The 1.3.2 update below adds a fee budget and extended-outage alerts. An explicit opt-in import for fills executed while the app was closed remains future work. Other exchange adapters still deserve the same depth of protocol testing as Kraken.

Version 1.3.1 left wallet SDK and desktop dependency advisories for compatibility work. Version 1.3.2 resolves the reported advisories; this is not a comprehensive security audit.

## Dashboard and monitoring update (1.3.2)

The Overview puts withdrawal problems, active chunks, and per-asset waiting reasons first. It distinguishes pause, simulation, holds, retry delays, cooldowns, limits, and incomplete configuration. The pending counter counts assets with pending fills. Navigation remains at the top in smaller windows; pausing no longer reopens onboarding. Account balances can be expanded and switched between configured exchanges. Amounts retain up to eight decimal places, with full values available in details/tooltips; progress bars expose numeric values to assistive technology.

The Withdrawals tab includes searchable, paginated history with exchange/status filters. Expand a row for its network, fee, destination, reference, timestamps, and transaction ID; identifiers can be copied. New jobs preserve the quoted fee and destination address at submission. Old records show unavailable details as unrecorded instead of inventing them. Orders refresh every 15 seconds while visible; status and balance freshness are shown separately. Requests stop when their view closes and do not overlap normal polling.

### Fee budget

Configuration → Global Settings has an optional **24-hour fee budget (USD)**. It defaults to no limit. Moby reserves the quoted USD fee in the same database transaction that reserves the withdrawal amount, across all exchanges. The rolling window uses the request creation time and survives restarts. Accepted cancellations and unknown outcomes keep their fee reservation; a confirmed non-submission releases it. A higher reported fee increases the amount counted. Fees for requests created over 24 hours ago leave the budget window even if the exchange has not completed them.

USD fees are estimates at quote time (some adapters use USD stablecoin quote markets). The budget gates submissions; it cannot guarantee the fees ultimately charged by an exchange. Kraken additionally receives the quoted fee ceiling. Missing fee prices, or recent older jobs without fee records, pause budget-controlled submissions until the missing entries age out of the window. The Overview shows unpriced counts; blanking the budget disables this optional limit. Asset dialogs show a cached chunk-fee estimate and an optional total-amount preview. Mixed networks do not borrow one another's fee/minimum preview.

### Health alerts

Existing Telegram recipients and tokens are preserved. When automatic alerts are enabled, **connection and delay alerts** default to a 5-minute outage delay and a 30-minute stalled-withdrawal/idle-queue delay. Adjust these or disable health alerts in Notifications. Brief outages do not notify. One alert is queued per outage episode or stalled job, with a recovery message when the exchange reconnects and catch-up is healthy. Pausing or dry-run mode suspends idle-queue detection. Already submitted withdrawals are still monitored while paused. Delivery retries and deduplication survive restarts. Moby must be running to detect problems, and messages wait while Telegram is unreachable; it cannot report its own shutdown.

### Dependency and release verification

Electron is updated to [44.3.0](https://github.com/electron/electron/releases/tag/v44.3.0), Stellar SDK to [17.0.1](https://github.com/stellar/js-stellar-sdk/releases/tag/v17.0.1), and sharp to 0.35.4. Terra's full legacy SDK and Solana's full network SDK are no longer required solely for wallet generation. Terra Classic uses the same BIP39/BIP32 path and address format through ethers and scure; Solana uses Node's Ed25519 implementation and scure's base58 encoder, preserving its 64-byte secret-key export. Public test vectors from the previous SDKs verify compatible addresses/keys. Existing encrypted wallet records are not rewritten.

The locked dependencies report **0 npm audit vulnerabilities as of 2026-09-10**. Regression tests cover budget races, uncertain outcomes, history filtering/authentication, health-alert persistence, wallet compatibility, pause/display behavior, and polling recovery. Run `MOBY_LAYOUT_REVIEW=1 node scripts/desktop-smoke.mjs` after packaging to check the AppImage with an isolated profile and sample UI data at 1200×800 and 800×600. No test uses live exchange credentials or sends real withdrawals or Telegram messages. Multi-day real-time operation still needs a soak test.

Upgrade backups on this machine are in `~/.local/share/Moby-backups/2026-09-10-dashboard/`. Installation replaces `~/.local/bin/Moby.AppImage`; close and reopen an already running session to load the update.


## Pause, manual activity and saved queues (1.3.3)

Moby persists pending amounts in its local SQLite database. Resume now requires successful trade-history and balance checks for every enabled exchange with active credentials. A failed check leaves withdrawals paused. An interrupted resume request or another Pause cannot later turn withdrawals back on. A manual pause also survives app restarts.

Each observed trade debits the asset spent (including fees paid from it or a third asset), even if the received asset or order type is not configured for sweeping. Eligible proceeds still accumulate while paused. History is processed oldest first and both sides of a fill are deduplicated atomically. Balance reconciliation can reduce pending amounts, including an asset absent from a valid full snapshot; it never increases pending based on deposits or pre-existing holdings. Invalid responses are errors, not zero balances. Concurrent account changes invalidate the snapshot.

Before each chunk, Moby catches up trades, reconciles total balances and checks funds again after preparing the quote. It waits for an asset's current withdrawal to settle before preparing another for that asset. Other assets can continue within the global limit. This conservative per-asset serialization avoids treating an unsettled withdrawal as a manual debit; configured inflight limits remain upper bounds. Funds held in open orders are included when reconciling the queue, so a temporary hold does not erase it. Relevant balance contracts: [Kraken account balance](https://docs.kraken.com/api-reference/account-data/get-account-balance), [Gemini balances](https://developer.gemini.com/rest/fund-management), [KuCoin spot account list](https://www.kucoin.com/docs-new/rest/account-info/account-funding/get-account-list-spot), and [Gate spot accounts](https://www.gate.com/docs/developers/apiv4/en/#list-spot-trading-accounts).

After handling funds yourself, pause and use **Clear queued amounts…** on Overview to review and discard amounts you no longer intend to sweep. This is particularly useful for activity while Moby was closed: a balance snapshot cannot tell whether a current holding replaced an earlier one you sold. Clearing requires confirming an unchanged preview, is blocked while withdrawals are active or unresolved, and retains wallets, configuration, history and cumulative wallet totals. A persisted cutoff prevents delayed fills from re-adding the cleared queue; newer fills can accumulate normally. Clearing leaves withdrawals paused.

Already submitted transfers can still complete while paused or closed. Moby cannot make a remote balance check and withdrawal atomic with manual exchange activity, so an exchange can still reject a transfer if funds change immediately after a check. New regression coverage uses mocked exchanges and isolated databases; no real funds are moved.

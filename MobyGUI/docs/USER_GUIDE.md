# Moby User Guide

Moby monitors eligible order fills while it runs, accumulates received assets, and submits withdrawals in configured chunks to saved exchange destinations. Kraken is the currently supported exchange.

## Install and sign in

Use a trusted build from [Godswildones/Moby](https://github.com/Godswildones/Moby/releases), when available. On Linux, make the downloaded AppImage executable and launch it. On first launch, create a dashboard username and password. Desktop data is stored locally; the desktop server listens on loopback.

The running version appears beside **Moby** at the top of the dashboard. After replacing the installed AppImage, fully quit and reopen the app to use the updated version.

### Building from source

Use Node.js 22 LTS and the native build prerequisites for your platform (a C/C++ compiler, Python, and the platform SDK). From your checkout:

```sh
cd MobyGUI
npm ci
npm run build
npx electron-builder --linux AppImage --x64 --publish never
```

The Linux artifact is written to `release/`. For Windows or macOS, build on that platform with `npm run electron:build:win` or `npm run electron:build:mac`. Native dependencies must match the runtime: the desktop packaging hook rebuilds them for Electron. For server development, `npm run dev` rebuilds them for your local Node.js.

## Connect Kraken

Create a dedicated API key in Kraken and add it in Moby's API Keys section. Enable:

| Permission | Used for |
| --- | --- |
| Query Funds | Balance checks and withdrawal monitoring |
| Query Open Orders & Trades | Open orders shown in the dashboard |
| Query Closed Orders & Trades | Fill history and recovery from connection interruptions |
| Withdraw Funds | Withdrawal destinations, quotes, and submissions |
| WebSocket interface | Live authenticated fill notifications |

See Kraken's [API key setup instructions](https://support.kraken.com/articles/how-to-create-an-api-key-on-kraken-pro), [trade history permissions](https://docs.kraken.com/api-reference/account-data/get-trades-history), and [WebSocket token requirements](https://docs.kraken.com/api-reference/trading/get-websockets-token). Moby does not place or cancel trading orders, so those trading permissions are unnecessary.

Add and approve withdrawal addresses in Kraken first, then sync them in Configuration and select them for the assets you want swept. A wallet generated in Moby is not automatically registered as an exchange withdrawal destination. Verify the complete address, network, and any required destination tag or memo on both sides.

## Configure withdrawals

Start in **dry-run mode**. Review these settings for each asset before allowing real withdrawals:

| Setting | Behavior |
| --- | --- |
| Threshold | Queued amount needed before attempting a withdrawal |
| Reserve | Amount to retain on the exchange |
| Destination keys | Saved exchange destinations, rotated when more than one is selected |
| Chunk size and maximum | Size of each withdrawal attempt, subject to available funds and exchange limits |
| Priority | Lower numbers are processed first |
| Cooldown | Delay between withdrawals for an asset |
| Per-wallet caps | Limits accumulated withdrawals to a destination |
| Rolling fee budget | Optional USD limit for withdrawal fees over 24 hours |

Minimums, fees, reserves, and available funds can prevent a configured chunk from being sent. When the fee budget is enabled and a necessary price is unavailable, Moby waits. Small chunks still incur fees and can still be held by an exchange; chunking does not guarantee faster approval.

After checking dry-run activity, test one small real withdrawal and confirm receipt at the destination. Keep Moby running to continue monitoring and submitting transfers.

## Pause, resume, and restart

Moby keeps an internal SQLite database of detected fills, queued amounts, and withdrawal jobs.

- **Pause withdrawals** stops new submissions. Monitoring continues while the app runs, so eligible fills can still add to the queue. Already submitted withdrawals can complete.
- **Resume withdrawals** checks exchange balances before enabling submissions. Selling an asset or withdrawing manually reduces what remains available, and Moby lowers queued amounts accordingly. It will not increase the queue merely because you deposit funds or already have an exchange balance. A failed balance check leaves withdrawals paused.
- **Clear queued amounts…** discards the accumulated withdrawal queue. First pause and wait for active withdrawals to resolve. Review and confirm the preview. Settings, wallets, and job history remain; later eligible fills can accumulate again.
- **Closing the app** stops monitoring. Queues and job history survive, but fills that occur while Moby is closed are not automatically added on restart. Each run begins a new monitoring period. A queue saved before closing can still contain available funds, so review it before resuming.
- **Connection interruptions during a run** are recovered through recent trade history for that run. Duplicate fills are ignored. Reconcile also compares queued amounts against current balances.

Moby cannot always infer which particular funds you intended to keep after other trading. If you want a clean starting point after selling and withdrawing to your bank, clear the queue while paused. Bank withdrawals are performed through the exchange; Moby's configured destinations are cryptocurrency addresses.

## Monitor activity and notifications

Overview shows connectivity, queued assets, cooldowns, fees, and withdrawal progress. History shows exchange references, destination addresses when available, transaction IDs, and reported fees.

A held withdrawal continues to be checked. An uncertain submission is retained for review rather than automatically sent again. Check its exchange reference and account withdrawal history before resolving it; requesting cancellation does not prove it has been cancelled.

In Notifications, configure an optional Telegram bot and chat. Use the test-message button to check delivery. Alerts cover withdrawal starts, completions, problems, and prolonged connection or withdrawal delays. They do not include API credentials or wallet recovery secrets.

## Generated wallets

Wallets can generate and store wallets for the supported blockchains. Set a unique wallet password of at least eight characters; a long, unique passphrase is preferable. This password is separate from your dashboard login.

Unlocking identifies the wallet by its name, chain, and full address. Secrets are cleared from the dialog on focus loss, screen lock/suspend events, or 60 seconds without interaction. This locks wallet views while background withdrawal monitoring continues.

Deleting a wallet requires its wallet password and confirmation that you have tested its backup. Deletion removes local recovery information; it does not move funds or remove the saved address from Kraken.

Avoid copying recovery information when clipboard history or clipboard sync is enabled. Desktop Moby clears its clipboard copy after 30 seconds, or on a screen-lock/suspend event, only if it still matches what Moby copied. Browser clearing is best effort and may be denied by browser permissions. Neither mode can erase a clipboard manager's history or copies already synced elsewhere.

Existing wallet ciphertext remains readable. Successfully unlocking an older wallet upgrades both its private key and recovery phrase to the new versioned encryption together. New password verifiers use the full password, including bytes beyond the old bcrypt limit. If an old vault contains wallets created with different password suffixes, each can still be recovered with its original full password; Moby retains the legacy verifier until one password successfully decrypts every wallet. Do not discard the original passwords or backups.

## Backups and recovery

| Item | Protects / contains | Recovery requirement |
| --- | --- | --- |
| Dashboard login password | Access to the application | Your local account credentials |
| Wallet password | Generated private keys and recovery phrases | The original full wallet password; it cannot be recovered from `.env` |
| `.env` encryption key | Stored exchange API credentials and Telegram credentials | The matching `.env` file |
| `moby.db` | Encrypted wallets, account settings, queue, and withdrawal history | The database plus the appropriate passwords/keys above |

Before funding a generated wallet, back up its recovery information securely and verify that your chosen recovery software reproduces the **same address on the same chain**. Recovery formats vary: some chains expose private keys, others also offer a mnemonic; a private key is not interchangeable with a seed phrase. In particular, XRP's displayed private key is not an XRP family seed, and Cardano's displayed extended root key is not a mnemonic.

To back up the app:

1. Pause new withdrawals and review outstanding jobs.
2. Fully quit Moby and wait for the process to exit.
3. Copy `moby.db` and `.env` together into protected offline storage. Keep the wallet password separately and safely. On Unix, use a private backup directory and owner-only file permissions.
4. Retain a backup made before upgrading. Once a wallet is upgraded, an older Moby version may not understand its new ciphertext.

Do not copy only `moby.db` while Moby is running: recent changes can still be in its SQLite WAL file. For a backup without shutting down, use SQLite's supported online backup operation and preserve the matching `.env` file. Do not manually remove WAL files.

To restore, fully quit Moby, preserve the current data first, and restore the matching backup files to the data directory using the same or newer compatible app version. Restoring an old database also restores old withdrawal state: keep withdrawals paused and reconcile with the exchange before resuming. Test wallet recovery without enabling withdrawals. Moby has no wallet-password reset that can recover encrypted keys without the original password.

## Data locations

| Platform | Desktop data directory |
| --- | --- |
| Linux | `~/.config/Moby/` |
| macOS | `~/Library/Application Support/Moby/` |
| Windows | `%APPDATA%/Moby/` |

Configuration is stored in the database. Custom server deployments can override the data paths. On Unix, Moby creates private database/key files and restricts the desktop data directory to the current user.

## Troubleshooting

If withdrawals are waiting, check pause/dry-run state, eligible fills, the threshold, exchange minimums, reserves, cooldowns, caps, fee budget, and active or held withdrawals for that asset. Reconcile can refresh trade history for the current run and check balances.

If password attempts are temporarily blocked, wait for the displayed delay. Wallet endpoints share the same limit, and restarting the app does not reset it. An unreadable legacy wallet may need the exact original password, including any suffix beyond 72 bytes.

For GitHub access after the repository transfer, the repository URL is `https://github.com/Godswildones/Moby.git`. Check `git remote -v` and make sure the branch's upstream points to that repository.

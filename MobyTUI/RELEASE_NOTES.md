MobyTUI is the Linux terminal version of Moby. Download the archive for your CPU and its matching SHA-256 file; Rust is not required.

Version 0.2.8 fixes pieces of the whale repeating near the water during the launch animation in Kitty-compatible terminals. Each image cell retains explicit coordinates when waves overlap it or the whale moves, including at screen edges. This is a display-only change; an existing worker can keep running.

Version 0.2.7 adds settlement validation for Kraken synthetic spot fills reported as explicit `BASE/QUOTE` pairs, such as `XLM/USDC`, without a native market listing. Both assets must be known to Kraken metadata, and linked trade ledgers must match the assets, direction, volume, cost and fees before funds can be queued. Synthetic order placement remains unsupported; Moby does not invent market limits or infer unknown compact pair names. Synthetic handling is covered by offline fixtures, not a live fill test.

The Omarchy companion can edit an asset's shared cooldown while paused. The new `moby config cooldown ASSET SECONDS --expect CONFIG_DIGEST` command changes timing without resetting fill monitoring, queues or wallet rotation. Cooldowns are rechecked before recording a withdrawal, shared by all fills for the same asset, and retained across restarts.

Version 0.2.6 fixes order refreshes and fill reconciliation stopping when an order's pair is missing from the current market metadata. Those orders retain Kraken's original pair name. Recognized compact display aliases are accepted only when unambiguous; actual fills and order placement still require validated pair metadata. Unresolved fill errors now identify the affected pair.

- Monitor Kraken fills and withdraw received crypto in configured chunks, with cooldowns, rotating approved wallets, reserves and fee limits.
- Use a terminal dashboard and a shared JSON command line for local agents.
- Store one encrypted Kraken key per named account; unlock through hidden terminal prompts.
- Recover monitoring with WebSocket reconnects and REST/ledger catch-up. Keep queues and submission history in SQLite.
- Receive optional Telegram alerts and use an isolated paper account with `moby --demo`.
- Follow the included README for key permissions, wallet selection and first-run setup. Withdrawals start paused and require explicit Resume.

Linux x86_64 and ARM64 packages include a static executable, documentation, generic examples and build metadata. They contain no developer account data or credentials.

This is an early release. Automated checks use offline exchange fixtures; one user-run market buy and automatic withdrawal has completed on Kraken. Long-running exchange reliability has not yet been established. Smaller withdrawals can still be held by Kraken and incur fees. GUI and TUI workers do not coordinate: use only one active withdrawal engine for a given account.

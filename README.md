# Moby

Moby monitors order fills and helps move received assets to your own wallets in configured withdrawal chunks. This repository contains two separate applications:

| Project | Status | Stack | Start here |
| --- | --- | --- | --- |
| **[MobyGUI](MobyGUI/)** | Existing desktop app, v1.3.4; Kraken withdrawals | Electron, React, TypeScript | [Desktop guide](MobyGUI/docs/USER_GUIDE.md) |
| **[MobyTUI](MobyTUI/)** | v0.2.8; Kraken automation, agent CLI + isolated paper mode | Rust, Ratatui, SQLite | [Terminal guide](MobyTUI/README.md) |

The optional **[Omarchy companion](moby-plugin/)** adds a whale to the desktop bar with a Moby status dropdown, confirmed pause/resume controls, per-asset cooldown settings and terminal configuration shortcuts. It connects to the TUI's worker and keeps account data out of the plugin.

## Desktop app

The desktop source, build tools, tests, and documentation live in `MobyGUI/`. Its product name, installed data location, and version are unchanged by the repository split.

```sh
cd MobyGUI
npm ci
npm run electron:build:linux
```

See the [desktop README](MobyGUI/README.md) for exchange setup, wallet security, backups, and pause/restart behavior. Existing releases are on [GitHub](https://github.com/GodsWildOnes/Moby/releases).

## Terminal app

The terminal command is `moby`; its source lives in `MobyTUI/`. Start with the **[new-user README](MobyTUI/README.md)** for downloading a Linux executable, setting up Kraken, choosing wallets and enabling withdrawal rules. Users of a compiled release do not need Rust installed. TUI releases use `tui-v…` tags, separate from the desktop app's `v…` releases.

For development, build from the repository root with Rust 1.90 or newer:

```sh
cargo build --release --locked -p moby-tui
./target/release/moby
```

`moby` starts the background worker if needed, asks you to create or unlock your encrypted vault, and opens the dashboard. Run the same command to reopen it; an already unlocked worker does not ask for the password again. Users of a prebuilt Linux executable do not need Rust installed.

Useful commands:

```sh
./target/release/moby --help
./target/release/moby --demo
./target/release/moby key set
./target/release/moby --account second
./target/release/moby accounts
./target/release/moby status --json
./target/release/moby lock
./target/release/moby stop
```

The worker owns the database, encrypted vault, and queue. The TUI and command-line clients, including local coding agents, connect to that same worker. Quitting the dashboard or closing its terminal leaves the background worker running. A worker restart or reboot requires unlocking again. `moby --account NAME` creates or reopens another account with its own vault, worker and data; plain `moby` uses `main`. `moby watch` remains an alias for opening the app; `moby run` is available for foreground/tmux operation. `moby --demo` opens a separate paper account with its own worker, database and rules; it never loads real credentials or changes the configured account.

**The Rust terminal app supports encrypted named Kraken accounts, agent order commands, fill monitoring with REST/WebSocket recovery, and configurable chunked withdrawals.** Withdrawals start paused. Use **7 Watch rules → E** to configure matching fills, verified destinations, chunks, cooldowns, reserves and fee caps; **N** sets up optional Telegram alerts; balances and orders refresh automatically. `moby --demo` remains completely separate. Automated tests use offline fixtures; a user-run market buy and automatic withdrawal has also completed on Kraken. See the [detailed user guide](MobyTUI/USER_GUIDE.md) and [release process](MobyTUI/RELEASING.md).

## Repository layout

```text
Moby/
├── MobyGUI/                 # Desktop app; npm commands run here
├── MobyTUI/                 # Rust worker, CLI, TUI, tests and examples
├── moby-plugin/             # Omarchy bar companion for the TUI worker
├── Cargo.toml               # Rust workspace
├── Cargo.lock               # Reproducible Rust dependency versions
└── .github/workflows/       # Separate GUI/TUI packaging and project checks
```

The applications have separate dependencies, runtime data, and release versions. They do not yet share an execution engine. Do not run two independent live withdrawal engines against the same exchange account.

## Development checks

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm --prefix MobyGUI run test:run
npm --prefix MobyGUI run build
npm --prefix MobyGUI run test:smoke
```

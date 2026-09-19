# Moby for the Omarchy bar

A whale in your bar, with a quick dropdown for the **running MobyTUI worker**. This companion lives alongside `MobyGUI/` and `MobyTUI/` in the same repository. It uses Moby's normal command interface; it is not another exchange client or withdrawal engine.

## What it shows

- Worker/withdrawal state: watching, sending, paused, locked, recovering or unavailable.
- WebSocket and REST health, Telegram delivery status, and the selected live/paper account.
- Queued assets, active sends and transfers needing review.
- Recent withdrawals with the recipient amount, fee and status.
- A Rules tab showing chunk sizes, withdrawal minimums, cooldowns and wallet counts.

The bar shows a monochrome vector whale using Omarchy's standard icon size, spacing and theme foreground color. Hover for the account and worker status. The dropdown uses the theme's colors with a nearly opaque background for readability. Amounts remain decimal strings; amounts for different assets are never added together. The dropdown omits wallet addresses and credentials.

## Install from this repository

Requires an installed `moby` executable (MobyTUI v0.2.7 / status protocol 8), Omarchy's Quickshell plugin system, and Python 3 for the installer. You do not need Rust to run the plugin or a compiled Moby release.

From the Moby repository root:

```sh
python3 moby-plugin/install.py --dry-run
python3 moby-plugin/install.py --enable
```

This copies only the plugin's runtime files to `~/.config/omarchy/plugins/godswildones.moby/`. Existing plugin files and `shell.json` are backed up under `~/.local/state/moby-plugin/backups/` before changes. Re-run to install local updates; no shell restart is normally needed.

If an update keeps showing an older version of the dropdown, run `omarchy restart shell` to clear the shell's QML cache. This restarts the desktop shell, not Moby's worker.

Omarchy's `plugin add <git-url>` expects a manifest at the **repository root**. Because this plugin is a subfolder in Moby, use this installer rather than pointing `plugin add` at the entire Moby repository. A standalone distribution can be added later without moving development out of this repo.

Click the whale to open the dropdown. Right-click or **F** rereads local status. **O** opens Moby, **Esc** closes the panel, left/right switches tabs and up/down scrolls.

```sh
omarchy-shell shell toggle godswildones.moby
omarchy-shell godswildones.moby rules
omarchy bar move godswildones.moby --section right
omarchy plugin disable godswildones.moby
```

The toggle command can be assigned to an Omarchy keyboard shortcut of your choice. Installing the plugin does not create or replace a keybinding.

## Configure the companion

Use the widget's settings in Omarchy, or the bar command:

```sh
omarchy bar set godswildones.moby account main
omarchy bar set godswildones.moby showAmounts false --json
omarchy bar set godswildones.moby demo true --json
omarchy bar set godswildones.moby refreshSeconds 5 --json
```

Set `demo` back to `false` for the live account. `account` is a Moby profile name, such as `main` or `second`; it does not create an exchange account. Every read and action carries the same profile, paper/live selection and optional custom data root.

If `moby` is not on the shell's PATH, set an absolute executable path:

```sh
omarchy bar set godswildones.moby executable /home/YOU/.local/bin/moby
# Only if your worker uses a custom root:
omarchy bar set godswildones.moby stateDir /your/private/moby-root
```

Executable paths and arguments are passed as separate process arguments, not shell commands. Do not enter API keys, passwords or tokens in widget settings.

## Manage Moby

**Open Moby** starts/reopens the terminal dashboard. Passwords and keys stay in its existing hidden terminal prompts. Loading the plugin itself never starts, unlocks or resumes the worker.

**Pause / Resume** asks for confirmation naming the selected account. Resume can enable real withdrawals under that account's existing rules. Confirmations default to Cancel, are invalidated when the worker/rules/queue changes, and are refused when status is stale. Pausing does not cancel requests already sent to Kraken, stop fill monitoring, or block independent order commands.

On **Rules**, each asset has a **Set Cooldown** button. Pause withdrawals and wait for active sends to settle, enter 1–86400 seconds, then save. All fills receiving that asset share one queue and one cooldown across its wallets; another order does not create an overlapping timer. Different assets retain independent cooldowns. Timing edits preserve queued amounts, fill history and the last submission time, and leave withdrawals paused. A changed configuration invalidates the editor rather than overwriting another edit.

**Edit rules** opens Moby's full terminal editor. It is enabled only while unlocked and paused, with fresh wallet data and no active transfers. **Telegram setup** opens the existing hidden-token terminal flow.

Action messages clear after eight seconds. The status above them reflects the worker's current state, including REST catch-up after resume or reconnect.

The first version does not place/cancel orders, unlock credentials inside the panel, alter queues, retry uncertain transfers or edit databases. Open Moby for full details and recovery.

## Refresh and privacy

While open, the panel reads `moby status --json` every 5 seconds by default; while closed it reads every 30 seconds or slower. These are local cached reads and make **no additional Kraken requests**. Moby owns WebSocket reconnects, REST polling, SQLite and credentials. A dead worker or failed read clears the display; it is never presented as an empty healthy account. A healthy REST fallback can still monitor fills if WebSocket disconnects.

The plugin saves no account snapshots, databases, passwords or keys to disk. Widget preferences live in Omarchy's normal configuration. Account data stays in Moby's own private state directory. Hiding amounts also hides detailed warning text that could contain amounts; it affects presentation and is not a security boundary against other software running as your OS user.

## Development checks

```sh
omarchy plugin validate moby-plugin
node moby-plugin/tests/model.test.cjs
python3 moby-plugin/tests/qml-check.py
unshare -Urn sh -c 'ip link set lo up && python3 moby-plugin/tests/service-check.py'
```

The model checks cover stale/wrong-account snapshots, locked-data redaction, exact amounts and argument construction. QML checks use the installed Omarchy API. The service check runs real QML/CLI pause and resume only against a disposable paper worker in an isolated network namespace. It requires a compiled `target/release/moby`. Do not exercise financial controls against a live account as a development test.

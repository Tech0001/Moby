#!/usr/bin/env python3
"""Install this repo's plugin subfolder without copying the Moby checkout or data."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
PLUGIN_ID = "godswildones.moby"
FILES = ("manifest.json", "Widget.qml", "WhaleIcon.qml", "CooldownEditor.qml", "Service.qml", "Model.js", "assets/whale.png", "README.md")


def install(enable, dry_run):
    config = Path.home() / ".config/omarchy"
    destination = config / "plugins" / PLUGIN_ID
    if dry_run:
        print(f"Destination: {destination}\nFiles: {', '.join(FILES)}\nEnable: {enable}")
        return
    subprocess.run(["omarchy", "plugin", "validate", str(ROOT)], check=True)
    if destination.is_symlink():
        raise SystemExit("Refusing to replace a symlinked plugin directory.")
    if destination.exists():
        manifest = destination / "manifest.json"
        if not manifest.is_file() or json.loads(manifest.read_text()).get("id") != PLUGIN_ID:
            raise SystemExit("Existing destination is not the Moby plugin; nothing changed.")
    config.mkdir(parents=True, exist_ok=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    backups = Path.home() / ".local/state/moby-plugin/backups" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backups.mkdir(parents=True, mode=0o700)
    shell_config = config / "shell.json"
    if shell_config.is_file():
        shutil.copy2(shell_config, backups / "shell.json")
        (backups / "shell.json").chmod(0o600)
    # Stage outside the plugin discovery directory to avoid duplicate IDs.
    with tempfile.TemporaryDirectory(prefix=".moby-install-", dir=config) as temporary:
        staged = Path(temporary) / PLUGIN_ID
        staged.mkdir()
        for name in FILES:
            source = ROOT / name
            if source.is_symlink() or not source.is_file():
                raise SystemExit(f"Expected a regular plugin file: {name}")
            target = staged / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o644)
        subprocess.run(["omarchy", "plugin", "validate", str(staged)], check=True)
        old = backups / PLUGIN_ID
        if destination.exists():
            shutil.move(str(destination), old)
        try:
            staged.rename(destination)
        except OSError:
            if old.exists():
                shutil.move(str(old), destination)
            raise
    subprocess.run(["omarchy-shell", "shell", "rescanPlugins"], check=True)
    if enable:
        subprocess.run(["omarchy", "plugin", "enable", PLUGIN_ID, "--section", "right"], check=True)
    print(f"Installed {destination}\nBackup: {backups}")
    if not enable:
        print(f"Enable with: omarchy plugin enable {PLUGIN_ID}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enable", action="store_true", help="also add the whale widget to the right of the bar")
    parser.add_argument("--dry-run", action="store_true", help="show the file list without changing anything")
    args = parser.parse_args()
    install(args.enable, args.dry_run)

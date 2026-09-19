#!/usr/bin/env python3
"""Exercise the real CLI/TUI in a Linux PTY, with disposable credentials only."""
import errno
import fcntl
import json
import hashlib
import socket
import sqlite3
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import copy
import contextlib
import socketserver
import threading

if any(name != "lo" for _, name in socket.if_nameindex()):
    raise SystemExit("Run this test with loopback only: unshare -Urn sh -c 'ip link set lo up && python3 MobyTUI/scripts/smoke-launch.py target/release/moby'")

BIN = str(pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "target/release/moby").resolve())
PASSWORD = "smoke-test-only passphrase"
API_KEY = "smoke-test-only-api-key"
API_SECRET = "smoke-test-only-api-secret"
TELEGRAM_TOKEN = "123456:smoke-test-only-telegram-token"


class Terminal:
    def __init__(self, profile, *args):
        self.output = b""
        self.pid, self.fd = pty.fork()
        self.status = None
        if self.pid == 0:
            os.environ["TERM"] = "xterm-256color"
            os.execv(BIN, [BIN, "--state-dir", str(profile), *args])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))

    def read(self, timeout=0.05):
        if self.fd is not None and select.select([self.fd], [], [], timeout)[0]:
            try:
                self.output += os.read(self.fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise

    def wait_for(self, text, timeout=15):
        needle = text.encode()
        deadline = time.monotonic() + timeout
        while needle not in self.output and time.monotonic() < deadline:
            self.read()
        assert needle in self.output, f"terminal never displayed {text!r}"
        self.assert_hidden()
        output = self.output
        self.output = b""
        return output

    def send(self, text):
        os.write(self.fd, text.encode())

    def assert_hidden(self):
        for secret in (PASSWORD, API_KEY, API_SECRET, TELEGRAM_TOKEN):
            assert secret.encode() not in self.output, "terminal echoed a test secret"

    def wait_exit(self, expected=0):
        deadline = time.monotonic() + 10
        while self.status is None and time.monotonic() < deadline:
            self.read()
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.status = os.waitstatus_to_exitcode(status)
        assert self.status is not None, "terminal client did not exit"
        if expected is not None:
            assert self.status == expected, f"client exited with {self.status}"
        self.assert_hidden()

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.status is None:
            self.wait_exit(expected=None)


@contextlib.contextmanager
def editor_fixture(root, snapshot):
    """Supply a fresh wallet snapshot over IPC; no exchange or real credentials."""
    state = copy.deepcopy(snapshot)
    state["account_status"]["busy"] = False
    state["account_status"]["refresh"]["wallets"]["stale"] = False
    state["account_status"]["sync_error"] = None
    state["account_status"]["wallets_updated_at"] = int(time.time())
    directory = root / "account"
    directory.mkdir(parents=True, mode=0o700)
    root.chmod(0o700)
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            request = json.loads(self.rfile.readline())
            if request["command"] == "configure_watch":
                state["account_status"]["live"]["config"] = request["config"]
            else:
                assert request["command"] == "status"
            self.wfile.write((json.dumps({"ok": True, "message": "Fixture state", "state": state}) + "\n").encode())
    with socketserver.UnixStreamServer(str(directory / "worker.sock"), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            yield state
        finally:
            server.shutdown()
            thread.join()


def smoke(profile):
    terminals = []

    def terminal(*args):
        client = Terminal(profile, *args)
        terminals.append(client)
        return client

    def cli(*args):
        output = subprocess.run([BIN, "--state-dir", str(profile), "--json", *args],
                                capture_output=True, timeout=15, check=True)
        return json.loads(output.stdout)

    def dashboard():
        return terminal("--no-animation", "--text-icons")

    try:
        first = dashboard()
        first.wait_for("New password:")
        first.send(PASSWORD + "\r")
        first.wait_for("Confirm password:")
        first.send(PASSWORD + "\r")
        first.wait_for("MOBY")
        state = cli("status")["state"]
        pid = state["worker_pid"]
        assert state["vault"]["state"] == "unlocked"
        first.send("q")
        first.wait_exit()
        assert cli("status")["state"]["worker_pid"] == pid

        # Plain moby reopens without another password or another worker.
        second = dashboard()
        second.wait_for("MOBY")
        assert cli("status")["state"]["worker_pid"] == pid
        cli("lock")
        second.send("u")
        second.wait_for("Password:")
        second.send("incorrect-password\r")
        second.wait_for("incorrect password or damaged vault")
        second.send(PASSWORD + "\r")
        second.wait_for("MOBY")
        # Closing the terminal itself (SIGHUP) must leave the worker alive.
        second.close()
        assert cli("status")["state"]["worker_pid"] == pid

        entry = dashboard()
        entry.wait_for("MOBY")
        # Ratatui redraws only changed cells, so assert the action's result
        # rather than looking for contiguous footer text in the ANSI stream.
        entry.send("6e")
        entry.wait_for("Kraken API key:")
        entry.send(API_KEY + "\r")
        entry.wait_for("Kraken API secret:")
        entry.send(API_SECRET + "\r")
        entry.wait_for("MOBY")
        entry.send("n")
        entry.wait_for("Telegram bot token:")
        entry.send(TELEGRAM_TOKEN + "\r")
        entry.wait_for("Numeric chat ID")
        entry.send("-123456\r")
        entry.wait_for("MOBY")
        assert cli("telegram", "status")["data"]["enabled"] is True
        assert cli("telegram", "disable")["data"]["enabled"] is False
        entry.send("q")
        entry.wait_exit()
        assert cli("key", "list")["state"]["vault"]["credentials"] == ["account"]

        cli("stop")
        # Seed a disposable wallet cache, not an exchange account. The namespace
        # guard above prevents the configured monitor from reaching production.
        fingerprint = hashlib.sha256(len(API_KEY.encode()).to_bytes(8, "big") + API_KEY.encode() + API_SECRET.encode()).hexdigest()
        wallet = {"id": "ABTEST1-TEST2-TEST33", "name": "Fixture destination", "address": "fixture-address", "memo": None,
                  "assets": ["BTC"], "network": "Bitcoin", "verified": True, "source": "kraken", "rule": None,
                  "methods": [{"id": "d4ec4d52-b159-428e-ba64-f45455a978a1", "asset": "BTC", "network": "Bitcoin", "minimum": "1", "maximum": "100"}]}
        with sqlite3.connect(profile / "account" / "state.sqlite3") as db:
            db.execute("INSERT INTO meta(key,value) VALUES('account',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (json.dumps({"wallets": [wallet], "wallets_fingerprint": fingerprint, "wallets_updated_at": int(time.time())}),))
        third = dashboard()
        third.wait_for("Password:")
        restarted = cli("status")["state"]
        assert restarted["worker_pid"] != pid
        assert restarted["vault"]["state"] == "locked"
        third.send(PASSWORD + "\r")
        third.wait_for("MOBY")
        assert cli("status")["state"]["vault"]["credentials"] == ["account"]
        third.send("7e")
        third.wait_for("wallet data is stale")
        snapshot = cli("status")["state"]
        assert snapshot["account_status"]["refresh"]["wallets"]["stale"] is True
        # Exercise the whole editor against a fresh IPC fixture. A persisted
        # wallet snapshot alone must no longer pass the real worker's freshness gate.
        editor_root = profile / "editor-fixture"
        with editor_fixture(editor_root, snapshot) as fixture_state:
            editor = Terminal(editor_root, "config", "edit")
            terminals.append(editor)
            prompts = [
                ("Asset received from fills", "BTC"),
                ("Destination numbers", "1"),
                ("Watch enabled?", "yes"),
                ("Order types,", "market,limit,stop-loss,trailing-stop"),
                ("Sides,", "buy"),
                ("Pairs BASE/QUOTE", "BTC/USD"),
                ("Order IDs,", "*"),
                ("Withdrawal minimum after fees (Enter accepts; you may raise it) [1]", "0.5"),
                ("Withdrawal minimum after fees (Enter accepts; you may raise it) [1]", ""),
                ("Maximum gross amount", "0.5"),
                ("Maximum gross amount", "10"),
                ("Amount to leave", "2"),
                ("Maximum fee per chunk", "1"),
                ("Maximum fee as percent", "10"),
                ("Rolling 24-hour fee budget", "2"),
                ("Cooldown between chunks", "60"),
                ("Type save", "save"),
            ]
            rejected_amounts = 0
            for label, value in prompts:
                output = editor.wait_for(label)
                if b"Enter at least 1. Nothing has been saved." in output:
                    rejected_amounts += 1
                editor.send(value + "\r")
            assert rejected_amounts == 2, "editor accepted a setting below Kraken's minimum"
            editor.wait_exit()
            assert fixture_state["paused"] is True
            configured = fixture_state["account_status"]["live"]["config"]["rules"][0]
            assert configured["chunk"] == "10" and configured["cooldown_seconds"] == 60
            assert configured["minimum"] == "1", "blank minimum did not use Kraken's value"
            assert configured["pairs"] == ["BTC/USD"] and configured["destinations"][0]["address"] == "fixture-address"
        third.send("q")
        third.wait_exit()

        cli("lock")
        cancelled = dashboard()
        cancelled.wait_for("Password:")
        cancelled.send("\x03")
        cancelled.wait_exit(expected=None)
        attrs = termios.tcgetattr(cancelled.fd)
        assert attrs[3] & termios.ECHO and attrs[3] & termios.ICANON, "cancel left terminal in raw mode"
        assert cli("status")["state"]["vault"]["state"] == "locked"

        # Demo is available even with a locked configured account, with no prompt.
        paper = terminal("--demo", "--no-animation", "--text-icons")
        paper.wait_for("PAPER")
        paper.send("56q")
        paper.wait_exit()
        assert cli("--demo", "status")["state"]["vault"]["state"] == "not_required"
        assert cli("status")["state"]["vault"]["state"] == "locked"
        assert not (profile / "paper" / "vault.json").exists()

        # Named-account startup must pass the name to its detached worker.
        named = terminal("--account", "second", "key", "set")
        named.wait_for("New password:")
        named.send(PASSWORD + "\r")
        named.wait_for("Confirm password:")
        named.send(PASSWORD + "\r")
        named.wait_for("Kraken API key:")
        named.send(API_KEY + "\r")
        named.wait_for("Kraken API secret:")
        named.send(API_SECRET + "\r")
        named.wait_exit()
        secondary = cli("--account", "second", "status")["state"]
        assert secondary["account"] == "second"
        assert secondary["vault"]["credentials"] == ["account"]
        assert cli("status")["state"]["vault"]["state"] == "locked"
        reopen = terminal("--account", "second", "--no-animation", "--text-icons")
        reopen.wait_for("MOBY")
        reopen.send("q")
        reopen.wait_exit()
        assert cli("--account", "second", "status")["state"]["worker_pid"] == secondary["worker_pid"]
        assert cli("accounts")["accounts"] == ["main", "second"]

        for path in profile.rglob("*"):
            if path.is_file():
                data = path.read_bytes()
                for secret in (PASSWORD, API_KEY, API_SECRET, TELEGRAM_TOKEN):
                    assert secret.encode() not in data, f"test secret leaked to {path.name}"
        print("PTY smoke passed: setup, reopen, unlock, hidden key/Telegram entry, terminal close, restart, Ctrl-C, separate paper mode, named accounts, watch-rule editor.")
    finally:
        for client in terminals:
            if client.status is None:
                os.kill(client.pid, signal.SIGKILL)
            client.close()
        for flags in ([], ["--demo"], ["--account", "second"]):
            subprocess.run([BIN, "--state-dir", str(profile), *flags, "stop", "--json"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)


with tempfile.TemporaryDirectory(prefix="moby-launch-") as directory:
    smoke(pathlib.Path(directory) / "profile")

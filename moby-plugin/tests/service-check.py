"""Exercise actual QML/CLI controls only against a disposable offline paper worker."""
import json
import copy
import os
from pathlib import Path
import socket
import socketserver
import subprocess
import tempfile
import threading
import time

if any(name != "lo" for _, name in socket.if_nameindex()):
    raise SystemExit("Run in a network namespace with loopback only.")
root = Path(__file__).resolve().parents[1]
binary = root.parent / "target/release/moby"
with tempfile.TemporaryDirectory(prefix="moby-plugin-service-") as directory:
    temp = Path(directory)
    profile = temp / "profile"
    base = [str(binary), "--state-dir", str(profile), "--demo"]
    subprocess.run(base + ["start", "--json"], capture_output=True, check=True, timeout=10)
    config = {"executable": str(binary), "stateDir": str(profile), "demo": True, "refreshSeconds": 3}
    harness = temp / "shell.qml"
    harness.write_text('''import QtQuick
import Quickshell
import Quickshell.Io
import "''' + root.as_uri() + '''" as Moby
ShellRoot {
  property int phase: 0
  property int attempts: 0
  Moby.Service { id: service; settings: ''' + json.dumps(config) + '''; panelOpen: true }
  Timer {
    interval: 100; running: true; repeat: true
    onTriggered: {
      if (++attempts > 220) { console.error("CHECK_FAILED phase " + phase + ": " + service.error); Qt.quit(); return; }
      if (service.busy) return;
      if (phase === 0 && service.view.canResume) {
        if (service.control("resume", "outdated-confirmation")) { console.error("CHECK_FAILED stale confirmation accepted"); Qt.quit(); return; }
        phase = 1;
      } else if (phase === 1 && service.view.canResume) {
        if (service.control("resume", service.view.confirmationKey)) phase = 2;
      } else if (phase === 2 && service.view.canPause) {
        if (service.control("pause", service.view.confirmationKey)) phase = 3;
      } else if (phase === 3 && service.view.canResume) {
        if (service.notice) { phase = 4; return; }
      } else if (phase === 4 && !service.notice) {
        console.log("MOBY_PLUGIN_SERVICE_PASS"); Qt.quit();
      }
    }
  }
}''')
    try:
        try:
            result = subprocess.run(["quickshell", "--no-color", "-p", str(harness)], capture_output=True,
                                    text=True, timeout=25, env={**os.environ, "QT_QPA_PLATFORM": "offscreen"})
        except subprocess.TimeoutExpired as error:
            raise SystemExit((error.stdout or b"").decode() + (error.stderr or b"").decode())
        logs = result.stdout + result.stderr
        if "MOBY_PLUGIN_SERVICE_PASS" not in logs or "CHECK_FAILED" in logs:
            raise SystemExit(logs)
        final = json.loads(subprocess.check_output(base + ["status", "--json"]))["state"]
        assert final["paused"] and final["mode"] == "paper"
        assert not (profile / "account").exists(), "paper test touched an account profile"
        print("QML service passed: local reads, stale confirmations, paper resume/pause and expiring action messages.")

        # A credential-free IPC fixture exercises the actual CLI arguments for
        # cooldown edits. Rust tests separately enforce the worker's write guards.
        fixture = copy.deepcopy(final)
        fixture.update(mode="account", paused=True, account="main")
        fixture["vault"]["state"] = "unlocked"
        fixture["account_status"]["live"].update(
            config=json.loads((root.parent / "MobyTUI/examples/watch-config.json").read_text()),
            config_digest="a" * 64, rest_updated_at=int(time.time()),
            caught_up_through=int(time.time()), websocket="Connected")
        mock_root = temp / "fixture"
        mock_account = mock_root / "account"
        mock_account.mkdir(parents=True, mode=0o700)
        changes = []
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                request = json.loads(self.rfile.readline())
                if request["command"] == "set_cooldown":
                    changes.append(request)
                    assert request == {"command":"set_cooldown", "asset":"USDC", "seconds":120, "expected_config":"a"*64}
                    fixture["account_status"]["live"]["config"]["rules"][0]["cooldown_seconds"] = 120
                    fixture["account_status"]["live"]["config_digest"] = "b"*64
                else:
                    assert request["command"] == "status"
                fixture["observed_at"] = int(time.time())
                self.wfile.write((json.dumps({"ok":True,"message":"Fixture result","state":fixture})+"\n").encode())
        with socketserver.UnixStreamServer(str(mock_account / "worker.sock"), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval":0.05}, daemon=True)
            thread.start()
            harness.write_text('''import QtQuick
import Quickshell
import "''' + root.as_uri() + '''" as Moby
ShellRoot {
  property int phase: 0
  property int attempts: 0
  Moby.Service { id: service; settings: ''' + json.dumps({"executable":str(binary),"stateDir":str(mock_root)}) + '''; panelOpen: true }
  Timer {
    interval: 100; running: true; repeat: true
    onTriggered: {
      if (++attempts > 150) { console.error("CHECK_FAILED cooldown " + service.error + service.notice); Qt.quit(); return; }
      if (service.busy) return;
      if (phase === 0 && service.view.canEditCooldown) {
        if (service.setCooldown("USDC",120,"stale-editor")) { console.error("CHECK_FAILED stale edit accepted"); Qt.quit(); return; }
        phase = 1;
      } else if (phase === 1 && service.view.canEditCooldown) {
        if (service.setCooldown("USDC",120,service.view.cooldownKey)) phase = 2;
      } else if (phase === 2 && service.view.rules[0].cooldown === "120" && service.view.paused) {
        console.log("MOBY_PLUGIN_COOLDOWN_PASS"); Qt.quit();
      }
    }
  }
}''')
            try:
                result = subprocess.run(["quickshell","--no-color","-p",str(harness)], capture_output=True,
                                        text=True, timeout=20, env={**os.environ,"QT_QPA_PLATFORM":"offscreen"})
                logs = result.stdout + result.stderr
                assert "MOBY_PLUGIN_COOLDOWN_PASS" in logs and "CHECK_FAILED" not in logs, logs
                assert len(changes) == 1
                assert not (mock_account / "vault.json").exists()
                print("Cooldown service passed: QML → real CLI → isolated IPC, stale edit refused, exactly one save, still paused.")
            finally:
                server.shutdown()
                thread.join()
    finally:
        subprocess.run(base + ["stop", "--json"], capture_output=True, timeout=10)

import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Item {
    id: root
    property var settings: ({})
    property bool panelOpen: false
    property bool pollingEnabled: true // Isolated UI tests can supply a fixture.
    property var response: null
    property double now: Date.now() / 1000
    property string error: ""
    property string notice: ""
    property string probeKey: ""
    property string actionKey: ""
    property string actionKind: ""
    property bool probeExpired: false
    property bool actionExpired: false
    readonly property var config: {
        try { return Model.options(settings, Quickshell.env("HOME") || ""); }
        catch (_) { return null; }
    }
    readonly property string configKey: JSON.stringify(config)
    readonly property bool busy: action.running
    readonly property var view: {
        if (!config) return Model.empty("Check settings", "Use a valid account, executable and data path.");
        if (error) return Model.empty("Unavailable", error);
        return Model.project(response, config, now);
    }

    function refresh() {
        if (!pollingEnabled || !config || probe.running || action.running) return;
        probeKey = configKey;
        probeExpired = false;
        probe.command = Model.command(config, "status");
        probe.running = true;
        probeTimeout.restart();
    }

    function accept(text, code) {
        var parsed;
        try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
        now = Date.now() / 1000;
        if (code !== 0 || !parsed || parsed.ok !== true || !parsed.state) {
            response = null;
            error = "Moby did not return a current status. Open it to start or unlock the selected account.";
            return false;
        }
        error = "";
        response = parsed;
        return true;
    }

    function control(verb, expectedKey) {
        if (!config) return false;
        var current = Model.project(response, config, Date.now() / 1000);
        if (error || action.running || probe.running || expectedKey !== current.confirmationKey
            || !(verb === "pause" ? current.canPause : verb === "resume" && current.canResume)) {
            notice = "Status changed or is refreshing. Review the current account and try again.";
            refresh();
            return false;
        }
        actionKey = configKey;
        actionKind = verb;
        actionExpired = false;
        action.command = Model.command(config, verb);
        action.running = true;
        actionTimeout.restart();
        notice = "Waiting for Moby…";
        return true;
    }

    function setCooldown(seconds, expectedKey) {
        if (!config) return false;
        var current = Model.project(response, config, Date.now() / 1000);
        if (error || action.running || probe.running || !current.canEditCooldown
            || expectedKey !== current.cooldownKey) {
            notice = "Pause withdrawals and refresh before changing this cooldown.";
            refresh();
            return false;
        }
        try { action.command = Model.cooldownCommand(config, seconds, current.configDigest); }
        catch (_) { notice = "Enter a cooldown from 1 to 86400 seconds."; return false; }
        actionKey = configKey;
        actionKind = "cooldown";
        actionExpired = false;
        action.running = true;
        actionTimeout.restart();
        notice = "Saving account cooldown…";
        return true;
    }

    function openTerminal(destination) {
        if (!config || (destination === "rules" && !view.canEdit)) return;
        Quickshell.execDetached(Model.terminalCommand(config, destination));
    }

    onConfigKeyChanged: {
        response = null;
        notice = "";
        error = "";
        Qt.callLater(refresh);
    }
    onPanelOpenChanged: if (panelOpen) { now = Date.now() / 1000; refresh(); }
    Component.onCompleted: refresh()
    onNoticeChanged: {
        if (notice) noticeTimeout.restart();
        else noticeTimeout.stop();
    }

    Timer { id: noticeTimeout; interval: 8000; onTriggered: root.notice = "" }

    Timer {
        interval: root.config ? (root.panelOpen ? root.config.refreshSeconds : Math.max(30, root.config.refreshSeconds)) * 1000 : 30000
        running: root.pollingEnabled
        repeat: true
        onTriggered: root.refresh()
    }
    Timer { interval: 1000; running: true; repeat: true; onTriggered: root.now = Date.now() / 1000 }
    Timer {
        id: probeTimeout
        interval: 5000
        onTriggered: {
            root.probeExpired = true;
            probe.running = false;
            root.response = null;
            root.error = "Cannot reach Moby. Check the executable path and open the selected account.";
        }
    }
    Timer {
        id: actionTimeout
        interval: 8000
        onTriggered: {
            root.actionExpired = true;
            action.running = false;
            root.response = null;
            root.notice = "No command result received. Check Moby before trying again.";
            Qt.callLater(root.refresh);
        }
    }
    Process {
        id: probe
        stdout: StdioCollector { id: probeOutput; waitForEnd: true }
        stderr: StdioCollector { waitForEnd: true }
        onExited: function(code) {
            probeTimeout.stop();
            if (!root.probeExpired && root.probeKey === root.configKey) root.accept(probeOutput.text, code);
            else if (root.probeKey !== root.configKey) Qt.callLater(root.refresh);
        }
    }
    Process {
        id: action
        stdout: StdioCollector { id: actionOutput; waitForEnd: true }
        stderr: StdioCollector { waitForEnd: true }
        onExited: function(code) {
            actionTimeout.stop();
            if (!root.actionExpired && root.actionKey === root.configKey) {
                if (root.accept(actionOutput.text, code)) root.notice = root.actionKind === "cooldown"
                    ? "Cooldown saved; withdrawals remain paused."
                    : root.view.paused ? "Withdrawals paused; monitoring continues." : "Withdrawals enabled; Moby reconciles before sending.";
                else {
                    var result;
                    try { result = JSON.parse(actionOutput.text); } catch (_) { result = null; }
                    root.notice = result && result.ok === false ? Model.text(result.message)
                        : "Moby did not confirm the change. Check the account in its terminal.";
                }
            }
            Qt.callLater(root.refresh);
        }
    }
}

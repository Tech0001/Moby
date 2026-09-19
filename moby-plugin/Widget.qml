import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell.Io
import qs.Commons
import qs.Ui as Ui
import "Model.js" as Model

Ui.Panel {
    id: root
    moduleName: "godswildones.moby"
    ipcTarget: "godswildones.moby"
    manageIpc: false
    implicitWidth: barButton.implicitWidth
    implicitHeight: barButton.implicitHeight

    property int page: 0
    property string pendingVerb: ""
    property string pendingKey: ""
    property string cooldownKey: ""
    // Used only by the offline preview harness; never a plugin setting.
    property var previewResponse: null
    readonly property var status: service.view
    readonly property bool showAmounts: setting("showAmounts", true) !== false
    readonly property color statusColor: status.tone === "urgent" ? Color.urgent : status.tone === "accent" ? Color.accent : Color.muted
    readonly property string profileLabel: (service.config ? service.config.account : "Check settings") + (service.config && service.config.demo ? " · Paper account" : " · Live account")

    function askControl(verb) {
        if (service.busy || !(verb === "pause" ? status.canPause : status.canResume)) return;
        pendingVerb = verb;
        pendingKey = status.confirmationKey;
        confirm.selectedIndex = 0;
        confirm.opened = true;
    }
    function launch(destination) {
        service.openTerminal(destination);
        root.close();
    }
    function editCooldown(rule) {
        if (!root.status.canEditCooldown || service.busy) return;
        cooldownEditor.asset = rule.asset;
        cooldownEditor.currentSeconds = Number(rule.cooldown);
        root.cooldownKey = root.status.cooldownKey;
        service.notice = "";
        cooldownEditor.opened = true;
    }
    onOpenedChanged: {
        confirm.opened = false;
        cooldownEditor.opened = false;
        if (opened) scroller.contentY = 0;
    }
    onPreviewResponseChanged: if (previewResponse) service.response = previewResponse

    Service {
        id: service
        settings: root.settings
        panelOpen: root.opened
        pollingEnabled: root.previewResponse === null
        onViewChanged: {
            if (confirm.opened && root.pendingKey !== view.confirmationKey) confirm.opened = false;
            if (cooldownEditor.opened && (!view.canEditCooldown || root.cooldownKey !== view.cooldownKey)) {
                cooldownEditor.opened = false;
                notice = "Account or rules changed. Reopen the cooldown editor.";
                keys.forceActiveFocus();
            }
        }
    }

    // IPC only opens views; financial controls require the visible confirmation.
    IpcHandler {
        target: root.ipcTarget
        function open(): void { root.open(); }
        function close(): void { root.close(); }
        function show(): void { root.open(); }
        function hide(): void { root.close(); }
        function toggle(): void { root.toggle(); }
        function rules(): void { root.page = 1; root.open(); }
        function overview(): void { root.page = 0; root.open(); }
    }

    Ui.BarIconButton {
        id: barButton
        anchors.fill: parent
        bar: root.bar
        tooltipText: "Moby · " + root.profileLabel + "\n" + root.status.label + "\nClick for details · Right-click to reread local status"
        onPressed: function(button) {
            if (button === Qt.RightButton) service.refresh();
            else root.toggle();
        }
        iconComponent: Component {
            WhaleIcon {
                color: root.barForeground
            }
        }
    }

    Ui.KeyboardPanel {
        id: popup
        anchorItem: barButton
        owner: root
        bar: root.bar
        open: root.opened
        focusTarget: keys
        contentWidth: popup.fittedContentWidth(Style.space(430))
        contentHeight: popup.fittedContentHeight(content.implicitHeight + footer.implicitHeight + Style.space(16), Style.space(650))

        // Keep this dropdown at least 96% opaque without changing other panels.
        // Content sits inside the card's border and padding; cover its padding
        // too, while leaving the theme's border visible.
        Rectangle {
            anchors.fill: parent
            anchors.margins: -popup.padding
            z: -1
            radius: Math.max(0, Style.cornerRadius - Math.max(Border.top(popup.borderSpec), Border.right(popup.borderSpec), Border.bottom(popup.borderSpec), Border.left(popup.borderSpec)))
            readonly property color surfaceColor: Color.popups.background
            readonly property real fillAlpha: surfaceColor.a >= 0.96 ? 0 : (0.96 - surfaceColor.a) / (1 - surfaceColor.a)
            color: Qt.rgba(surfaceColor.r, surfaceColor.g, surfaceColor.b, fillAlpha)
        }

        Ui.PanelKeyCatcher {
            id: keys
            anchors.fill: parent
            blocked: cooldownEditor.opened
            onCloseRequested: {
                if (confirm.opened) confirm.opened = false;
                else root.close();
            }
            onTabRequested: function(direction) {
                if (confirm.opened) confirm.selectedIndex = 1 - confirm.selectedIndex;
                else root.switchPanel(direction);
            }
            onActivateRequested: {
                if (!confirm.opened) return;
                if (confirm.selectedIndex === 0) confirm.opened = false;
                else confirm.confirmed();
            }
            onMoveRequested: function(dx, dy) {
                if (confirm.opened) { if (dx) confirm.selectedIndex = 1 - confirm.selectedIndex; return; }
                if (dx) { root.page = root.page === 0 ? 1 : 0; scroller.contentY = 0; }
                if (dy) scroller.contentY = Math.max(0, Math.min(scroller.contentHeight - scroller.height, scroller.contentY + dy * Style.space(40)));
            }
            onTextKey: function(key) {
                if (confirm.opened) return;
                var k = key.toLowerCase();
                if (k === "o") root.launch("open");
                else if (k === "f") service.refresh();
                else if (k === "p") root.askControl("pause");
                else if (k === "r") root.askControl("resume");
            }

            Flickable {
                id: scroller
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.bottom: footer.top
                anchors.bottomMargin: Style.space(12)
                contentHeight: content.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

                Column {
                    id: content
                    width: scroller.width
                    spacing: Style.space(12)

                    Ui.PanelHero {
                        width: parent.width
                        title: "Moby"
                        meta: root.profileLabel
                        detail: root.status.version ? "v" + root.status.version : ""
                        iconComponent: Component {
                            Image { source: "assets/whale.png"; width: Style.space(58); height: Style.space(38); fillMode: Image.PreserveAspectFit; smooth: true }
                        }
                    }
                    Column {
                        width: parent.width; spacing: Style.space(4)
                        Text {
                            text: root.status.label
                            textFormat: Text.PlainText
                            color: root.statusColor
                            font.family: Style.font.family; font.pixelSize: Style.font.title; font.bold: true
                        }
                        Text {
                            width: parent.width; wrapMode: Text.WordWrap; textFormat: Text.PlainText
                            text: root.status.detail
                            color: Color.foreground; opacity: 0.75
                            font.family: Style.font.family; font.pixelSize: Style.font.caption
                        }
                    }
                    RowLayout {
                        width: parent.width
                        Repeater {
                            model: [{label: "Queued assets", value: root.status.queuedCount}, {label: "Active sends", value: root.status.activeCount}, {label: "Review", value: root.status.reviewCount}]
                            delegate: Column {
                                required property var modelData
                                Layout.fillWidth: true; spacing: Style.space(3)
                                Text { text: root.status.unlocked ? String(modelData.value) : "—"; color: Color.foreground; font.family: Style.font.family; font.pixelSize: Style.font.title }
                                Text { text: modelData.label; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption }
                            }
                        }
                    }
                    Text {
                        width: parent.width; wrapMode: Text.WordWrap; textFormat: Text.PlainText
                        text: "WebSocket: " + root.status.ws + "   ·   REST: " + root.status.rest + "\nTelegram: " + root.status.telegram
                        color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption
                    }
                    Text {
                        visible: !!root.status.warning
                        width: parent.width; wrapMode: Text.WordWrap; textFormat: Text.PlainText
                        text: root.showAmounts ? root.status.warning : "A rule or service needs attention. Open Moby for details."
                        color: Color.urgent; font.family: Style.font.family; font.pixelSize: Style.font.caption
                    }
                    RowLayout {
                        width: parent.width
                        Ui.Button { text: "Overview"; selected: root.page === 0; Layout.fillWidth: true; onClicked: { root.page = 0; scroller.contentY = 0; } }
                        Ui.Button { text: "Rules · " + root.status.ruleCount; selected: root.page === 1; Layout.fillWidth: true; onClicked: { root.page = 1; scroller.contentY = 0; } }
                    }
                    Ui.PanelSeparator {}

                    Column {
                        visible: root.page === 0
                        width: parent.width; spacing: Style.space(10)
                        Text { text: "WAITING TO SEND"; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: true }
                        Text {
                            visible: root.status.queues.length === 0
                            text: root.status.unlocked ? "No assets queued." : "Unlock Moby to see your account."
                            color: Color.foreground; opacity: 0.7; font.family: Style.font.family; font.pixelSize: Style.font.body
                        }
                        Repeater {
                            model: root.status.queues.slice(0, 4)
                            delegate: Column {
                                required property var modelData
                                width: parent.width; spacing: Style.space(3)
                                Text { width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere; text: modelData.asset + "   " + Model.money(modelData.amount, root.showAmounts); color: Color.foreground; font.family: Style.font.family; font.pixelSize: Style.font.body }
                                Text { visible: !!modelData.blocked; width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WordWrap; text: root.showAmounts ? modelData.blocked : "Waiting; open Moby for details."; color: Color.urgent; font.family: Style.font.family; font.pixelSize: Style.font.caption }
                            }
                        }
                        Text { visible: root.status.queues.length > 4; text: "+ " + (root.status.queues.length - 4) + " more in Moby"; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption }
                        Ui.PanelSeparator {}
                        Text { text: "RECENT WITHDRAWALS"; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: true }
                        Text { visible: !root.status.transfers.length; text: root.status.unlocked ? "No withdrawals yet." : "—"; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.body }
                        Repeater {
                            model: root.status.transfers.slice(0, 3)
                            delegate: Column {
                                required property var modelData
                                width: parent.width; spacing: Style.space(3)
                                Text { width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere; text: modelData.asset + "   " + Model.money(modelData.amount, root.showAmounts) + "   ·   " + modelData.status; color: Color.foreground; font.family: Style.font.family; font.pixelSize: Style.font.body }
                                Text { width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WordWrap; text: Model.age(modelData.at, service.now) + " · fee " + Model.money(modelData.fee, root.showAmounts) + " " + modelData.asset; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption }
                            }
                        }
                    }

                    Column {
                        visible: root.page === 1
                        width: parent.width; spacing: Style.space(12)
                        Text { visible: root.status.rules.length === 0; width: parent.width; text: "Open Moby to choose wallets and add withdrawal rules."; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.body }
                        Repeater {
                            model: root.status.rules
                            delegate: Column {
                                required property var modelData
                                width: parent.width; spacing: Style.space(4)
                                Text { text: modelData.asset + (modelData.enabled ? "" : " · disabled"); textFormat: Text.PlainText; color: Color.foreground; font.family: Style.font.family; font.pixelSize: Style.font.body; font.bold: true }
                                Text { width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WordWrap; text: "Chunk " + Model.money(modelData.chunk, root.showAmounts) + " · minimum " + Model.money(modelData.minimum, root.showAmounts) + " " + modelData.asset + "\n" + modelData.cooldown + "s cooldown · " + modelData.destinations + " wallet(s)"; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption }
                                RowLayout {
                                    width: parent.width
                                    Text { Layout.fillWidth: true; text: modelData.cooldownRemaining > 0 ? "Cooldown: " + modelData.cooldownRemaining + "s left" : "Shared by all " + modelData.asset + " fills"; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption }
                                    Ui.Button { text: "Set Cooldown"; fontSize: Style.font.caption; verticalPadding: Style.space(4); enabled: root.status.canEditCooldown && !service.busy; onClicked: root.editCooldown(modelData) }
                                }
                                Ui.PanelSeparator {}
                            }
                        }
                    }
                }
            }

            Column {
                id: footer
                anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
                spacing: Style.space(8)
                Text {
                    visible: !!service.notice
                    width: parent.width; wrapMode: Text.WordWrap; textFormat: Text.PlainText
                    text: service.notice; color: Color.accent; font.family: Style.font.family; font.pixelSize: Style.font.caption
                }
                RowLayout {
                    width: parent.width
                    Ui.Button { text: root.status.unlocked ? "Open Moby" : "Open / unlock"; Layout.fillWidth: true; bordered: true; enabled: !!service.config; onClicked: root.launch("open") }
                    Ui.Button { text: root.status.paused ? "Resume…" : "Pause…"; Layout.fillWidth: true; bordered: true; enabled: !service.busy && (root.status.canPause || root.status.canResume); onClicked: root.askControl(root.status.paused ? "resume" : "pause") }
                    Ui.Button { text: "Refresh"; enabled: !service.busy; onClicked: service.refresh() }
                }
                RowLayout {
                    visible: root.page === 1
                    width: parent.width
                    Ui.Button { text: "Edit rules"; Layout.fillWidth: true; enabled: root.status.canEdit && !service.busy; onClicked: root.launch("rules") }
                    Ui.Button { text: "Telegram setup"; Layout.fillWidth: true; enabled: root.status.unlocked && !root.status.paper; onClicked: root.launch("telegram") }
                }
                Text {
                    width: parent.width; wrapMode: Text.WordWrap
                    text: root.page === 1 ? "Pause and let sends settle to change cooldowns here. Edit rules opens full setup in Moby." : "O open · F reread local status · Esc close"
                    color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption
                }
            }

            Ui.ConfirmDialog {
                id: confirm
                anchors.fill: parent
                background: Color.popups.background
                confirmText: root.pendingVerb === "resume" ? "Resume" : "Pause"
                message: root.pendingVerb === "resume"
                    ? "Resume withdrawals for " + root.profileLabel + "?\n" + root.status.ruleCount + " enabled rule(s), " + root.status.queuedCount + " queued asset(s). " + (root.status.paper ? "Paper mode simulates transfers only." : "Moby will reconcile and may send real funds to configured wallets.")
                    : "Pause withdrawals for " + root.profileLabel + "?\nMonitoring continues. Already submitted transfers may still complete."
                onCanceled: opened = false
                onConfirmed: {
                    service.control(root.pendingVerb, root.pendingKey);
                    opened = false;
                }
            }
            CooldownEditor {
                id: cooldownEditor
                anchors.fill: parent
                profile: root.profileLabel
                feedback: service.notice
                onCanceled: { opened = false; keys.forceActiveFocus(); }
                onSaved: function(seconds) {
                    if (service.setCooldown(asset, seconds, root.cooldownKey)) opened = false;
                    if (!opened) keys.forceActiveFocus();
                }
            }
        }
    }
}

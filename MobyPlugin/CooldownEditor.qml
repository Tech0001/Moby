import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui as Ui

Item {
    id: root
    property bool opened: false
    property string profile: ""
    property string feedback: ""
    property int currentSeconds: 60
    signal canceled()
    signal saved(int seconds)
    visible: opened

    function submit() {
        if (seconds.acceptableInput && Number(seconds.text) !== currentSeconds)
            saved(Number(seconds.text));
    }
    onOpenedChanged: if (opened) {
        seconds.text = String(currentSeconds);
        Qt.callLater(function() { seconds.forceActiveFocus(); seconds.selectAll(); });
    }
    Keys.onEscapePressed: { root.canceled(); event.accepted = true; }

    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(Color.background.r, Color.background.g, Color.background.b, 0.92)
        MouseArea { anchors.fill: parent; onClicked: root.canceled() }
    }
    Rectangle {
        anchors.centerIn: parent
        width: Math.min(parent.width, Style.space(370))
        height: form.implicitHeight + Style.space(32)
        color: Color.background
        border.color: Color.accent
        border.width: Style.normalBorderWidth
        radius: Style.cornerRadius
        MouseArea { anchors.fill: parent }
        ColumnLayout {
            id: form
            anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
            anchors.margins: Style.space(16)
            spacing: Style.space(12)
            Text { text: "Set Cooldown"; color: Color.foreground; font.family: Style.font.family; font.pixelSize: Style.font.body; font.bold: true }
            Text { text: root.profile; textFormat: Text.PlainText; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption }
            Text {
                Layout.fillWidth: true; wrapMode: Text.WordWrap
                text: "Seconds between withdrawals. All assets, orders and wallets in this account share this one timer."
                color: Color.foreground; font.family: Style.font.family; font.pixelSize: Style.font.caption
            }
            Ui.TextField {
                id: seconds
                Layout.fillWidth: true
                font.pixelSize: Style.font.caption
                placeholderText: "1–86400 seconds"
                validator: IntValidator { bottom: 1; top: 86400 }
                inputMethodHints: Qt.ImhDigitsOnly
                onAccepted: root.submit()
            }
            Text {
                Layout.fillWidth: true; wrapMode: Text.WordWrap
                text: "Current: " + root.currentSeconds + "s. Saving preserves the queue and last withdrawal time. Withdrawals stay paused."
                color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption
            }
            Text { visible: !!root.feedback; Layout.fillWidth: true; wrapMode: Text.WordWrap; textFormat: Text.PlainText; text: root.feedback; color: Color.accent; font.family: Style.font.family; font.pixelSize: Style.font.caption }
            RowLayout {
                Layout.fillWidth: true
                Ui.Button { text: "Cancel"; fontSize: Style.font.caption; Layout.fillWidth: true; onClicked: root.canceled() }
                Ui.Button { text: "Set Cooldown"; fontSize: Style.font.caption; Layout.fillWidth: true; bordered: true; enabled: seconds.acceptableInput && Number(seconds.text) !== root.currentSeconds; onClicked: root.submit() }
            }
        }
    }
}

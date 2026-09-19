"""Resolve the installed Omarchy QML API without loading the desktop shell."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
shell = Path(os.environ.get("OMARCHY_PATH", "/usr/share/omarchy")) / "shell"
lint = shutil.which("qmllint") or "/usr/lib/qt6/bin/qmllint"
with tempfile.TemporaryDirectory(prefix="moby-plugin-qml-") as directory:
    imports = Path(directory) / "qs"
    imports.mkdir()
    for module in ("Commons", "Ui"):
        (imports / module).symlink_to(shell / module, target_is_directory=True)
    result = subprocess.run([lint, "-I", directory, "--json", "-", *(str(file) for file in sorted(root.glob("*.qml")))],
                            capture_output=True, text=True, timeout=45)
    report = json.loads(result.stdout)
    # Omarchy declares these theme/bar objects as QtObject, so qmllint loses
    # their dynamic members. All other unknown properties remain failures.
    dynamic_members = {f'Member "{name}" not found on type "QObject"'
                       for name in ("vertical", "family", "body", "caption", "title", "background", "iconCanvas")}
    failures = [f'{file["filename"]}:{warning.get("line", 0)}: {warning["message"]}'
                for file in report["files"] for warning in file["warnings"]
                if warning["type"] == "error" or (warning.get("id") in
                ("import", "unresolved-type", "inheritance-cycle", "required", "syntax", "missing-property")
                and warning["message"] not in dynamic_members)]
    if failures:
        raise SystemExit("\n".join(failures))
print("QML imports, types and properties checked against installed Omarchy.")

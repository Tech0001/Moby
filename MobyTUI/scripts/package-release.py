#!/usr/bin/env python3
"""Package a native, static Linux build using an explicit public-file allowlist."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]
TARGETS = {
    "x86_64-unknown-linux-musl": ("x86_64", 62),
    "aarch64-unknown-linux-musl": ("aarch64", 183),
}
DOCUMENTS = ("README.md", "USER_GUIDE.md", "AGENT_GUIDE.md", "RELEASING.md")
EXAMPLES = ("demo-plan.json", "order-request.json", "watch-config.json")


def output(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def package(args):
    version = tomllib.loads((ROOT / "MobyTUI/Cargo.toml").read_text())["package"]["version"]
    arch, machine = TARGETS[args.target]
    binary = ROOT / "target" / args.target / "release/moby"
    header = binary.read_bytes()[:20]
    if header[:6] != b"\x7fELF\x02\x01" or int.from_bytes(header[18:20], "little") != machine:
        raise ValueError("binary does not match the selected Linux architecture")
    env = {**os.environ, "LC_ALL": "C"}
    for flag, forbidden in (("-l", "INTERP"), ("-d", "NEEDED")):
        result = subprocess.check_output(["readelf", flag, str(binary)], text=True, env=env)
        if forbidden in result:
            raise ValueError("release binary must be static, without a loader or shared libraries")
    if output(str(binary), "--version") != f"moby {version}":
        raise ValueError("binary version does not match Cargo.toml; rebuild first")
    dirty = bool(output("git", "status", "--porcelain", "--untracked-files=all"))
    if dirty and not args.allow_dirty:
        raise ValueError("commit source changes before packaging; --allow-dirty is for local checks only")
    info = {
        "version": version,
        "target": args.target,
        "source_commit": output("git", "rev-parse", "HEAD"),
        "source_dirty": dirty,
    }
    destination = Path(args.output).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    name = f"moby-tui-v{version}-linux-{arch}"
    archive = destination / f"{name}.tar.gz"
    with tempfile.TemporaryDirectory(prefix="moby-package-") as temp:
        manifest = Path(temp) / "BUILD_INFO.json"
        manifest.write_text(json.dumps(info, indent=2) + "\n")
        # Never recurse over the checkout, HOME, target, or a running profile.
        files = [(binary, "moby"), (manifest, "BUILD_INFO.json")]
        files += [(ROOT / "MobyTUI" / p, p) for p in DOCUMENTS]
        files += [(ROOT / "MobyTUI/examples" / p, f"examples/{p}") for p in EXAMPLES]
        staged_archive = Path(temp) / archive.name
        with tarfile.open(staged_archive, "w:gz") as tar:
            for source, relative in files:
                if source.is_symlink() or not source.is_file():
                    raise ValueError(f"expected a regular package file: {relative}")
                entry = tar.gettarinfo(str(source), f"{name}/{relative}")
                entry.uid = entry.gid = 0
                entry.uname = entry.gname = ""
                entry.mode = 0o755 if relative == "moby" else 0o644
                with source.open("rb") as stream:
                    tar.addfile(entry, stream)
        archive.write_bytes(staged_archive.read_bytes())
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum_file = destination / f"{archive.name}.sha256"
    checksum_file.write_text(f"{checksum}  {archive.name}\n")
    print(archive)
    print(checksum_file)
    if dirty:
        print("LOCAL CHECK ONLY: BUILD_INFO.json records uncommitted source changes.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=TARGETS, required=True)
    parser.add_argument("--output", default=str(ROOT / "dist/tui"))
    parser.add_argument("--allow-dirty", action="store_true", help="local packaging checks only")
    try:
        package(parser.parse_args())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Packaging failed: {error}\n")

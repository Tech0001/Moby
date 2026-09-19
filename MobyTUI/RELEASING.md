# Distributing MobyTUI

Distribute compiled binaries as **GitHub Release assets**, not files committed to Git. The GUI uses `v…` tags; the independently versioned TUI uses **`tui-v…`** tags.

The [Release MobyTUI workflow](../.github/workflows/release-tui.yml) builds native x86_64 and aarch64 Linux executables with musl. Both builds run the Rust tests and fresh-install terminal checks in a network namespace with only loopback available. No exchange credentials are used.

## Prepare a release

1. Update `MobyTUI/Cargo.toml`, the workspace `Cargo.lock`, documentation version examples and `RELEASE_NOTES.md` as needed.
2. Commit and push the reviewed source, including the workspace and GUI/TUI directory split. Release assets must correspond to that source commit.
3. Tag that commit, for example `git tag tui-v0.2.8`, then push the tag with `git push origin tui-v0.2.8`.
4. Wait for **Release MobyTUI** to pass for both architectures. It rejects a tag that does not match the package version.
5. Review the resulting **draft prerelease** on GitHub, then publish it when ready for users. While the repository is private, only people with repository access can download it.

Running the workflow manually builds downloadable Actions artifacts without creating a release. A draft release is not visible as a normal user download until published. No installer, updater or telemetry contacts GitHub from the Moby executable.

Each archive contains only `moby`, the README/user/agent/release guides, three generic examples and `BUILD_INFO.json` with version, target and source commit. The whale artwork and SQLite are compiled in. A separate `.sha256` file verifies the archive download. There are no state directories, credentials, wallet selections, databases, sockets or logs in a package. The packager uses an explicit list of regular files rather than archiving the checkout or home directory.

## Local packaging check

On an x86_64 Linux build machine with Rust, Python 3.11+, binutils and musl development tools (`musl-tools` on Debian/Ubuntu):

```sh
rustup target add x86_64-unknown-linux-musl
CC=musl-gcc RUSTFLAGS='-C target-feature=+crt-static' \
  cargo build --release --locked -p moby-tui --target x86_64-unknown-linux-musl
unshare -Urn sh -c 'ip link set lo up && python3 MobyTUI/scripts/smoke-launch.py target/x86_64-unknown-linux-musl/release/moby'
python3 MobyTUI/scripts/package-release.py --target x86_64-unknown-linux-musl
```

Run from the repository root. For a native ARM64 build, replace `x86_64` with `aarch64`. Use the native system linker; `musl-gcc` compiles the C dependencies. The packager executes `moby --version`, so packaging requires the matching native architecture.

Files appear under `dist/tui/`, which Git ignores. Packaging checks the binary architecture, version and absence of dynamic-library dependencies. It normally refuses a dirty checkout; `--allow-dirty` is only for local packaging tests and records that fact in `BUILD_INFO.json`. Do not publish such an archive as a release of a clean source tag.

For updates, users stop existing workers, replace the binary, reopen and unlock, then explicitly resume withdrawals. Packaging and installing never copy developer account data or change a running account.

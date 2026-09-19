//! Local lifecycle and interactive unlock. No passwords in flags, env, or stdin pipes.
use anyhow::{Context, Result, bail, ensure};
use crossterm::{
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEventKind,
        KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode},
};
use std::{
    fs::{self, OpenOptions},
    io::{IsTerminal, Write},
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    ipc,
    model::{Request, Response},
    profile::{Mode, Profile},
    vault::{Secret, VaultState, validate_new_password},
};

pub fn require_terminal() -> Result<()> {
    ensure!(
        std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
        "open `moby` in an interactive terminal; automation can use `moby start --json` or `moby status --json`"
    );
    Ok(())
}

fn supported(response: Response) -> Result<Response> {
    ensure!(response.ok, "{}", response.message);
    ensure!(
        response
            .state
            .as_ref()
            .is_some_and(|s| s.protocol_version == crate::PROTOCOL_VERSION),
        "an older worker is still running; stop it in its terminal or service, then run `moby` again"
    );
    Ok(response)
}

pub async fn ensure_running(profile: &Profile) -> Result<Response> {
    let directory = &profile.directory;
    if let Ok(response) = ipc::call(directory, &Request::Status).await {
        ensure!(
            response
                .state
                .as_ref()
                .is_some_and(|s| s.mode == profile.mode.name() && s.account == profile.account),
            "worker profile mode mismatch"
        );
        return supported(response);
    }
    profile.create_directories()?;
    let directory = fs::canonicalize(directory)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("worker.log"))?;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = log.metadata()?;
    // SAFETY: geteuid has no preconditions.
    ensure!(
        metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() },
        "invalid worker log file"
    );
    log.set_permissions(fs::Permissions::from_mode(0o600))?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--state-dir")
        .arg(fs::canonicalize(&profile.root)?)
        .arg("--account")
        .arg(&profile.account)
        .arg("run")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    if profile.mode == Mode::Paper {
        command.arg("--demo");
    }
    // A new session plus closed terminal descriptors lets the worker survive
    // closing this TUI/terminal. Never fork a multithreaded Rust runtime directly.
    // SAFETY: the pre-exec closure calls only async-signal-safe setsid.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().context("start background worker")?;
    // Reap if this client remains open. The worker itself outlives this thread
    // when the client exits; the OS reparents it normally.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let ready = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Ok(response) = ipc::call(&directory, &Request::Status).await {
                return supported(response);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    if let Ok(response) = ready {
        return response;
    }
    bail!(
        "worker did not become ready; see {}",
        directory.join("worker.log").display()
    )
}

pub fn prompt_secret(prompt: &str) -> Result<Secret> {
    require_terminal()?;
    #[cfg(target_os = "linux")]
    {
        // SAFETY: PR_SET_DUMPABLE accepts a scalar, with no pointer arguments.
        ensure!(
            unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } == 0,
            "could not disable credential-client core dumps"
        );
    }
    // Use the same input machinery as the TUI so cancellation returns normally
    // and the terminal guard restores echo, including on Ctrl-C or an error.
    enable_raw_mode()?;
    struct InputGuard;
    impl Drop for InputGuard {
        fn drop(&mut self) {
            let _ = execute!(std::io::stdout(), DisableBracketedPaste);
            let _ = disable_raw_mode();
            let _ = writeln!(std::io::stdout());
        }
    }
    let _guard = InputGuard;
    execute!(std::io::stdout(), EnableBracketedPaste)?;
    print!("{prompt}");
    std::io::stdout().flush()?;
    let mut value = Secret(String::with_capacity(4096));
    loop {
        match event::read()? {
            Event::Key(key) if key.kind != KeyEventKind::Release => match key.code {
                KeyCode::Esc => bail!("entry cancelled"),
                KeyCode::Char('c' | 'd') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    bail!("entry cancelled")
                }
                KeyCode::Enter => return Ok(value),
                KeyCode::Backspace => {
                    value.0.pop();
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    value.0.zeroize()
                }
                KeyCode::Char(c)
                    if !c.is_control()
                        && !key
                            .modifiers
                            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    ensure!(value.0.len() + c.len_utf8() <= 4096, "input is too long");
                    value.0.push(c);
                }
                _ => (),
            },
            Event::Paste(text) => {
                let text = Zeroizing::new(text);
                ensure!(
                    !text.chars().any(char::is_control),
                    "paste a single line without control characters"
                );
                ensure!(value.0.len() + text.len() <= 4096, "input is too long");
                value.0.push_str(&text);
            }
            _ => (),
        }
    }
}

pub async fn unlock(directory: &Path) -> Result<Response> {
    require_terminal()?;
    let response = supported(ipc::successful(directory, &Request::Status).await?)?;
    let snapshot = response.state.as_ref().context("missing worker snapshot")?;
    let state = &snapshot.vault.state;
    let name = &snapshot.account;
    match state {
        VaultState::Unlocked | VaultState::NotRequired => return Ok(response),
        VaultState::NotConfigured => {
            eprintln!("Moby · {name} · Set up your encrypted vault");
            eprintln!(
                "Choose a passphrase of at least 8 characters. There is no password recovery."
            );
            eprintln!(
                "Your account keys stay here. Paper mode uses separate data and no real keys.\n"
            );
            loop {
                let password = prompt_secret("New password: ")?;
                if let Err(error) = validate_new_password(&password) {
                    eprintln!("{error}");
                    continue;
                }
                let confirmation = prompt_secret("Confirm password: ")?;
                if password.0 != confirmation.0 {
                    eprintln!("Passwords did not match. Try again.");
                    continue;
                }
                return ipc::successful(directory, &Request::VaultCreate { password }).await;
            }
        }
        VaultState::Locked => eprintln!("Moby · {name} · Unlock for this worker session\n"),
        VaultState::Unsupported => {
            bail!("worker does not support vault unlock; restart it with this Moby version")
        }
    }
    for _ in 0..3 {
        let password = prompt_secret("Password: ")?;
        let response = ipc::call(directory, &Request::VaultUnlock { password }).await?;
        if response.ok {
            return Ok(response);
        }
        eprintln!("{}", response.message);
    }
    bail!("vault remains locked; run `moby` to try again")
}

pub async fn set_key(directory: &Path) -> Result<Response> {
    let state = unlock(directory).await?.state.context("missing account")?;
    ensure!(state.mode == "account", "paper mode does not use API keys");
    eprintln!("Moby · {} · Kraken API key", state.account);
    eprintln!(
        "Use one key with Query Funds, query open/closed orders, create/modify orders, cancel/close orders, Withdraw Funds, Query ledger entries and WebSocket access for the full workflow."
    );
    eprintln!(
        "Leave deposit, earn and withdrawal address-management permissions off.
Saving a key does not activate live orders or withdrawals."
    );
    let api_key = prompt_secret("Kraken API key: ")?;
    let api_secret = prompt_secret("Kraken API secret: ")?;
    ipc::successful(
        directory,
        &Request::SetKey {
            api_key,
            api_secret,
        },
    )
    .await
}
pub async fn setup_telegram(directory: &Path) -> Result<Response> {
    let state = unlock(directory).await?.state.context("missing account")?;
    ensure!(
        state.mode == "account",
        "paper mode cannot send Telegram messages"
    );
    eprintln!("Moby · {} · Telegram alerts", state.account);
    eprintln!(
        "Create a bot with Telegram's @BotFather, start a chat with your bot, and get your numeric chat ID. Escape cancels. The token is stored encrypted and never returned to agents."
    );
    let token = prompt_secret("Telegram bot token: ")?;
    let chat_id = prompt_secret("Numeric chat ID (input hidden): ")?.0.clone();
    ipc::successful(directory, &Request::SetTelegram { token, chat_id }).await
}

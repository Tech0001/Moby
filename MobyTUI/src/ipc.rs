use anyhow::{Context, Result, bail, ensure};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::{Semaphore, mpsc, oneshot},
    time::timeout,
};
use zeroize::Zeroizing;

use crate::{
    account::{Account, Finished, LiveFinished},
    engine::Engine,
    model::{Request, Response, Snapshot, Wallet, now},
    profile::{Mode, Profile},
    vault::{Vault, VaultState, VaultStatus},
};

const MAX_REQUEST: u64 = 64 * 1024;
const MAX_RESPONSE: u64 = 4 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(2);

fn uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

pub fn check_directory(directory: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(directory)
        .context("worker profile does not exist; run `moby` to start it")?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "profile must be a real directory, not a symlink"
    );
    ensure!(metadata.uid() == uid(), "profile is owned by another user");
    ensure!(
        metadata.mode() & 0o077 == 0,
        "profile must be private (chmod 700 on its directory)"
    );
    Ok(())
}

pub struct WorkerGuard {
    _lock: File,
    socket: PathBuf,
}

pub fn create_directory(directory: &Path) -> Result<()> {
    if !directory.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)?;
    }
    check_directory(directory)
}

impl WorkerGuard {
    pub fn acquire(directory: &Path) -> Result<Self> {
        create_directory(directory)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("worker.lock"))?;
        lock.try_lock()
            .context("another worker already owns this profile")?;
        let socket = directory.join("worker.sock");
        ensure!(
            socket.as_os_str().len() < 104,
            "profile path is too long for a Unix socket; choose a shorter --state-dir"
        );
        // Only the lock holder may remove a socket left by a crashed worker.
        match fs::symlink_metadata(&socket) {
            Ok(metadata) => {
                use std::os::unix::fs::FileTypeExt;
                ensure!(
                    metadata.file_type().is_socket(),
                    "refusing to remove a non-socket worker.sock"
                );
                fs::remove_file(&socket)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        Ok(Self {
            _lock: lock,
            socket,
        })
    }
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket);
    }
}

async fn read_message(
    mut reader: impl AsyncRead + Unpin,
    limit: u64,
    deadline: Duration,
) -> Result<Zeroizing<Vec<u8>>> {
    let mut line = Zeroizing::new(Vec::new());
    // Zero the wire buffer too; it can contain a password. Avoid BufReader's
    // additional, non-zeroized copy of the secret request.
    timeout(deadline, async {
        let mut chunk = Zeroizing::new([0u8; 1024]);
        while line.len() as u64 <= limit {
            let n = reader.read(&mut *chunk).await?;
            if n == 0 {
                break;
            }
            if let Some(end) = chunk[..n].iter().position(|b| *b == b'\n') {
                line.extend_from_slice(&chunk[..=end]);
                break;
            }
            line.extend_from_slice(&chunk[..n]);
        }
        Ok::<_, std::io::Error>(())
    })
    .await
    .context("local request timed out")??;
    ensure!(
        line.len() as u64 <= limit,
        "local message exceeds size limit"
    );
    ensure!(line.last() == Some(&b'\n'), "incomplete local message");
    Ok(line)
}

pub async fn call(directory: &Path, request: &Request) -> Result<Response> {
    check_directory(directory)?;
    let mut stream = timeout(DEADLINE, UnixStream::connect(directory.join("worker.sock")))
        .await?
        .context("worker unavailable; run `moby` to start or reconnect")?;
    ensure!(
        stream.peer_cred()?.uid() == uid(),
        "worker is owned by another user"
    );
    let mut message = Zeroizing::new(serde_json::to_vec(request)?);
    message.push(b'\n');
    ensure!(message.len() as u64 <= MAX_REQUEST, "request is too large");
    timeout(DEADLINE, stream.write_all(&message)).await??;
    let deadline = if matches!(
        request,
        Request::VaultCreate { .. } | Request::VaultUnlock { .. }
    ) {
        Duration::from_secs(30)
    } else {
        DEADLINE
    };
    let response =
        serde_json::from_slice(&read_message(&mut stream, MAX_RESPONSE, deadline).await?)?;
    Ok(response)
}

struct Command {
    request: Request,
    reply: oneshot::Sender<Response>,
    written: oneshot::Receiver<()>,
}

async fn serve_client(mut stream: UnixStream, commands: mpsc::Sender<Command>) -> Result<()> {
    ensure!(
        stream.peer_cred()?.uid() == uid(),
        "client is owned by another user"
    );
    let request: Request =
        serde_json::from_slice(&read_message(&mut stream, MAX_REQUEST, DEADLINE).await?)?;
    let (reply, receiver) = oneshot::channel();
    let (finished, written) = oneshot::channel();
    timeout(
        DEADLINE,
        commands.send(Command {
            request,
            reply,
            written,
        }),
    )
    .await??;
    let response = timeout(Duration::from_secs(30), receiver).await??;
    let mut bytes = serde_json::to_vec(&response)?;
    bytes.push(b'\n');
    timeout(DEADLINE, stream.write_all(&bytes)).await??;
    let _ = finished.send(());
    Ok(())
}

pub async fn run(profile: &Profile) -> Result<()> {
    let directory = &profile.directory;
    profile.create_directories()?;
    let guard = WorkerGuard::acquire(directory)?;
    profile.prepare()?;
    // Credentials must not end up in a worker core dump. This is not an OS-user
    // isolation boundary; same-user code can still control this application.
    #[cfg(target_os = "linux")]
    {
        // SAFETY: PR_SET_DUMPABLE accepts the scalar 0 and no pointer arguments.
        ensure!(
            unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } == 0,
            "could not disable worker core dumps"
        );
    }
    let mut worker = if profile.mode == Mode::Paper {
        Worker {
            name: profile.account.clone(),
            paper: Some(Engine::open(directory, now())?),
            account: None,
            vault: None,
        }
    } else {
        Worker {
            name: profile.account.clone(),
            paper: None,
            account: Some(Account::open(directory)?),
            vault: Some(Vault::open(directory)?),
        }
    };
    let listener = UnixListener::bind(&guard.socket)?;
    fs::set_permissions(&guard.socket, fs::Permissions::from_mode(0o600))?;
    eprintln!(
        "Moby {} · {} · profile {}",
        env!("CARGO_PKG_VERSION"),
        profile.mode.name(),
        directory.display()
    );
    eprintln!("Open and unlock with moby. Ctrl-C stops this worker; quitting the TUI does not.");
    let (commands, mut receiver) = mpsc::channel::<Command>(32);
    let (completed_tx, mut completed_rx) = mpsc::channel::<Finished>(1);
    let (live_tx, mut live_rx) = mpsc::channel::<LiveFinished>(1);
    let (ws_tx, mut ws_rx) = mpsc::channel::<crate::live::websocket::Update>(128);
    let clients = Arc::new(Semaphore::new(16));
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = terminate.recv() => break,
            Some(command) = receiver.recv() => {
                // No concurrent state changes: pause, plan updates and scheduling all
                // pass through this loop. A client timeout never implies cancellation.
                let stop = matches!(command.request, Request::Stop);
                let response = match tokio::task::block_in_place(|| worker.handle(command.request)) {
                    Ok(response) => response,
                    Err(error) => Response { ok:false, message:error.to_string(), state:None },
                };
                if stop {
                    // A successful stop must release ownership before its reply:
                    // callers may immediately start the replacement worker.
                    drop(listener);
                    drop(worker);
                    drop(guard);
                    let _ = command.reply.send(response);
                    let _ = timeout(DEADLINE, command.written).await;
                    break;
                }
                let _ = command.reply.send(response);
            }
            _ = interval.tick() => {
                // Stop on a database/scheduler error instead of continuing with stale state.
                if let Some(engine) = &mut worker.paper {
                    engine.tick(now()).context("paper worker stopped after a scheduling error")?;
                }
                if let (Some(account),Some(vault))=(&mut worker.account,&worker.vault){
                    account.tick_notifications(vault,&worker.name)?;
                    account.tick(vault,&live_tx,&completed_tx)?;
                }
            }
            Some(finished) = live_rx.recv() => {
                if let (Some(account),Some(vault))=(&mut worker.account,&worker.vault){account.finish_live(finished,vault,&ws_tx)?;}
            }
            Some(update) = ws_rx.recv() => {
                if let Some(account)=&mut worker.account {account.websocket(update)?;}
            }
            Some(finished) = completed_rx.recv() => {
                if let (Some(account), Some(vault)) = (&mut worker.account, &worker.vault) {
                    account.finish(finished, vault)?;
                }
            }
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                if let Ok(permit) = clients.clone().try_acquire_owned() {
                    let commands = commands.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let _ = serve_client(stream, commands).await;
                    });
                }
            }
        }
    }
    eprintln!("Worker stopped; queue and pause state saved.");
    Ok(())
}

struct Worker {
    name: String,
    paper: Option<Engine>,
    account: Option<Account>,
    vault: Option<Vault>,
}
impl Worker {
    fn snapshot(&self) -> Result<Snapshot> {
        if let Some(engine) = &self.paper {
            let mut state = engine.snapshot(now())?;
            state.protocol_version = crate::PROTOCOL_VERSION;
            state.mode = "paper".into();
            state.account = self.name.clone();
            state.vault = VaultStatus {
                state: VaultState::NotRequired,
                credentials: vec![],
            };
            state.account_status.wallets = state
                .assets
                .iter()
                .map(|a| Wallet {
                    id: format!("paper-{}", a.rule.asset),
                    name: a.rule.destination.clone(),
                    address: format!("SIMULATED-{}-DESTINATION", a.rule.asset),
                    memo: None,
                    assets: vec![a.rule.asset.clone()],
                    network: "Paper network".into(),
                    verified: false,
                    source: "paper".into(),
                    rule: Some(a.rule.clone()),
                    methods: vec![],
                })
                .collect();
            return Ok(state);
        }
        let mut state = self
            .account
            .as_ref()
            .unwrap()
            .snapshot(self.vault.as_ref().unwrap())?;
        state.account = self.name.clone();
        Ok(state)
    }
    fn response(&self, message: impl Into<String>) -> Result<Response> {
        Ok(Response {
            ok: true,
            message: message.into(),
            state: Some(self.snapshot()?),
        })
    }
    fn handle(&mut self, request: Request) -> Result<Response> {
        if matches!(request, Request::Stop) {
            if let Some(account) = &mut self.account {
                account.invalidate(false)?;
            }
            if let Some(vault) = &mut self.vault {
                vault.lock();
            }
            return self.response("Worker stopped; progress saved");
        }
        if matches!(request, Request::Status) {
            return self.response("Current worker state");
        }
        if let Some(engine) = &mut self.paper {
            ensure!(
                !matches!(
                    request,
                    Request::VaultCreate { .. }
                        | Request::VaultUnlock { .. }
                        | Request::VaultLock
                        | Request::SetKey { .. }
                        | Request::CheckKey
                        | Request::RemoveKey
                        | Request::RefreshWallets
                        | Request::RefreshBalances
                ),
                "paper mode cannot store, load or use real API credentials; open moby without --demo"
            );
            let response = engine.handle(request, now())?;
            return self.response(response.message);
        }
        let vault = self.vault.as_mut().unwrap();
        let account = self.account.as_mut().unwrap();
        let message = match request {
            Request::VaultCreate { password } => {
                vault.create(password)?;
                "Account vault created and unlocked"
            }
            Request::VaultUnlock { password } => {
                vault.unlock(password)?;
                "Account vault unlocked"
            }
            Request::VaultLock => {
                vault.lock();
                account.invalidate(false)?;
                "Account vault locked"
            }
            Request::SetKey {
                api_key,
                api_secret,
            } => {
                account.check_replace_key()?;
                vault.set_credential(api_key, api_secret)?;
                account.invalidate(true)?;
                "Kraken key encrypted and saved; account data will refresh automatically"
            }
            Request::RemoveKey => {
                account.check_replace_key()?;
                vault.remove_credential()?;
                account.invalidate(true)?;
                "Account key removed"
            }
            Request::CheckKey | Request::RefreshWallets | Request::RefreshBalances => {
                let kind = match request {
                    Request::RefreshWallets => crate::kraken::ReadKind::Wallets,
                    Request::RefreshBalances => crate::kraken::ReadKind::Balances,
                    _ => crate::kraken::ReadKind::Key,
                };
                account.request_read(vault, kind)?;
                "Kraken read-only refresh queued; status and the TUI will show its result"
            }
            Request::Pause => {
                account.pause()?;
                "Withdrawals paused; monitoring continues. Dispatched requests may still complete"
            }
            Request::Resume => {
                account.resume(vault)?;
                "Withdrawals enabled; reconciling before scheduling"
            }
            Request::ConfigureWatch { config, digest } => {
                account.configure(vault, config, &digest, &self.name)?;
                "Watch rules saved; withdrawals remain paused"
            }
            Request::SetCooldown {
                seconds,
                expected_config,
            } => {
                account.set_cooldown(vault, seconds, &expected_config)?;
                "Account-wide cooldown saved; all withdrawals share one timer. Withdrawals remain paused"
            }
            Request::ClearQueue { digest } => {
                account.clear_queue(&digest)?;
                "Queued amounts cleared"
            }
            Request::RefreshOrders => {
                account.refresh_orders(vault)?;
                "Order refresh scheduled"
            }
            Request::SubmitOrder { order, digest } => {
                account.submit_order(vault, *order, &digest, &self.name)?;
                "Order request recorded; inspect order_receipts for its result"
            }
            Request::AttachWithdrawalReceipt { id, exchange_id } => {
                account.attach_receipt(&id, &exchange_id)?;
                "Receipt linked for exchange verification; no withdrawal resent"
            }
            Request::ResolveWithdrawalNotSent {
                id,
                digest,
                confirmed,
            } => {
                account.resolve_not_sent(vault, &id, &digest, confirmed)?;
                "Withdrawal recorded as not sent after user review; amount restored to queue, withdrawals remain paused"
            }
            Request::SetTelegram { token, chat_id } => {
                vault.set_telegram(token, chat_id)?;
                account.configure_telegram(true, vault, true)?;
                "Telegram alerts enabled; bot token encrypted in the vault. Use moby telegram test to send a test"
            }
            Request::EnableTelegram { enabled } => {
                account.configure_telegram(enabled, vault, false)?;
                if enabled {
                    "Telegram alerts enabled"
                } else {
                    "Telegram alerts disabled; pending messages cleared"
                }
            }
            Request::TestTelegram => {
                account.test_telegram(vault, &self.name)?;
                "Telegram test queued; moby telegram status shows delivery status"
            }
            _ => bail!(
                "this account does not run simulated events or live execution; use moby --demo for paper activity"
            ),
        };
        self.response(message)
    }
}

pub async fn successful(directory: &Path, request: &Request) -> Result<Response> {
    let response = call(directory, request).await?;
    if !response.ok {
        bail!("{}", response.message);
    }
    Ok(response)
}

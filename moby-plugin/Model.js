// Pure presentation and argv construction. Monetary amounts remain strings.
function text(value, limit) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit || 240);
}

function options(settings, home) {
    var s = settings || {};
    var account = s.account === undefined ? "main" : String(s.account);
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(account)) throw new Error("Choose a valid Moby account name in widget settings.");
    var executable = String(s.executable || "moby");
    var stateDir = String(s.stateDir || "");
    if (executable.indexOf("~/") === 0) executable = home + executable.slice(1);
    if (stateDir.indexOf("~/") === 0) stateDir = home + stateDir.slice(1);
    if (/[\x00-\x1f\x7f]/.test(executable + stateDir)) throw new Error("Executable and data paths cannot contain control characters.");
    if (executable !== "moby" && executable.charAt(0) !== "/") throw new Error("Use moby or an absolute executable path.");
    if (stateDir && stateDir.charAt(0) !== "/") throw new Error("The custom data root must be an absolute path.");
    var interval = Number(s.refreshSeconds);
    return {account: account, demo: s.demo === true, executable: executable, stateDir: stateDir,
        refreshSeconds: isFinite(interval) && interval >= 3 ? Math.min(60, Math.floor(interval)) : 5};
}

function baseCommand(config) {
    var args = [config.executable, "--account", config.account];
    if (config.stateDir) args = args.concat(["--state-dir", config.stateDir]);
    if (config.demo) args.push("--demo");
    return args;
}

function command(config, action) {
    if (["status", "pause", "resume"].indexOf(action) === -1) throw new Error("Unsupported plugin action");
    return baseCommand(config).concat([action, "--json"]);
}

function cooldownCommand(config, asset, seconds, digest) {
    if (config.demo || !/^[A-Z0-9]{1,16}$/.test(asset)
        || !Number.isInteger(seconds) || seconds < 1 || seconds > 86400
        || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid cooldown change");
    return baseCommand(config).concat(["config", "cooldown", asset, String(seconds), "--expect", digest, "--json"]);
}

function terminalCommand(config, action) {
    var args = baseCommand(config);
    if (action === "rules" && !config.demo) args = args.concat(["config", "edit"]);
    else if (action === "telegram" && !config.demo) args = args.concat(["telegram", "setup"]);
    else if (action !== "open") throw new Error("Open Moby to configure this account.");
    return ["omarchy", "launch", "terminal"].concat(args);
}

function age(at, now) {
    if (!at || at > now + 5) return "not checked";
    var seconds = Math.max(0, Math.floor(now - at));
    if (seconds < 60) return seconds + "s ago";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    return Math.floor(seconds / 3600) + "h ago";
}

function money(value, show) {
    if (!show) return "••••";
    return typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? value : "—";
}

function nonzero(value) {
    return typeof value === "string" && /^\d+(\.\d+)?$/.test(value) && /[1-9]/.test(value);
}

function empty(label, detail) {
    return {label: label || "Unavailable", detail: detail || "Open Moby to start or unlock its worker.",
        tone: "muted", connected: false, unlocked: false, paused: true, paper: false,
        queues: [], transfers: [], rules: [], ruleCount: 0, activeCount: 0, reviewCount: 0,
        queuedCount: 0, orderCount: 0, ws: "—", rest: "—", telegram: "—", version: "",
        canPause: false, canResume: false, canEdit: false, canEditCooldown: false,
        configDigest: "", cooldownKey: "", confirmationKey: "", warning: ""};
}

function project(response, config, now) {
    if (!response || response.ok !== true || !response.state) return empty();
    var s = response.state;
    if (s.protocol_version !== 8) return empty("Version mismatch", "This plugin needs Moby's version 8 status protocol.");
    if (s.account !== config.account || s.mode !== (config.demo ? "paper" : "account"))
        return empty("Wrong profile", "The returned account does not match widget settings.");
    if (!s.observed_at || s.observed_at > now + 5 || now - s.observed_at > 75)
        return empty("Stale", "The worker snapshot is old. Actions are disabled until Moby responds.");
    var v = empty();
    v.connected = true;
    v.paper = config.demo;
    v.paused = s.paused === true;
    v.version = text(s.version, 30);
    v.unlocked = !!s.vault && (s.vault.state === "unlocked" || (config.demo && s.vault.state === "not_required"));
    if (!v.unlocked) {
        v.label = s.vault && s.vault.state === "not_configured" ? "Set up Moby" : "Locked";
        v.detail = "Open Moby and enter your password in its terminal.";
        return v; // Never retain account details from a previously unlocked snapshot.
    }
    var account = s.account_status || {};
    var live = account.live || {};
    var configData = live.config || {};
    var rules = config.demo ? (s.assets || []).map(function(a) { return a.rule; }) : (configData.rules || []);
    v.rules = rules.map(function(r) {
        var queue = (live.queues || {})[r.asset] || {};
        var last = Number(queue.last_submission || 0);
        return {asset: text(r.asset, 16), enabled: r.enabled !== false, chunk: r.chunk, minimum: r.minimum,
            cooldown: text(r.cooldown_seconds, 10), destinations: config.demo ? 1 : (r.destinations || []).length,
            cooldownRemaining: last > 0 ? Math.max(0, Math.ceil(last + Number(r.cooldown_seconds) - now)) : 0};
    });
    v.ruleCount = v.rules.filter(function(r) { return r.enabled; }).length;
    if (config.demo) {
        v.queues = (s.assets || []).filter(function(a) { return nonzero(a.queued) || a.blocked; }).map(function(a) {
            return {asset: text(a.rule.asset, 16), amount: a.queued, blocked: text(a.blocked)};
        });
    } else {
        var queues = live.queues || {};
        v.queues = Object.keys(queues).sort().filter(function(key) { return nonzero(queues[key].amount) || queues[key].blocked; }).map(function(key) {
            return {asset: text(key, 16), amount: queues[key].amount, blocked: text(queues[key].blocked)};
        });
    }
    var transfers = config.demo ? (s.withdrawals || []) : (live.transfers || []);
    v.transfers = transfers.map(function(t) {
        return {asset: text(t.asset, 16), amount: config.demo ? t.amount : t.net, fee: t.fee,
            status: text(t.status, 32), at: t.updated_at || t.created_at, error: text(t.error)};
    }).sort(function(a, b) { return b.at - a.at; });
    v.queuedCount = v.queues.filter(function(q) { return nonzero(q.amount); }).length;
    v.activeCount = transfers.filter(function(t) { return ["submitting", "pending", "held", "unknown"].indexOf(t.status) !== -1; }).length;
    v.reviewCount = transfers.filter(function(t) { return ["held", "unknown", "failed", "rejected"].indexOf(t.status) !== -1; }).length;
    v.orderCount = (live.orders || []).filter(function(o) { return ["open", "pending"].indexOf(o.status) !== -1; }).length;
    var restStale = !live.rest_updated_at || live.rest_updated_at > now + 5 || now - live.rest_updated_at > Math.max(120, Number(configData.poll_seconds || 30) * 2) || !!live.rest_error;
    var catchingUp = !config.demo && (!live.caught_up_through || now - live.caught_up_through > Number(configData.poll_seconds || 30) * 2);
    v.ws = config.demo ? "Simulated" : text(live.websocket || "Not configured", 60);
    v.rest = config.demo ? "Simulated" : (restStale ? "Waiting / stale" : catchingUp ? "Catching up" : age(live.rest_updated_at, now));
    var telegram = account.telegram || {};
    v.telegram = config.demo ? "Paper mode" : telegram.last_error ? "Delivery issue" : !telegram.configured ? "Not set up" : !telegram.enabled ? "Disabled" : telegram.pending ? "Alert queued" : "Enabled";
    v.warning = text(live.rest_error || (v.queues.filter(function(q) { return q.blocked; })[0] || {}).blocked || telegram.last_error);
    var problem = v.reviewCount > 0 || !!v.warning;
    v.label = v.paused ? "Paused" : !v.ruleCount ? "No rules" : (!config.demo && (restStale || catchingUp)) ? "Recovering" : problem ? "Needs attention" : v.activeCount ? "Sending" : "Watching";
    v.tone = problem ? "urgent" : v.paused || !v.ruleCount || (!config.demo && (restStale || catchingUp)) ? "muted" : "accent";
    v.detail = !v.ruleCount ? "Choose wallets and add a rule in Moby." : v.paused ? "Fill monitoring continues; new withdrawals are paused." : catchingUp ? "Catching up on fills before sending withdrawals." : "Matching fills queue for your configured wallets.";
    var fresh = now - s.observed_at <= 15;
    v.canPause = fresh && !v.paused;
    v.canResume = fresh && v.paused && v.ruleCount > 0;
    v.canEdit = fresh && v.paused && !config.demo && v.activeCount === 0
        && !!account.refresh && !!account.refresh.wallets && account.refresh.wallets.stale === false;
    var version = v.version.split(".").map(Number);
    var hasCooldownEditor = version[0] > 0 || version[1] > 2 || (version[1] === 2 && version[2] >= 7);
    v.configDigest = text(live.config_digest, 64);
    v.canEditCooldown = fresh && v.paused && !config.demo && v.activeCount === 0 && rules.length > 0 && hasCooldownEditor;
    v.cooldownKey = JSON.stringify([s.account, s.mode, s.worker_pid, s.paused, v.configDigest]);
    v.confirmationKey = JSON.stringify([s.account, s.mode, s.worker_pid, s.paused, live.config_digest || s.plan_digest, s.queue_digest]);
    return v;
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const m = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../Model.js'), 'utf8'), m);
const clone = value => JSON.parse(JSON.stringify(value));
const config = m.options({}, '/home/fixture');
const now = 1000;
function snapshot() {
  return {ok: true, state: {protocol_version: 9, version: '0.2.9', account: 'main', mode: 'account',
    worker_pid: 99, withdrawal_cooldown_seconds: 60, paused: false, observed_at: now, vault: {state: 'unlocked'}, queue_digest: 'queue-a',
    account_status: {refresh: {wallets: {stale: false}}, telegram: {configured: true, enabled: true},
      live: {config_digest: 'a'.repeat(64), rest_updated_at: 995, caught_up_through: 995, websocket: 'Connected', config: {poll_seconds: 30,
        rules: [{asset: 'BTC', enabled: true, chunk: '0.1', minimum: '0.001',
          destinations: [{address: 'PRIVATE_ADDRESS_DO_NOT_PROJECT', wallet_id: 'PRIVATE_WALLET_ID'}]}]},
        queues: {BTC: {amount: '0.000000000000000001'}, ETH: {amount: '0'}},
        transfers: [{asset: 'BTC', net: '0.009', gross: '0.01', fee: '0.001', status: 'complete', updated_at: 980,
          destination: {address: 'PRIVATE_ADDRESS_DO_NOT_PROJECT'}}],
        orders: [{status: 'open'}, {status: 'canceled'}]}}}};
}
const project = s => m.project(s, config, now);
let s = snapshot(), v = project(s);
assert.equal(v.label, 'Watching');
assert.equal(v.queuedCount, 1);
assert.equal(v.orderCount, 1);
assert.equal(v.transfers[0].amount, '0.009'); // recipient amount, not gross
assert.equal(v.canPause, true);
assert.equal(m.money(v.queues[0].amount, true), '0.000000000000000001');
assert.equal(m.money(0.1, true), '—'); // never manufacture money from a float
assert.equal(m.money('1.000000000000000001', false), '••••');
assert(!JSON.stringify(v).includes('PRIVATE_'));
s.state.vault.state = 'locked'; v = project(s);
assert.equal(v.label, 'Locked');
assert.equal(v.transfers.length, 0);
assert.equal(v.queues.length, 0);
assert.equal(v.canPause, false);
for (const change of [s => s.state.account = 'second', s => s.state.mode = 'paper',
  s => s.state.protocol_version = 999, s => s.state.observed_at = 900,
  s => s.state.observed_at = 1010]) {
  s = snapshot(); change(s); v = project(s);
  assert.equal(v.connected, false);
  assert.equal(v.canResume, false);
  assert.equal(v.queues.length, 0);
}
s = snapshot(); s.state.paused = true; v = project(s);
assert.equal(v.canResume, true);
assert.equal(v.canEdit, true);
assert.equal(v.canEditCooldown, true);
assert.equal(v.cooldownSeconds, '60');
assert.equal(v.rules[0].cooldown, undefined);
const cooldownKey = v.cooldownKey;
const reviewed = v.confirmationKey;
s.state.queue_digest = 'queue-b';
assert.notEqual(project(s).confirmationKey, reviewed);
assert.equal(project(s).cooldownKey, cooldownKey); // unrelated fills do not cancel a timing edit
s.state.account_status.live.config_digest = 'b'.repeat(64);
assert.notEqual(project(s).cooldownKey, cooldownKey);
s.state.observed_at = 980; v = project(s);
assert.equal(v.canResume, false); // visible recent cache, but controls need <15s
assert.equal(v.canEditCooldown, false);
assert.equal(v.connected, true);
s = snapshot(); s.state.account_status.live.rest_updated_at = 500;
assert.equal(project(s).label, 'Recovering');
s.state.account_status.live.rest_updated_at = 999;
s.state.account_status.live.websocket = 'Disconnected';
assert.equal(project(s).label, 'Watching'); // healthy REST fallback
s.state.account_status.live.caught_up_through = 500;
assert.equal(project(s).label, 'Recovering');
assert.equal(project(s).rest, 'Catching up');
s = snapshot(); s.state.account_status.live.transfers[0].status = 'unknown';
v = project(s); assert.equal(v.reviewCount, 1); assert.equal(v.activeCount, 1);
s.state.paused = true; assert.equal(project(s).canEdit, false);
assert.equal(project(s).canEditCooldown, false);
s = snapshot(); s.state.paused = true; s.state.version = '0.2.6';
assert.equal(project(s).canEditCooldown, false);
s = snapshot(); s.state.withdrawal_cooldown = {asset: 'ETH', started_at: 990, until: 1050};
assert.equal(project(s).cooldownRemaining, 50);
assert.equal(project(s).cooldownAsset, 'ETH');
assert.equal(project(s).accountCooldown, true);
s.state.withdrawal_cooldown.until = 995;
assert.equal(project(s).cooldownRemaining, 0);
s.state.version = '0.2.8'; s.state.paused = true;
assert.equal(project(s).accountCooldown, false);
assert.equal(project(s).canEditCooldown, false);
s = snapshot(); s.state.account_status.live.config.rules = []; s.state.paused = true;
assert.equal(project(s).canResume, false);
s = snapshot(); s.state.mode = 'paper'; s.state.vault.state = 'not_required';
s.state.assets = [{rule: {asset: 'BTC', chunk: '1', minimum: '0.1'}, queued: '2'}];
s.state.withdrawals = [{asset: 'BTC', amount: '1', fee: '0.1', status: 'pending', updated_at: 999}];
v = m.project(s, m.options({demo: true}, ''), now);
assert.equal(v.paper, true); assert.equal(v.queuedCount, 1); assert.equal(v.transfers[0].amount, '1');
assert.equal(v.telegram, 'Paper mode');
assert.deepEqual(clone(m.command(config, 'status')), ['moby', '--account', 'main', 'status', '--json']);
assert.throws(() => m.command(config, 'orders submit'));
assert.deepEqual(clone(m.cooldownCommand(config, 120, 'a'.repeat(64))),
  ['moby','--account','main','config','cooldown','120','--expect','a'.repeat(64),'--json']);
for (const seconds of [0,86401,1.5,NaN,'60']) assert.throws(() => m.cooldownCommand(config,seconds,'a'.repeat(64)));
assert.throws(() => m.cooldownCommand(config,60,'old-digest'));
assert.throws(() => m.cooldownCommand(m.options({demo:true},''),60,'a'.repeat(64)));
assert.throws(() => m.options({account: 'main;touch /tmp/no'}, ''));
assert.throws(() => m.options({executable: 'moby --extra'}, ''));
assert.throws(() => m.options({stateDir: 'relative/path'}, ''));
const unusual = m.options({executable: '/tmp/a $(touch nope)/moby', stateDir: '/tmp/a b', account: 'second', demo: true}, '');
assert.deepEqual(clone(m.terminalCommand(unusual, 'open')), ['omarchy', 'launch', 'terminal',
  '/tmp/a $(touch nope)/moby', '--account', 'second', '--state-dir', '/tmp/a b', '--demo']);
assert.equal(project({ok: false}).label, 'Unavailable');
console.log('Model checks passed: profiles, redaction, precision, stale data, confirmations, argv and paper mode.');

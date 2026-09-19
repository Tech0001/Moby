import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initDb, closeDb, getDb } from '../src/server/db/sqlite';
import * as repo from '../src/server/db/repositories';
import { buildDashboardStatus } from '../src/server/domain/dashboardStatus';
import { feeBudgetReason, getFeeBudgetUsage, FEE_WINDOW_MS } from '../src/server/domain/feeBudget';
import { config } from './helpers';
import { createRoutes } from '../src/server/web/routes';
import { createWebServer, startServer } from '../src/server/web/server';

beforeEach(() => {
  process.env.MOBY_ENCRYPTION_KEY = 'a'.repeat(64); initDb(); repo.setEnabled(true);
  repo.createApiKey('fake', 'kraken', 'test', 'not-a-real-key', 'c2VjcmV0');
  repo.upsertAssetConfig('kraken', 'BTC', { threshold: 1, cooldownSeconds: 0, reserve: 0, destKeys: ['cold'], chunkAmount: 1 });
  repo.upsertExchangeAddress('kraken', 'BTC', 'Bitcoin', 'cold', 'example-wallet');
  repo.addPendingAmount('kraken', 'BTC', 5);
});
afterEach(() => { closeDb(); vi.restoreAllMocks(); });
function reserve(feeUsd: number | null = 6, budget: number | null = 10) {
  return repo.reserveWithdrawal('kraken', 'BTC', 'Bitcoin', 'cold', 1, repo.getAssetConfig('kraken', 'BTC')!,
    { global: 5, perAsset: 5, quotedFee: 0.001, feeUsd, dailyFeeBudgetUsd: budget, destinationAddress: 'example-wallet' });
}
it('reserves the fee atomically so two prepared chunks cannot exceed one budget', () => {
  expect(reserve()).not.toBeNull(); expect(reserve()).toBeNull();
  expect(getFeeBudgetUsage(10).reservedUsd).toBe(6); expect(repo.getAssetState('kraken','BTC')!.pendingAmount).toBe(4);
});
it('keeps uncertain and accepted-cancelled fees reserved but releases confirmed non-submissions', () => {
  const first = reserve()!; repo.updateWithdrawalJob(first.id, { status: 'unknown' });
  expect(getFeeBudgetUsage().reservedUsd).toBe(6);
  repo.releaseWithdrawal(first.id, 'cancelled', 'Confirmed not sent'); expect(getFeeBudgetUsage().reservedUsd).toBe(0);
  const second = reserve()!; repo.updateWithdrawalJob(second.id, { exchangeRef: 'accepted' }); repo.releaseWithdrawal(second.id,'cancelled');
  expect(getFeeBudgetUsage().reservedUsd).toBe(6);
});
it('does not bypass an enabled budget when current or historical fee prices are unavailable', () => {
  expect(reserve(null)).toBeNull();
  const old = repo.createWithdrawalJob('gemini', 'ETH', 'Ethereum', 'other', 1); repo.updateWithdrawalJob(old.id,{ status:'complete', exchangeRef:'old' });
  expect(reserve()).toBeNull(); expect(feeBudgetReason(10, 1)).toMatch(/unpriced/);
  getDb().prepare('UPDATE withdrawal_jobs SET created_at = ? WHERE id = ?').run(Date.now() - FEE_WINDOW_MS - 1, old.id);
  expect(reserve()).not.toBeNull();
});
it('counts increased reported fees conservatively and retains fee and destination snapshots in history', () => {
  const first = reserve()!; repo.updateWithdrawalJob(first.id,{ status:'complete', actualFee:0.002 });
  expect(getFeeBudgetUsage(10).reservedUsd).toBe(12);
  const job = repo.listWithdrawalJobs().jobs[0]; expect(job.destinationAddress).toBe('example-wallet'); expect(job.quotedFee).toBe(0.001); expect(job.actualFee).toBe(0.002);
  expect(feeBudgetReason(10,0)).toMatch(/budget reached/);
});
it('shows a real pending count and prioritizes holds, pause, dry run and retry delays over a full threshold', () => {
  repo.upsertAssetConfig('kraken','ETH',{ threshold:1,destKeys:['eth'] }); const cfg=config();
  expect(buildDashboardStatus(cfg).summary.pendingAssets).toBe(1);
  repo.setEnabled(false); expect(buildDashboardStatus(cfg).assets.find(a=>a.asset==='BTC')!.state).toBe('Paused');
  repo.setEnabled(true); cfg.global.dryRun=true; expect(buildDashboardStatus(cfg).assets.find(a=>a.asset==='BTC')!.state).toBe('Dry run');
  cfg.global.dryRun=false; repo.recordWithdrawalAttempt('kraken','BTC',false,Date.now()+60000);
  expect(buildDashboardStatus(cfg).assets.find(a=>a.asset==='BTC')!.state).toBe('Retry delay');
  const job=repo.createWithdrawalJob('kraken','BTC','Bitcoin','cold',1); repo.updateWithdrawalJob(job.id,{ status:'held' });
  expect(buildDashboardStatus(cfg).assets.find(a=>a.asset==='BTC')!.state).toBe('On hold');
});
it('filters history by exchange, status and literal search, with stable pagination', () => {
  for (const [exchange,asset,wallet] of [['kraken','BTC','wallet_1'],['gemini','ETH','walletX1'],['kraken','BTC','wallet3']] as const) {
    const j=repo.createWithdrawalJob(exchange,asset,'network',wallet,1); repo.updateWithdrawalJob(j.id,{status:'complete'});
  }
  expect(repo.listWithdrawalJobs({query:'wallet_1'}).total).toBe(1);
  expect(repo.listWithdrawalJobs({exchange:'kraken',status:'complete'}).total).toBe(2);
  const first=repo.listWithdrawalJobs({limit:1}).jobs[0], next=repo.listWithdrawalJobs({limit:1,offset:1}).jobs[0]; expect(first.id).not.toBe(next.id);
});
it('authenticates history and rejects malformed filters and fee budgets without changing saved settings', async () => {
  const cfg=config(), web={...cfg.web,port:0,host:'127.0.0.1',sessionSecret:'a'.repeat(32)};
  const app=createWebServer({config:web}); app.post('/test-login',(req,res)=>{req.session.userId='test';res.json({ok:true})});
  app.use(createRoutes({config:cfg,reloadConfig:async()=>{},updateConfig:()=>{}})); const server=await startServer(app,web);
  try {
    const url=`http://127.0.0.1:${(server.address() as any).port}`;
    expect((await fetch(url+'/api/withdrawals')).status).toBe(401);
    const login=await fetch(url+'/test-login',{method:'POST'}),cookie=login.headers.get('set-cookie')!.split(';')[0];
    for(const query of ['limit=1000','offset=-1','status=madeup','exchange=invalid']) expect((await fetch(url+'/api/withdrawals?'+query,{headers:{cookie}})).status).toBe(400);
    expect((await fetch(url+'/api/withdrawals?limit=5',{headers:{cookie}})).status).toBe(200);
    for(const value of [-1,0,'10']) expect((await fetch(url+'/api/settings',{method:'PUT',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({dailyFeeBudgetUsd:value})})).status).toBe(400);
    expect(repo.getAllSettings().dailyFeeBudgetUsd).toBeNull();
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

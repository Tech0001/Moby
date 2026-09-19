import { Router } from 'express';
import { requireAuth } from './auth.js';
import { getDb } from '../db/sqlite.js';
import { getWithdrawalJob, releaseWithdrawal, updateWithdrawalJob, getExchangeAddressesByAsset } from '../db/repositories.js';
import { getClientPool } from '../exchanges/clientPool.js';
import { normalizeAsset } from '../domain/types.js';

export function createWithdrawalReviewRoutes(onChange: () => void): Router {
  const router = Router();
  router.post('/:id/resolve', requireAuth, async (req, res) => {
    const job = getWithdrawalJob(String(req.params.id));
    if (!job || job.status !== 'unknown' || job.exchangeRef) { res.status(409).json({ error: 'Withdrawal no longer needs this review.' }); return; }
    if (Date.now() - job.createdAt < 120000) { res.status(400).json({ error: 'Wait at least two minutes and check the exchange withdrawal history.' }); return; }
    if (req.body.outcome === 'not_sent') {
      if (req.body.confirmed !== true) { res.status(400).json({ error: 'Explicit confirmation is required.' }); return; }
      if (!releaseWithdrawal(job.id, 'cancelled', 'User confirmed no withdrawal was sent.')) { res.sendStatus(409); return; }
      onChange(); res.json({ success: true }); return;
    }
    const ref = req.body.refid;
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 200) { res.status(400).json({ error: 'Enter the exchange withdrawal reference.' }); return; }
    try {
      const statuses = await getClientPool(job.exchange).execute(client => client.getWithdrawStatus(job.asset));
      const remote = statuses.find(status => status.refId === ref.trim());
      const destination = getExchangeAddressesByAsset(job.exchange, job.asset).find(address => address.key === job.destKey);
      if (!remote || normalizeAsset(remote.asset) !== job.asset || !Number.isFinite(remote.amount) ||
          !Number.isFinite(remote.fee) || !Number.isFinite(remote.timestamp) || remote.timestamp < job.createdAt - 120000 ||
          (remote.address && remote.address !== destination?.address) ||
          Math.min(Math.abs(remote.amount - job.amount), Math.abs(remote.amount + remote.fee - job.amount)) > 1e-8) {
        res.status(400).json({ error: 'Reference does not match this withdrawal’s asset, amount, time, or destination.' }); return;
      }
      const linked = getDb().transaction(() => {
        const current = getWithdrawalJob(job.id);
        if (current?.status !== 'unknown' || current.exchangeRef || getDb().prepare('SELECT 1 FROM withdrawal_jobs WHERE exchange = ? AND exchange_ref = ?').get(job.exchange, ref.trim())) return false;
        updateWithdrawalJob(job.id, { exchangeRef: ref.trim(), status: 'pending', lastError: 'Reference linked after review.' });
        return true;
      }).immediate();
      if (!linked) { res.status(409).json({ error: 'This withdrawal or reference has already been resolved.' }); return; }
      onChange(); res.json({ success: true });
    } catch { res.status(502).json({ error: 'Could not verify the reference with the exchange. Try again later.' }); }
  });
  return router;
}

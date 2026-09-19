import { Router } from 'express';
import { requireAuth } from './auth.js';
import { clearQueuedAmounts, getQueuePreview, type WithdrawalControl } from '../domain/withdrawalControl.js';

export function createWithdrawalControlRoutes(control: WithdrawalControl) {
  const router = Router();
  router.use(requireAuth);
  router.post('/start', async (req, res) => {
    try {
      await control.resume(() => !req.aborted && !res.destroyed);
      res.json({ enabled: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : 'Balance check failed; withdrawals remain paused' });
    }
  });
  router.post('/stop', (_req, res) => { control.pause(); res.json({ enabled: false }); });
  router.get('/queue', (_req, res) => { res.json(getQueuePreview()); });
  router.post('/queue/clear', (req, res) => {
    if (req.body?.confirmed !== true || typeof req.body?.token !== 'string') {
      res.status(400).json({ error: 'Review and explicitly confirm the queued amounts to clear' }); return;
    }
    try { res.json(clearQueuedAmounts(req.body.token)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Could not clear queued amounts' }); }
  });
  return router;
}

import { Router } from 'express';
import { requireAuth } from './auth.js';
import type { TelegramNotifications } from '../notifications/telegram.js';

export function createNotificationRoutes(notifications: TelegramNotifications): Router {
  const router = Router();
  router.use(requireAuth);
  router.get('/', (_req, res) => { res.json(notifications.getStatus()); });
  router.put('/', (req, res) => {
    try { res.json(notifications.configure(req.body)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save notification settings.' }); }
  });
  router.post('/test', async (_req, res) => {
    try { await notifications.test(); res.json({ success: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not send test notification.' }); }
  });
  router.post('/chats', async (req, res) => {
    try { res.json({ chats: await notifications.findChats(req.body) }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not find chats.' }); }
  });
  return router;
}

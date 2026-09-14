import { it, expect } from 'vitest';
import { createWebServer, startServer } from '../src/server/web/server.js';
import { requireAuth } from '../src/server/web/auth.js';
import { config } from './helpers.js';

it('renews the browser cookie on read-only polling and rejects missing sessions', async () => {
  const web = { ...config().web, port: 0, host: '127.0.0.1', sessionSecret: 'a'.repeat(32) };
  const app = createWebServer({ config: web });
  app.post('/login', (req, res) => { req.session.userId = 'test'; res.json({ ok: true }); });
  app.get('/status', requireAuth, (_req, res) => res.json({ ok: true }));
  const server = await startServer(app, web);
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const login = await fetch(url + '/login', { method: 'POST' });
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('Expires=');
    const poll = await fetch(url + '/status', { headers: { cookie: cookie.split(';')[0] } });
    expect(poll.status).toBe(200);
    // The original non-rolling configuration returned no Set-Cookie on this read-only route.
    expect(poll.headers.get('set-cookie')).toContain('Expires=');
    expect((await fetch(url + '/status')).status).toBe(401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

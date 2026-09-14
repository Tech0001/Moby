import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const directory = mkdtempSync('/tmp/moby-smoke-');
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
writeFileSync(directory + '/config.yaml', `global:\n  enabledOnBoot: false\nweb:\n  port: ${port}\n  host: 127.0.0.1\nassets: {}\n`);
const processChild = spawn(process.execPath, ['dist/server/app.js'], {
  cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, NODE_ENV: 'production', DATA_DIR: directory, MOBY_DATA_PATH: directory, ENV_FILE_PATH: directory + '/.env',
    DB_PATH: directory + '/smoke.db', CONFIG_PATH: directory + '/config.yaml', LOG_LEVEL: 'silent' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = ''; processChild.stderr.on('data', chunk => stderr += chunk);
try {
  let response;
  for (let i = 0; i < 50; i++) {
    try { response = await fetch(`http://127.0.0.1:${port}/api/setup/status`); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(response, stderr); const setup = await response.json(); assert.equal(setup.setupComplete, false); assert.equal(setup.hasApiKeys, false);
  const ui = await fetch(`http://127.0.0.1:${port}/`); assert.equal(ui.status, 200); assert.match(await ui.text(), /<div id="root">/);
  const status = await fetch(`http://127.0.0.1:${port}/api/status`); assert.equal(status.status, 401);
  const missing = await fetch(`http://127.0.0.1:${port}/api/missing`); assert.equal(missing.status, 404); assert.match(missing.headers.get('content-type'), /json/);
  const startUrl = `http://127.0.0.1:${port}/api/control/start`;
  assert.equal((await fetch(startUrl, { method: 'POST' })).status, 401);
  const account = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'smoke', password: 'isolated-smoke-password-123' }) });
  assert.equal(account.status, 200);
  const cookie = account.headers.get('set-cookie').split(';')[0];
  const resume = await fetch(startUrl, { method: 'POST', headers: { cookie } });
  assert.equal(resume.status, 409); assert.match((await resume.json()).error, /No enabled exchange/);
  const queue = await fetch(`http://127.0.0.1:${port}/api/control/queue`, { headers: { cookie } });
  assert.equal(queue.status, 200); assert.deepEqual((await queue.json()).amounts, []);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } })).json()).enabled, false);
  console.log('Production smoke passed: setup, UI, authentication, API 404 and guarded resume/queue routes. Temporary database only.');
} finally { processChild.kill('SIGTERM'); await once(processChild, 'exit'); }

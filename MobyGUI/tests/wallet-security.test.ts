import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import bcrypt from 'bcrypt';
import { initDb, closeDb, getDb } from '../src/server/db/sqlite.js';
import { createWallet, getWalletById, setWalletSetting, getWalletSetting } from '../src/server/db/repositories.js';
import { setWalletPassword, verifyWalletPassword, encryptPrivateKey, decryptPrivateKey, decryptWallet, upgradeWalletEncryption } from '../src/server/utils/walletEncryption.js';
import { createWebServer } from '../src/server/web/server.js';
import { createWalletRoutes } from '../src/server/web/wallets.js';
import { config } from './helpers.js';

const password = 'disposable-test-password';
const fakeKey = 'TEST DATA ONLY - not a private key';
function legacyEncrypt(text: string, pass: string) {
  const salt = randomBytes(32), iv = randomBytes(16);
  const key = scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text), cipher.final()]);
  return { encrypted: `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`, salt: salt.toString('hex') };
}
async function legacyWallet(id = 'A', pass = password) {
  setWalletSetting('password_hash', await bcrypt.hash(pass, 4));
  const key = legacyEncrypt(fakeKey, pass), phrase = legacyEncrypt('TEST DATA ONLY - not a seed phrase', pass);
  return createWallet(id, `Wallet ${id}`, 'ethereum', `TEST-ADDRESS-${id}`, key.encrypted, key.salt, phrase.encrypted, phrase.salt);
}
beforeEach(() => { initDb(); });
afterEach(() => { vi.restoreAllMocks(); closeDb(); });
it('atomically permits only one first password and verifies its full UTF-8 contents', async () => {
  const first = '🔒'.repeat(20) + '-one', second = '🔒'.repeat(20) + '-two';
  const results = await Promise.allSettled([setWalletPassword(first), setWalletPassword(second)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const winner = results[0].status === 'fulfilled' ? first : second;
  expect(await verifyWalletPassword(winner)).toBe(true);
  expect(await verifyWalletPassword(winner === first ? second : first)).toBe(false);
});
it('rejects a bcrypt prefix collision without changing or losing the old wallet', async () => {
  const pass = 'a'.repeat(72) + 'original', other = 'a'.repeat(72) + 'wrong';
  const wallet = await legacyWallet('A', pass), oldHash = getWalletSetting('password_hash');
  expect(await verifyWalletPassword(other, wallet)).toBe(false);
  expect(getWalletSetting('password_hash')).toBe(oldHash);
  expect(getWalletById('A')).toEqual(wallet);
  expect(await verifyWalletPassword(pass, wallet)).toBe(true);
  expect(getWalletSetting('password_hash')).toMatch(/^scrypt-v2:/);
  expect(await verifyWalletPassword(other)).toBe(false);
});
it('preserves individual recovery of wallets created with different legacy password suffixes', async () => {
  const first = 'b'.repeat(72) + 'one', second = 'b'.repeat(72) + 'two';
  const a = await legacyWallet('A', first), b = await legacyWallet('B', second);
  const hash = getWalletSetting('password_hash');
  expect(await verifyWalletPassword(first, a)).toBe(true);
  expect(await verifyWalletPassword(second, b)).toBe(true);
  expect(await verifyWalletPassword(first)).toBe(false);
  expect(getWalletSetting('password_hash')).toBe(hash);
  expect(getWalletById('A')).toEqual(a); expect(getWalletById('B')).toEqual(b);
});
it('upgrades both legacy secrets together and detects modified ciphertext', async () => {
  const wallet = await legacyWallet(), secrets = await decryptWallet(wallet, password);
  await upgradeWalletEncryption(wallet, secrets, password);
  const upgraded = getWalletById('A')!;
  expect(upgraded.encryptedPrivateKey).toMatch(/^v2:/);
  expect(upgraded.encryptedMnemonic).toMatch(/^v2:/);
  expect(await decryptWallet(upgraded, password)).toEqual(secrets);
  const parts = upgraded.encryptedPrivateKey.split(':'); parts[2] = '00'.repeat(16);
  await expect(decryptPrivateKey(parts.join(':'), upgraded.salt, password)).rejects.toThrow();
  await expect(decryptPrivateKey(upgraded.encryptedPrivateKey.replace('v2:', 'v3:'), upgraded.salt, password)).rejects.toThrow('Unsupported');
  await expect(decryptPrivateKey(upgraded.encryptedPrivateKey, upgraded.salt, 'wrong-password')).rejects.toThrow();
});
it('retains the original key and phrase if an encryption upgrade cannot be saved', async () => {
  const wallet = await legacyWallet(), secrets = await decryptWallet(wallet, password);
  getDb().exec("CREATE TRIGGER refuse_wallet_update BEFORE UPDATE ON wallets BEGIN SELECT RAISE(ABORT, 'test write failure'); END;");
  await expect(upgradeWalletEncryption(wallet, secrets, password)).rejects.toThrow('test write failure');
  expect(getWalletById('A')).toEqual(wallet);
  expect(await decryptWallet(wallet, password)).toEqual(secrets);
});
it('uses randomized versioned encryption without blocking the event loop', async () => {
  let ticked = false;
  setTimeout(() => { ticked = true; }, 0);
  const first = await encryptPrivateKey(fakeKey, password);
  expect(ticked).toBe(true);
  const second = await encryptPrivateKey(fakeKey, password);
  expect(first.encrypted).not.toBe(second.encrypted); expect(first.salt).not.toBe(second.salt);
  expect(await decryptPrivateKey(first.encrypted, first.salt, password)).toBe(fakeKey);
});
it('protects wallet HTTP routes, shares throttling across operations, and requires fresh deletion authorization', async () => {
  const wallet = await legacyWallet();
  const app = createWebServer({ config: { ...config().web, sessionSecret: 'test-only-session-secret' } });
  app.post('/test-login', (req, res) => { req.session.userId = 'test'; res.json({ ok: true }); });
  app.use('/api/wallets', createWalletRoutes());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const login = await fetch(url + '/test-login', { method: 'POST' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const request = (path: string, body?: unknown, method = 'POST', extra = {}) => fetch(url + '/api/wallets' + path, {
      method, headers: { cookie, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect((await fetch(url + '/api/wallets')).status).toBe(401);
    const list = await request('', undefined, 'GET');
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(list.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(JSON.stringify(await list.json())).not.toMatch(/encrypted|salt|privateKey|mnemonic/);
    expect((await request('/A', { backupConfirmed: true }, 'DELETE')).status).toBe(400);
    expect((await request('/A', { password }, 'DELETE')).status).toBe(400);
    expect((await request('/A/unlock', { password }, 'POST', { origin: 'https://untrusted.invalid' })).status).toBe(403);
    const invalid = await request('/password/verify', { password: 'wrong-password' }); expect(invalid.status).toBe(400);
    // A new session / router instance cannot reset the saved backoff.
    expect(getWalletSetting('authentication_attempts')).toContain('retryAt');
    for (const [path, method] of [['/A/unlock', 'POST'], ['', 'POST'], ['/A', 'DELETE'], ['/password/verify', 'POST']]) {
      const blocked = await request(path, { password, name: 'test', backupConfirmed: true }, method);
      expect(blocked.status).toBe(429); expect(blocked.headers.get('retry-after')).toBeTruthy();
    }
    expect(getWalletById('A')).toEqual(wallet);
    setWalletSetting('authentication_attempts', JSON.stringify({ count: 1, retryAt: Date.now() - 1 }));
    const pending = request('/A/unlock', { password });
    // Wait for the operation to enter its asynchronous KDF before overlapping it.
    await new Promise(resolve => setTimeout(resolve, 40));
    expect((await request('/password/verify', { password })).status).toBe(429);
    const unlocked = await pending;
    expect(unlocked.status).toBe(200); expect(unlocked.headers.get('cache-control')).toBe('no-store');
    expect(await unlocked.json()).toMatchObject({ id: 'A', address: 'TEST-ADDRESS-A', chain: 'ethereum', privateKey: fakeKey });
    expect((await request('/A', { password, backupConfirmed: true, address: 'DIFFERENT' }, 'DELETE')).status).toBe(400);
    expect(getWalletById('A')).not.toBeNull();
    expect((await request('/A', { password, backupConfirmed: true, address: wallet.address }, 'DELETE')).status).toBe(200);
    expect(getWalletById('A')).toBeNull();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 20_000);

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth } from './auth.js';
import { createWallet, deleteWallet, getAllWallets, getWalletById, getWalletSetting, setWalletSetting, type WalletChain } from '../db/repositories.js';
import { hasWalletPassword, setWalletPassword, verifyWalletPassword, encryptPrivateKey, decryptWallet, upgradeWalletEncryption } from '../utils/walletEncryption.js';
import { generateWallet, isChainSupported } from '../utils/walletGenerator.js';

// One expensive operation at a time across sessions, endpoints and router instances.
// Reject excess work rather than queueing secrets or unbounded scrypt allocations.
let busy = false;
const ATTEMPTS_KEY = 'authentication_attempts';
class WalletError extends Error {
  constructor(message: string, readonly status = 400, readonly retryAfter?: number) { super(message); }
}
function attempts(): { count: number; retryAt: number } {
  const stored = getWalletSetting(ATTEMPTS_KEY);
  return stored ? JSON.parse(stored) : { count: 0, retryAt: 0 };
}
function checkAttempts(): void {
  const remaining = attempts().retryAt - Date.now();
  if (remaining > 0) throw new WalletError(`Too many wallet password attempts. Try again in ${Math.ceil(remaining / 1000)} seconds.`, 429, Math.ceil(remaining / 1000));
}
function failedAttempt(): never {
  const old = attempts();
  const count = Date.now() - old.retryAt > 15 * 60_000 ? 1 : old.count + 1;
  const delay = Math.min(15 * 60_000, 1000 * 2 ** Math.min(count - 1, 10));
  setWalletSetting(ATTEMPTS_KEY, JSON.stringify({ count, retryAt: Date.now() + delay }));
  throw new WalletError('Invalid wallet password or unreadable wallet data. Check the original password and your backup.', 400);
}
async function authenticate(password: string, walletId?: string) {
  checkAttempts();
  const wallet = walletId ? getWalletById(walletId) : undefined;
  if (walletId && !wallet) throw new WalletError('Wallet not found', 404);
  if (!(await verifyWalletPassword(password, wallet ?? undefined))) failedAttempt();
  // Confirm complete decryption before any destructive operation, including deletion.
  let secrets;
  try { secrets = wallet ? await decryptWallet(wallet, password) : undefined; }
  catch { failedAttempt(); }
  setWalletSetting(ATTEMPTS_KEY, JSON.stringify({ count: 0, retryAt: 0 }));
  return { wallet, secrets };
}
function operation(handler: (req: Request, res: Response, password: string) => Promise<void>) {
  return async (req: Request, res: Response) => {
    if (busy) { res.setHeader('Retry-After', '1'); res.status(429).json({ error: 'Another wallet operation is in progress. Please try again.' }); return; }
    busy = true;
    try {
      checkAttempts();
      const password = req.body?.password;
      if (typeof password !== 'string' || !password) {
        throw new WalletError('Wallet password is required');
      }
      await handler(req, res, password);
    } catch (error) {
      if (error instanceof WalletError) {
        if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
        res.status(error.status).json({ error: error.message });
      } else {
        // Never return cryptographic internals or log request bodies / wallet secrets.
        res.status(500).json({ error: 'Wallet operation failed. Your stored wallets have been retained; check your backup before retrying.' });
      }
    } finally { busy = false; }
  };
}
export function createWalletRoutes(): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); next(); });
  router.use(requireAuth);
  router.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`) || !req.is('application/json')) {
        res.status(403).json({ error: 'Wallet changes require a same-origin JSON request' }); return;
      }
    }
    next();
  });
  router.get('/password/exists', (_req, res) => { res.json({ exists: hasWalletPassword() }); });
  router.post('/password', operation(async (_req, res, password) => {
    if (hasWalletPassword()) throw new WalletError('Wallet password already set', 409);
    if (password.length < 8) throw new WalletError('Password must be at least 8 characters');
    if (Buffer.byteLength(password, 'utf8') > 4096) throw new WalletError('New passwords must be at most 4096 UTF-8 bytes');
    await setWalletPassword(password);
    res.json({ success: true });
  }));
  router.post('/password/verify', operation(async (_req, res, password) => {
    await authenticate(password); res.json({ valid: true });
  }));
  router.get('/', (_req, res) => { res.json({ wallets: getAllWallets() }); });
  router.post('/', operation(async (req, res, password) => {
    const { name, chain = 'ethereum' } = req.body;
    const chains: WalletChain[] = ['ethereum', 'bitcoin', 'solana', 'xrp', 'xlm', 'lunc', 'algorand', 'cardano'];
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new WalletError('Wallet name must be 1–100 characters');
    if (!chains.includes(chain) || !isChainSupported(chain)) throw new WalletError('Unsupported blockchain');
    await authenticate(password);
    const generated = await generateWallet(chain);
    const key = await encryptPrivateKey(generated.privateKey, password);
    const phrase = generated.mnemonic ? await encryptPrivateKey(generated.mnemonic, password) : undefined;
    const wallet = createWallet(randomUUID(), name.trim(), chain, generated.address, key.encrypted, key.salt, phrase?.encrypted, phrase?.salt);
    res.json({ wallet: { id: wallet.id, name: wallet.name, chain: wallet.chain, address: wallet.address, createdAt: wallet.createdAt } });
  }));
  router.post('/:id/unlock', operation(async (req, res, password) => {
    const { wallet, secrets } = await authenticate(password, String(req.params.id));
    await upgradeWalletEncryption(wallet!, secrets!, password);
    res.json({ id: wallet!.id, name: wallet!.name, address: wallet!.address, chain: wallet!.chain, ...secrets });
  }));
  router.delete('/:id', operation(async (req, res, password) => {
    if (req.body.backupConfirmed !== true) throw new WalletError('Confirm you have a working backup of this wallet before deleting it');
    const { wallet } = await authenticate(password, String(req.params.id));
    if (req.body.address !== wallet!.address) throw new WalletError('Wallet address does not match. Refresh and try again');
    deleteWallet(wallet!.id);
    res.json({ success: true });
  }));
  return router;
}

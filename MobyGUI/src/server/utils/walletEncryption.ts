import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import bcrypt from 'bcrypt';
import { getDb } from '../db/sqlite.js';
import { getAllWallets, getWalletById, getWalletSetting, type WalletRecord } from '../db/repositories.js';

// Versioned parameters: never change the derivation of existing ciphertext.
const CURRENT_VERSION = 'v2';
const HASH_PREFIX = 'scrypt-v2';
function deriveKey(password: string, salt: Buffer, legacy = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: legacy ? 16384 : 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}
function hex(value: string, bytes?: number): Buffer {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value) || (bytes !== undefined && value.length !== bytes * 2)) {
    throw new Error('Invalid encrypted wallet data');
  }
  return Buffer.from(value, 'hex');
}
async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await deriveKey(password, salt);
  try { return `${HASH_PREFIX}:${salt.toString('hex')}:${key.toString('hex')}`; }
  finally { key.fill(0); }
}
export function hasWalletPassword(): boolean { return getWalletSetting('password_hash') !== null; }
export async function setWalletPassword(password: string): Promise<void> {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  if (hasWalletPassword()) throw new Error('Wallet password already set');
  const hash = await passwordHash(password);
  // Do not overwrite another setup that completed while the KDF was running.
  const result = getDb().prepare("INSERT OR IGNORE INTO wallet_settings (key, value) VALUES ('password_hash', ?)").run(hash);
  if (!result.changes) throw new Error('Wallet password already set');
}

export async function verifyWalletPassword(password: string, target?: WalletRecord): Promise<boolean> {
  const stored = getWalletSetting('password_hash');
  if (!stored) return false;
  if (stored.startsWith(`${HASH_PREFIX}:`)) {
    const [prefix, salt, digest, extra] = stored.split(':');
    if (prefix !== HASH_PREFIX || extra !== undefined) throw new Error('Invalid wallet password data');
    const expected = hex(digest, 32);
    const actual = await deriveKey(password, hex(salt, 32));
    try { return timingSafeEqual(actual, expected); }
    finally { actual.fill(0); }
  }
  if (!(await bcrypt.compare(password, stored))) return false;

  // bcrypt ignores bytes after byte 72. Authenticate the complete password against
  // EVERY encrypted secret before replacing the legacy verifier. A vault produced
  // by the old bug may contain different suffixes: each wallet remains recoverable
  // with its own original password, without upgrading or discarding its neighbours.
  const wallets = getAllWallets().map(w => getWalletById(w.id)!);
  let allValid = true;
  let targetValid = false;
  for (const wallet of wallets) {
    try {
      await decryptWallet(wallet, password);
      if (wallet.id === target?.id) targetValid = true;
    } catch { allValid = false; }
  }
  if (allValid) {
    const hash = await passwordHash(password);
    getDb().prepare("UPDATE wallet_settings SET value = ? WHERE key = 'password_hash' AND value = ?").run(hash, stored);
  }
  return target ? targetValid : allValid;
}

export async function encryptPrivateKey(plaintext: string, password: string): Promise<{ encrypted: string; salt: string }> {
  const salt = randomBytes(32);
  const key = await deriveKey(password, salt);
  try {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(CURRENT_VERSION));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { encrypted: `${CURRENT_VERSION}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`, salt: salt.toString('hex') };
  } finally { key.fill(0); }
}
export async function decryptPrivateKey(data: string, salt: string, password: string): Promise<string> {
  const parts = data.split(':');
  const legacy = parts.length === 3;
  if (!legacy && (parts.length !== 4 || parts.shift() !== CURRENT_VERSION)) throw new Error('Unsupported wallet encryption version');
  const [iv, tag, ciphertext] = parts;
  const ivBytes = hex(iv, 16), tagBytes = hex(tag, 16), encrypted = hex(ciphertext);
  const key = await deriveKey(password, hex(salt, 32), legacy);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, ivBytes);
    if (!legacy) decipher.setAAD(Buffer.from(CURRENT_VERSION));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } finally { key.fill(0); }
}
export async function decryptWallet(wallet: WalletRecord, password: string): Promise<{ privateKey: string; mnemonic?: string }> {
  if (!!wallet.encryptedMnemonic !== !!wallet.mnemonicSalt) throw new Error('Incomplete recovery phrase data');
  const privateKey = await decryptPrivateKey(wallet.encryptedPrivateKey, wallet.salt, password);
  const mnemonic = wallet.encryptedMnemonic && wallet.mnemonicSalt
    ? await decryptPrivateKey(wallet.encryptedMnemonic, wallet.mnemonicSalt, password) : undefined;
  return { privateKey, mnemonic };
}

export async function upgradeWalletEncryption(wallet: WalletRecord, secrets: { privateKey: string; mnemonic?: string }, password: string): Promise<void> {
  if (wallet.encryptedPrivateKey.startsWith('v2:') && (!wallet.encryptedMnemonic || wallet.encryptedMnemonic.startsWith('v2:'))) return;
  const key = await encryptPrivateKey(secrets.privateKey, password);
  const phrase = secrets.mnemonic ? await encryptPrivateKey(secrets.mnemonic, password) : undefined;
  // Both secrets change together, only if the record is still the one we decrypted.
  getDb().transaction(() => {
    if (JSON.stringify(getWalletById(wallet.id)) !== JSON.stringify(wallet)) throw new Error('Wallet changed; unlock it again');
    getDb().prepare(`UPDATE wallets SET encrypted_private_key = ?, salt = ?, encrypted_mnemonic = ?, mnemonic_salt = ?, updated_at = ? WHERE id = ?`)
      .run(key.encrypted, key.salt, phrase?.encrypted ?? null, phrase?.salt ?? null, Date.now(), wallet.id);
  }).immediate();
}

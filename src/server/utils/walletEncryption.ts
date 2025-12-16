import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'crypto';
import { getWalletSetting, setWalletSetting } from '../db/repositories.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const SCRYPT_COST = 1048576; // N parameter (2^20) - high security, ~1s decrypt time

/**
 * Hash password for storage (verification only, NOT for encryption)
 * Uses SHA-256 with a pepper for simple verification
 */
function hashPassword(password: string): string {
  const pepper = 'moby-wallet-pepper-v1';
  return createHash('sha256').update(password + pepper).digest('hex');
}

/**
 * Derive encryption key from password using scrypt
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_COST, r: 8, p: 1 });
}

/**
 * Check if a wallet password has been set
 */
export function hasWalletPassword(): boolean {
  const hash = getWalletSetting('password_hash');
  return hash !== null;
}

/**
 * Set the wallet password (first time setup)
 * Stores only a hash for verification - NOT used for encryption
 */
export function setWalletPassword(password: string): void {
  if (hasWalletPassword()) {
    throw new Error('Wallet password already set');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const hash = hashPassword(password);
  setWalletSetting('password_hash', hash);
}

/**
 * Verify the wallet password is correct
 */
export function verifyWalletPassword(password: string): boolean {
  const storedHash = getWalletSetting('password_hash');
  if (!storedHash) {
    return false;
  }

  const inputHash = hashPassword(password);
  return storedHash === inputHash;
}

/**
 * Encrypt a private key with the user's password
 * Returns: { encrypted: string, salt: string } where both are hex-encoded
 */
export function encryptPrivateKey(
  privateKey: string,
  password: string
): { encrypted: string; salt: string } {
  // Generate random salt for this wallet
  const salt = randomBytes(SALT_LENGTH);

  // Derive encryption key from password + salt
  const key = deriveKey(password, salt);

  // Generate random IV
  const iv = randomBytes(IV_LENGTH);

  // Encrypt
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all hex)
  const encryptedData = `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;

  return {
    encrypted: encryptedData,
    salt: salt.toString('hex'),
  };
}

/**
 * Decrypt a private key with the user's password
 */
export function decryptPrivateKey(
  encryptedData: string,
  saltHex: string,
  password: string
): string {
  const salt = Buffer.from(saltHex, 'hex');
  const key = deriveKey(password, salt);

  const [ivHex, authTagHex, ciphertext] = encryptedData.split(':');

  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error('Invalid encrypted data format');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Change the wallet password
 * This requires re-encrypting all existing wallets
 */
export function changeWalletPassword(
  oldPassword: string,
  newPassword: string,
  reEncryptCallback: (oldPass: string, newPass: string) => void
): void {
  if (!verifyWalletPassword(oldPassword)) {
    throw new Error('Current password is incorrect');
  }

  if (newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters');
  }

  // Re-encrypt all wallets with new password
  reEncryptCallback(oldPassword, newPassword);

  // Update the password hash
  const hash = hashPassword(newPassword);
  setWalletSetting('password_hash', hash);
}

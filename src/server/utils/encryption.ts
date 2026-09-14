import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { createChildLogger } from './logger.js';
import { restrictPrivateFile } from './privateFiles.js';

const logger = createChildLogger('encryption');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT = 'moby-api-key-encryption-v1';
const ENV_KEY_NAME = 'MOBY_ENCRYPTION_KEY';
const DATA_ROOT = process.env.MOBY_DATA_PATH || process.env.DATA_DIR || process.cwd();
const PRIMARY_ENV_PATH = process.env.ENV_FILE_PATH || join(DATA_ROOT, '.env');

let cachedKey: Buffer | null = null;

function ensureEnvDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readEnvFromFiles(): string | undefined {
  const candidates = [
    PRIMARY_ENV_PATH,
    // Fallback to working directory for backward compatibility (dev)
    join(process.cwd(), '.env'),
  ].filter((value, index, arr) => arr.indexOf(value) === index);

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    restrictPrivateFile(envPath);
    const envContent = readFileSync(envPath, 'utf-8');
    const match = envContent.match(new RegExp(`^${ENV_KEY_NAME}=(.+)$`, 'm'));
    if (match) {
      return match[1].trim();
    }
  }

  return undefined;
}

/**
 * Generate a new random encryption key (64 hex chars = 32 bytes)
 */
export function generateKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Get or generate the master encryption key
 * Returns the 256-bit key derived from the environment variable
 */
function getMasterKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  let envKey = process.env[ENV_KEY_NAME];

  // If not in environment, try to load from .env file
  if (!envKey) {
    envKey = readEnvFromFiles();
    if (envKey) {
      process.env[ENV_KEY_NAME] = envKey;
    }
  }

  if (!envKey) {
    throw new Error(
      `${ENV_KEY_NAME} not set. Run the app once to auto-generate, or set manually.`
    );
  }

  // Derive 256-bit key from provided key using scrypt
  cachedKey = scryptSync(envKey, SALT, 32);
  return cachedKey;
}

/**
 * Initialize encryption - ensures key exists, generates if needed
 * Call this on app startup before any encryption/decryption
 */
export function initEncryption(): { keyGenerated: boolean; keySource: string } {
  restrictPrivateFile(PRIMARY_ENV_PATH);
  let envKey = process.env[ENV_KEY_NAME];
  let keySource = 'environment';

  // Try to load from .env file if not in environment
  if (!envKey) {
    const loaded = readEnvFromFiles();
    if (loaded) {
      envKey = loaded;
      process.env[ENV_KEY_NAME] = envKey;
      keySource = '.env file';
    }
  }

  // Generate new key if none exists
  if (!envKey) {
    const newKey = generateKey();
    process.env[ENV_KEY_NAME] = newKey;

    // Write to .env file
    const envLine = `\n# Auto-generated encryption key for API credentials\n# BACKUP THIS KEY - if lost, stored API keys cannot be decrypted\n${ENV_KEY_NAME}=${newKey}\n`;

    ensureEnvDir(PRIMARY_ENV_PATH);

    if (existsSync(PRIMARY_ENV_PATH)) {
      appendFileSync(PRIMARY_ENV_PATH, envLine, { mode: 0o600 });
    } else {
      writeFileSync(PRIMARY_ENV_PATH, envLine.trimStart(), { mode: 0o600 });
    }

    logger.info({ path: PRIMARY_ENV_PATH }, 'Generated new encryption key and saved to .env file');
    logger.warn('IMPORTANT: Backup your .env file - the encryption key is required to decrypt API credentials');

    // Clear cached key so it gets re-derived
    cachedKey = null;

    return { keyGenerated: true, keySource: '.env file (new)' };
  }

  // Clear cached key so it gets derived fresh
  cachedKey = null;

  return { keyGenerated: false, keySource };
}

/**
 * Encrypt a plaintext string
 * Returns format: iv:authTag:ciphertext (all hex)
 */
export function encrypt(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an encrypted string
 * Expects format: iv:authTag:ciphertext (all hex)
 */
export function decrypt(encryptedData: string): string {
  const key = getMasterKey();
  const parts = encryptedData.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Check if a value appears to be encrypted
 * Encrypted values have format: iv:authTag:ciphertext (hex)
 * iv = 32 hex chars (16 bytes)
 * authTag = 32 hex chars (16 bytes)
 * ciphertext = variable length hex
 */
export function isEncrypted(value: string): boolean {
  if (!value || typeof value !== 'string') {
    return false;
  }
  // Match: 32 hex chars : 32 hex chars : 1+ hex chars
  return /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i.test(value);
}

/**
 * Safely decrypt - returns original value if not encrypted or decryption fails
 * Useful during migration period
 */
export function safeDecrypt(value: string): string {
  if (!isEncrypted(value)) {
    return value;
  }
  try {
    return decrypt(value);
  } catch (error) {
    logger.error({ error }, 'Failed to decrypt value, returning as-is');
    return value;
  }
}

/**
 * Encrypt only if not already encrypted
 */
export function ensureEncrypted(value: string): string {
  if (isEncrypted(value)) {
    return value;
  }
  return encrypt(value);
}

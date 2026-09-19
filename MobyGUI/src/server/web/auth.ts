import bcrypt from 'bcrypt';
import { createChildLogger } from '../utils/logger.js';
import {
  getUserByUsername,
  createUser,
  userExists,
} from '../db/repositories.js';
import type { Request, Response, NextFunction } from 'express';

const logger = createChildLogger('auth');

const SALT_ROUNDS = 12;

/**
 * Hash a password
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Register a new user
 */
export async function registerUser(
  username: string,
  password: string
): Promise<{ success: boolean; error?: string; userId?: string }> {
  // Check if any user exists (single-user mode)
  if (userExists()) {
    return { success: false, error: 'User already exists' };
  }

  // Validate password
  if (password.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters' };
  }

  try {
    const passwordHash = await hashPassword(password);
    const userId = createUser(username, passwordHash);

    logger.info({ username }, 'User registered');
    return { success: true, userId };
  } catch (error) {
    logger.error({ error }, 'Failed to register user');
    return { success: false, error: 'Registration failed' };
  }
}

/**
 * Authenticate a user
 */
export async function authenticateUser(
  username: string,
  password: string
): Promise<{ success: boolean; error?: string; userId?: string }> {
  const user = getUserByUsername(username);

  if (!user) {
    return { success: false, error: 'Invalid credentials' };
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (!valid) {
    return { success: false, error: 'Invalid credentials' };
  }

  logger.info({ username }, 'User authenticated');
  return { success: true, userId: user.id };
}

/**
 * Express middleware to require authentication
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Express middleware to check if setup is needed
 */
export function checkSetupNeeded(req: Request, res: Response, next: NextFunction): void {
  // Allow access to setup endpoint if no user exists
  if (!userExists()) {
    next();
    return;
  }

  // If user exists, require authentication
  requireAuth(req, res, next);
}

/**
 * Check if initial setup is complete
 */
export function isSetupComplete(): boolean {
  return userExists();
}

// Extend Express session type
declare module 'express-session' {
  interface SessionData {
    userId: string;
    username: string;
  }
}

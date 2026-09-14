import { chmodSync, existsSync, mkdirSync, openSync, closeSync } from 'fs';
import { dirname } from 'path';

export function restrictPrivateFile(path: string): void {
  if (process.platform !== 'win32' && existsSync(path)) chmodSync(path, 0o600);
}
export function preparePrivateFile(path: string): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { closeSync(openSync(path, 'ax', 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  restrictPrivateFile(path);
}

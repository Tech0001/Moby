import { afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { chmodSync, mkdtempSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { preparePrivateFile, restrictPrivateFile } from '../src/server/utils/privateFiles.js';
const { createSecretClipboard } = createRequire(import.meta.url)('../electron/secret-clipboard.cjs');
afterEach(() => { vi.useRealTimers(); });
it('expires copied secrets without erasing something copied afterwards', () => {
  vi.useFakeTimers();
  let contents = '';
  const clipboard = { readText: () => contents, writeText: (text: string) => { contents = text; }, clear: () => { contents = ''; } };
  const secrets = createSecretClipboard(clipboard);
  secrets.copy('FAKE KEY'); vi.advanceTimersByTime(29_999); expect(contents).toBe('FAKE KEY');
  vi.advanceTimersByTime(1); expect(contents).toBe('');
  secrets.copy('FAKE KEY'); contents = 'something the user copied'; vi.advanceTimersByTime(30_000);
  expect(contents).toBe('something the user copied');
  secrets.copy('FAKE KEY'); secrets.clear(); expect(contents).toBe('');
});
it.skipIf(process.platform === 'win32')('creates private files and tightens existing permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moby-permissions-'));
  try {
    const path = join(dir, 'new', 'vault.db'); preparePrivateFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'new')).mode & 0o777).toBe(0o700);
    chmodSync(path, 0o755); restrictPrivateFile(path); expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    env: { DB_PATH: ':memory:', LOG_LEVEL: 'silent', NODE_ENV: 'test' },
    pool: 'forks', maxWorkers: 2, minWorkers: 1,
  },
});

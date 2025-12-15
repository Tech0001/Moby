import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { initDb, closeDb } from './sqlite.js';

const DB_PATH = process.env.DB_PATH || './data/sweeper.db';

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  console.log(`Created data directory: ${dataDir}`);
}

console.log('Running database migrations...');
initDb();
console.log('Migrations complete.');
closeDb();

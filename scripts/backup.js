#!/usr/bin/env node
// Online backup of the SQLite database (safe while the app is running).
//   npm run backup
// Writes <DATA_DIR>/backups/companion-<timestamp>.db using VACUUM INTO.
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { ScriptError } from './lib/importFile.js';
import { backupDatabase } from './lib/dbFiles.js';

try {
  const config = loadConfig();
  const target = backupDatabase({ dbPath: config.dbPath, backupDir: path.join(config.dataDir, 'backups') });
  console.log(`Backup written: ${target}`);
  console.log('');
  console.log('Notes:');
  console.log('  - The backup contains no plaintext secrets. OAuth tokens are stored AES-256-GCM encrypted.');
  console.log('  - Those tokens can only be decrypted with the SAME key: TOKEN_ENCRYPTION_KEY from .env, or');
  console.log(`    ${config.keyPath} if TOKEN_ENCRYPTION_KEY is empty.`);
  console.log('    Back that key up separately and securely (not next to the backup). Without it, messages,');
  console.log('    settings and logs restore fine, but connected accounts must be reconnected.');
} catch (err) {
  console.error(err instanceof ScriptError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
}

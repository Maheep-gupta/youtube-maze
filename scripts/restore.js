#!/usr/bin/env node
// Restore the SQLite database from a backup made by `npm run backup`.
//   npm run restore -- <backup.db> --yes
// Refuses while the app is running. The current database is first saved as
// <DATA_DIR>/companion.pre-restore-<timestamp>.db.
import { loadConfig } from '../src/config.js';
import { ScriptError } from './lib/importFile.js';
import { isServerResponding, restoreDatabase, validateBackupFile } from './lib/dbFiles.js';

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new ScriptError('Usage: npm run restore -- <path-to-backup.db> --yes');

  const config = loadConfig();
  const hosts = [...new Set(['127.0.0.1', config.host])].map((h) => (h.includes(':') ? `[${h}]` : h));
  for (const host of hosts) {
    if (await isServerResponding(`http://${host}:${config.port}/api/health`)) {
      throw new ScriptError(`The app appears to be running on http://${host}:${config.port}. Stop it (Ctrl+C) before restoring.`);
    }
  }

  const info = validateBackupFile(file);
  console.log(`Backup OK: ${file}`);
  console.log(`  messages: ${info.counts.messages}, connections: ${info.counts.connections}, activity entries: ${info.counts.activity}`);
  console.log(`This will REPLACE ${config.dbPath}`);
  if (!confirmed) {
    console.log('Nothing changed. Re-run with --yes to proceed:  npm run restore -- "<backup.db>" --yes');
    process.exitCode = 1;
    return;
  }

  const { preRestore } = restoreDatabase({ dbPath: config.dbPath, backupFile: file });
  if (preRestore) console.log(`Previous database saved as: ${preRestore}`);
  console.log(`Restored ${config.dbPath}`);
  console.log('Connected accounts work only if the same TOKEN_ENCRYPTION_KEY / secret.key is in place;');
  console.log('otherwise reconnect them from the Connections page. Start the app with: npm start');
}

main().catch((err) => {
  console.error(err instanceof ScriptError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
});

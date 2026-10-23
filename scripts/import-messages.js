#!/usr/bin/env node
// Migrate an existing messages.json into the SQLite library.
//   npm run import -- <path-to-messages.json>
// Accepts every format the dashboard import accepts: { version, messages: [...] }, a bare array of
// { text, category, enabled? } objects, a bare array of strings (category "compliments"), or the legacy
// { "<category>": ["text", ...] } object. Duplicates and invalid entries are skipped, never overwritten.
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ScriptError, importIntoDatabase, readImportFile } from './lib/importFile.js';

function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const { path: resolved, payload } = readImportFile(file);
  const config = loadConfig();

  const db = openDatabase(config.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;'); // the app may be running and holding a write lock briefly
    const { imported, skipped } = importIntoDatabase(db, payload);
    console.log(`Imported ${imported} message(s) from ${resolved}`);
    console.log(`Database: ${config.dbPath}`);
    if (skipped.length) {
      console.log(`Skipped ${skipped.length}:`);
      const shown = skipped.slice(0, 20);
      for (const s of shown) console.log(`  - "${s.text.slice(0, 60)}${s.text.length > 60 ? '...' : ''}": ${s.reason}`);
      if (skipped.length > shown.length) console.log(`  ... and ${skipped.length - shown.length} more`);
    } else {
      console.log('Skipped 0.');
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof ScriptError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
}

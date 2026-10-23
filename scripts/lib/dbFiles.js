import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ScriptError } from './importFile.js';

/** Tables from migration 001 that every valid backup must contain. send_ledger (002) is added on next start if missing. */
export const REQUIRED_TABLES = Object.freeze([
  'schema_migrations', 'messages', 'account_connections', 'scheduler_settings', 'sessions', 'activity_logs', 'generated_drafts',
]);

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** Filesystem-safe UTC timestamp, e.g. 2026-10-20T22-53-01-123Z. */
export const fileStamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

/** SQL string literal with single quotes doubled (VACUUM INTO does not accept bound parameters). */
export const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Consistent online copy of a SQLite database with `VACUUM INTO`. Safe while the app is running:
 * it reads a single snapshot (including committed WAL content) and never modifies the source.
 */
export function vacuumInto(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) throw new ScriptError(`Database not found: ${sourcePath}`);
  if (fs.existsSync(targetPath)) throw new ScriptError(`Refusing to overwrite existing file: ${targetPath}`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  let db;
  try {
    db = new DatabaseSync(sourcePath, { readOnly: true });
  } catch {
    // A read-only handle on a WAL database can fail when the -shm file is absent; a normal handle is
    // still safe because VACUUM INTO never writes to the source.
    db = new DatabaseSync(sourcePath);
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(`VACUUM INTO ${sqlString(targetPath)}`);
  } finally {
    db.close();
  }
  return targetPath;
}

export function backupDatabase({ dbPath, backupDir, date = new Date() }) {
  return vacuumInto(dbPath, path.join(backupDir, `companion-${fileStamp(date)}.db`));
}

/** Throws ScriptError unless `file` is a readable, intact SQLite database with the app's tables. */
export function validateBackupFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { throw new ScriptError(`Backup file not found: ${file}`); }
  if (!stat.isFile()) throw new ScriptError(`Not a regular file: ${file}`);
  const header = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (!header.equals(SQLITE_HEADER)) throw new ScriptError(`Not a SQLite database: ${file}`);

  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    throw new ScriptError(`Cannot open ${file}: ${err.message}`);
  }
  try {
    const check = db.prepare('PRAGMA quick_check').get();
    const result = check ? Object.values(check)[0] : 'no result';
    if (result !== 'ok') throw new ScriptError(`Integrity check failed for ${file}: ${result}`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) throw new ScriptError(`${file} is not a Live Chat Companion database (missing tables: ${missing.join(', ')}).`);
    const count = (t) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    return {
      tables: [...tables].sort(),
      counts: { messages: count('messages'), connections: count('account_connections'), activity: count('activity_logs') },
    };
  } finally {
    db.close();
  }
}

/** Resolve true if anything answers HTTP on `url` within `timeoutMs` (any status counts). */
export async function isServerResponding(url, { timeoutMs = 1500, fetch = globalThis.fetch } = {}) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace `dbPath` with `backupFile`. The caller must ensure the app is not running.
 * 1. validate the backup; 2. snapshot the current db to companion.pre-restore-<ts>.db (if it exists);
 * 3. delete -wal/-shm sidecars (a stale WAL would be replayed onto the restored file); 4. copy.
 */
export function restoreDatabase({ dbPath, backupFile, date = new Date() }) {
  const source = path.resolve(backupFile);
  const target = path.resolve(dbPath);
  if (source.toLowerCase() === target.toLowerCase()) throw new ScriptError('The backup file is the live database itself.');
  const info = validateBackupFile(source);

  let preRestore = null;
  if (fs.existsSync(target)) {
    preRestore = path.join(path.dirname(target), `companion.pre-restore-${fileStamp(date)}.db`);
    vacuumInto(target, preRestore);
  }
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${target}${suffix}`, { force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  validateBackupFile(target);
  return { preRestore, info };
}

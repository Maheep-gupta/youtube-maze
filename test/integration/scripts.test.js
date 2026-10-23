// Tests for the maintenance scripts' logic (scripts/lib/*), against real SQLite files in a temp dir.
import '../helpers.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/index.js';
import { ScriptError, importIntoDatabase, readImportFile, MAX_IMPORT_BYTES } from '../../scripts/lib/importFile.js';
import {
  backupDatabase, fileStamp, isServerResponding, restoreDatabase, sqlString, validateBackupFile, vacuumInto,
} from '../../scripts/lib/dbFiles.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-scripts-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => { const d = path.join(root, `case-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file, content) => { fs.writeFileSync(file, content); return file; };
const countMessages = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n); } finally { db.close(); }
};

describe('readImportFile', () => {
  it('rejects missing args, wrong extension, missing files, directories, oversize files and bad JSON', () => {
    const d = dir();
    assert.throws(() => readImportFile(undefined), ScriptError);
    assert.throws(() => readImportFile(write(path.join(d, 'm.txt'), '[]')), /Not a \.json file/);
    assert.throws(() => readImportFile(path.join(d, 'missing.json')), /File not found/);
    fs.mkdirSync(path.join(d, 'folder.json'));
    assert.throws(() => readImportFile(path.join(d, 'folder.json')), /Not a regular file/);
    assert.throws(() => readImportFile(write(path.join(d, 'big.json'), '[]'), { maxBytes: 1 }), /limit/);
    assert.throws(() => readImportFile(write(path.join(d, 'bad.json'), '{ nope')), /Invalid JSON/);
    assert.equal(MAX_IMPORT_BYTES, 5 * 1024 * 1024);
  });

  it('parses JSON (tolerating a UTF-8 BOM and an upper-case extension)', () => {
    const d = dir();
    const { payload } = readImportFile(write(path.join(d, 'M.JSON'), '\uFEFF["Hello from Windows"]'));
    assert.deepEqual(payload, ['Hello from Windows']);
  });
});

describe('importIntoDatabase', () => {
  it('imports every supported format with duplicate/invalid skipping, into a file database', () => {
    const dbPath = path.join(dir(), 'companion.db');
    const db = openDatabase(dbPath);
    try {
      const legacy = importIntoDatabase(db, { compliments: ['Legacy nice one'], witty_jokes: ['Legacy pun'], bogus: ['x y z'] });
      assert.equal(legacy.imported, 2);
      assert.equal(legacy.skipped.length, 1);
      const versioned = importIntoDatabase(db, { version: 1, messages: [{ text: 'Versioned', category: 'motivation', enabled: false }, { text: 'legacy NICE one!', category: 'wholesome' }] });
      assert.equal(versioned.imported, 1);
      assert.equal(versioned.skipped[0].reason, 'Duplicate of an existing message.');
      assert.equal(importIntoDatabase(db, ['Bare string']).imported, 1);
      assert.throws(() => importIntoDatabase(db, { compliments: 'nope' }), ScriptError);
      const rows = db.prepare('SELECT source FROM messages').all();
      assert.ok(rows.every((r) => r.source === 'import'));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event_type = 'message.imported'").get().n, 3);
    } finally {
      db.close();
    }
    assert.equal(countMessages(dbPath), 4);
  });

  it('imports the bundled sample file', () => {
    const { payload } = readImportFile(fileURLToPath(new URL('../../samples/messages.sample.json', import.meta.url)));
    const db = openDatabase(':memory:');
    const res = importIntoDatabase(db, payload);
    assert.ok(res.imported > 0);
    assert.equal(res.imported + res.skipped.length, payload.messages.length);
    db.close();
  });
});

describe('backup / restore', () => {
  it('quotes SQL strings and builds filesystem-safe stamps', () => {
    assert.equal(sqlString("C:\\Users\\O'Brien\\a.db"), "'C:\\Users\\O''Brien\\a.db'");
    assert.equal(fileStamp(new Date('2026-10-20T22:53:01.123Z')), '2026-10-20T22-53-01-123Z');
  });

  it('backs up a live WAL database (open connection, uncheckpointed writes) to a path with a quote', () => {
    const d = dir();
    const dbPath = path.join(d, 'companion.db');
    const live = openDatabase(dbPath); // stays open, like the running app
    try {
      importIntoDatabase(live, ['Backed up one', 'Backed up two']);
      assert.ok(fs.existsSync(`${dbPath}-wal`), 'WAL mode in use');
      const backupDir = path.join(d, "O'Brien backups");
      const file = backupDatabase({ dbPath, backupDir, date: new Date('2026-01-01T00:00:00Z') });
      assert.equal(file, path.join(backupDir, 'companion-2026-01-01T00-00-00-000Z.db'));
      const info = validateBackupFile(file);
      assert.equal(info.counts.messages, 2);
      assert.ok(info.tables.includes('send_ledger'));
      assert.throws(() => backupDatabase({ dbPath, backupDir, date: new Date('2026-01-01T00:00:00Z') }), /Refusing to overwrite/);
    } finally {
      live.close();
    }
  });

  it('refuses to back up a missing database', () => {
    const d = dir();
    assert.throws(() => backupDatabase({ dbPath: path.join(d, 'nope.db'), backupDir: d }), /Database not found/);
    assert.equal(fs.existsSync(path.join(d, 'nope.db')), false, 'did not create an empty db');
  });

  it('validateBackupFile rejects non-SQLite files and foreign SQLite databases', () => {
    const d = dir();
    assert.throws(() => validateBackupFile(path.join(d, 'missing.db')), /not found/);
    assert.throws(() => validateBackupFile(write(path.join(d, 'text.db'), 'hello, definitely not sqlite')), /Not a SQLite database/);
    const foreign = new DatabaseSync(path.join(d, 'foreign.db'));
    foreign.exec('CREATE TABLE things (id INTEGER)');
    foreign.close();
    assert.throws(() => validateBackupFile(path.join(d, 'foreign.db')), /missing tables: schema_migrations/);
  });

  it('restores: saves the current db as pre-restore, removes stale WAL/SHM, replaces the db', () => {
    const d = dir();
    const dbPath = path.join(d, 'companion.db');
    const db = openDatabase(dbPath);
    importIntoDatabase(db, ['Original one']);
    db.close();
    const backup = backupDatabase({ dbPath, backupDir: path.join(d, 'backups') });

    const db2 = openDatabase(dbPath);
    importIntoDatabase(db2, ['Added after backup', 'Another after backup']);
    db2.close();
    write(`${dbPath}-wal`, 'stale');
    write(`${dbPath}-shm`, 'stale');
    assert.equal(countMessages(dbPath), 3);

    const { preRestore, info } = restoreDatabase({ dbPath, backupFile: backup, date: new Date('2026-02-02T00:00:00Z') });
    assert.equal(info.counts.messages, 1);
    assert.equal(preRestore, path.join(d, 'companion.pre-restore-2026-02-02T00-00-00-000Z.db'));
    assert.equal(validateBackupFile(preRestore).counts.messages, 3);
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);
    assert.equal(countMessages(dbPath), 1);

    const reopened = openDatabase(dbPath); // migrations still apply cleanly
    assert.equal(reopened.prepare('SELECT text FROM messages').get().text, 'Original one');
    reopened.close();
  });

  it('restore refuses the live database as its own source and invalid backups (leaving the db untouched)', () => {
    const d = dir();
    const dbPath = path.join(d, 'companion.db');
    openDatabase(dbPath).close();
    assert.throws(() => restoreDatabase({ dbPath, backupFile: dbPath }), /live database itself/);
    assert.throws(() => restoreDatabase({ dbPath, backupFile: write(path.join(d, 'junk.db'), 'junk') }), /Not a SQLite/);
    assert.deepEqual(fs.readdirSync(d).filter((f) => f.includes('pre-restore')), []);
  });

  it('isServerResponding detects a listening server and a closed port (loopback only)', async () => {
    const server = http.createServer((_req, res) => res.writeHead(403).end());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      assert.equal(await isServerResponding(`http://127.0.0.1:${port}/api/health`), true, 'any status counts as running');
    } finally {
      await new Promise((r) => server.close(r));
    }
    assert.equal(await isServerResponding(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 500 }), false);
  });

  it('vacuumInto never modifies the source', () => {
    const d = dir();
    const dbPath = path.join(d, 'companion.db');
    openDatabase(dbPath).close();
    const before = fs.readFileSync(dbPath);
    vacuumInto(dbPath, path.join(d, 'copy.db'));
    assert.ok(before.equals(fs.readFileSync(dbPath)));
  });
});

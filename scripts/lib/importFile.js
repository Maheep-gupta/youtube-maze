import fs from 'node:fs';
import path from 'node:path';
import { createActivityService } from '../../src/services/activity.js';
import { createMessagesService } from '../../src/services/messages.js';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** Thrown for user-facing problems (bad path, bad JSON); the CLI prints the message and exits 1. */
export class ScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScriptError';
  }
}

/**
 * Validate and parse a messages JSON file: must exist, be a regular `.json` file, and be at most 5 MB.
 * A UTF-8 BOM (written by Windows PowerShell 5.1 `Out-File`/`Set-Content`) is tolerated.
 */
export function readImportFile(filePath, { maxBytes = MAX_IMPORT_BYTES } = {}) {
  if (!filePath || typeof filePath !== 'string') throw new ScriptError('Usage: npm run import -- <path-to-messages.json>');
  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== '.json') throw new ScriptError(`Not a .json file: ${resolved}`);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new ScriptError(`File not found: ${resolved}`);
  }
  if (!stat.isFile()) throw new ScriptError(`Not a regular file: ${resolved}`);
  if (stat.size > maxBytes) {
    throw new ScriptError(`File is ${(stat.size / 1024 / 1024).toFixed(1)} MB; the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  }
  const text = fs.readFileSync(resolved, 'utf8').replace(/^﻿/, '');
  try {
    return { path: resolved, payload: JSON.parse(text) };
  } catch (err) {
    throw new ScriptError(`Invalid JSON in ${resolved}: ${err.message}`);
  }
}

/**
 * Import a payload into an open database using the same rules as POST /api/messages/import
 * (validation, duplicate detection, 5000-item cap). Returns { imported, skipped }.
 */
export function importIntoDatabase(db, payload) {
  const activity = createActivityService({ db });
  const messages = createMessagesService({ db, activity });
  try {
    return messages.importMessages(payload, { source: 'import' });
  } catch (err) {
    if (err?.name === 'AppError') throw new ScriptError(err.message);
    throw err;
  }
}

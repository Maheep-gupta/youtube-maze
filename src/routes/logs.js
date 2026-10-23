import express from 'express';
import { ah, parse } from '../lib/http.js';
import { redact } from '../logger.js';
import { clearLogsSchema, exportLogsQuerySchema, listLogsQuerySchema } from '../validation/logs.js';

const CSV_COLUMNS = ['id', 'ts', 'eventType', 'level', 'sessionId', 'connectionId', 'provider', 'category', 'outcome', 'messageId', 'details'];

/**
 * One CSV cell: neutralize spreadsheet formulas (OWASP CSV injection) by prefixing a single quote
 * to values starting with = + - @ (or tab / CR), then always quote and double embedded quotes.
 */
export function csvCell(value) {
  let s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(entries) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const e of entries) lines.push(CSV_COLUMNS.map((c) => csvCell(e[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Mounted at /api/logs. */
export default function logsRouter(ctx) {
  const r = express.Router();
  const { activity } = ctx;

  r.get('/', ah(async (req, res) => {
    res.json(activity.list(parse(listLogsQuerySchema, req.query)));
  }));

  r.get('/export', ah(async (req, res) => {
    const { format, level, group, connectionId } = parse(exportLogsQuerySchema, req.query);
    const entries = redact(activity.exportAll({ level, group, connectionId }));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      res.set('Content-Disposition', `attachment; filename="activity-${stamp}.csv"`);
      return res.type('text/csv; charset=utf-8').send(toCsv(entries));
    }
    res.set('Content-Disposition', `attachment; filename="activity-${stamp}.json"`);
    res.type('application/json').send(JSON.stringify({ exportedAt: new Date().toISOString(), items: entries }, null, 2));
  }));

  r.delete('/', ah(async (req, res) => {
    parse(clearLogsSchema, req.body ?? {});
    res.json({ cleared: activity.clear() });
  }));

  return r;
}

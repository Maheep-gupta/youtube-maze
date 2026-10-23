/** Express 4 does not forward rejected promises; wrap async handlers with this. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parse with a zod schema; ZodError is turned into a 400 by the central error handler. */
export const parse = (schema, data) => schema.parse(data);

/** Route param `:id` as a positive integer, or throws (handled as 400). */
export function intId(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    const err = new Error('Invalid id');
    err.name = 'ZodError';
    err.issues = [{ path: ['id'], message: 'Must be a positive integer' }];
    throw err;
  }
  return n;
}

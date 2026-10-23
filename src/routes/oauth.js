import express from 'express';
import { ah, parse } from '../lib/http.js';
import { oauthCallbackQuery } from '../validation/connections.js';

/**
 * /oauth — Google redirects the browser here after consent. Success -> 302 to the dashboard;
 * failures throw and the central error handler renders an HTML error page for /oauth paths.
 * The code/state are never logged or echoed back.
 */
export default function oauthRouter(ctx) {
  const r = express.Router();

  r.get('/google/callback', ah(async (req, res) => {
    const query = parse(oauthCallbackQuery, req.query);
    await ctx.connections.completeYouTubeAuth(query);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, '/#connections');
  }));

  return r;
}

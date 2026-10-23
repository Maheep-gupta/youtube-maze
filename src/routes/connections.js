import express from 'express';
import { ah, parse } from '../lib/http.js';
import { AppError, isAccountError } from '../errors.js';
import { connectionIdParams, testConnectionBody } from '../validation/connections.js';

/** /api/connections — never returns tokens (the service's public shape excludes them). */
export default function connectionsRouter(ctx, { strictLimiter } = {}) {
  const r = express.Router();
  const limit = strictLimiter ? [strictLimiter] : [];

  r.get('/', ah(async (_req, res) => {
    res.json({
      items: ctx.connections.list(),
      oauthConfigured: ctx.googleOAuth.isConfigured(),
      chatProvider: ctx.config.chatProvider,
    });
  }));

  r.post('/youtube/start', ...limit, ah(async (_req, res) => {
    res.json(await ctx.connections.beginYouTubeAuth());
  }));

  /** Re-authorize THIS account (Google account chooser; a different channel is rejected at the callback). */
  r.post('/:id/reconnect', ...limit, ah(async (req, res) => {
    const { id } = parse(connectionIdParams, req.params);
    res.json(await ctx.connections.beginYouTubeAuth({ connectionId: id }));
  }));

  /** Refresh Status: refresh the token, re-read the channel, verify the posting scope. */
  r.post('/:id/refresh', ...limit, ah(async (req, res) => {
    const { id } = parse(connectionIdParams, req.params);
    res.json(await ctx.connections.refresh(id));
  }));

  r.post('/test', ah(async (req, res) => {
    const body = parse(testConnectionBody, req.body ?? {});
    res.status(201).json(ctx.connections.addTestConnection(body));
  }));

  r.post('/:id/check', ah(async (req, res) => {
    const { id } = parse(connectionIdParams, req.params);
    const conn = ctx.connections.get(id);
    const provider = ctx.chatProviders[conn.provider];
    if (!provider) throw new AppError('NOT_CONFIGURED', `No chat provider "${conn.provider}" is available.`, { status: 400 });
    try {
      const auth = await ctx.connections.getAuth(id);
      const broadcast = await provider.getActiveBroadcast(auth);
      const chat = broadcast
        ? await provider.checkChat(auth, broadcast.liveChatId)
        : { available: false, reason: 'No active livestream was found for this channel.' };
      res.json({ broadcast: broadcast ? { title: broadcast.title, broadcastId: broadcast.broadcastId } : null, chat });
    } catch (err) {
      if (err?.name === 'ChatProviderError' && isAccountError(err)) ctx.connections.markError(id, err);
      throw err;
    }
  }));

  r.post('/:id/disconnect', ah(async (req, res) => {
    const { id } = parse(connectionIdParams, req.params);
    res.json(await ctx.connections.disconnect(id));
  }));

  r.delete('/:id', ah(async (req, res) => {
    const { id } = parse(connectionIdParams, req.params);
    await ctx.connections.remove(id);
    res.status(204).end();
  }));

  return r;
}

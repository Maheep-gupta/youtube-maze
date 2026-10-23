import { AiProviderError } from '../../errors.js';
import { redactString } from '../../logger.js';
import { YOUTUBE_MAX_MESSAGE_LENGTH } from '../../config.js';

/**
 * Generic OpenAI-compatible Chat Completions provider (OpenAI, Azure-style proxies, OpenRouter,
 * LM Studio, Ollama's /v1 endpoint, ...). Returns RAW candidate strings; the drafts service
 * sanitizes and validates them.
 *
 * `response_format: { type: 'json_object' }` is not supported everywhere, so the model is asked
 * for a JSON object in the prompt and the reply is parsed defensively.
 */

const CATEGORY_GUIDANCE = {
  compliments: 'sincere, specific-sounding compliments about the stream, the gameplay/content, or the vibe',
  sarcasm: 'light, playful, affectionate sarcasm that the creator and viewers would laugh at; never mean, never insulting, never punching down',
  witty_jokes: 'short clever jokes, puns, or one-liners that fit a live chat',
  motivation: 'encouraging, upbeat messages that motivate the creator and the community',
  wholesome: 'warm, kind, feel-good messages that make the chat a nicer place',
};

const EMOJI_GUIDANCE = {
  none: 'Do not use any emoji.',
  some: 'Use at most one emoji in some of the messages; many should have none.',
  lots: 'Use one to three emoji per message.',
};

const LENGTH_GUIDANCE = {
  short: 'Keep each message short: roughly 20 to 60 characters.',
  medium: 'Aim for roughly 60 to 110 characters per message.',
  long: 'Messages may be longer: roughly 100 characters up to the maximum.',
};

/** Free-text prompt parameters are validated at the route; re-clean here as defense in depth. */
const cleanParam = (value, fallback) => {
  const s = String(value ?? '').replace(/[^\p{L}\p{M}\p{N} ,.'&()-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || fallback;
};

export function buildPrompt({ category, tone, language, emoji, length, maxLength, count }) {
  const limit = Math.min(Number(maxLength) || 150, YOUTUBE_MAX_MESSAGE_LENGTH);
  const system = [
    'You write short live-chat messages that a YouTube creator will post in the chat of THEIR OWN livestream, from their own channel account.',
    'Rules (all mandatory):',
    '- Friendly and positive. No hate, harassment, insults about real people, slurs, sexual content, violence, or politics.',
    '- No links or URLs, no @mentions, no hashtags spam, no phone numbers, emails, names of real private people, or any personal data.',
    '- Never pretend to be a viewer, a different person, or claim to be a human; never fake donations, subscriptions, or giveaways.',
    '- No requests for money, follows, or subscriptions; no spam, no repeated characters.',
    '- Each message must stand alone and be distinct from the others.',
    'Output format: reply with ONLY a JSON object of the form {"messages": ["first message", "second message"]}. No commentary, no markdown.',
  ].join('\n');
  const user = [
    `Write ${count} distinct chat messages.`,
    `Category: ${category} — ${CATEGORY_GUIDANCE[category] ?? 'friendly chat messages'}.`,
    `Tone: ${cleanParam(tone, 'friendly')}.`,
    `Language: ${cleanParam(language, 'en')} (write every message in this language).`,
    EMOJI_GUIDANCE[emoji] ?? EMOJI_GUIDANCE.some,
    LENGTH_GUIDANCE[length] ?? LENGTH_GUIDANCE.short,
    `Hard limit: every message must be at most ${limit} characters.`,
  ].join('\n');
  return { system, user, limit };
}

/** Pull candidate strings out of model output. Throws BAD_RESPONSE if nothing usable. */
export function parseCandidates(content) {
  if (typeof content !== 'string' || !content.trim()) throw new AiProviderError('BAD_RESPONSE', 'The AI provider returned an empty response.');
  const stripped = content.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();

  const json = tryParseJson(stripped);
  if (json.ok) {
    const list = Array.isArray(json.value) ? json.value
      : Array.isArray(json.value?.messages) ? json.value.messages
      : null;
    if (!list) throw new AiProviderError('BAD_RESPONSE', 'The AI provider returned JSON in an unexpected shape.');
    return list
      .map((item) => (typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : null))
      .filter((s) => s != null);
  }

  // Not JSON: fall back to one candidate per line, skipping JSON/markdown debris.
  const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[[\]{}(),:"']+$/.test(l) && !/^"?messages"?\s*:/.test(l));
  if (!lines.length) throw new AiProviderError('BAD_RESPONSE', 'The AI provider response could not be parsed.');
  return lines.map((l) => l.replace(/^"(.*)",?$/, '$1'));
}

function tryParseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { /* try a slice below */ }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try { return { ok: true, value: JSON.parse(text.slice(start, end + 1)) }; } catch { /* next */ }
    }
  }
  return { ok: false };
}

function validBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export function createOpenAiCompatibleProvider({ baseUrl, model, apiKey, timeoutMs = 30000, fetch = globalThis.fetch } = {}) {
  const parsedUrl = baseUrl ? validBaseUrl(baseUrl) : null;
  // Mask the key in every message even if it was never registered with the logger.
  const safe = (msg) => {
    let out = String(msg);
    if (apiKey) out = out.split(apiKey).join('[REDACTED]');
    return redactString(out).slice(0, 300);
  };

  return {
    name: 'openai-compatible',
    model: model || null,
    baseUrlHost: parsedUrl?.host ?? null,
    isConfigured: () => Boolean(apiKey && baseUrl && model),

    async generateMessages(opts) {
      if (!apiKey || !baseUrl || !model) {
        throw new AiProviderError('NOT_CONFIGURED', 'AI generation is not configured. Set AI_API_KEY, AI_BASE_URL and AI_MODEL in .env.');
      }
      if (!parsedUrl) throw new AiProviderError('NOT_CONFIGURED', 'AI_BASE_URL must be an http(s) URL.');

      const count = Math.max(1, Math.min(20, Number(opts.count) || 5));
      const { system, user } = buildPrompt({ ...opts, count });
      const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

      let res;
      let raw;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.9,
            max_tokens: Math.min(4000, 200 + count * 120),
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        raw = await res.text();
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw new AiProviderError('TIMEOUT', `The AI provider did not respond within ${Math.round(timeoutMs / 1000)} s.`);
        }
        // Deliberately no `cause`: the underlying error may echo request details.
        throw new AiProviderError('NETWORK', `Could not reach the AI provider at ${parsedUrl.host}.`);
      }

      if (!res.ok) {
        const upstream = upstreamMessage(raw);
        const suffix = upstream ? `: ${safe(upstream)}` : '.';
        if (res.status === 401 || res.status === 403) throw new AiProviderError('AUTH_FAILED', `The AI provider rejected the API key (HTTP ${res.status}). Check AI_API_KEY.`);
        if (res.status === 429) throw new AiProviderError('RATE_LIMITED', 'The AI provider rate limit or quota was reached. Try again later.');
        throw new AiProviderError('BAD_RESPONSE', safe(`The AI provider returned HTTP ${res.status}${suffix}`));
      }

      let data;
      try { data = JSON.parse(raw); } catch {
        throw new AiProviderError('BAD_RESPONSE', 'The AI provider returned a response that is not valid JSON.');
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AiProviderError('BAD_RESPONSE', 'The AI provider response did not contain a message.');
      return parseCandidates(content).slice(0, count * 2);
    },
  };
}

function upstreamMessage(raw) {
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message ?? j?.message;
    return typeof m === 'string' ? m : '';
  } catch {
    return '';
  }
}

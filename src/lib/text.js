import { YOUTUBE_MAX_MESSAGE_LENGTH } from '../config.js';

/**
 * Shared message-text rules used by the message library, AI drafts, imports and chat providers.
 */

// C0/C1 control chars except tab/newline; zero-width and bidi-override chars.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/i;

/** Strip control/invisible chars, collapse whitespace, trim surrounding quotes/bullets/numbering. */
export function sanitizeText(input) {
  return String(input ?? '')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*•]\s+|\d{1,3}[.)]\s+)/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

/** Canonical form for duplicate detection: case-, whitespace-, punctuation- and emoji-insensitive. */
export function normalizeForCompare(input) {
  return sanitizeText(input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Extended_Pictographic}️]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Length in user-perceived characters (emoji count as one), which is how YouTube counts. */
export function visibleLength(text) {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
}

/**
 * Validate a (sanitized) message. Returns { ok: true, text } or { ok: false, reason }.
 * @param {string} input
 * @param {{ maxLength?: number, allowUrls?: boolean }} [opts]
 */
export function validateMessageText(input, { maxLength = YOUTUBE_MAX_MESSAGE_LENGTH, allowUrls = false } = {}) {
  const text = sanitizeText(input);
  if (!text) return { ok: false, reason: 'Message is empty.' };
  const limit = Math.min(maxLength, YOUTUBE_MAX_MESSAGE_LENGTH);
  if (visibleLength(text) > limit) return { ok: false, reason: `Message exceeds ${limit} characters.` };
  if (!normalizeForCompare(text)) return { ok: false, reason: 'Message has no readable text.' };
  if (!allowUrls && URL_LIKE.test(text)) return { ok: false, reason: 'Links are not allowed in scheduled messages.' };
  if (/(.)\1{9,}/u.test(text)) return { ok: false, reason: 'Message contains excessive repeated characters.' };
  return { ok: true, text };
}

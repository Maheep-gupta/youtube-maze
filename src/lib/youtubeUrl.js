import { AppError } from '../errors.js';

const MAX_URL_LENGTH = 2048;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORT_HOST = 'youtu.be';

const invalid = (message) => new AppError('INVALID_STREAM_URL', message, { status: 400 });

export const isValidVideoId = (id) => typeof id === 'string' && VIDEO_ID_RE.test(id);

/** Canonical watch URL for a validated video id. */
export const canonicalWatchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

/**
 * Parse a YouTube livestream URL and extract its video id. Accepted forms (http or https):
 *   https://www.youtube.com/watch?v=VIDEO_ID   (also youtube.com, m.youtube.com)
 *   https://youtu.be/VIDEO_ID
 *   https://www.youtube.com/live/VIDEO_ID
 * Hosts are matched exactly (no look-alike or sub-domains), credentials in the URL are rejected,
 * and the id must be exactly 11 characters of [A-Za-z0-9_-].
 * @returns {{ videoId: string, url: string }}
 */
export function parseYouTubeStreamUrl(input) {
  if (typeof input !== 'string') throw invalid('Enter a YouTube livestream URL.');
  const raw = input.trim();
  if (!raw) throw invalid('Enter a YouTube livestream URL.');
  if (raw.length > MAX_URL_LENGTH) throw invalid('The URL is too long.');

  let u;
  try { u = new URL(raw); } catch { throw invalid('That is not a valid URL. Paste the full link, e.g. https://www.youtube.com/watch?v=VIDEO_ID.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw invalid('Only http(s) YouTube links are accepted.');
  if (u.username || u.password) throw invalid('URLs containing credentials are not accepted.');
  if (u.port) throw invalid('YouTube links never include a port number.');

  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split('/').filter(Boolean);
  let id;
  if (host === SHORT_HOST) {
    if (segments.length !== 1) throw invalid('A youtu.be link must look like https://youtu.be/VIDEO_ID.');
    id = segments[0];
  } else if (WATCH_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === 'watch') {
      const values = u.searchParams.getAll('v');
      if (values.length !== 1) throw invalid('The link has no video id (missing ?v=VIDEO_ID).');
      id = values[0];
    } else if (segments.length === 2 && segments[0] === 'live') {
      id = segments[1];
    } else {
      throw invalid('Use a livestream video link (/watch?v=…, /live/… or youtu.be/…), not a channel, Shorts or playlist link.');
    }
  } else {
    throw invalid('Only youtube.com and youtu.be links are accepted.');
  }

  if (!isValidVideoId(id)) throw invalid('The video id in this link is malformed (expected 11 letters, digits, "-" or "_").');
  return { videoId: id, url: canonicalWatchUrl(id) };
}

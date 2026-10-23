// Single fetch wrapper for the dashboard. Fetches the CSRF token once and sends it on
// every state-changing request. Errors from the server ({ error: { code, message, hint, details } })
// become ApiError instances.

export class ApiError extends Error {
  constructor({ code = 'ERROR', message = 'Request failed.', hint, details, status } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint;
    this.details = details;
    this.status = status;
  }
}

let csrfPromise = null;

async function getCsrfToken({ refresh = false } = {}) {
  if (refresh) csrfPromise = null;
  if (!csrfPromise) {
    csrfPromise = fetch('/api/csrf', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw await toApiError(res);
        const body = await res.json();
        return body.token;
      })
      .catch((err) => {
        csrfPromise = null;
        throw err;
      });
  }
  return csrfPromise;
}

async function toApiError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  const e = body && body.error ? body.error : {};
  return new ApiError({
    code: e.code || `HTTP_${res.status}`,
    message: e.message || `Request failed (${res.status} ${res.statusText}).`,
    hint: e.hint,
    details: e.details,
    status: res.status,
  });
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, query?: Record<string, unknown> }} [opts]
 */
export async function request(path, { method = 'GET', body, query } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const isGet = method === 'GET' || method === 'HEAD';
  const send = async (token) => {
    const headers = { Accept: 'application/json' };
    if (!isGet) {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = token;
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        body: isGet ? undefined : JSON.stringify(body ?? {}),
      });
    } catch {
      throw new ApiError({ code: 'NETWORK_ERROR', message: 'Cannot reach the local server.', hint: 'Is `npm start` still running?' });
    }
    return res;
  };

  let res = await send(isGet ? null : await getCsrfToken());
  // The server's CSRF token is per-process; if it restarted, refresh once and retry.
  if (!isGet && res.status === 403) {
    const err = await toApiError(res.clone());
    if (err.code === 'BAD_CSRF') res = await send(await getCsrfToken({ refresh: true }));
  }
  if (res.status === 204) return null;
  if (!res.ok) throw await toApiError(res);
  const type = res.headers.get('content-type') || '';
  return type.includes('application/json') ? res.json() : res.text();
}

export const api = {
  get: (path, query) => request(path, { query }),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path, body) => request(path, { method: 'DELETE', body }),
};

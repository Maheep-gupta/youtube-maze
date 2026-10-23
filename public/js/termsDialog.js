// External Livestream Terms: rendering and the confirmation modal. The checkbox stays disabled until
// the end of the terms has been scrolled into view; nothing is recorded unless the user chooses
// Accept or Decline (Escape/close records nothing). Acceptance is a local record only: the server
// still runs every authorization and permission check.
import { api } from './api.js';
import { el, openDialog, errorBox, withBusy } from './ui.js';

let cached = null;

/** Current terms from the server (cached; pass refresh after TERMS_OUTDATED). */
export async function getTerms({ refresh = false } = {}) {
  if (!cached || refresh) cached = await api.get('/api/terms/external-stream');
  return cached;
}

/** The terms text: draft notice, version line, sections. */
export function renderTerms(terms) {
  return el('div', { class: 'terms-text' },
    el('p', { class: 'terms-draft', attrs: { role: 'note' }, text: terms.draftNotice }),
    el('p', { class: 'muted small', text: `Version ${terms.version} · effective ${terms.effectiveDate}` }),
    terms.sections.map((s) => el('section', { class: 'terms-section' },
      el('h3', { text: s.heading }),
      s.paragraphs.map((p) => el('p', { text: p })))));
}

/**
 * Ask for a decision before starting/resuming an external-stream workflow.
 * Resolves 'accepted', 'declined', or undefined (closed without deciding).
 */
export async function askExternalTerms({ connectionId, videoId, accountLabel, streamLabel }) {
  let terms = await getTerms();
  return openDialog({
    title: 'External livestream: terms and responsibility',
    className: 'dialog-terms',
    build(body, close) {
      const scope = el('p', { class: 'small', text: `Account: ${accountLabel || connectionId} · Livestream: ${streamLabel || videoId}` });
      const region = el('div', { class: 'terms-scroll', attrs: { tabindex: '0', role: 'region', 'aria-label': 'Terms text' } });
      const sentinel = el('div', { class: 'terms-end', attrs: { 'aria-hidden': 'true' } });
      const box = el('input', { type: 'checkbox', name: 'acceptTerms', disabled: true, attrs: { 'aria-describedby': 'terms-gate' } });
      const gate = el('p', { id: 'terms-gate', class: 'muted small', attrs: { 'aria-live': 'polite' }, text: 'Scroll to the end of the terms to enable the checkbox.' });
      const errors = el('div');
      const decline = el('button', { type: 'button', class: 'btn', text: 'Decline' });
      const accept = el('button', { type: 'button', class: 'btn btn-primary', text: 'Accept and continue', disabled: true });
      const label = el('label', { class: 'check terms-accept' }, box, el('span'));

      const fill = () => {
        region.replaceChildren(renderTerms(terms), sentinel);
        label.lastChild.textContent = terms.acceptLabel;
      };
      const unlock = () => {
        if (!box.disabled) return;
        box.disabled = false;
        gate.textContent = 'You reached the end of the terms. Tick the box to accept, or decline.';
      };
      fill();
      // Enable only after the end of the text has been visible (or immediately if nothing scrolls).
      const io = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) unlock(); }, { root: region, threshold: 1 })
        : null;
      if (io) io.observe(sentinel);
      region.addEventListener('scroll', () => { if (region.scrollTop + region.clientHeight >= region.scrollHeight - 4) unlock(); });
      requestAnimationFrame(() => { if (region.scrollHeight <= region.clientHeight + 4) unlock(); });

      box.addEventListener('change', () => { accept.disabled = !box.checked; });

      const decide = async (accepted, button) => {
        errors.replaceChildren();
        try {
          await withBusy(button, () => api.post('/api/terms/acknowledgements', {
            connectionId, videoId, accepted, termsVersion: terms.version, contentHash: terms.contentHash,
          }));
          io?.disconnect();
          close(accepted ? 'accepted' : 'declined');
        } catch (err) {
          errors.append(errorBox(err));
          if (err.code === 'TERMS_OUTDATED') {
            // The terms changed while open: show the new version and require reading it again.
            terms = await getTerms({ refresh: true });
            box.checked = false; box.disabled = true; accept.disabled = true;
            gate.textContent = 'The terms were updated. Scroll to the end of the new version to enable the checkbox.';
            fill();
            region.scrollTop = 0;
            io?.observe(sentinel);
          }
        }
      };
      decline.addEventListener('click', () => decide(false, decline));
      accept.addEventListener('click', () => decide(true, accept));

      body.append(scope, region, gate, label, errors,
        el('div', { class: 'btn-row dialog-actions' }, decline, accept));
      requestAnimationFrame(() => region.focus());
    },
  });
}

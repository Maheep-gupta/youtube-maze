import { api } from './api.js';
import {
  el, clear, pill, timeEl, categoryLabel, CATEGORIES, MAX_MESSAGE_LENGTH, graphemeLength, debounce,
  toast, toastError, errorBox, confirmDialog, openDialog, withBusy, field, download,
} from './ui.js';

const PAGE_SIZE = 50;
const TONES = ['friendly', 'playful', 'dry', 'energetic', 'calm'];
const LANGUAGES = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean']];

const state = { category: '', q: '', offset: 0, total: 0, items: [], drafts: [], selected: new Set() };
let refs;

function categoryOptions(selected, { includeAll = false } = {}) {
  const opts = includeAll ? [el('option', { value: '', text: 'All categories' })] : [];
  for (const c of CATEGORIES) opts.push(el('option', { value: c, text: categoryLabel(c), selected: c === selected }));
  return opts;
}

export function init(container) {
  refs = {
    tabs: el('div', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Filter by category' } }),
    search: el('input', { type: 'search', placeholder: 'Search messages…', attrs: { 'aria-label': 'Search messages' } }),
    list: el('div', { class: 'table-wrap' }),
    pager: el('div', { class: 'pager' }),
    listError: el('div'),
    fileInput: el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', attrs: { 'aria-hidden': 'true', tabindex: '-1' } }),
    aiStatus: el('div', { class: 'ai-status' }),
    aiForm: null,
    rejected: el('div'),
    drafts: el('div', { class: 'drafts' }),
    draftBar: el('div', { class: 'draft-bar' }),
  };

  const debouncedSearch = debounce(() => { state.q = refs.search.value.trim(); state.offset = 0; loadMessages(); }, 300);
  refs.search.addEventListener('input', debouncedSearch);

  const tabDefs = [['', 'All'], ...CATEGORIES.map((c) => [c, categoryLabel(c)])];
  for (const [value, label] of tabDefs) {
    const b = el('button', { type: 'button', class: 'tab', text: label, attrs: { role: 'tab', 'aria-selected': String(value === state.category) }, dataset: { value } });
    b.addEventListener('click', () => {
      state.category = value; state.offset = 0;
      for (const t of refs.tabs.children) t.setAttribute('aria-selected', String(t.dataset.value === value));
      loadMessages();
    });
    refs.tabs.append(b);
  }

  refs.fileInput.addEventListener('change', onImportFile);

  const newBtn = el('button', { type: 'button', class: 'btn btn-primary', text: 'New message', on: { click: () => messageDialog({ mode: 'create' }) } });
  const importBtn = el('button', { type: 'button', class: 'btn', text: 'Import JSON', on: { click: () => { refs.fileInput.value = ''; refs.fileInput.click(); } } });
  const exportBtn = el('button', { type: 'button', class: 'btn', text: 'Export', on: { click: () => download('/api/messages/export') } });
  const samplesBtn = el('button', { type: 'button', class: 'btn', text: 'Load sample library' });
  samplesBtn.addEventListener('click', () => withBusy(samplesBtn, async () => {
    try { showImportResult(await api.post('/api/messages/load-samples', {}), 'Sample library'); loadMessages(); } catch (err) { toastError(err, 'Could not load samples'); }
  }));

  clear(container,
    el('header', { class: 'view-header' }, el('h1', { text: 'Message Studio' })),
    el('section', { class: 'card' },
      el('div', { class: 'card-title-row' },
        el('h2', { class: 'card-title', text: 'Message library' }),
        el('div', { class: 'btn-row' }, newBtn, importBtn, exportBtn, samplesBtn, refs.fileInput)),
      el('div', { class: 'toolbar' }, refs.tabs, refs.search),
      refs.listError, refs.list, refs.pager),
    el('div', { class: 'grid grid-studio' },
      el('section', { class: 'card' },
        el('h2', { class: 'card-title', text: 'Generate drafts' }),
        refs.aiStatus, buildAiForm(), refs.rejected),
      el('section', { class: 'card' },
        el('div', { class: 'card-title-row' }, el('h2', { class: 'card-title', text: 'Drafts to review' }),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Clear decided', on: { click: clearDecided } })),
        el('p', { class: 'muted small', text: 'Drafts are not used by the scheduler until you approve them into the library.' }),
        refs.draftBar, refs.drafts)));
}

export function show() {
  loadMessages();
  loadAiStatus();
  loadDrafts();
}

// ---------------- library ----------------

async function loadMessages() {
  try {
    const data = await api.get('/api/messages', { category: state.category, q: state.q, limit: PAGE_SIZE, offset: state.offset });
    state.items = data.items || [];
    state.total = data.total ?? state.items.length;
    refs.listError.replaceChildren();
    renderMessages();
  } catch (err) {
    clear(refs.listError, errorBox(err));
  }
}

function renderMessages() {
  if (!state.items.length) {
    clear(refs.list, el('p', { class: 'empty', text: state.q || state.category ? 'No messages match this filter.' : 'No messages yet. Create one, import JSON, or load the sample library.' }));
    refs.pager.replaceChildren();
    return;
  }
  const rows = state.items.map((m) => {
    const toggleId = `en-${m.id}`;
    const toggle = el('input', { type: 'checkbox', id: toggleId, class: 'switch', checked: Boolean(m.enabled), attrs: { 'aria-label': `Enabled: ${m.text.slice(0, 40)}` } });
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try { Object.assign(m, await api.patch(`/api/messages/${m.id}`, { enabled: toggle.checked })); }
      catch (err) { toggle.checked = !toggle.checked; toastError(err, 'Could not update message'); }
      finally { toggle.disabled = false; }
    });
    return el('tr', {},
      el('td', { class: 'cell-text', text: m.text }),
      el('td', {}, el('span', { class: 'tag', text: categoryLabel(m.category) })),
      el('td', {}, toggle),
      el('td', { class: 'num', text: m.timesSent ?? 0 }),
      el('td', {}, m.lastSentAt ? timeEl(m.lastSentAt) : el('span', { class: 'muted', text: 'never' })),
      el('td', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-sm', text: 'Edit', on: { click: () => messageDialog({ mode: 'edit', message: m }) } }),
        el('button', { type: 'button', class: 'btn btn-sm', text: 'Duplicate', on: { click: () => messageDialog({ mode: 'duplicate', message: m }) } }),
        el('button', { type: 'button', class: 'btn btn-sm btn-danger-ghost', text: 'Delete', on: { click: () => deleteMessage(m) } })));
  });
  clear(refs.list, el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      ...['Message', 'Category', 'Enabled', 'Sent', 'Last sent', 'Actions'].map((h) => el('th', { attrs: { scope: 'col' }, class: h === 'Sent' ? 'num' : undefined, text: h })))),
    el('tbody', {}, rows)));

  const from = state.offset + 1;
  const to = state.offset + state.items.length;
  const prev = el('button', { type: 'button', class: 'btn btn-sm', text: '← Previous', disabled: state.offset === 0, on: { click: () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); loadMessages(); } } });
  const next = el('button', { type: 'button', class: 'btn btn-sm', text: 'Next →', disabled: to >= state.total, on: { click: () => { state.offset += PAGE_SIZE; loadMessages(); } } });
  clear(refs.pager, el('span', { class: 'muted small', text: `${from}–${to} of ${state.total}` }), prev, next);
}

async function deleteMessage(m) {
  const ok = await confirmDialog({ title: 'Delete message?', message: `"${m.text}" will be permanently removed from the library.`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try { await api.del(`/api/messages/${m.id}`); toast('Message deleted.', { tone: 'success' }); loadMessages(); }
  catch (err) { toastError(err, 'Could not delete message'); }
}

/** Live counter + debounced duplicate check bound to a textarea. */
function bindTextChecks(textarea, { counter, dupStatus, excludeId, original, onState }) {
  let dupState = { checking: false, duplicate: false };
  let seq = 0;
  const emit = () => onState?.({ length: graphemeLength(textarea.value.trim()), ...dupState });
  const check = debounce(async () => {
    const text = textarea.value.trim();
    const my = ++seq;
    if (!text) { dupState = { checking: false, duplicate: false }; dupStatus.replaceChildren(); emit(); return; }
    try {
      const r = await api.post('/api/messages/check-duplicate', excludeId ? { text, excludeId } : { text });
      if (my !== seq) return;
      dupState = { checking: false, duplicate: Boolean(r.duplicate) };
      clear(dupStatus, r.duplicate
        ? pill(`Duplicate of an existing message${r.existing?.text ? `: "${r.existing.text}"` : ''}`, 'red')
        : pill('Unique', 'green'));
    } catch {
      if (my !== seq) return;
      dupState = { checking: false, duplicate: false };
      clear(dupStatus, el('span', { class: 'muted small', text: 'Duplicate check unavailable.' }));
    }
    emit();
  }, 350);
  const update = () => {
    const len = graphemeLength(textarea.value.trim());
    counter.textContent = `${len} / ${MAX_MESSAGE_LENGTH}`;
    counter.classList.toggle('over', len > MAX_MESSAGE_LENGTH);
    if (original !== undefined && textarea.value.trim() === original.trim()) {
      dupState = { checking: false, duplicate: true };
      clear(dupStatus, pill('Change the text — duplicates are not allowed', 'amber'));
      check.cancel();
      emit();
      return;
    }
    dupState = { checking: true, duplicate: false };
    emit();
    check();
  };
  textarea.addEventListener('input', update);
  update();
}

function messageDialog({ mode, message }) {
  const titles = { create: 'New message', edit: 'Edit message', duplicate: 'Duplicate message' };
  return openDialog({
    title: titles[mode],
    className: 'dialog-wide',
    build(body, close) {
      const textarea = el('textarea', { rows: 3, required: true, value: message?.text || '', attrs: { autofocus: true } });
      const counter = el('span', { class: 'counter', attrs: { 'aria-live': 'polite' } });
      const dupStatus = el('div', { class: 'dup-status', attrs: { 'aria-live': 'polite' } });
      const category = el('select', {}, categoryOptions(message?.category || state.category || CATEGORIES[0]));
      const enabled = el('input', { type: 'checkbox', checked: message ? Boolean(message.enabled) : true });
      const errors = el('div');
      const save = el('button', { type: 'submit', class: 'btn btn-primary', text: mode === 'edit' ? 'Save changes' : 'Create message' });

      if (mode === 'duplicate') body.append(el('p', { class: 'muted small', text: 'Edit the text so it differs from the original — exact duplicates are rejected.' }));
      const form = el('form', { class: 'stack' },
        field('Message text', textarea, { help: 'Max 200 characters (emoji count as one). Links are not allowed.' }),
        el('div', { class: 'text-meta' }, dupStatus, counter),
        el('div', { class: 'form-row' },
          field('Category', category),
          el('label', { class: 'check' }, enabled, el('span', { text: 'Enabled' }))),
        errors,
        el('div', { class: 'dialog-actions' },
          el('button', { type: 'button', class: 'btn', text: 'Cancel', on: { click: () => close(null) } }), save));

      bindTextChecks(textarea, {
        counter, dupStatus,
        excludeId: mode === 'edit' ? message.id : undefined,
        original: mode === 'duplicate' ? message.text : undefined,
        onState: ({ length, duplicate }) => { save.disabled = !length || length > MAX_MESSAGE_LENGTH || duplicate; },
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errors.replaceChildren();
        const payload = { text: textarea.value.trim(), category: category.value, enabled: enabled.checked };
        try {
          await withBusy(save, () => (mode === 'edit'
            ? api.patch(`/api/messages/${message.id}`, payload)
            : api.post('/api/messages', payload)));
          toast(mode === 'edit' ? 'Message saved.' : 'Message created.', { tone: 'success' });
          close(true);
          loadMessages();
        } catch (err) {
          errors.append(errorBox(err));
        }
      });
      body.append(form);
    },
  });
}

async function onImportFile() {
  const file = refs.fileInput.files?.[0];
  if (!file) return;
  if (file.size > 900 * 1024) { toast('File is too large (max ~900 KB).', { tone: 'error' }); return; }
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { toast('That file is not valid JSON.', { tone: 'error', hint: 'Expected { "version": 1, "messages": [{ "text", "category" }] } or an array.' }); return; }
  try { showImportResult(await api.post('/api/messages/import', payload), file.name); loadMessages(); }
  catch (err) { toastError(err, 'Import failed'); }
}

function showImportResult(result, sourceName) {
  const skipped = result?.skipped || [];
  openDialog({
    title: 'Import complete',
    build(body, close) {
      body.append(
        el('p', { text: `${sourceName}: imported ${result?.imported ?? 0}, skipped ${skipped.length}.` }),
        skipped.length ? el('div', { class: 'scroll-box' },
          el('table', { class: 'table table-compact' },
            el('thead', {}, el('tr', {}, el('th', { attrs: { scope: 'col' }, text: 'Text' }), el('th', { attrs: { scope: 'col' }, text: 'Reason' }))),
            el('tbody', {}, skipped.slice(0, 200).map((s) => el('tr', {}, el('td', { class: 'cell-text', text: typeof s.text === 'string' ? s.text : JSON.stringify(s.text ?? '') }), el('td', { text: s.reason || '' })))))) : null,
        skipped.length > 200 ? el('p', { class: 'muted small', text: `…and ${skipped.length - 200} more.` }) : null,
        el('div', { class: 'dialog-actions' }, el('button', { type: 'button', class: 'btn btn-primary', text: 'Close', on: { click: () => close() } })));
    },
  });
}

// ---------------- AI drafts ----------------

let aiConfigured = false;
async function loadAiStatus() {
  try {
    const s = await api.get('/api/drafts/ai-status');
    aiConfigured = Boolean(s.configured);
    clear(refs.aiStatus, s.configured
      ? el('div', {}, pill('AI configured', 'green'), el('span', { class: 'muted small', text: ` ${[s.provider, s.model, s.baseUrlHost].filter(Boolean).join(' · ')}` }))
      : el('div', {}, pill('AI not configured', 'grey'), el('span', { class: 'muted small', text: ' AI not configured — preset library will be used.' })));
    const aiOpt = refs.aiForm?.querySelector('option[value="ai"]');
    if (aiOpt) aiOpt.disabled = !aiConfigured;
  } catch (err) {
    clear(refs.aiStatus, errorBox(err));
  }
}

function buildAiForm() {
  const category = el('select', { name: 'category' }, categoryOptions(CATEGORIES[0]));
  const tone = el('select', { name: 'tone' }, ...TONES.map((t) => el('option', { value: t, text: t[0].toUpperCase() + t.slice(1) })), el('option', { value: '__custom', text: 'Custom…' }));
  const customTone = el('input', { type: 'text', maxLength: 40, placeholder: 'e.g. nerdy', hidden: true, attrs: { 'aria-label': 'Custom tone' } });
  tone.addEventListener('change', () => { customTone.hidden = tone.value !== '__custom'; if (!customTone.hidden) customTone.focus(); });
  const langList = el('datalist', { id: 'lang-list' }, LANGUAGES.map(([v, l]) => el('option', { value: v, text: l })));
  const language = el('input', { type: 'text', value: 'en', maxLength: 20, attrs: { list: 'lang-list' } });
  const length = el('select', {}, ['short', 'medium', 'long'].map((v) => el('option', { value: v, text: v })));
  const emoji = el('select', {}, [['none', 'None'], ['some', 'Some'], ['lots', 'Lots']].map(([v, l]) => el('option', { value: v, text: l, selected: v === 'some' })));
  const count = el('input', { type: 'number', min: 1, max: 20, value: 5, required: true });
  const maxLength = el('input', { type: 'number', min: 20, max: MAX_MESSAGE_LENGTH, value: 150, required: true });
  const source = el('select', {}, [['auto', 'Auto (AI if configured)'], ['ai', 'AI only'], ['preset', 'Preset library']].map(([v, l]) => el('option', { value: v, text: l })));
  const errors = el('div');
  const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Generate drafts' });

  const form = el('form', { class: 'stack' },
    el('div', { class: 'form-grid' },
      field('Category', category),
      el('div', { class: 'field-group' }, field('Tone', tone), customTone),
      field('Language', language), langList,
      field('Length', length),
      field('Emoji', emoji),
      field('Count (1–20)', count),
      field('Max length', maxLength, { help: `20–${MAX_MESSAGE_LENGTH} characters` }),
      field('Source', source)),
    errors,
    el('div', { class: 'btn-row' }, submit));
  refs.aiForm = form;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errors.replaceChildren();
    const toneValue = tone.value === '__custom' ? customTone.value.trim().slice(0, 40) : tone.value;
    if (!toneValue) { errors.append(errorBox({ message: 'Enter a custom tone or pick one from the list.' })); return; }
    const body = {
      category: category.value, tone: toneValue, language: language.value.trim() || 'en',
      length: length.value, emoji: emoji.value, count: Number(count.value), maxLength: Number(maxLength.value), source: source.value,
    };
    try {
      const r = await withBusy(submit, () => api.post('/api/drafts/generate', body));
      const n = r.drafts?.length ?? 0;
      toast(`Generated ${n} draft${n === 1 ? '' : 's'} via ${r.provider || 'provider'}.`, { tone: 'success' });
      renderRejected(r.rejected || []);
      loadDrafts();
    } catch (err) {
      errors.append(errorBox(err));
    }
  });
  return form;
}

function renderRejected(rejected) {
  if (!rejected.length) { refs.rejected.replaceChildren(); return; }
  clear(refs.rejected, el('details', { class: 'rejected', open: true },
    el('summary', { text: `${rejected.length} candidate${rejected.length === 1 ? '' : 's'} rejected` }),
    el('ul', { class: 'plain-list' }, rejected.map((r) => el('li', {},
      el('span', { class: 'cell-text', text: r.text || '(empty)' }), ' ', el('span', { class: 'muted small', text: `— ${r.reason || 'rejected'}` }))))));
}

async function loadDrafts() {
  try {
    const data = await api.get('/api/drafts', { status: 'pending' });
    state.drafts = data.items || [];
    const ids = new Set(state.drafts.map((d) => d.id));
    for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
    renderDrafts();
  } catch (err) {
    clear(refs.drafts, errorBox(err));
  }
}

function renderDrafts() {
  const total = state.drafts.length;
  const selAll = el('input', { type: 'checkbox', checked: total > 0 && state.selected.size === total, disabled: !total, attrs: { 'aria-label': 'Select all drafts' } });
  selAll.indeterminate = state.selected.size > 0 && state.selected.size < total;
  selAll.addEventListener('change', () => {
    state.selected = selAll.checked ? new Set(state.drafts.map((d) => d.id)) : new Set();
    renderDrafts();
  });
  const approve = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: `Approve selected (${state.selected.size})`, disabled: !state.selected.size });
  const reject = el('button', { type: 'button', class: 'btn btn-sm btn-danger-ghost', text: `Reject selected (${state.selected.size})`, disabled: !state.selected.size });
  approve.addEventListener('click', () => decide('approve', approve));
  reject.addEventListener('click', () => decide('reject', reject));
  clear(refs.draftBar, el('label', { class: 'check' }, selAll, el('span', { text: 'Select all' })), approve, reject);

  if (!total) { clear(refs.drafts, el('p', { class: 'empty', text: 'No pending drafts. Generate some on the left.' })); return; }
  clear(refs.drafts, state.drafts.map(draftItem));
}

function draftItem(d) {
  const cb = el('input', { type: 'checkbox', checked: state.selected.has(d.id), attrs: { 'aria-label': 'Select draft' } });
  cb.addEventListener('change', () => { if (cb.checked) state.selected.add(d.id); else state.selected.delete(d.id); renderDrafts(); });
  const textarea = el('textarea', { rows: 2, value: d.text, attrs: { 'aria-label': 'Draft text' } });
  const counter = el('span', { class: 'counter' });
  const err = el('div', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
  const updateCounter = () => {
    const n = graphemeLength(textarea.value.trim());
    counter.textContent = `${n} / ${MAX_MESSAGE_LENGTH}`;
    counter.classList.toggle('over', n > MAX_MESSAGE_LENGTH);
  };
  textarea.addEventListener('input', updateCounter);
  updateCounter();
  textarea.addEventListener('change', async () => {
    const text = textarea.value.trim();
    if (text === d.text) return;
    err.textContent = '';
    try {
      const updated = await api.patch(`/api/drafts/${d.id}`, { text });
      Object.assign(d, updated);
      textarea.value = d.text;
      updateCounter();
      dupBadge.replaceChildren(...(d.duplicateOf ? [pill('Duplicate of library message', 'amber')] : []));
      toast('Draft updated.', { tone: 'success', timeout: 2000 });
    } catch (e) {
      err.textContent = e.hint ? `${e.message} ${e.hint}` : e.message;
    }
  });
  const dupBadge = el('span', {}, d.duplicateOf ? pill('Duplicate of library message', 'amber') : null);
  return el('div', { class: ['draft', d.duplicateOf ? 'draft-dup' : ''] },
    cb,
    el('div', { class: 'draft-main' },
      textarea,
      el('div', { class: 'draft-meta' },
        el('span', { class: 'tag', text: categoryLabel(d.category) }),
        d.tone ? el('span', { class: 'muted small', text: d.tone }) : null,
        d.provider ? el('span', { class: 'muted small', text: `via ${d.provider}` }) : null,
        dupBadge, counter),
      err));
}

async function decide(kind, button) {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    const r = await withBusy(button, () => api.post(`/api/drafts/${kind}`, { ids }));
    if (kind === 'approve') {
      const ok = r.approved?.length ?? 0;
      const failed = r.failed || [];
      toast(`Approved ${ok} draft${ok === 1 ? '' : 's'} into the library.`, { tone: ok ? 'success' : 'info' });
      if (failed.length) toast(`${failed.length} draft${failed.length === 1 ? '' : 's'} could not be approved: ${failed.map((f) => f.reason).filter(Boolean).slice(0, 3).join('; ')}`, { tone: 'warning', timeout: 9000 });
      for (const a of r.approved || []) state.selected.delete(a.draftId);
      loadMessages();
    } else {
      toast(`Rejected ${r.rejected ?? 0} draft(s).`, { tone: 'info' });
      state.selected.clear();
    }
    loadDrafts();
  } catch (err) {
    toastError(err, `Could not ${kind} drafts`);
  }
}

async function clearDecided() {
  try { const r = await api.del('/api/drafts'); toast(`Cleared ${r?.cleared ?? 0} decided draft(s).`, { tone: 'success' }); }
  catch (err) { toastError(err, 'Could not clear drafts'); }
}

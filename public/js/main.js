// Entry point: hash routing, workflow status polling (2 s while the tab is visible) and a 1 s
// local countdown tick.
import { api } from './api.js';
import { $, $$, pill } from './ui.js';
import { refreshStatus, fireTick, onWorkflows, aggregatePill, setAppTestMode, updateTestBanner, countdownText, onTick, selectedWorkflow, store } from './store.js';
import * as overview from './overview.js';
import * as studio from './studio.js';
import * as scheduler from './scheduler.js';
import * as connections from './connections.js';
import * as logs from './logs.js';
import * as terms from './terms.js';

const VIEWS = { overview, studio, scheduler, connections, logs, terms };
const TITLES = { overview: 'Overview', studio: 'Message Studio', scheduler: 'Scheduler', connections: 'Accounts', logs: 'Activity Logs', terms: 'Terms' };
const POLL_MS = 2000;

let current = null;
let pollTimer = null;

function route() {
  const name = (location.hash || '#overview').slice(1).split('?')[0];
  const target = VIEWS[name] ? name : 'overview';
  if (target === current) return;
  // Navigating (e.g. browser Back) closes any modal left open by the previous view.
  for (const d of $$('dialog[open]')) d.close();
  if (current) {
    VIEWS[current].hide?.();
    $(`#view-${current}`).hidden = true;
  }
  current = target;
  const section = $(`#view-${target}`);
  section.hidden = false;
  for (const a of $$('.nav-link')) {
    if (a.getAttribute('href') === `#${target}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${TITLES[target]} · Live Chat Companion`;
  document.body.classList.remove('nav-open');
  $('#nav-toggle')?.setAttribute('aria-expanded', 'false');
  VIEWS[target].show?.();
  const heading = section.querySelector('h1');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}

function startPolling() {
  stopPolling();
  refreshStatus();
  pollTimer = setInterval(refreshStatus, POLL_MS);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

function initSidebarStatus() {
  const pillSlot = $('#nav-status-pill');
  const countdown = $('#nav-countdown');
  // Countdown of the Scheduler's selected account if it is running, else of the first running one.
  const focus = () => {
    const sel = selectedWorkflow();
    if (sel?.status?.state === 'running') return sel.status;
    return store.workflows.find((w) => w.status?.state === 'running')?.status ?? sel?.status ?? null;
  };
  onWorkflows((items, err) => {
    if (err && !store.loaded) { pillSlot.replaceChildren(pill('Offline', 'grey')); return; }
    pillSlot.replaceChildren(aggregatePill(items));
    countdown.textContent = countdownText(focus());
  });
  onTick(() => { countdown.textContent = countdownText(focus()); });
}

function boot() {
  for (const [name, mod] of Object.entries(VIEWS)) mod.init($(`#view-${name}`));
  initSidebarStatus();

  const toggle = $('#nav-toggle');
  toggle.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startPolling(); else stopPolling();
  });
  setInterval(() => { if (document.visibilityState === 'visible') fireTick(); }, 1000);

  // Test-mode flag for the banner, regardless of which view loads first.
  api.get('/api/overview').then((o) => setAppTestMode(o.app?.testMode)).catch(() => updateTestBanner());

  if (document.visibilityState === 'visible') startPolling();
  route();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

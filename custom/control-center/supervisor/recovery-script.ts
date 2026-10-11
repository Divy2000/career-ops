/**
 * The recovery page's only script: it submits the revert and restart forms with
 * fetch so the POST carries X-CC (a plain form cannot), and shows a refusal
 * instead of navigating: its first line as the message, any further lines (a
 * startup error's stack) in a closed details block. Each form asks first (the
 * first press turns its button into a confirm button, as the app's dialogs ask),
 * one request runs at a time (every button is disabled meanwhile), and a revert's
 * per-file outcome is kept across the reload that shows the new state. The CSP
 * allows exactly this script by its hash. Its own module, so it is tested in a
 * DOM without starting a supervisor.
 */
export const RECOVERY_SCRIPT = `const LABELS = new Map([
  ['revert', { busy: 'Reverting...', refused: 'Revert refused: ', failed: 'Revert failed: ', done: 'Reverted: ', confirm: 'Confirm revert', ask: 'A revert restores the bytes the turn replaced and deletes files it created. Press "Confirm revert" again to confirm.' }],
  ['restart', { busy: 'Restarting the server...', refused: 'Restart failed: ', failed: 'Restart failed: ', done: '', confirm: 'Confirm restart', ask: 'A restart drains the running server and its open sessions. Press "Confirm restart" again to confirm.' }],
]);
const KEPT = 'cc-recovery-outcome';
const show = (out, text) => {
  const [first, ...rest] = text.split('\\n');
  out.replaceChildren(first);
  if (!rest.join('').trim()) return;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Details';
  const pre = document.createElement('pre');
  pre.textContent = rest.join('\\n');
  details.append(summary, pre);
  out.append(details);
};
const storage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};
const kept = storage()?.getItem(KEPT);
if (kept) {
  storage().removeItem(KEPT);
  const out = document.getElementById('revert-status');
  if (out) show(out, kept);
}
let busy = false;
let armed = null;
const disarm = () => {
  if (!armed) return;
  const button = armed.querySelector('button');
  if (button && button.dataset.label) button.textContent = button.dataset.label;
  armed = null;
};
const setDisabled = (disabled) => {
  for (const button of document.querySelectorAll('form[data-cc] button')) button.disabled = disabled;
};
// A failed restart does not reload the page, so the reload status block is re-read from it: it still shows the state
// the page was rendered with (an old server that kept serving, or the new start's failure, is news to it).
const refreshStatus = async () => {
  try {
    const res = await fetch(location.href, { credentials: 'same-origin' });
    if (!res.ok) return;
    const fresh = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('.status');
    const current = document.querySelector('.status');
    if (!fresh || !current) return;
    // The restart form stays the one on the page: a press made while this was read (armed, asking to confirm) holds.
    const kept = current.querySelector('form[data-cc]');
    fresh.querySelector('form[data-cc]')?.remove();
    current.replaceChildren(...[...fresh.childNodes].map((n) => document.importNode(n, true)), ...(kept ? [kept] : []));
  } catch {
    // The message above already says what happened; the block keeps its older state.
  }
};
document.addEventListener('submit', async (e) => {
  const form = e.target;
  const labels = form instanceof HTMLFormElement ? LABELS.get(form.dataset.cc) : undefined;
  if (!labels) return;
  e.preventDefault();
  if (busy) return;
  const out = document.getElementById('revert-status');
  if (armed !== form) {
    disarm();
    const button = form.querySelector('button');
    if (button) {
      button.dataset.label = button.textContent;
      button.textContent = labels.confirm;
    }
    armed = form;
    out.textContent = labels.ask;
    return;
  }
  disarm();
  busy = true;
  setDisabled(true);
  out.textContent = labels.busy;
  try {
    const res = await fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { 'X-CC': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(form)).toString() });
    const text = await res.text();
    if (res.ok) {
      try {
        if (labels.done) storage()?.setItem(KEPT, labels.done + text);
      } catch {
        // Storage full or blocked: the reload still shows the new state, only without the per-file outcome.
      }
      location.reload();
      return;
    }
    show(out, labels.refused + text);
    if (form.dataset.cc === 'restart') void refreshStatus();
  } catch (err) {
    show(out, labels.failed + err.message);
  }
  busy = false;
  setDisabled(false);
});`;

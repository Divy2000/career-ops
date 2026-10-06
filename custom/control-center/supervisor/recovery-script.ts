/**
 * The recovery page's only script: it submits the revert and restart forms with
 * fetch so the POST carries X-CC (a plain form cannot), and shows a refusal
 * instead of navigating: its first line as the message, any further lines (a
 * startup error's stack) in a closed details block. The CSP allows exactly this script by its hash. Its own
 * module, so it is tested in a DOM without starting a supervisor.
 */
export const RECOVERY_SCRIPT = `const LABELS = new Map([['revert', ['Reverting...', 'Revert refused: ', 'Revert failed: ']], ['restart', ['Restarting the server...', 'Restart failed: ', 'Restart failed: ']]]);
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
document.addEventListener('submit', async (e) => {
  const form = e.target;
  const labels = form instanceof HTMLFormElement ? LABELS.get(form.dataset.cc) : undefined;
  if (!labels) return;
  e.preventDefault();
  const out = document.getElementById('revert-status');
  out.textContent = labels[0];
  try {
    const res = await fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { 'X-CC': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(form)).toString() });
    const text = await res.text();
    if (res.ok) location.reload();
    else show(out, labels[1] + text);
  } catch (err) {
    show(out, labels[2] + err.message);
  }
});`;

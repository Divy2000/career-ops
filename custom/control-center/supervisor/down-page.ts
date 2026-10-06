// The page the supervisor answers with while no server child is running. Its
// own module (and supervisor-owned like everything the supervisor loads), so
// it is unit-tested without starting a supervisor.
import type { ReloadState } from './bluegreen.js';
import { PAGE_THEME_CSS } from './page-theme.js';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * `viewer` is null for a request without the session cookie or token: it gets
 * the way to /__recovery but not the startup error, which can carry paths and
 * source lines, nor whether Dev Chat changed anything.
 */
export function renderDownPage(status: ReloadState, viewer: { devChatChanged: boolean } | null): string {
  let body: string;
  if (!viewer) {
    body = `<p>Open the recovery link printed where the Control Center was started, or the <a href="/__recovery">recovery page</a> if you already signed in.</p>`;
  } else if (status.state !== 'failed') {
    body = `<p>The server is starting. Reload this page in a few seconds, or open the <a href="/__recovery">recovery page</a>.</p>`;
  } else {
    const detail = status.stderrTail && !status.error.includes(status.stderrTail) ? `${status.error}\n${status.stderrTail}` : status.error;
    const advice = viewer.devChatChanged
      ? `<p>The last Dev Chat change to its code may have broken it. <a href="/__recovery">Open the recovery page</a> to revert the Dev Chat turn that made it, or to restart the server; the app comes back by itself once the server starts.</p>`
      : `<p>It stopped with the error below. Once its cause is fixed, <a href="/__recovery">open the recovery page</a> and restart the server.</p>`;
    body = `<h2>The server could not start</h2>${advice}<pre>${escapeHtml(detail)}</pre>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Control Center is not running</title><meta name="color-scheme" content="dark light"><style>${PAGE_THEME_CSS}body{background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,Inter,sans-serif;margin:0;padding:32px;max-width:640px}a{color:var(--accent)}h2{font-size:17px}pre{background:var(--surface-1);border:1px solid var(--border);border-radius:6px;padding:8px;overflow:auto;max-height:320px;white-space:pre-wrap;font:12px/1.4 ui-monospace,Menlo,monospace}</style></head><body><h1>The Control Center server is not running</h1>${body}</body></html>`;
}

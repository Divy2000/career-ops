// The page the supervisor answers with while no server child is running. Its
// own module (and supervisor-owned like everything the supervisor loads), so
// it is unit-tested without starting a supervisor.
import type { ReloadState } from './bluegreen.js';
import { PAGE_THEME_CSS } from './page-theme.js';

const ESC = '\u001b';
// CSI (colours and cursor moves: ESC [ parameters, final byte), OSC (ESC ] text, ended by BEL or ESC \), and the
// short escapes: ESC, any intermediate bytes, one final byte (ESC 7, ESC M, ESC ( B).
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|${ESC}[ -/]*[0-~]`, 'g');

/** Terminal escape sequences out: a child's stderr is coloured when FORCE_COLOR is set, and pages show it as text. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

// An escape sequence a chunk ends in the middle of: ESC, then a CSI, OSC or short escape that is not finished yet.
const UNFINISHED = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*|\\][^\\u0007${ESC}]*${ESC}?|[ -/]*)$`);
/** Past this, a "sequence" that never ends is no escape: it is let through as text instead of held back forever. */
const MAX_HELD = 1024;

/**
 * The last `limit` characters a child wrote to stderr, as plain text for the pages. Each chunk is stripped as it
 * arrives (see stripAnsi), so the cut to `limit` falls on plain text; an escape sequence split across chunks is held
 * back until its end arrives.
 */
export function plainTail(limit = 4000): { push(chunk: string): void; text(): string } {
  let plain = '';
  let held = '';
  return {
    push: (chunk) => {
      let raw = held + chunk;
      const open = UNFINISHED.exec(raw);
      held = open && raw.length - open.index <= MAX_HELD ? raw.slice(open.index) : '';
      if (held) raw = raw.slice(0, open!.index);
      plain = (plain + stripAnsi(raw)).slice(-limit);
    },
    text: () => plain,
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** A failed start's error, with the stderr tail when the error does not already end with it. */
function errorText(status: Extract<ReloadState, { state: 'failed' }>): string {
  return status.stderrTail && !status.error.includes(status.stderrTail) ? `${status.error}\n${status.stderrTail}` : status.error;
}

/** The recovery page's status block: what the last start or reload did, in words, and a failure's error as text. */
export function renderStatus(status: ReloadState): string {
  switch (status.state) {
    case 'idle':
      return '<p>No reload since the server started.</p>';
    case 'reloading':
      return `<p>A reload is under way (started ${escapeHtml(status.startedAt)}).</p>`;
    case 'ok':
      return `<p>The last reload came up at ${escapeHtml(status.at)} (pid ${status.pid}).</p>`;
    case 'failed':
      return `<p>The last start failed at ${escapeHtml(status.at)}.</p><pre>${escapeHtml(errorText(status))}</pre>`;
  }
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
    const detail = errorText(status);
    const advice = viewer.devChatChanged
      ? `<p>The last Dev Chat change to its code may have broken it. <a href="/__recovery">Open the recovery page</a> to revert the Dev Chat turn that made it, or to restart the server; the app comes back by itself once the server starts.</p>`
      : `<p>It stopped with the error below. Once its cause is fixed, <a href="/__recovery">open the recovery page</a> and restart the server.</p>`;
    body = `<h2>The server could not start</h2>${advice}<pre>${escapeHtml(detail)}</pre>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Control Center is not running</title><meta name="color-scheme" content="dark light"><style>${PAGE_THEME_CSS}body{background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,Inter,sans-serif;margin:0;padding:32px;max-width:640px}a{color:var(--accent)}h2{font-size:17px}pre{background:var(--surface-1);border:1px solid var(--border);border-radius:6px;padding:8px;overflow:auto;max-height:320px;white-space:pre-wrap;font:12px/1.4 ui-monospace,Menlo,monospace}</style></head><body><h1>The Control Center server is not running</h1>${body}</body></html>`;
}

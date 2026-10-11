import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCRIPT } from '../../supervisor/recovery-script';
import { until } from '../helpers/until';

/** The parts of the recovery page the script works on: the status line and one form of each kind. */
const PAGE = `<div id="revert-status" role="alert"></div>
<form method="post" action="/__recovery/restart" data-cc="restart"><button>Restart the server</button></form>
<form method="post" action="/__recovery/revert" data-cc="revert"><input type="hidden" name="turn" value="1"><button>Revert whole turn</button></form>`;

const ERROR = [
  'the server still does not start: server child exited before listening (code 1, signal null)',
  'node:net:2167',
  "    const ex = new UVExceptionWithHostPort(err, 'listen', address, port);",
  '',
  'Error: listen EADDRINUSE: address already in use 127.0.0.1:55674',
  '    at Server.setupListenHandle [as _listen2] (node:net:2167:16)',
].join('\n');

const reply = (status: number, text: string) => vi.fn(async () => ({ ok: status < 300, status, text: async () => text }));
const form = (kind: string) => document.querySelector<HTMLFormElement>(`form[data-cc="${kind}"]`)!;
const press = (kind: string) => form(kind).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
/** Both steps: the first press asks, the second confirms and sends. */
const submit = (kind: string) => {
  press(kind);
  press(kind);
};
const status = () => document.getElementById('revert-status')!;

/** The submit listeners the script has added; a real page load starts with none, so each test runs its own one. */
let listeners: Parameters<typeof document.addEventListener>[] = [];
const unload = () => {
  for (const args of listeners) document.removeEventListener(...args);
  listeners = [];
};
/** Runs the script as a page load does, in place of the previous page's. */
const load = () => {
  unload();
  const add = vi.spyOn(document, 'addEventListener');
  try {
    new Function(RECOVERY_SCRIPT)();
    listeners = [...add.mock.calls];
  } finally {
    add.mockRestore();
  }
};

describe('the recovery page script', () => {
  beforeEach(() => {
    load();
  });
  afterEach(() => {
    unload();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('a multi-line failure shows its first line as the message and the rest, line breaks kept, in a details block', async () => {
    document.body.innerHTML = PAGE;
    vi.stubGlobal('fetch', reply(502, ERROR));
    submit('restart');
    await until(() => status().textContent!.startsWith('Restart failed:'), 'the restart failure');
    const message = status().firstChild!;
    expect(message.nodeType).toBe(Node.TEXT_NODE);
    expect(message.textContent).toBe('Restart failed: the server still does not start: server child exited before listening (code 1, signal null)');
    const details = status().querySelector('details')!;
    expect(details.querySelector('summary')!.textContent).toBe('Details');
    expect(details.querySelector('pre')!.textContent).toBe(ERROR.split('\n').slice(1).join('\n'));
    expect(details.open).toBe(false);
  });

  it('a one-line refusal is just the message, and a new submit replaces the previous message and its details', async () => {
    document.body.innerHTML = PAGE;
    vi.stubGlobal('fetch', reply(502, ERROR));
    submit('restart');
    await until(() => status().querySelector('details') !== null, 'the failure details');
    vi.stubGlobal('fetch', reply(409, 'notes.md changed after turn 1; nothing was reverted'));
    submit('revert');
    await until(() => status().textContent!.startsWith('Revert refused:'), 'the revert refusal');
    expect(status().textContent).toBe('Revert refused: notes.md changed after turn 1; nothing was reverted');
    expect(status().querySelector('details')).toBeNull();
  });

  it('sends the form with X-CC from the page origin, and a request that fails outright says so', async () => {
    document.body.innerHTML = PAGE;
    const fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetch);
    submit('revert');
    await until(() => status().textContent === 'Revert failed: network down', 'the network failure');
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/__recovery\/revert$/), expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: expect.objectContaining({ 'X-CC': '1' }), body: 'turn=1' }));
  });
  it('a revert or restart asks first: the first press only asks, and only the second sends it (R14-supervisor-L3-01)', async () => {
    document.body.innerHTML = PAGE;
    const fetch = reply(409, 'refused');
    vi.stubGlobal('fetch', fetch);
    press('revert');
    expect(fetch).not.toHaveBeenCalled();
    expect(status().textContent).toMatch(/deletes files it created.*again to confirm/);
    expect(form('revert').querySelector('button')!.textContent).toBe('Confirm revert');
    press('restart');
    expect(fetch).not.toHaveBeenCalled();
    // Asking about another form takes the first one's question back.
    expect(form('revert').querySelector('button')!.textContent).toBe('Revert whole turn');
    expect(status().textContent).toMatch(/drains the running server.*again to confirm/);
    press('restart');
    await until(() => status().textContent === 'Restart failed: refused', 'the restart reply');
    // One POST: the GET after it re-reads the reload status a failed restart left (R20-supervisor-L3-01).
    expect(fetch.mock.calls.filter((c) => (c as unknown[])[1] && ((c as unknown[])[1] as { method?: string }).method === 'POST')).toHaveLength(1);
    expect(form('restart').querySelector('button')!.textContent).toBe('Restart the server');
  });

  it('while one request is in flight, every button is disabled and further presses send nothing (R14-supervisor-L3-04)', async () => {
    document.body.innerHTML = PAGE;
    let answer: (v: { ok: boolean; status: number; text: () => Promise<string> }) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((r) => (answer = r)));
    vi.stubGlobal('fetch', fetch);
    submit('restart');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
    submit('restart');
    submit('revert');
    expect(fetch).toHaveBeenCalledTimes(1);
    answer({ ok: false, status: 502, text: async () => 'the server still does not start: boom' });
    await until(() => status().textContent!.startsWith('Restart failed:'), 'the restart failure');
    expect([...document.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true);
  });

  it('a failed restart shows the reload status as it is now, not as the page was rendered (R20-supervisor-L3-01)', async () => {
    document.body.innerHTML = `${PAGE}<div class="status"><strong>Server reload status</strong><p>The last reload came up at t0 (pid 1).</p></div>`;
    const now = '<div class="status"><strong>Server reload status</strong><p>The last start failed at t1.</p><p>The running server keeps serving the previous code.</p></div>';
    const fetch = vi.fn(async (_url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? { ok: false, status: 502, text: async () => 'the new server did not start; the running server keeps serving the previous code: boom' } : { ok: true, status: 200, text: async () => `<html><body>${now}</body></html>` },
    );
    vi.stubGlobal('fetch', fetch);
    submit('restart');
    await until(() => document.querySelector('.status')!.textContent!.includes('The last start failed at t1.'), 'the status block refreshed');
    expect(document.querySelector('.status')!.textContent).toContain('The running server keeps serving the previous code.');
    expect(document.querySelectorAll('.status')).toHaveLength(1);
    expect(status().textContent).toBe('Restart failed: the new server did not start; the running server keeps serving the previous code: boom');
    expect(fetch).toHaveBeenLastCalledWith(location.href, expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('a restart pressed once while the status re-read is under way still needs only the confirming press (R20-supervisor-L3-01 review)', async () => {
    document.body.innerHTML = `<div id="revert-status" role="alert"></div><div class="status"><strong>Server reload status</strong><p>The last reload came up at t0 (pid 1).</p><form method="post" action="/__recovery/restart" data-cc="restart"><button>Restart the server</button></form></div>`;
    let page: (v: { ok: boolean; status: number; text: () => Promise<string> }) => void = () => undefined;
    const fetch = vi.fn((_url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? Promise.resolve({ ok: false, status: 502, text: async () => 'boom' }) : new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((r) => (page = r)),
    );
    vi.stubGlobal('fetch', fetch);
    submit('restart');
    await until(() => fetch.mock.calls.length === 2, 'the status re-read');
    press('restart');
    expect(form('restart').querySelector('button')!.textContent).toBe('Confirm restart');
    page({ ok: true, status: 200, text: async () => '<div class="status"><strong>Server reload status</strong><p>The last start failed at t1.</p><form method="post" action="/__recovery/restart" data-cc="restart"><button>Restart the server</button></form></div>' });
    await until(() => document.querySelector('.status')!.textContent!.includes('t1'), 'the status block refreshed');
    expect(form('restart').querySelector('button')!.textContent).toBe('Confirm restart');
    press('restart');
    await until(() => fetch.mock.calls.length === 3, 'the confirmed restart');
    expect((fetch.mock.calls[2] as unknown[])[1]).toMatchObject({ method: 'POST' });
  });

  it('a revert that succeeds shows its per-file outcome after the page reloads (R14-supervisor-L3-03)', async () => {
    document.body.innerHTML = PAGE;
    vi.stubGlobal('fetch', reply(200, 'notes.md: restored\nplan.md: no-snapshot'));
    submit('revert');
    await until(() => sessionStorage.length > 0, 'the outcome kept for the reload');
    // The reload: a new page whose script shows the kept outcome.
    document.body.innerHTML = PAGE;
    load();
    expect(status().textContent).toContain('Reverted: notes.md: restored');
    expect(status().querySelector('pre')!.textContent).toBe('plan.md: no-snapshot');
    expect(sessionStorage.length).toBe(0);
  });
  it('a successful revert whose outcome cannot be kept (storage full) still reloads, and is never shown as failed', async () => {
    document.body.innerHTML = PAGE;
    const fetch = reply(200, 'notes.md: restored');
    vi.stubGlobal('fetch', fetch);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      submit('revert');
      await until(() => setItem.mock.calls.length > 0, 'the attempt to keep the outcome');
      await new Promise((r) => setTimeout(r, 20));
      expect(status().textContent).toBe('Reverting...');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
    }
  });
});

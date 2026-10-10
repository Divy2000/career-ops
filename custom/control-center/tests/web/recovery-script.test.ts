import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('the recovery page script', () => {
  beforeAll(() => {
    new Function(RECOVERY_SCRIPT)();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
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
    expect(fetch).toHaveBeenCalledTimes(1);
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

  // It runs the script a second time, as the reload does.
  it('a revert that succeeds shows its per-file outcome after the page reloads (R14-supervisor-L3-03)', async () => {
    document.body.innerHTML = PAGE;
    vi.stubGlobal('fetch', reply(200, 'notes.md: restored\nplan.md: no-snapshot'));
    submit('revert');
    await until(() => sessionStorage.length > 0, 'the outcome kept for the reload');
    document.body.innerHTML = PAGE;
    new Function(RECOVERY_SCRIPT)();
    expect(status().textContent).toContain('Reverted: notes.md: restored');
    expect(status().querySelector('pre')!.textContent).toBe('plan.md: no-snapshot');
    expect(sessionStorage.length).toBe(0);
  });
  // After the reload test, which leaves the scripts before it waiting for a reload.
  it('a successful revert whose outcome cannot be kept (storage full) still reloads, and is never shown as failed', async () => {
    document.body.innerHTML = PAGE;
    // The earlier reloads left their scripts waiting for the reload; a fresh one stands for the reloaded page.
    new Function(RECOVERY_SCRIPT)();
    vi.stubGlobal('fetch', reply(200, 'notes.md: restored'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      submit('revert');
      await until(() => setItem.mock.calls.length > 0, 'the attempt to keep the outcome');
      await new Promise((r) => setTimeout(r, 20));
      expect(status().textContent).toBe('Reverting...');
    } finally {
      setItem.mockRestore();
    }
  });
});

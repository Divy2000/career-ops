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
const submit = (kind: string) => document.querySelector<HTMLFormElement>(`form[data-cc="${kind}"]`)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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
});

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The advisor session itself is out of scope: the stub hands its envelope callback to the test while it is mounted, as
// the real panel only delivers envelopes while mounted, and counts how often it was mounted (its session id is its state).
let emitEnvelope: ((kind: string, payload: unknown, turn: number) => void) | null = null;
const panelMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@web/components/SessionPanel', async () => {
  const { useEffect } = await import('react');
  return {
    SessionPanel: (props: { onEnvelope?: (kind: string, payload: unknown, turn: number) => void }) => {
      emitEnvelope = props.onEnvelope ?? null;
      useEffect(() => {
        panelMounts.count++;
        return () => void (emitEnvelope = null);
      }, []);
      return null;
    },
  };
});
const navigations = vi.hoisted(() => [] as unknown[]);
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ navigate: async (to: unknown) => void navigations.push(to) }),
  useRouterState: () => '/',
}));

let host: HTMLElement;
let root: Root;

beforeEach(async () => {
  document.body.innerHTML = '';
  emitEnvelope = null;
  panelMounts.count = 0;
  navigations.length = 0;
  const { AskDrawer } = await import('@web/components/AskDrawer');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  renderDrawer = (open: boolean) => act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(AskDrawer, { open, onClose: () => undefined })))));
  await renderDrawer(true);
});
let renderDrawer: (open: boolean) => Promise<void>;
afterEach(async () => {
  await act(async () => root.unmount());
});

// Remount the drawer with a fresh QueryClient so the sessions list (useSessions) loads from the current fetch stub:
// the shared beforeEach mounts before each describe stubs fetch.
async function remountDrawer() {
  const { AskDrawer } = await import('@web/components/AskDrawer');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  await act(async () => root.unmount());
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(AskDrawer, { open: true, onClose: () => undefined })))));
}

describe('Ask drawer: proposed actions', () => {
  it('an act envelope naming an Object property is shown as not allowlisted and offers nothing to run', async () => {
    for (const action of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      await act(async () => emitEnvelope!('act', { action, params: {} }, 1));
    }
    const items = [...host.querySelectorAll<HTMLLIElement>('li.proposal')];
    expect(items.map((li) => li.dataset.proposalState)).toEqual(['unsupported', 'unsupported', 'unsupported', 'unsupported']);
    expect(items.map((li) => li.textContent!.replace(/\s+/g, ' '))).toEqual([
      'toString "toString" is not in the action allowlistunsupported',
      'constructor "constructor" is not in the action allowlistunsupported',
      'hasOwnProperty "hasOwnProperty" is not in the action allowlistunsupported',
      '__proto__ "__proto__" is not in the action allowlistunsupported',
    ]);
    expect(host.querySelectorAll('li.proposal button')).toHaveLength(0);
  });

  it('a proposal the drawer cannot run (setProfile, setPortals) is marked unsupported on Review and run without asking to approve a write (R30-shared-comp-X-01)', async () => {
    for (const action of ['setProfile', 'setPortals']) {
      await act(async () => emitEnvelope!('act', { action, params: {} }, 1));
      const item = [...host.querySelectorAll<HTMLLIElement>('li.proposal')].pop()!;
      expect(item.textContent, action).not.toContain('writes');
      await act(async () => item.querySelector('button')!.click());
      expect(document.body.querySelector('.dialog'), action).toBeNull();
      expect(item.dataset.proposalState, action).toBe('unsupported');
      expect(item.textContent, action).toContain('Structured settings editors are not available yet');
    }
  });

  it('an allowlisted act envelope is offered to run with its label', async () => {
    await act(async () => emitEnvelope!('act', { action: 'navigate', params: { to: '/pipeline' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    expect(item.dataset.proposalState).toBe('pending');
    expect(item.textContent).toContain('Open /pipeline');
    expect([...item.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Run', 'Dismiss']);
  });

  it('the drawer runs exactly the actions the advisor is told about (SW7-web-a-01)', async () => {
    const { ASK_ACTIONS } = await import('@web/components/AskDrawer');
    const { ASK_ACTION_SPECS } = await import('@shared/ask-actions');
    expect(Object.keys(ASK_ACTIONS).sort()).toEqual(ASK_ACTION_SPECS.map((a) => a.name).sort());
  });

  it('navigate without a path fails instead of opening Today (SW7-web-a-01)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'navigate', params: { path: '/tracker/12' } }, 1));
    await act(async () => host.querySelector<HTMLButtonElement>('li.proposal button')!.click());
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('navigate needs "to"');
    expect(navigations).toEqual([]);
  });

  it('navigate to a protocol-relative path (another site) fails without navigating (review fix)', async () => {
    for (const to of ['//attacker.example/path', '/\\attacker.example/path']) {
      await act(async () => emitEnvelope!('act', { action: 'navigate', params: { to } }, 1));
      const item = [...host.querySelectorAll<HTMLLIElement>('li.proposal')].pop()!;
      await act(async () => item.querySelector('button')!.click());
      expect(item.dataset.proposalState, to).toBe('failed');
      expect(item.textContent, to).toContain('navigate needs "to"');
      expect(navigations, to).toEqual([]);
    }
  });

  it('Filter the pipeline opens the Inbox filtered by the proposed query (SW-web-a-07)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'filterPipeline', params: { q: 'Stripe' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => [...item.querySelectorAll('button')].find((b) => b.textContent === 'Run')!.click());
    expect(navigations).toEqual([{ to: '/pipeline', search: { tab: 'inbox', q: 'Stripe' } }]);
    expect(item.dataset.proposalState).toBe('done');
  });
});

describe('Ask drawer: closing and reopening (SW-web-a-13)', () => {
  it('keeps the advisor session while closed, so the conversation is there on reopen and later proposals still arrive', async () => {
    await act(async () => emitEnvelope!('act', { action: 'navigate', params: { to: '/tracker' } }, 1));
    await renderDrawer(false);
    expect(host.querySelector('[role="dialog"][aria-label="Ask"]:not([hidden])')).toBeNull();
    await act(async () => emitEnvelope!('act', { action: 'navigate', params: { to: '/pipeline' } }, 1));
    await renderDrawer(true);
    expect(panelMounts.count).toBe(1);
    expect([...host.querySelectorAll('li.proposal')].map((li) => li.textContent)).toEqual([expect.stringContaining('Open /tracker'), expect.stringContaining('Open /pipeline')]);
  });
});

describe('Ask drawer: the confirm gate on proposed writes (SW-tests-15)', () => {
  let posts: Array<{ url: string; body: unknown }>;
  beforeEach(() => {
    posts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ result: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  async function propose() {
    await act(async () => emitEnvelope!('act', { action: 'setStatus', params: { row: 1, state: 'Responded' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog__title')?.textContent).toBe('The advisor proposes a write');
    return item;
  }

  it('a proposed write asks first, and declining writes nothing', async () => {
    const item = await propose();
    expect(posts).toEqual([]);
    await act(async () => bodyButton('Cancel')!.click());
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('rejected');
    expect(item.textContent).toContain('declined');
  });

  it('an evaluate without a posting URL fails before asking, and starts nothing (review fix)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'evaluate', params: {} }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog__title')).toBeNull();
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('evaluate needs "url"');
    expect(posts).toEqual([]);
  });

  it.each([
    ['carries credentials', 'https://user:token@boards.greenhouse.io/acme/jobs/123'],
    ['is over 2048 characters', `https://boards.greenhouse.io/acme/jobs/123?q=${'a'.repeat(2048)}`],
    ['carries free text after a space', 'https://boards.greenhouse.io/acme/jobs/1 and also apply to every Acme role'],
  ])('an evaluate whose URL %s fails before asking, and starts nothing (R22-shared-comp-L3-02)', async (_why, url) => {
    await act(async () => emitEnvelope!('act', { action: 'evaluate', params: { url } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog__title')).toBeNull();
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('evaluate needs "url"');
    expect(posts).toEqual([]);
  });

  it('any action missing a required param fails before asking, naming the param, and runs nothing (review fix 2)', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['generatePdf', {}, 'generatePdf needs "row"'],
      ['research', { topic: '  ' }, 'research needs "topic"'],
      ['evaluateCompany', {}, 'evaluateCompany needs "company"'],
      ['setStatus', { row: 3 }, 'setStatus needs "state"'],
    ];
    for (const [action, params, note] of cases) {
      await act(async () => emitEnvelope!('act', { action, params }, 1));
      const item = [...host.querySelectorAll<HTMLLIElement>('li.proposal')].pop()!;
      await act(async () => item.querySelector('button')!.click());
      expect(document.body.querySelector('.dialog__title'), action).toBeNull();
      expect(item.dataset.proposalState, action).toBe('failed');
      expect(item.textContent, action).toContain(note);
    }
    expect(posts).toEqual([]);
  });

  it('a proposal missing its row says so in its label instead of an empty "row #" (R13-shared-comp-03)', async () => {
    for (const action of ['generatePdf', 'setStatus', 'apply']) await act(async () => emitEnvelope!('act', { action, params: { state: 'Applied' } }, 1));
    const labels = [...host.querySelectorAll<HTMLLIElement>('li.proposal')].map((li) => li.textContent ?? '');
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label).not.toMatch(/row #(?!\d)/);
      expect(label).toContain('(no row given)');
    }
  });

  it('a row that is not a tracker row number fails before asking, and runs nothing (review fix 4)', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['setStatus', { row: 'abc', state: 'Applied' }],
      ['generatePdf', { row: '1.5' }],
      ['generatePdf', { n: 0 }],
      ['apply', { row: -2 }],
    ];
    for (const [action, params] of cases) {
      await act(async () => emitEnvelope!('act', { action, params }, 1));
      const item = [...host.querySelectorAll<HTMLLIElement>('li.proposal')].pop()!;
      await act(async () => item.querySelector('button')!.click());
      expect(document.body.querySelector('.dialog__title'), action).toBeNull();
      expect(item.dataset.proposalState, action).toBe('failed');
      expect(item.textContent, action).toContain(`${action} needs "row", the tracker row number`);
    }
    expect(posts).toEqual([]);
    expect(navigations).toEqual([]);
  });

  it('confirming runs the write with the proposed params', async () => {
    const item = await propose();
    await act(async () => bodyButton('Do it')!.click());
    expect(posts).toEqual([{ url: '/api/actions/tracker.setStatus', body: { params: { row: 1, state: 'Responded' } } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('a setStatus naming its row by the older key "n" sets that row, as the other row actions do (review fix 3)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'setStatus', params: { n: 3, state: 'Applied' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    expect(item.textContent).toContain('Set row #3 to Applied');
    await act(async () => bodyButton('Review and run')!.click());
    await act(async () => bodyButton('Do it')!.click());
    expect(posts).toEqual([{ url: '/api/actions/tracker.setStatus', body: { params: { row: 3, state: 'Applied' } } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('a remember fact over 300 characters fails before asking, matching the server limit (R17-shared-comp-L2-04)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'remember', params: { fact: 'x'.repeat(301) } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('at most 300 characters');
    expect(posts).toEqual([]);
  });

  it('a setStatus to a state that is not canonical fails before asking, naming the exact statuses (R21-shared-comp-L2-02)', async () => {
    for (const state of ['applied', 'Applied ', 'Ghosted']) {
      await act(async () => emitEnvelope!('act', { action: 'setStatus', params: { row: 3, state } }, 1));
      const item = [...host.querySelectorAll<HTMLLIElement>('li.proposal')].pop()!;
      await act(async () => item.querySelector('button')!.click());
      expect(document.body.querySelector('.dialog'), state).toBeNull();
      expect(item.dataset.proposalState, state).toBe('failed');
      expect(item.textContent, state).toContain('setStatus needs "state", one of the exact statuses: Evaluated, Applied');
    }
    expect(posts).toEqual([]);
  });

  it('a setStatus note over 500 characters fails before asking, matching the server limit (R19-shared-comp-L2-01)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'setStatus', params: { row: 3, state: 'Applied', note: 'x'.repeat(501) } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('at most 500 characters');
    expect(posts).toEqual([]);
  });
});

describe('Ask drawer: remembering a fact the profile already holds (SW3-tests-25)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ result: 'deduped' }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says it was already remembered instead of done', async () => {
    await act(async () => emitEnvelope!('act', { action: 'remember', params: { fact: 'Prefers remote roles' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    // remember writes the profile, so it always goes through the write confirm (ASK_ACTIONS: confirm true).
    const button = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
    await act(async () => button('Review and run').click());
    expect(document.body.querySelector('.dialog__title')?.textContent).toBe('The advisor proposes a write');
    await act(async () => button('Do it').click());
    expect(item.dataset.proposalState).toBe('done');
    expect(item.textContent).toContain('Already remembered');
  });
});

describe('Ask drawer: research a company runs deep, not the Portfolio research virtual mode (R17-shared-comp-L2-03)', () => {
  let body: Record<string, unknown> | null;
  beforeEach(() => {
    body = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && url === '/api/sessions') {
          body = JSON.parse(String(init.body));
          return Promise.resolve(new Response(JSON.stringify({ id: 's-deep', mode: 'deep', status: 'queued' }), { status: 202, headers: { 'content-type': 'application/json' } }));
        }
        return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

  it('starts a deep session (which WebSearch covers) with the topic as its text target', async () => {
    await act(async () => emitEnvelope!('act', { action: 'research', params: { topic: 'Acme' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await act(async () => bodyButton('Do it')!.click());
    expect(body?.mode).toBe('deep');
    expect(body?.target).toEqual({ type: 'text', value: 'Acme' });
    expect(item.dataset.proposalState).toBe('done');
  });
});

describe('Ask drawer: a 202 whose session already failed shows failed, not done (R17-shared-comp-X-02)', () => {
  const FAILED = { id: 's-fail', mode: 'oferta', status: 'error', error: 'Claude CLI not approved', target: { type: 'url', value: 'https://jobs.example.com/1' } };
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && url === '/api/sessions') {
          return Promise.resolve(new Response(JSON.stringify(FAILED), { status: 202, headers: { 'content-type': 'application/json' } }));
        }
        return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

  it.each([
    ['evaluate', { url: 'https://jobs.example.com/1' }],
    ['research', { topic: 'Acme' }],
    ['generatePdf', { row: '2' }],
  ] as const)('%s reports the start failure instead of done', async (action, params) => {
    await act(async () => emitEnvelope!('act', { action, params }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await act(async () => bodyButton('Do it')!.click());
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('Claude CLI not approved');
    expect(navigations).toEqual([]);
  });
});

describe('Ask drawer: a confirmed paid proposal starts once (SW3-web-a-05)', () => {
  let starts: number;
  let refuseStarts: Array<() => void>;
  beforeEach(() => {
    starts = 0;
    refuseStarts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && url === '/api/sessions') {
          starts++;
          return new Promise<Response>((r) => refuseStarts.push(() => r(new Response('{"error":"gone"}', { status: 500, headers: { 'content-type': 'application/json' } }))));
        }
        return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
      }),
    );
  });
  afterEach(async () => {
    // A start left pending would hold Process inbox back into the next test.
    await act(async () => refuseStarts.forEach((r) => r()));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    vi.unstubAllGlobals();
  });

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

  it('runs the proposal once while its session is starting, and shows it as running', async () => {
    await act(async () => emitEnvelope!('act', { action: 'evaluate', params: { url: 'https://jobs.example.com/1' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await act(async () => bodyButton('Do it')!.click());
    expect(starts).toBe(1);
    expect(item.dataset.proposalState).toBe('running');
    expect(bodyButton('Review and run')).toBeUndefined();
  });

  it('given a start slower than the sessions read limit, holds Process inbox back until the start answers (R27-comp-askdrawer-01)', async () => {
    const { useBatchStarting } = await import('@web/features/pipeline/InboxAi');
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useBatchStarting());
      return null;
    };
    const probeHost = document.createElement('div');
    document.body.append(probeHost);
    const probeRoot = createRoot(probeHost);
    await act(async () => probeRoot.render(createElement(Probe)));
    // The posting is a pending Inbox row, which Process inbox would evaluate too.
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) =>
      String(url) === '/api/pipeline'
        ? Promise.resolve(new Response(JSON.stringify({ kind: 'ok', path: 'data/pipeline.md', etag: 'e1', rows: [{ url: 'https://jobs.example.com/1', company: 'Acme', role: 'Engineer', done: false, section: 'pending' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
        : answer(url as string, init),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => emitEnvelope!('act', { action: 'evaluate', params: { url: 'https://jobs.example.com/1' } }, 1));
      await act(async () => bodyButton('Review and run')!.click());
      await act(async () => bodyButton('Do it')!.click());
      expect(starts).toBe(1);
      expect(seen.at(-1)).toBe(true);
      // Past the 10 s sessions read limit the POST is still out: the session may yet start, so the hold stays.
      await act(async () => vi.advanceTimersByTime(30_000));
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(seen.at(-1)).toBe(true);
      await act(async () => refuseStarts.forEach((r) => r()));
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(seen.at(-1)).toBe(false);
    } finally {
      vi.useRealTimers();
      await act(async () => probeRoot.unmount());
      probeHost.remove();
    }
  });
});

describe('Ask drawer: evaluate joins an already-running evaluation (R17-shared-comp-L1-01)', () => {
  let posts: Array<{ url: string; body: unknown }>;
  const ACTIVE = { id: 's-active', mode: 'oferta', status: 'running', target: { type: 'url', value: 'https://jobs.example.com/1' } };
  beforeEach(async () => {
    posts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url === '/api/sessions' && init?.method !== 'POST') return new Response(JSON.stringify([ACTIVE]), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    await remountDrawer();
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

  it('opens the live oferta session instead of starting a second paid one', async () => {
    await act(async () => emitEnvelope!('act', { action: 'evaluate', params: { url: 'https://jobs.example.com/1' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await act(async () => bodyButton('Do it')!.click());
    expect(posts).toEqual([]);
    expect(navigations).toEqual([{ to: '/sessions/$id', params: { id: 's-active' } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('opens the live oferta session for another spelling of its posting URL (a tracking param and a trailing slash) instead of starting a second paid one (R25-shared-comp-L2-01)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'evaluate', params: { url: 'https://jobs.example.com/1/?utm_source=linkedin' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await act(async () => bodyButton('Do it')!.click());
    expect(posts).toEqual([]);
    expect(navigations).toEqual([{ to: '/sessions/$id', params: { id: 's-active' } }]);
    expect(item.dataset.proposalState).toBe('done');
  });
});


describe('Ask drawer: generatePdf honors the per-row tailored-CV guard (R17-shared-comp-L3-03)', () => {
  let posts: Array<{ url: string; body: unknown }>;
  let listed: Array<Record<string, unknown>>;
  beforeEach(async () => {
    posts = [];
    listed = [];
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify({ id: 's-new', mode: 'pdf', status: 'queued', target: { type: 'app', value: '2' } }), { status: 202, headers: { 'content-type': 'application/json' } });
        }
        if (url === '/api/sessions') return new Response(JSON.stringify(listed), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    await remountDrawer();
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  const run = async (row = '2') => {
    await act(async () => emitEnvelope!('act', { action: 'generatePdf', params: { row } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await act(async () => bodyButton('Do it')!.click());
    return item;
  };

  it('starts the session, writes cc.pdf.N, and clears the in-flight mark', async () => {
    const item = await run();
    expect(posts).toHaveLength(1);
    expect(sessionStorage.getItem('cc.pdf.2')).toBe('s-new');
    expect(sessionStorage.getItem('cc.pdf.2:starting')).toBeNull();
    expect(navigations).toEqual([{ to: '/sessions/$id', params: { id: 's-new' } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('opens a live pdf session for the row instead of starting a second', async () => {
    listed = [{ id: 's-pdf', mode: 'pdf', status: 'running', target: { type: 'app', value: '2' } }];
    await remountDrawer();
    await run();
    expect(posts).toEqual([]);
    expect(navigations).toEqual([{ to: '/sessions/$id', params: { id: 's-pdf' } }]);
  });

  it('refuses to start while another mount is starting the row\'s CV', async () => {
    sessionStorage.setItem('cc.pdf.2:starting', String(Date.now()));
    await remountDrawer();
    const item = await run();
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('already starting');
  });

  it('opens a pdf session the Apply page started after the drawer last polled, instead of starting a second (R19-shared-comp-L1-01)', async () => {
    // The drawer's sessions list loaded empty; Apply then starts row 2's CV and never adds it to that cached list.
    listed = [{ id: 's-apply', mode: 'pdf', status: 'queued', target: { type: 'app', value: '2' } }];
    await run();
    expect(posts).toEqual([]);
    expect(navigations).toEqual([{ to: '/sessions/$id', params: { id: 's-apply' } }]);
  });

  it('opens a live pdf session whose row was named with leading zeros or spaces, as the server reads it', async () => {
    listed = [{ id: 's-zero', mode: 'pdf', status: 'running', target: { type: 'app', value: ' 02' } }];
    await run();
    expect(posts).toEqual([]);
    expect(navigations).toEqual([{ to: '/sessions/$id', params: { id: 's-zero' } }]);
  });

  it('starts a CV beside a live session whose row only reads as a number in another notation, as the server does', async () => {
    listed = [
      { id: 's-dec', mode: 'pdf', status: 'running', target: { type: 'app', value: '2.0' } },
      { id: 's-text', mode: 'pdf', status: 'running', target: { type: 'text', value: '2' } },
    ];
    await run();
    expect(posts).toHaveLength(1);
  });

  const failSessionsRead = (post?: (url: string, init: RequestInit) => Response) => {
    // Only the sessions read fails; the drawer's other reads answer as before.
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (url === '/api/sessions' && !init?.method) return new Response(JSON.stringify({ error: 'sessions unreadable' }), { status: 500, headers: { 'content-type': 'application/json' } });
      if (post && init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return post(String(url), init);
      }
      return answer(url, init);
    });
  };

  it('still starts the CV when the sessions list cannot be read at run time, since the server refuses a duplicate itself', async () => {
    failSessionsRead();
    const item = await run();
    expect(posts).toEqual([{ url: '/api/sessions', body: expect.objectContaining({ mode: 'pdf', target: { type: 'app', value: '2' } }) }]);
    expect(navigations).toEqual([{ to: '/sessions/$id', params: { id: 's-new' } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('shows the server\'s refusal when the sessions list cannot be read and the row already has a live CV session', async () => {
    const refusal = 'Not started: session s-live is already generating the tailored CV for tracker row #2. Open it instead.';
    failSessionsRead(() => new Response(JSON.stringify({ error: refusal }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const item = await run();
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain(refusal);
    expect(sessionStorage.getItem('cc.pdf.2:starting')).toBeNull();
  });

  it('a row with surrounding whitespace opens the live pdf session for that row (R18-shared-comp-L2-01)', async () => {
    listed = [{ id: 's-pdf', mode: 'pdf', status: 'running', target: { type: 'app', value: '2' } }];
    await remountDrawer();
    await run(' 2 ');
    expect(posts).toEqual([]);
    expect(navigations).toEqual([{ to: '/sessions/$id', params: { id: 's-pdf' } }]);
  });

  it('apply with a row with surrounding whitespace opens that row\'s Apply page (R18-shared-comp-L2-01)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'apply', params: { row: ' 12 ' } }, 1));
    await act(async () => bodyButton('Run')!.click());
    expect(navigations).toEqual([{ to: '/apply/$n', params: { n: '12' } }]);
  });

  it('a row with surrounding whitespace honors the row\'s starting mark (R18-shared-comp-L2-01)', async () => {
    sessionStorage.setItem('cc.pdf.2:starting', String(Date.now()));
    await remountDrawer();
    const item = await run(' 2');
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
  });

  it('starts after an orphaned starting mark has expired, so a reload mid-start does not block the row forever', async () => {
    sessionStorage.setItem('cc.pdf.2:starting', String(Date.now() - 16_000));
    await remountDrawer();
    const item = await run();
    expect(posts).toHaveLength(1);
    expect(item.dataset.proposalState).toBe('done');
  });
});


describe('Ask drawer: setStatus names its row and shows the note it writes (R17-shared-comp-L3-01)', () => {
  const TRACKER = { kind: 'ok', path: 'data/applications.md', etag: 'e', rows: [{ num: 1, date: '2026-10-01', company: 'Acme', role: 'Engineer' }] };
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return new Response(JSON.stringify({ result: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url === '/api/tracker') return new Response(JSON.stringify(TRACKER), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    await remountDrawer();
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

  it('shows the note it writes and names the row by company and role', async () => {
    await act(async () => emitEnvelope!('act', { action: 'setStatus', params: { row: 1, state: 'Applied', note: 're-linked report 12' } }, 1));
    await act(async () => bodyButton('Review and run')!.click());
    const dialog = document.body.querySelector('.dialog')!;
    expect(dialog.textContent).toContain('Acme');
    expect(dialog.textContent).toContain('Engineer');
    expect(dialog.textContent).toContain('re-linked report 12');
  });
});

describe('Ask drawer: setStatus carries the identity of the row the confirm named (R30-feat-c-L2-01c)', () => {
  const TRACKER = { kind: 'ok', path: 'data/applications.md', etag: 'e', rows: [{ num: 1, date: '2026-10-01', company: 'Acme', role: 'Engineer', report: 7 }] };
  let posts: Array<{ url: string; body: unknown }>;
  let answer: () => Response;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  beforeEach(async () => {
    posts = [];
    answer = () => json({ result: 'ok' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return answer();
        }
        if (url === '/api/tracker') return json(TRACKER);
        return json([]);
      }),
    );
    await remountDrawer();
    // The confirm names the row from the loaded tracker, so it has to be loaded before the proposal is reviewed.
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  const approve = async () => {
    await act(async () => emitEnvelope!('act', { action: 'setStatus', params: { row: 1, state: 'Applied' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await until(() => document.body.querySelector('.dialog')?.textContent?.includes('Acme'), 'the confirm naming Acme');
    await act(async () => bodyButton('Do it')!.click());
    return item;
  };

  it('sends the company, role and report of the row the confirm showed, so a reindex cannot move the write onto another row', async () => {
    const item = await approve();
    expect(posts).toEqual([{ url: '/api/actions/tracker.setStatus', body: { params: { row: 1, state: 'Applied', expectCompany: 'Acme', expectRole: 'Engineer', expectReport: 7 } } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('a 409 because another row now sits under that number fails the proposal with the server message', async () => {
    answer = () => json({ error: 'Row #1 now holds Globex (Designer), not the row you picked. Reload the tracker.' }, 409);
    const item = await approve();
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('Row #1 now holds Globex (Designer)');
  });
});

describe('Ask drawer: generatePdf names the application the confirm showed (R35-sessions-FC-01)', () => {
  const TRACKER = { kind: 'ok', path: 'data/applications.md', etag: 'e', rows: [{ num: 2, date: '2026-10-01', company: 'Acme', role: 'Engineer', report: 7 }] };
  let posts: Array<{ url: string; body: unknown }>;
  let answer: () => Response;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  beforeEach(async () => {
    posts = [];
    sessionStorage.clear();
    answer = () => json({ id: 's-new', mode: 'pdf', status: 'queued', target: { type: 'app', value: '2' } }, 202);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return answer();
        }
        if (url === '/api/tracker') return json(TRACKER);
        return json([]);
      }),
    );
    await remountDrawer();
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  const approve = async () => {
    await act(async () => emitEnvelope!('act', { action: 'generatePdf', params: { row: '2' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await until(() => document.body.querySelector('.dialog')?.textContent?.includes('Acme'), 'the confirm naming Acme');
    await act(async () => bodyButton('Do it')!.click());
    await until(() => item.dataset.proposalState !== 'running' && item.dataset.proposalState !== 'pending', 'the proposal to settle');
    return item;
  };

  it('starts the CV session expecting the company, role and report of the row the confirm named', async () => {
    const item = await approve();
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { target: unknown }).target).toEqual({ type: 'app', value: '2', expect: { company: 'Acme', role: 'Engineer', report: 7 } });
    expect(item.dataset.proposalState).toBe('done');
  });

  it('a 409 because another application now sits under the number fails the proposal with the reload message', async () => {
    answer = () => json({ error: 'Not started: tracker row #2 now holds Globex (Designer), not Acme (Engineer). Reload the page.' }, 409);
    const item = await approve();
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('Reload the page');
    expect(sessionStorage.getItem('cc.pdf.2:starting')).toBeNull();
  });
});

describe('Ask drawer: evaluating every posting at a company (SW7-web-a-03)', () => {
  let posts: Array<{ url: string; body: unknown }>;
  const row = (url: string, company: string, done = false) => ({ url, company, role: 'Engineer', location: null, compensation: null, done, section: done ? 'done' : 'pending', postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'manual', seniority: null, line: 1 });
  let rows: ReturnType<typeof row>[];
  beforeEach(() => {
    posts = [];
    rows = [row('https://jobs.acme.example/1', 'Acme'), row('https://jobs.acme.example/2', ' acme '), row('https://jobs.acme.example/3', 'Acme', true), row('https://jobs.globex.example/1', 'Globex')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return url === '/api/sessions/fanout' ? json({ sessions: [{ id: 's1' }, { id: 's2' }], reserved: [50, 51] }, 202) : json({ error: 'unexpected' }, 500);
        }
        if (url === '/api/pipeline')
          return json({
            kind: 'ok',
            path: 'data/pipeline.md',
            etag: 'e1',
            rows,
          });
        return json([]);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  const runProposal = async (company: string) => {
    await act(async () => emitEnvelope!('act', { action: 'evaluateCompany', params: { company } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await act(async () => bodyButton('Do it')!.click());
    return item;
  };

  it('asks with the number of evaluations it will start, before starting any (review fix)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'evaluateCompany', params: { company: 'Acme' } }, 1));
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog')?.textContent).toContain('2 pending Inbox postings at Acme');
    expect(posts).toEqual([]);
  });

  it('above three evaluations, asks the way Evaluate visible does: Start N evaluation sessions? (review fix)', async () => {
    rows.push(row('https://jobs.acme.example/4', 'Acme'), row('https://jobs.acme.example/5', 'Acme'));
    await act(async () => emitEnvelope!('act', { action: 'evaluateCompany', params: { company: 'Acme' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog__title')?.textContent).toBe('Start 4 evaluation sessions?');
    await act(async () => bodyButton('Start them')!.click());
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { urls: string[] }).urls).toHaveLength(4);
    expect(item.dataset.proposalState).toBe('done');
  });

  it("evaluates each of the company's pending Inbox postings by URL, so each row moves to Processed once its report is written", async () => {
    const item = await runProposal('Acme');
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.acme.example/1', 'https://jobs.acme.example/2'] } }]);
    expect(item.dataset.proposalState).toBe('done');
    expect(navigations).toEqual([{ to: '/sessions' }]);
  });

  it('leaves saved-JD rows and needs-JD rows out, as Evaluate visible does (R13-shared-comp-L2-01)', async () => {
    rows.push(row('local:jds/2026-10-06_acme_pm.pdf', 'Acme'), { ...row('https://www.linkedin.com/jobs/view/4100000001', 'Acme'), needsJd: true } as ReturnType<typeof row>);
    const item = await runProposal('Acme');
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.acme.example/1', 'https://jobs.acme.example/2'] } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('leaves a posting already being evaluated out, as Evaluate visible does (R17-shared-comp-L1-01)', async () => {
    const active = { id: 's-active', mode: 'oferta', status: 'running', target: { type: 'url', value: 'https://jobs.acme.example/1' } };
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return json({ sessions: [{ id: 's1' }], reserved: [50] }, 202);
      }
      if (String(url) === '/api/pipeline') return json({ kind: 'ok', path: 'data/pipeline.md', etag: 'e1', rows });
      if (String(url) === '/api/sessions') return json([active]);
      return json([]);
    });
    await remountDrawer();
    const item = await runProposal('Acme');
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.acme.example/2'] } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('a fan-out whose sessions fail to start is reported, names the postings left pending, and stays on the page (review fix)', async () => {
    const session = (id: string, url: string, status: string) => ({ id, status, target: { type: 'url', value: url }, reportNum: null, error: status === 'error' ? 'the Claude CLI is not approved' : null });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return json({ sessions: [session('s1', 'https://jobs.acme.example/1', 'queued'), session('s2', 'https://jobs.acme.example/2', 'error')], reserved: [50, 51] }, 202);
      }
      return String(url) === '/api/pipeline' ? json({ kind: 'ok', path: 'data/pipeline.md', etag: 'e1', rows }) : json([]);
    });
    const item = await runProposal('Acme');
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('Started 1 of 2 evaluations with report number 50. 1 could not start: the Claude CLI is not approved');
    expect(item.textContent).toContain('Not started: https://jobs.acme.example/2');
    expect(navigations).toEqual([]);
  });

  it('given the advisor names the company as the pipeline writes it (markdown-escaped), evaluates its postings (R21-shared-comp-L2-01)', async () => {
    rows.push(row('https://jobs.acmelabs.example/1', 'Acme [Labs]'), row('https://jobs.acmelabs.example/2', 'Acme [Labs]'));
    const item = await runProposal('Acme \\[Labs\\]');
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.acmelabs.example/1', 'https://jobs.acmelabs.example/2'] } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('given the advisor names the company in its plain spelling, evaluates its postings too (R21-shared-comp-L2-01)', async () => {
    rows.push(row('https://jobs.acmelabs.example/1', 'Acme [Labs]'));
    const item = await runProposal('Acme [Labs]');
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.acmelabs.example/1'] } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('given one pending row with a credential-bearing URL, evaluates the clean postings and says how many rows were left out (FU-askdrawer-creds)', async () => {
    rows.push(row('https://user:secret@jobs.acme.example/9', 'Acme'));
    const item = await runProposal('Acme');
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.acme.example/1', 'https://jobs.acme.example/2'] } }]);
    expect(item.dataset.proposalState).toBe('done');
    expect(item.textContent).toContain('1 row has a URL that is not a plain http(s) posting address');
  });

  it('given one pending row whose URL cell runs into the role (a space in it), evaluates the clean postings and counts it as left out (R22-feat-b-L2-01)', async () => {
    rows.push(row('https://jobs.acme.example/9 Senior Engineer', 'Acme'));
    const item = await runProposal('Acme');
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.acme.example/1', 'https://jobs.acme.example/2'] } }]);
    expect(item.dataset.proposalState).toBe('done');
    expect(item.textContent).toContain('1 row has a URL that is not a plain http(s) posting address (credentials, spaces or another scheme)');
  });

  it('given every clean posting is already being evaluated, the note still counts the rows left out (FU-askdrawer-creds review)', async () => {
    rows.push(row('https://user:secret@jobs.acme.example/9', 'Acme'));
    const listed = ['https://jobs.acme.example/1', 'https://jobs.acme.example/2'].map((value, i) => ({ id: `s-active-${i}`, mode: 'oferta', status: 'running', target: { type: 'url', value } }));
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return json({ error: 'unexpected' }, 500);
      }
      if (String(url) === '/api/pipeline') return json({ kind: 'ok', path: 'data/pipeline.md', etag: 'e1', rows });
      if (String(url) === '/api/sessions') return json(listed);
      return json([]);
    });
    await remountDrawer();
    await act(async () => emitEnvelope!('act', { action: 'evaluateCompany', params: { company: 'Acme' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('already being evaluated');
    expect(item.textContent).toContain('1 row has a URL that is not a plain http(s) posting address');
  });

  it('given every pending row at the company has an unsendable URL, starts nothing and says why, without asking (FU-askdrawer-creds)', async () => {
    rows.push(row('https://user:secret@jobs.initech.example/1', 'Initech'), row('ftp://jobs.initech.example/2', 'Initech'));
    await act(async () => emitEnvelope!('act', { action: 'evaluateCompany', params: { company: 'Initech' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('2 rows have a URL that is not a plain http(s) posting address');
  });

  it('with no pending posting at that company, starts nothing and says so, without asking', async () => {
    await act(async () => emitEnvelope!('act', { action: 'evaluateCompany', params: { company: 'Initech' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('No pending Inbox posting at Initech');
  });

  it('given an unsendable spelling of a posting whose plain twin is evaluated, does not say that posting is left out (R27-shared-comp-X-01 review)', async () => {
    rows.push(row('https://jobs.acme.example/1 ', 'Acme'));
    const item = await runProposal('Acme');
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.acme.example/1', 'https://jobs.acme.example/2'] } }]);
    await until(() => item.dataset.proposalState === 'done' || undefined, 'the proposal done');
    expect(item.textContent).not.toContain('left out');
  });

  it('given two spellings of one posting pending at the company, starts one evaluation for it and reports done (R27-shared-comp-L2-01)', async () => {
    rows.push(row('https://jobs.acme.example/1?gh_src=abc', 'Acme'));
    const item = await runProposal('Acme');
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.acme.example/1', 'https://jobs.acme.example/2'] } }]);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('holds Process inbox back from the confirm on, so one started during the recheck cannot join this fan-out (R27-shared-comp-X-01 review)', async () => {
    const { markBatchStarting, useBatchStarting } = await import('@web/features/pipeline/InboxAi');
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useBatchStarting());
      return null;
    };
    const probeHost = document.createElement('div');
    document.body.append(probeHost);
    const probeRoot = createRoot(probeHost);
    await act(async () => probeRoot.render(createElement(Probe)));
    let confirmed = false;
    let answerRecheck: (() => void) | undefined;
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (confirmed && !answerRecheck && String(url) === '/api/sessions' && !init?.method) await new Promise<void>((r) => (answerRecheck = r));
      return answer(url as string, init);
    });
    try {
      await act(async () => emitEnvelope!('act', { action: 'evaluateCompany', params: { company: 'Acme' } }, 1));
      const item = host.querySelector<HTMLLIElement>('li.proposal')!;
      await act(async () => bodyButton('Review and run')!.click());
      const doIt = await until(() => bodyButton('Do it'), 'the confirm');
      // Set in the same task as the click, so no sessions poll can be taken for the recheck.
      await act(async () => {
        confirmed = true;
        doIt.click();
      });
      await until(() => answerRecheck, 'the recheck of live Process inbox runs');
      expect(seen.at(-1)).toBe(true);
      await act(async () => answerRecheck!());
      await until(() => item.dataset.proposalState === 'done' || undefined, 'the proposal done');
      expect(seen.at(-1)).toBe(false);
    } finally {
      if (seen.at(-1)) markBatchStarting(false);
      await act(async () => probeRoot.unmount());
      probeHost.remove();
    }
  });

  it('holds Process inbox back while an evaluate of a pending Inbox row starts (R27-shared-comp-X-01 review)', async () => {
    const { markBatchStarting, useBatchStarting } = await import('@web/features/pipeline/InboxAi');
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useBatchStarting());
      return null;
    };
    const probeHost = document.createElement('div');
    document.body.append(probeHost);
    const probeRoot = createRoot(probeHost);
    await act(async () => probeRoot.render(createElement(Probe)));
    let answerStart: (() => void) | undefined;
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/sessions' && init?.method === 'POST') {
        await new Promise<void>((r) => (answerStart = r));
        return new Response(JSON.stringify({ id: 's-new', mode: 'oferta', status: 'queued', target: { type: 'url', value: 'https://jobs.acme.example/1' } }), { status: 202, headers: { 'content-type': 'application/json' } });
      }
      return answer(url as string, init);
    });
    try {
      await act(async () => emitEnvelope!('act', { action: 'evaluate', params: { url: 'https://jobs.acme.example/1' } }, 1));
      const item = host.querySelector<HTMLLIElement>('li.proposal')!;
      await act(async () => bodyButton('Review and run')!.click());
      const doIt = await until(() => bodyButton('Do it'), 'the confirm');
      await act(async () => doIt.click());
      await until(() => answerStart, 'the evaluation start');
      expect(seen.at(-1)).toBe(true);
      await act(async () => answerStart!());
      await until(() => item.dataset.proposalState === 'done' || undefined, 'the proposal done');
      expect(seen.at(-1)).toBe(false);
    } finally {
      if (seen.at(-1)) markBatchStarting(false);
      await act(async () => probeRoot.unmount());
      probeHost.remove();
    }
  });

  it('does not hold Process inbox back while an evaluate of a posting not in the Inbox starts (R27-shared-comp-X-01 review)', async () => {
    const { markBatchStarting, useBatchStarting } = await import('@web/features/pipeline/InboxAi');
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useBatchStarting());
      return null;
    };
    const probeHost = document.createElement('div');
    document.body.append(probeHost);
    const probeRoot = createRoot(probeHost);
    await act(async () => probeRoot.render(createElement(Probe)));
    let answerStart: (() => void) | undefined;
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/sessions' && init?.method === 'POST') {
        await new Promise<void>((r) => (answerStart = r));
        return new Response(JSON.stringify({ id: 's-new', mode: 'oferta', status: 'queued', target: { type: 'url', value: 'https://jobs.initech.example/9' } }), { status: 202, headers: { 'content-type': 'application/json' } });
      }
      return answer(url as string, init);
    });
    try {
      await act(async () => emitEnvelope!('act', { action: 'evaluate', params: { url: 'https://jobs.initech.example/9' } }, 1));
      const item = host.querySelector<HTMLLIElement>('li.proposal')!;
      await act(async () => bodyButton('Review and run')!.click());
      const doIt = await until(() => bodyButton('Do it'), 'the confirm');
      await act(async () => doIt.click());
      await until(() => answerStart, 'the evaluation start');
      expect(seen).not.toContain(true);
      await act(async () => answerStart!());
      await until(() => item.dataset.proposalState === 'done' || undefined, 'the proposal done');
      expect(seen.at(-1)).toBe(false);
    } finally {
      if (seen.at(-1)) markBatchStarting(false);
      await act(async () => probeRoot.unmount());
      probeHost.remove();
    }
  });

  it('holds Process inbox back while the fan-out starts, and refreshes the sessions list before letting go (R27-shared-comp-L1-01)', async () => {
    const { markBatchStarting, useBatchStarting } = await import('@web/features/pipeline/InboxAi');
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useBatchStarting());
      return null;
    };
    const probeHost = document.createElement('div');
    document.body.append(probeHost);
    const probeRoot = createRoot(probeHost);
    await act(async () => probeRoot.render(createElement(Probe)));
    const calls: string[] = [];
    let answerFanout!: () => void;
    const answer = vi.mocked(fetch).getMockImplementation()!;
    // The first sessions read after the fan-out answered is held open, to check the hold outlasts it.
    let fanoutAnswered = false;
    let answerRefresh: (() => void) | undefined;
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (String(url) === '/api/sessions' && !init?.method && fanoutAnswered && !answerRefresh) await new Promise<void>((r) => (answerRefresh = r));
      if (String(url) === '/api/sessions/fanout') await new Promise<void>((r) => (answerFanout = r));
      return answer(url as string, init);
    });
    try {
      const item = await runProposal('Acme');
      expect(seen.at(-1)).toBe(true);
      await act(async () => {
        fanoutAnswered = true;
        answerFanout();
      });
      await until(() => answerRefresh, 'the sessions refresh');
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(seen.at(-1)).toBe(true);
      await act(async () => answerRefresh!());
      await until(() => item.dataset.proposalState === 'done' || undefined, 'the proposal done');
      expect(seen.at(-1)).toBe(false);
      expect(calls).toContain('POST /api/sessions/fanout');
      expect(calls.slice(calls.indexOf('POST /api/sessions/fanout'))).toContain('GET /api/sessions');
    } finally {
      // A failed run must not leave the shared mark set for the next test.
      if (seen.at(-1)) markBatchStarting(false);
      await act(async () => probeRoot.unmount());
      probeHost.remove();
    }
  });
});

describe('Ask drawer: evaluations wait for a live Process inbox run (R18-shared-comp-L3-01)', () => {
  let posts: Array<{ url: string; body: unknown }>;
  let listed: Array<Record<string, unknown>>;
  const row = (url: string, company: string) => ({ url, company, role: 'Engineer', location: null, compensation: null, done: false, section: 'pending', postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'manual', seniority: null, line: 1 });
  const PIPELINE = { id: 's-pipeline', mode: 'pipeline', status: 'running', target: { type: 'none', value: '' } };
  beforeEach(async () => {
    posts = [];
    listed = [PIPELINE];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return url === '/api/sessions/fanout' ? json({ sessions: [{ id: 's1' }], reserved: [50] }, 202) : json({ id: 's-new', mode: 'oferta', status: 'queued', target: { type: 'url', value: 'x' } }, 202);
        }
        if (url === '/api/pipeline') return json({ kind: 'ok', path: 'data/pipeline.md', etag: 'e1', rows: [row('https://jobs.acme.example/1', 'Acme')] });
        if (url === '/api/sessions') return json(listed);
        return json([]);
      }),
    );
    await remountDrawer();
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  const propose = async (action: string, params: Record<string, unknown>) => {
    await act(async () => emitEnvelope!('act', { action, params }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    return item;
  };

  it('given Process inbox is running, an evaluateCompany fails before asking and starts nothing', async () => {
    const item = await propose('evaluateCompany', { company: 'Acme' });
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('Process inbox is evaluating the pending rows');
  });

  it('given a language-directory Process inbox (de/pipeline) is running, an evaluate of a pending Inbox row fails before asking and starts nothing (R30-feat-b-X-01b)', async () => {
    listed = [{ ...PIPELINE, mode: 'de/pipeline' }];
    const item = await propose('evaluate', { url: 'https://jobs.acme.example/1' });
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('Process inbox is evaluating the pending rows');
  });

  it('given Process inbox is running, an evaluate of a pending Inbox row fails before asking and starts nothing', async () => {
    const item = await propose('evaluate', { url: 'https://jobs.acme.example/1' });
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('Process inbox is evaluating the pending rows');
  });

  it('given Process inbox is running, an evaluate of a pending Inbox row spelled with a tracking param and a trailing slash fails before asking and starts nothing (R25-shared-comp-L2-01)', async () => {
    const item = await propose('evaluate', { url: 'https://jobs.acme.example/1/?utm_source=linkedin' });
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
    expect(item.textContent).toContain('Process inbox is evaluating the pending rows');
  });

  it('given Process inbox is running, an evaluate of a posting not in the Inbox still runs', async () => {
    const item = await propose('evaluate', { url: 'https://jobs.globex.example/9' });
    await act(async () => bodyButton('Do it')!.click());
    expect(posts.map((p) => p.url)).toEqual(['/api/sessions']);
    expect(item.dataset.proposalState).toBe('done');
  });

  it('given Process inbox started after the last sessions poll, an evaluateCompany still fails before asking', async () => {
    listed = [];
    await remountDrawer();
    listed = [PIPELINE];
    const item = await propose('evaluateCompany', { company: 'Acme' });
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
  });

  it('given Process inbox starts while the confirm is open, Do it starts nothing', async () => {
    listed = [];
    await remountDrawer();
    for (const [action, params] of [['evaluateCompany', { company: 'Acme' }], ['evaluate', { url: 'https://jobs.acme.example/1' }]] as const) {
      listed = [];
      const item = await propose(action, params);
      listed = [PIPELINE];
      await act(async () => bodyButton('Do it')!.click());
      expect(posts).toEqual([]);
      expect(item.dataset.proposalState).toBe('failed');
      expect(item.textContent).toContain('Process inbox is evaluating the pending rows');
      await remountDrawer();
    }
  });

  it('given a Process inbox start sent while the confirm is open but not answered yet, Do it starts nothing (R27-shared-comp-X-01 review)', async () => {
    const { lastSession } = await import('@web/lib/lastSession');
    const process = lastSession('cc.pipeline.process');
    for (const [action, params] of [['evaluateCompany', { company: 'Acme' }], ['evaluate', { url: 'https://jobs.acme.example/1' }]] as const) {
      listed = [];
      await remountDrawer();
      const item = await propose(action, params);
      // The Inbox's start form marks the start before its POST; the session is in no list until the POST answers.
      process.setStarting(true);
      try {
        await act(async () => bodyButton('Do it')!.click());
        expect(posts).toEqual([]);
        expect(item.dataset.proposalState).toBe('failed');
        expect(item.textContent).toContain('Process inbox is evaluating the pending rows');
      } finally {
        process.setStarting(false);
      }
    }
  });

  it('given a Process inbox that reported its id while the confirm was open but is not listed yet, Do it starts nothing (R27-shared-comp-X-01 review)', async () => {
    const { lastSession } = await import('@web/lib/lastSession');
    const process = lastSession('cc.pipeline.process');
    for (const [action, params] of [['evaluateCompany', { company: 'Acme' }], ['evaluate', { url: 'https://jobs.acme.example/1' }]] as const) {
      listed = [];
      await remountDrawer();
      const item = await propose(action, params);
      process.write('s-reported');
      try {
        await act(async () => bodyButton('Do it')!.click());
        expect(posts).toEqual([]);
        expect(item.dataset.proposalState).toBe('failed');
      } finally {
        process.write(null);
      }
    }
  });

  it('given a remembered Process inbox id from before the proposal that the server no longer lists, the evaluation still runs', async () => {
    const { lastSession } = await import('@web/lib/lastSession');
    const process = lastSession('cc.pipeline.process');
    listed = [];
    process.write('s-gone');
    try {
      await remountDrawer();
      const item = await propose('evaluateCompany', { company: 'Acme' });
      await act(async () => bodyButton('Do it')!.click());
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(posts.map((p) => p.url)).toEqual(['/api/sessions/fanout']);
      expect(item.dataset.proposalState).toBe('done');
    } finally {
      process.write(null);
    }
  });

  it('given a sessions poll sent before Process inbox started is still in flight, the check does not reuse its answer', async () => {
    let releasePoll: (() => void) | null = null;
    const fetchMock = vi.mocked(fetch);
    const passThrough = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (String(url) === '/api/sessions' && init?.method !== 'POST' && releasePoll === null) {
        const stale = new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        return new Promise<Response>((r) => (releasePoll = () => r(stale)));
      }
      return passThrough(url, init);
    });
    await remountDrawer();
    expect(releasePoll).not.toBeNull();
    const item = await propose('evaluateCompany', { company: 'Acme' });
    await act(async () => releasePoll!());
    expect(document.body.querySelector('.dialog')).toBeNull();
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('failed');
  });

  it('given the Process inbox run has ended, an evaluateCompany runs', async () => {
    listed = [{ ...PIPELINE, status: 'done' }];
    await remountDrawer();
    const item = await propose('evaluateCompany', { company: 'Acme' });
    await act(async () => bodyButton('Do it')!.click());
    expect(posts.map((p) => p.url)).toEqual(['/api/sessions/fanout']);
    expect(item.dataset.proposalState).toBe('done');
  });
});

describe('Ask drawer: an evaluateCompany skips postings whose evaluation started while the confirm was open (R29-shared-comp-X-01)', () => {
  const U1 = 'https://jobs.acme.example/1';
  const U2 = 'https://jobs.acme.example/2';
  let posts: Array<{ url: string; body: unknown }>;
  let listed: Array<Record<string, unknown>>;
  let answerSingleStart: (() => void) | null;
  const row = (url: string) => ({ url, company: 'Acme', role: 'Engineer', location: null, compensation: null, done: false, section: 'pending', postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'manual', seniority: null, line: 1 });
  const oferta = (id: string, url: string, status = 'running') => ({ id, mode: 'oferta', status, target: { type: 'url', value: url } });
  beforeEach(async () => {
    posts = [];
    listed = [];
    answerSingleStart = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          if (url === '/api/sessions/fanout') return json({ sessions: [{ id: 's-fan' }], reserved: [50] }, 202);
          // A single Evaluate elsewhere, still waiting on its answer.
          await new Promise<void>((r) => (answerSingleStart = r));
          return json(oferta('s-single', U1, 'queued'), 202);
        }
        if (url === '/api/pipeline') return json({ kind: 'ok', path: 'data/pipeline.md', etag: 'e1', rows: [row(U1), row(U2)] });
        if (url === '/api/sessions') return json(listed);
        return json([]);
      }),
    );
    await remountDrawer();
  });
  afterEach(async () => {
    // A start left waiting would stay in the shared in-flight map for the next test.
    await act(async () => answerSingleStart?.());
    vi.unstubAllGlobals();
  });

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  const propose = async () => {
    await act(async () => emitEnvelope!('act', { action: 'evaluateCompany', params: { company: 'Acme' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog')?.textContent).toContain('2 pending Inbox postings at Acme');
    return item;
  };
  const fannedOut = () => posts.filter((p) => p.url === '/api/sessions/fanout').map((p) => (p.body as { urls: string[] }).urls);

  it('given an oferta session for one posting started on the server while the confirm was open, Do it starts only the other', async () => {
    const item = await propose();
    listed = [oferta('s-elsewhere', `${U1}?utm_source=linkedin`)];
    await act(async () => bodyButton('Do it')!.click());
    await until(() => item.dataset.proposalState === 'done' || undefined, 'the proposal done');
    expect(fannedOut()).toEqual([[U2]]);
  });

  it('given every posting started elsewhere while the confirm was open, Do it starts nothing and says so', async () => {
    const item = await propose();
    listed = [oferta('s-a', U1), oferta('s-b', U2, 'awaiting_user')];
    await act(async () => bodyButton('Do it')!.click());
    await until(() => item.dataset.proposalState === 'failed' || undefined, 'the proposal failed');
    expect(fannedOut()).toEqual([]);
    expect(item.textContent).toContain('Every pending Inbox posting at Acme is already being evaluated.');
  });

  it('given an evaluate of a posting whose oferta session started elsewhere while the confirm was open, Do it opens that session and starts none', async () => {
    await act(async () => emitEnvelope!('act', { action: 'evaluate', params: { url: U1 } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    listed = [oferta('s-elsewhere', U1)];
    await act(async () => bodyButton('Do it')!.click());
    await until(() => item.dataset.proposalState === 'done' || undefined, 'the proposal done');
    expect(posts).toEqual([]);
    expect(navigations.at(-1)).toEqual({ to: '/sessions/$id', params: { id: 's-elsewhere' } });
  });

  it('given a single Evaluate start for one posting still awaiting its answer, Do it starts only the other', async () => {
    const { useStartEvaluation } = await import('@web/features/today/evaluate');
    let start: ((ref: string) => Promise<unknown>) | null = null;
    const Probe = () => {
      start = useStartEvaluation();
      return null;
    };
    const probeHost = document.createElement('div');
    document.body.append(probeHost);
    const probeRoot = createRoot(probeHost);
    await act(async () => probeRoot.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe))));
    try {
      const item = await propose();
      let single: Promise<unknown> | null = null;
      await act(async () => void (single = start!(U1)));
      await until(() => answerSingleStart, 'the single start sent');
      await act(async () => bodyButton('Do it')!.click());
      await until(() => item.dataset.proposalState === 'done' || undefined, 'the proposal done');
      expect(fannedOut()).toEqual([[U2]]);
      await act(async () => {
        answerSingleStart!();
        await single;
      });
    } finally {
      await act(async () => probeRoot.unmount());
      probeHost.remove();
    }
  });
});

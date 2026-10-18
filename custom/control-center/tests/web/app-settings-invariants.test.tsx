// The app-settings invariants (web/features/settings/AppTab.invariants.md) over table cases and seeded random
// operation sequences. The server stub follows /api/settings/app: versions are the file's content, as the real route's
// hash, so they repeat when the content returns to an earlier state (R34-feat-c-L1-01), and a write against an older
// version is refused with settings-changed and the current read.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Settings = { logos: boolean; retention: number; claudeConcurrency: number; modelDefault: string; usageBudgets: { fiveHourTokens: number | null; sevenDayTokens: number | null } };
const INITIAL: Settings = { logos: false, retention: 200, claudeConcurrency: 1, modelDefault: '', usageBudgets: { fiveHourTokens: null, sevenDayTokens: null } };

let settings: Settings;
let puts: Array<{ ifMatch: string | null; patch: Partial<Settings>; status: number }>;
let held: Array<() => void> | null;
/** When set, each read waits here until the test lets it answer. */
let heldGets: Array<() => void> | null;
let roots: Root[];

const etag = (s: Settings = settings) => `c:${JSON.stringify(s)}`;
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  settings = structuredClone(INITIAL);
  puts = [];
  held = null;
  heldGets = null;
  roots = [];
  localStorage.clear();
  vi.resetModules();
  stubLocks();
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/settings/app' && method === 'GET') {
        if (heldGets) await new Promise<void>((answer) => heldGets!.push(answer));
        return json(200, { ...settings, problem: null, etag: etag() });
      }
      if (url === '/api/settings/app' && method === 'PUT') {
        const patch = JSON.parse(String(init!.body)) as Partial<Settings>;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const ifMatch = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-match')?.[1] ?? null;
        if (held) await new Promise<void>((take) => held!.push(take));
        if (ifMatch !== null && ifMatch !== etag()) {
          puts.push({ ifMatch, patch, status: 409 });
          return json(409, { code: 'settings-changed', error: 'settings.json changed since you loaded it', current: { ...settings, problem: null, etag: etag() } });
        }
        puts.push({ ifMatch, patch, status: 200 });
        settings = { ...settings, ...patch };
        return json(200, { ...settings, etag: etag() });
      }
      if (url === '/api/usage') return json(200, {});
      return json(404, { error: 'not stubbed' });
    }),
  );
});
afterEach(async () => {
  for (const answer of [...(heldGets ?? []), ...(held ?? [])]) answer();
  for (const r of roots) await act(async () => r.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (navigator as { locks?: unknown }).locks;
});

/** The browser's Web Locks: one holder per name across every tab of the origin, granted in request order. */
function stubLocks() {
  const locks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, cb: () => Promise<unknown>) => {
        const run = (locks.get(name) ?? Promise.resolve()).then(() => cb());
        locks.set(
          name,
          run.catch(() => undefined),
        );
        return run;
      },
    },
  });
}

type Tab = { host: HTMLElement; qc: QueryClient };
/** A browser tab: its own module instance and query cache; tabs share localStorage and the Web Locks. */
async function openTab(): Promise<Tab> {
  vi.resetModules();
  const mod = await import('@web/features/settings/AppTab');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(mod.AppTab))));
  await until(() => host.querySelector('#setting-logos'), 'the logos checkbox');
  return { host, qc };
}
const box = (tab: Tab) => tab.host.querySelector<HTMLInputElement>('#setting-logos')!;
const alerts = (tab: Tab) => [...tab.host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '').join('\n');
/** Waits until no write is on its way and the tab's reads have answered. */
async function settle(tab: Tab, putsBefore: number, sent = 1) {
  await until(() => puts.length >= putsBefore + sent && tab.qc.isFetching() === 0 && tab.qc.isMutating() === 0, 'the save answered and the reads settled');
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  await until(() => tab.qc.isFetching() === 0, 'the refetch after the save');
}
async function toggle(tab: Tab) {
  const before = puts.length;
  await act(async () => box(tab).click());
  await settle(tab, before);
  return puts.at(-1)!;
}
async function refetch(tab: Tab) {
  await act(async () => tab.qc.invalidateQueries());
  await until(() => tab.qc.isFetching() === 0, 'the refetch');
}
/** Another browser, device or a hand edit: the file changes without this browser knowing. */
const outside = (patch: Partial<Settings>) => {
  settings = { ...settings, ...patch };
};

describe('app settings invariants: liveness when versions repeat (R34-feat-c-L1-01)', () => {
  // Each case ends with the file at a version this browser has seen before, changed by someone else.
  const cases: Array<{ name: string; history: (tab: Tab) => Promise<void> }> = [
    { name: 'the file returns to the content this browser started from', history: async (tab) => void (await toggle(tab), outside({ logos: false })) },
    { name: 'the file is restored to the content of an earlier own save', history: async (tab) => void (await toggle(tab), await toggle(tab), outside({ logos: true })) },
    { name: 'another browser repeats a content this browser wrote and left', history: async (tab) => void (await toggle(tab), await toggle(tab), await toggle(tab), outside({ logos: false })) },
    { name: 'a hand edit brings back a version, with a field this tab never touched', history: async (tab) => void (outside({ retention: 900 }), await refetch(tab), await toggle(tab), outside({ logos: false, retention: 200 }), outside({ retention: 900 })) },
  ];

  for (const { name, history } of cases) {
    it(`Given ${name}, when the tab reads it and saves, then the save is taken`, async () => {
      const tab = await openTab();
      await history(tab);
      await refetch(tab);
      const want = !box(tab).checked;
      const put = await toggle(tab);
      expect(put.status).toBe(200);
      expect(settings.logos).toBe(want);
      expect(alerts(tab)).toBe('');
    });

    it(`Given ${name}, when the tab saves without reading it, then the save is refused and the next one taken`, async () => {
      const tab = await openTab();
      await history(tab);
      const outsideState = structuredClone(settings);
      const refused = await toggle(tab);
      expect(refused.status).toBe(409);
      expect(settings).toEqual(outsideState);
      await until(() => /changed since you loaded it/.test(alerts(tab)), 'the conflict shown');
      const taken = await toggle(tab);
      expect(taken.status).toBe(200);
    });
  }
});

describe('app settings invariants: a refusal is a read of the file (invariant 5)', () => {
  it('Given a save refused as changed elsewhere, when a sibling tab saves before the refetch answers, then the next save is taken', async () => {
    const [tabA, tabB] = [await openTab(), await openTab()];
    outside({ retention: 900 });
    await refetch(tabB);
    heldGets = [];
    await act(async () => box(tabA).click());
    await until(() => puts.length === 1 && /changed since you loaded it/.test(alerts(tabA)), 'tab A refused');
    expect(puts[0]!.status).toBe(409);
    await act(async () => box(tabB).click());
    await until(() => puts.length === 2, 'tab B taken');
    expect(puts[1]!.status).toBe(200);
    // Tab A still shows the refusal's read: the file as it was before tab B's write, which is this browser's own.
    await act(async () => box(tabA).click());
    await until(() => puts.length === 3, 'tab A saved again');
    expect(puts[2]!.status).toBe(200);
  });
});

/** mulberry32: a small seeded PRNG, so a failing sequence can be replayed from its seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('app settings invariants: seeded random sequences over two tabs', () => {
  const SEEDS = 20;
  const STEPS = 12;

  it(`Given ${SEEDS} seeded sequences of saves, outside edits and reads, then every save is taken exactly when its base is the file's current version`, async () => {
    const base = Number(process.env.APP_SETTINGS_SEED ?? 1);
    for (let seed = base; seed < base + SEEDS; seed++) {
      const log: string[] = [];
      try {
        await runSequence(seed, log);
      } catch (err) {
        throw new Error(`seed ${seed} (replay with APP_SETTINGS_SEED=${seed}) failed after:\n${log.join('\n')}\n${(err as Error).message}`, { cause: err });
      }
      for (const r of roots.splice(0)) await act(async () => r.unmount());
      document.body.innerHTML = '';
      settings = structuredClone(INITIAL);
      puts = [];
      localStorage.clear();
    }
  }, 30_000);

  /**
   * The model, independent of how AppTab tracks versions: a tab's read shows the file as it was when asked for; the
   * browser counts its taken writes. A save is based on the browser's latest own write when the tab's read was asked
   * for before it, else on the tab's read; it must be taken exactly when that base is the file's current content.
   */
  async function runSequence(seed: number, log: string[]) {
    const rand = prng(seed);
    const tabs = [await openTab(), await openTab()];
    let ownN = 0;
    let ownContent: string | null = null;
    const reads = tabs.map(() => ({ at: 0, content: etag() }));
    for (let step = 0; step < STEPS; step++) {
      const t = Math.floor(rand() * tabs.length);
      const op = rand();
      if (op < 0.5) {
        const r = reads[t]!;
        const based = r.at < ownN ? ownContent! : r.content;
        const file = etag();
        const put = await toggle(tabs[t]!);
        log.push(`tab ${t} toggles logos: ${put.status}`);
        expect(put.status, `tab ${t}'s save based on ${based}, file at ${file}`).toBe(based === file ? 200 : 409);
        if (put.status === 200) {
          ownN += 1;
          ownContent = etag();
        }
        // Every save ends with a read of the file, taken or refused.
        reads[t] = { at: ownN, content: etag() };
      } else if (op < 0.8) {
        const patch = rand() < 0.5 ? { logos: !settings.logos } : { retention: [200, 300][Math.floor(rand() * 2)]! };
        outside(patch);
        log.push(`outside ${JSON.stringify(patch)}`);
      } else {
        await refetch(tabs[t]!);
        reads[t] = { at: ownN, content: etag() };
        log.push(`tab ${t} reads`);
      }
    }
  }
});

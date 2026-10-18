// The server refuses an app-settings write over a settings.json it could not read (R33-feat-c-L2-01) and one based on
// a read another device has since changed (R33-feat-c-X-01). The settings tabs say so, keep the user's draft, and only
// replace an unreadable file when the user asks for it.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The server's settings, the version it reports, and whether settings.json could be read. */
let settings: Record<string, unknown>;
let version: number;
let problem: string | null;
let puts: Array<{ url: string; ifMatch: string | null; patch: Record<string, unknown> }>;
/** When set, each write waits here until the test lets it reach the server. */
let held: Array<() => void> | null;
let roots: Root[];
/** When set, the version is the settings' content, as the real server's hash of the file: saving earlier values revisits a version. */
let contentEtag: boolean;
let lastQc: QueryClient;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const etag = () => (contentEtag ? `c:${JSON.stringify(settings)}` : `v${version}`);
const read = () => ({ ...settings, problem, etag: etag() });

beforeEach(() => {
  settings = { logos: false, retention: 200, claudeConcurrency: 1, modelDefault: '', usageBudgets: { fiveHourTokens: null, sevenDayTokens: null } };
  version = 1;
  problem = null;
  puts = [];
  held = null;
  contentEtag = false;
  roots = [];
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/settings/app' && method === 'GET') return json(200, read());
      if (url.startsWith('/api/settings/app') && method === 'PUT') {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const ifMatch = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-match')?.[1] ?? null;
        const patch = JSON.parse(String(init!.body)) as Record<string, unknown>;
        puts.push({ url, ifMatch, patch });
        if (held) await new Promise<void>((take) => held!.push(take));
        if (problem && !url.endsWith('?reset=1')) return json(409, { code: 'settings-problem', problem, error: `data/control-center/settings.json could not be read (${problem}), so saving would replace it with defaults.` });
        if (ifMatch !== null && ifMatch !== etag()) return json(409, { code: 'settings-changed', error: 'settings.json changed since you loaded it', current: read() });
        settings = { ...settings, ...patch };
        problem = null;
        version += 1;
        return json(200, { ...settings, etag: etag() });
      }
      if (url === '/api/usage') return json(200, {});
      return json(404, { error: 'not stubbed' });
    }),
  );
});
afterEach(async () => {
  for (const r of roots) await act(async () => r.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (navigator as { locks?: unknown }).locks;
});

async function mount(which: 'AppTab' | 'EngineSettings', fresh = false) {
  if (fresh) vi.resetModules();
  const mod = await import('@web/features/settings/AppTab');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastQc = qc;
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(mod[which]))));
  return host;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
/** Another browser or device saving: the server's version moves on without this browser knowing. */
function elsewhere(patch: Record<string, unknown>) {
  settings = { ...settings, ...patch };
  version += 1;
}
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
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const alerts = (host: HTMLElement) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '').join('\n');

describe('app settings: a write the server refuses', () => {
  it('Given settings.json could not be read, when the model is saved, then the refusal is shown, the draft kept and nothing written', async () => {
    problem = 'settings.json is not valid JSON: Unexpected end';
    const host = await mount('EngineSettings');
    await type(await until(() => host.querySelector<HTMLInputElement>('#setting-model'), 'the model field'), 'opus');
    await act(async () => button(host, 'Save')!.click());
    await until(() => /could not be read/.test(alerts(host)) && button(host, 'Replace settings.json'), 'the refusal and the replace button');
    expect(settings.modelDefault).toBe('');
    expect(host.querySelector<HTMLInputElement>('#setting-model')!.value).toBe('opus');
  });

  it('Given the refusal is shown, when the user asks to replace settings.json, then the same patch is sent with the reset opt-in', async () => {
    problem = 'settings.json is not valid JSON: Unexpected end';
    const host = await mount('EngineSettings');
    await type(await until(() => host.querySelector<HTMLInputElement>('#setting-model'), 'the model field'), 'opus');
    await act(async () => button(host, 'Save')!.click());
    const replace = await until(() => button(host, 'Replace settings.json'), 'the replace button');
    await act(async () => replace.click());
    await until(() => settings.modelDefault === 'opus', 'the reset write');
    expect(puts.at(-1)).toMatchObject({ url: '/api/settings/app?reset=1', patch: { modelDefault: 'opus' } });
    await until(() => !alerts(host), 'the alerts cleared');
    // The replaced value is saved, so the field follows the server again rather than holding the sent draft.
    elsewhere({ modelDefault: 'haiku' });
    await act(async () => lastQc.invalidateQueries());
    await until(() => host.querySelector<HTMLInputElement>('#setting-model')?.value === 'haiku', 'the field showing the server value');
  });
});

describe('app settings: a write based on a read another device has changed', () => {
  it('Given another device saved after this tab read, when the model is saved, then it is refused, the latest values shown and the draft kept', async () => {
    const host = await mount('EngineSettings');
    await type(await until(() => host.querySelector<HTMLInputElement>('#setting-model'), 'the model field'), 'opus');
    elsewhere({ modelDefault: 'haiku', claudeConcurrency: 4 });
    await act(async () => button(host, 'Save')!.click());
    await until(() => /changed since you loaded it/.test(alerts(host)), 'the conflict shown');
    expect(puts[0]!.ifMatch).toBe('v1');
    expect(settings.modelDefault).toBe('haiku');
    await until(() => host.querySelector<HTMLSelectElement>('#setting-concurrency')?.value === '4', 'the other device value shown');
    expect(host.querySelector<HTMLInputElement>('#setting-model')!.value).toBe('opus');
    await act(async () => button(host, 'Save')!.click());
    await until(() => settings.modelDefault === 'opus', 'the second save taken');
    expect(puts.at(-1)!.ifMatch).toBe('v2');
  });

  it('Given an immediate control, when its save is refused as changed elsewhere, then the current server value is shown', async () => {
    const host = await mount('AppTab');
    const box = await until(() => host.querySelector<HTMLInputElement>('#setting-logos'), 'the logos checkbox');
    elsewhere({ retention: 900 });
    await act(async () => box.click());
    await until(() => /changed since you loaded it/.test(alerts(host)), 'the conflict shown');
    expect(settings.logos).toBe(false);
    await until(() => host.querySelector<HTMLInputElement>('#setting-retention')?.value === '900' && host.querySelector<HTMLInputElement>('#setting-logos')?.checked === false, 'the current values shown');
  });

  it('Given two tabs of one browser, when both save before either answers, then both are taken in order with no conflict', async () => {
    stubLocks();
    held = [];
    const tabA = await mount('EngineSettings', true);
    const tabB = await mount('EngineSettings', true);
    await choose(await until(() => tabA.querySelector<HTMLSelectElement>('#setting-concurrency'), 'tab A select'), '2');
    await until(() => held!.length > 0, 'tab A write on its way');
    await choose(await until(() => tabB.querySelector<HTMLSelectElement>('#setting-concurrency'), 'tab B select'), '3');
    for (let i = 0; i < 20 && (held!.length > 0 || puts.length < 2); i++) {
      await act(async () => {
        for (const take of held!.splice(0)) take();
        await new Promise((r) => setTimeout(r, 20));
      });
    }
    expect(puts.map((p) => p.ifMatch)).toEqual(['v1', 'v2']);
    expect(settings.claudeConcurrency).toBe(3);
    expect(alerts(tabA) + alerts(tabB)).toBe('');
  });
});

describe('app settings: this browser\'s own saves never conflict with each other', () => {
  it('Given versions named by content, when logos are toggled on, off, on and off, then every save is taken', async () => {
    contentEtag = true;
    const host = await mount('AppTab');
    for (const want of [true, false, true, false]) {
      const box = await until(() => host.querySelector<HTMLInputElement>('#setting-logos'), 'the logos checkbox');
      await act(async () => box.click());
      await until(() => settings.logos === want && host.querySelector<HTMLInputElement>('#setting-logos')?.checked === want, `logos saved ${want}`);
      await act(async () => new Promise((r) => setTimeout(r, 20)));
    }
    expect(alerts(host)).toBe('');
    expect(puts).toHaveLength(4);
  });

  it('Given storage that refuses writes, when logos are toggled twice before the first save answers, then both saves are taken', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    held = [];
    const host = await mount('AppTab');
    const box = await until(() => host.querySelector<HTMLInputElement>('#setting-logos'), 'the logos checkbox');
    await act(async () => box.click());
    await until(() => held!.length > 0, 'the first save on its way');
    await act(async () => host.querySelector<HTMLInputElement>('#setting-logos')!.click());
    for (let i = 0; i < 20 && (held!.length > 0 || puts.length < 2); i++) {
      await act(async () => {
        for (const take of held!.splice(0)) take();
        await new Promise((r) => setTimeout(r, 20));
      });
    }
    expect(alerts(host)).toBe('');
    expect(settings.logos).toBe(false);
    expect(puts.map((p) => p.ifMatch)).toEqual(['v1', 'v2']);
  });

  it('Given versions named by content, when the file returns to a version this browser saw, then a save from that read is taken (R34-feat-c-L1-01)', async () => {
    contentEtag = true;
    const host = await mount('AppTab');
    const box = () => host.querySelector<HTMLInputElement>('#setting-logos');
    await act(async () => (await until(box, 'the logos checkbox')).click());
    await until(() => settings.logos === true && box()?.checked === true, 'logos saved on');
    // Another browser (or a hand restore) brings back the content this browser started from.
    elsewhere({ logos: false });
    await act(async () => lastQc.invalidateQueries());
    await until(() => box()?.checked === false, 'the restored value shown');
    await act(async () => box()!.click());
    // The read was asked for after this browser's own write, so it is written as it is, with no refusal first.
    await until(() => settings.logos === true, 'the save taken');
    expect(puts.filter((p) => p.ifMatch !== null)).toHaveLength(2);
    expect(alerts(host)).toBe('');
    expect(puts.at(-1)!.ifMatch).toBe(`c:${JSON.stringify({ ...settings, logos: false })}`);
  });
});


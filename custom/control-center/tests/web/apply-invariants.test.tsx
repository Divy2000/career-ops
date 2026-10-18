// Apply page invariants (web/features/apply/ApplyPage.invariants.md): a tracker row number is reused after a reindex,
// so nothing the page holds for one application (typed link, CV and cover picks, answers, prefill summary, documents
// listing, draft session) may reach the application that inherits the number. Table cases pin the edge shapes; the
// seeded runs drive random sequences of the page's operations and check the invariants after every step.
import { createElement, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyDocuments, SessionMeta } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; initialPrompt?: string; onStarting?: () => void; onEnvelope?: (kind: string, payload: unknown, turn: number) => void; onSessionId?: (id: string) => void; onStatus?: (s: string, r: string | null) => void };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return props.sessionId ? createElement('button', { type: 'button' }, 'Send') : createElement('button', { type: 'button', onClick: () => props.onStarting?.() }, 'Draft answers');
  },
}));

// Two applications that take turns owning row #12. Each one's data carries its tag, so a value of the other one is
// recognized wherever it shows up.
const OWNERS = {
  a: { tag: 'zq-a', identity: { company: 'Acme Robotics', role: 'Robotics Engineer', report: 31 } },
  b: { tag: 'zq-b', identity: { company: 'Beta Labs', role: 'Data Engineer', report: 44 } },
} as const;
type Owner = keyof typeof OWNERS;
const other = (o: Owner): Owner => (o === 'a' ? 'b' : 'a');
const postingUrl = (o: Owner) => `https://boards.greenhouse.io/${OWNERS[o].tag}/jobs/1`;
// An apply link typed over the posting URL, of the shape the zero-token prefill reads.
const typedLink = (o: Owner, k: number) => `https://boards.greenhouse.io/${OWNERS[o].tag}-careers/jobs/${k}`;
const docsFor = (o: Owner): ApplyDocuments => {
  const t = OWNERS[o].tag;
  return { pdfs: [`output/cv-${t}.pdf`, `output/cv-${t}-short.pdf`], covers: [`output/cover-${t}.md`], suggestedPdf: `output/cv-${t}.pdf`, suggestedCover: null };
};
const answersFor = (o: Owner) => ({ fields: [{ id: 'why', label: 'Why us', type: 'textarea', required: true, value: `answer-${OWNERS[o].tag}`, needsConfirmation: false }] });

const SESSION: SessionMeta = {
  id: 's-x', claudeSessionId: '22222222-2222-4222-8222-222222222222', mode: 'apply', policyClass: 'apply', target: { type: 'app', value: '12' }, model: null,
  status: 'running', createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:05:00.000Z', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null,
  error: null, reportNum: null, lastReason: null, policyVersion: 2,
};

let host: HTMLElement;
let root: Root | null;
/** The application the tracker now holds under #12; the documents listing answers for it. */
let serverOwner: Owner;
/** While set, GET /api/apply/documents waits for it. */
let docsGate: Promise<void> | null;
/** Every POST the page sent, in order. */
let posts: Array<{ url: string; body: string }>;
let reindex: ((o: Owner) => void) | null;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  panels = [];
  serverOwner = 'a';
  docsGate = null;
  posts = [];
  reindex = null;
  root = null;
  sessionStorage.clear();
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push({ url, body: String(init.body ?? '') });
      if (url === '/api/sessions/engine') return json({ playwrightAvailable: true, modes: ['apply'] });
      if (url === '/api/apply/documents?n=12') {
        const owner = serverOwner;
        if (docsGate) await docsGate;
        return json(docsFor(owner));
      }
      if (url === '/api/sessions' && init?.method !== 'POST') return json([]);
      const turn = /^\/api\/sessions\/([^/]+)\/turns$/.exec(url);
      if (turn && init?.method === 'POST') return json({ ...SESSION, id: turn[1] });
      if (url === '/api/actions/docs.prepareApplication') {
        const { params } = JSON.parse(String(init!.body)) as { params: { url: string } };
        return json({ result: `summary of ${params.url}` });
      }
      if (url === '/api/actions/tracker.setStatus') return json({ result: 'updated' });
      return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** Opens /apply/12 as the tracker shows it now; `reindex` hands the number to the other application in place. */
async function open() {
  const { ApplyBody } = await import('@web/features/apply/ApplyPage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  function Shown() {
    const [owner, setOwner] = useState<Owner>(serverOwner);
    reindex = (o) => {
      serverOwner = o;
      setOwner(o);
    };
    return createElement(ApplyBody, { n: '12', company: OWNERS[owner].identity.company, postingUrl: postingUrl(owner), status: 'Evaluated', identity: OWNERS[owner].identity });
  }
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const apply = createRoute({ getParentRoute: () => rootRoute, path: '/apply', component: Shown });
  const router = createRouter({ routeTree: rootRoute.addChildren([apply]), history: createMemoryHistory({ initialEntries: ['/apply'] }) });
  root = createRoot(host);
  await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
  await until(() => applyPanel(), 'the apply session panel');
}
async function leave() {
  await act(async () => root!.unmount());
  root = null;
  panels = [];
}

const applyPanel = () => panels.filter((p) => p.mode === 'apply').pop();
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith(text));
const urlInput = () => host.querySelector<HTMLInputElement>('[aria-label="Posting URL"]');
const select = (label: string) => host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`);
async function typeUrl(value: string) {
  const input = urlInput()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pick(label: string, value: string) {
  const s = select(label)!;
  await act(async () => {
    s.value = value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Everything the page shows or would send for the row: text, every control's value, and the draft prompt. */
function shownStrings(): string[] {
  const controls = [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')].map((c) => c.value);
  return [host.textContent ?? '', ...controls, applyPanel()?.initialPrompt ?? ''];
}
/** The values of `owner`'s rival that reached the page or a request sent since `since`. */
function leaks(owner: Owner, since: number): string[] {
  const tag = OWNERS[other(owner)].tag;
  return [...shownStrings(), ...posts.slice(since).map((p) => p.body)].filter((s) => s.includes(tag));
}

describe('Given row #12 changes owner while its Apply page is open, before any draft started', () => {
  // Each case leaves one piece of the earlier owner's form state behind, then hands the number over.
  const CASES: Array<{ name: string; before: () => Promise<void> }> = [
    { name: 'a typed apply link', before: () => typeUrl(typedLink('a', 1)) },
    { name: 'a picked CV PDF', before: async () => pick('CV PDF to attach', 'output/cv-zq-a-short.pdf') },
    { name: 'a picked cover letter', before: async () => pick('Cover letter text', 'output/cover-zq-a.md') },
    { name: 'None picked for the CV PDF', before: async () => pick('CV PDF to attach', '') },
    {
      name: 'a prefill summary',
      before: async () => {
        await act(async () => button('Zero-token prefill')!.click());
        await until(() => host.querySelector('[aria-label="Prefill summary"]'), 'the prefill summary');
      },
    },
  ];
  for (const c of CASES) {
    it(`When it held ${c.name}, Then the new owner's form shows, prompts and prefills none of the earlier owner's values`, async () => {
      await open();
      await until(() => select('Cover letter text'), 'the documents listing');
      await c.before();
      const since = posts.length;
      await act(async () => reindex!('b'));
      await until(() => select('CV PDF to attach')?.value === 'output/cv-zq-b.pdf' || undefined, "the new owner's suggested CV");
      expect(leaks('b', since)).toEqual([]);
      expect(urlInput()!.value).toBe(postingUrl('b'));
      expect(applyPanel()!.initialPrompt).toContain(postingUrl('b'));

      await act(async () => button('Zero-token prefill')!.click());
      await until(() => host.querySelector('[aria-label="Prefill summary"]'), 'the prefill summary');
      expect(leaks('b', since)).toEqual([]);
    });
  }

  it("When the new owner's documents listing is still loading, Then the earlier owner's listing is not offered for it", async () => {
    await open();
    await until(() => select('CV PDF to attach')?.value === 'output/cv-zq-a.pdf' || undefined, 'the CV PDF select');
    let release!: () => void;
    docsGate = new Promise((r) => (release = r));
    await act(async () => reindex!('b'));
    expect(leaks('b', 0)).toEqual([]);
    expect(button('Zero-token prefill')!.disabled).toBe(true);
    await act(async () => release());
    await until(() => select('CV PDF to attach')?.value === 'output/cv-zq-b.pdf' || undefined, "the new owner's suggested CV");
  });
});

// mulberry32: small, seedable, good enough to pick operations.
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

describe('Seeded operation sequences on a reused row number', () => {
  const SEEDS = 24;
  const STEPS = 12;
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: the page never shows, attaches or sends another application's values`, async () => {
      const rand = prng(seed);
      const log: string[] = [];
      // The application each session was started or forked for, as the page showed it at that moment.
      const startedFor = new Map<string, Owner>();
      let shown: Owner = 'a';
      let since = 0;
      let sid = 0;
      await open();
      await until(() => select('Cover letter text'), 'the documents listing');
      const ops: Record<string, () => Promise<void>> = {
        type: async () => {
          if (urlInput()?.disabled === false) await typeUrl(typedLink(shown, seed));
        },
        pickPdf: async () => {
          if (select('CV PDF to attach')) await pick('CV PDF to attach', rand() < 0.5 ? '' : `output/cv-${OWNERS[shown].tag}-short.pdf`);
        },
        pickCover: async () => {
          if (select('Cover letter text')) await pick('Cover letter text', rand() < 0.5 ? '' : `output/cover-${OWNERS[shown].tag}.md`);
        },
        draft: async () => {
          const b = button('Draft answers');
          if (!b || applyPanel()?.sessionId) return;
          await act(async () => b.click());
          const id = `s-${seed}-${++sid}`;
          startedFor.set(id, shown);
          await act(async () => applyPanel()!.onSessionId!(id));
        },
        envelope: async () => {
          const id = applyPanel()?.sessionId;
          if (!id) return;
          await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
          await act(async () => applyPanel()!.onEnvelope!('answers', answersFor(startedFor.get(id)!), 1));
        },
        fork: async () => {
          if (!applyPanel()?.sessionId) return;
          const id = `s-${seed}-${++sid}`;
          startedFor.set(id, shown);
          await act(async () => applyPanel()!.onSessionId!(id));
        },
        fill: async () => {
          const b = button('Fill real form');
          if (b && !b.disabled) await act(async () => b.click());
        },
        prefill: async () => {
          const b = button('Zero-token prefill');
          if (b && !b.disabled) await act(async () => b.click());
        },
        markApplied: async () => {
          const b = button('Mark applied');
          if (b && !b.disabled) await act(async () => b.click());
        },
        gone: async () => {
          if (applyPanel()?.sessionId) await act(async () => applyPanel()!.onStatus!('gone', null));
        },
        reindex: async () => {
          shown = other(shown);
          since = posts.length;
          await act(async () => reindex!(shown));
        },
        leaveAndReturn: async () => {
          await leave();
          await open();
        },
      };
      const names = Object.keys(ops);
      for (let step = 0; step < STEPS; step++) {
        const name = names[Math.floor(rand() * names.length)]!;
        log.push(name);
        await ops[name]!();
        await act(async () => new Promise((r) => setTimeout(r, 0)));
        const where = `seed ${seed}, steps ${log.join(' > ')}`;
        const attached = applyPanel()?.sessionId ?? null;
        expect(attached === null || startedFor.get(attached) === shown, `${where}: attached ${attached} of ${attached && startedFor.get(attached)} while showing ${shown}`).toBe(true);
        expect(leaks(shown, since), where).toEqual([]);
        for (const p of posts.slice(since).filter((x) => x.url === '/api/actions/tracker.setStatus')) expect(JSON.parse(p.body).params.expectCompany, where).toBe(OWNERS[shown].identity.company);
      }
    });
  }
});

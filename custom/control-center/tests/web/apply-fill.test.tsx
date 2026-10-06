// Apply: the CV PDF and cover letter picked on the page are the ones the session attaches. The apply mode otherwise
// resolves a CV by its own rules, which can differ from the file the page shows as chosen (SW-web-a-14).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { initialPrompt?: string; onEnvelope?: (kind: string, payload: unknown) => void; onSessionId?: (id: string) => void; onStatus?: (s: string) => void };
let panel: PanelProps = {};
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: PanelProps) => {
    panel = props;
    return null;
  },
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async () => undefined,
}));

let host: HTMLElement;
let root: Root;
let turns: Array<{ prompt: string }>;
let turnAnswer: (() => Response) | null;
let releaseTurn: () => void;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  turns = [];
  turnAnswer = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions/engine') return json({ playwrightAvailable: true, modes: ['apply'] });
      if (url === '/api/apply/documents') return json({ pdfs: ['output/cv-acme-v1.pdf', 'output/cv-acme-v2.pdf'], covers: ['output/cover-acme.md'], suggestedPdf: 'output/cv-acme-v1.pdf', suggestedCover: null });
      if (url === '/api/sessions/s1/turns') {
        turns.push(JSON.parse(String(init!.body)));
        if (turnAnswer) return new Promise<Response>((resolve) => (releaseTurn = () => resolve(turnAnswer!())));
        return json({ id: 's1' });
      }
      return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404 });
    }),
  );
  const { ApplyPage } = await import('@web/features/apply/ApplyPage');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ApplyPage))));
  await until(() => host.querySelector('select[aria-label="Cover letter text"]'), 'the document pickers');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function pick(label: string, value: string) {
  const el = host.querySelector<HTMLSelectElement | HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

describe('Apply: the chosen documents reach the session', () => {
  it('the draft prompt and the fill turn name the CV PDF and cover letter picked on the page', async () => {
    await pick('Posting URL', 'https://boards.greenhouse.io/acme/jobs/1');
    await pick('CV PDF to attach', 'output/cv-acme-v2.pdf');
    await pick('Cover letter text', 'output/cover-acme.md');
    expect(panel.initialPrompt).toContain('output/cv-acme-v2.pdf');
    expect(panel.initialPrompt).toContain('output/cover-acme.md');
    await act(async () => {
      panel.onSessionId!('s1');
      panel.onStatus!('done');
      panel.onEnvelope!('answers', { fields: [{ id: 'name', label: 'Name', type: 'text', required: true, value: 'Jane', needsConfirmation: false }] });
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fill real form')!.click());
    await until(() => turns.length > 0, 'the fill turn');
    expect(turns[0]!.prompt).toContain('output/cv-acme-v2.pdf');
    expect(turns[0]!.prompt).toContain('output/cover-acme.md');
    expect(turns[0]!.prompt).not.toContain('output/cv-acme-v1.pdf');
  });

  async function draft() {
    await pick('Posting URL', 'https://boards.greenhouse.io/acme/jobs/1');
    await act(async () => {
      panel.onSessionId!('s1');
      panel.onStatus!('done');
      panel.onEnvelope!('answers', { fields: [{ id: 'name', label: 'Name', type: 'text', required: true, value: 'Jane', needsConfirmation: false }] });
    });
    return () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fill real form')!;
  }

  it('a double click on Fill real form sends one fill turn (SW4-web-a-05)', async () => {
    turnAnswer = () => json({ id: 's1' });
    const fillButton = await draft();
    await act(async () => fillButton().click());
    await act(async () => fillButton().click());
    expect(turns).toHaveLength(1);
    expect(fillButton().disabled).toBe(true);
    await act(async () => releaseTurn());
    await until(() => host.textContent?.includes('Fill turn sent with your edited answers.'), 'the sent note');
  });

  it('a refused fill turn says why, in the server\'s words (SW4-web-a-05)', async () => {
    turnAnswer = () => new Response(JSON.stringify({ error: 'session s1 has a turn running' }), { status: 409, headers: { 'content-type': 'application/json' } });
    const fillButton = await draft();
    await act(async () => fillButton().click());
    await act(async () => releaseTurn());
    await until(() => host.textContent?.includes('Could not send the fill turn'), 'the failure note');
    expect(host.textContent).toContain('Could not send the fill turn: session s1 has a turn running');
    expect(fillButton().disabled).toBe(false);
  });
});


// Apply: a fill turn the server accepted with 202 but failed before spawn (no approved CLI, no token) reports the
// failure instead of saying it was sent (R15-tests-custom-L1-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import { ConfirmProvider } from '@web/components/ConfirmDialog';

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
  // The page remembers its last apply session in this tab; each test starts as a fresh tab.
  sessionStorage.clear();
  turns = [];
  turnAnswer = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions/engine') return json({ playwrightAvailable: true, modes: ['apply'] });
      // /apply with no tracker row: readApplyDocuments suggests nothing (documents.ts).
      if (url === '/api/apply/documents') return json({ pdfs: ['output/cv-acme-v1.pdf', 'output/cv-acme-v2.pdf'], covers: ['output/cover-acme.md'], suggestedPdf: null, suggestedCover: null });
      if (url === '/api/sessions/s1/turns') {
        turns.push(JSON.parse(String(init!.body)));
        if (turnAnswer) return new Promise<Response>((resolve) => (releaseTurn = () => resolve(turnAnswer!())));
        return json({ id: 's1', status: 'running' });
      }
      return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404 });
    }),
  );
  const { ApplyPage } = await import('@web/features/apply/ApplyPage');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(ApplyPage)))));
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

describe('Apply: a fill turn that failed before it ran', () => {
  it('says why it could not be sent, in the server\'s words, and leaves Fill enabled', async () => {
    turnAnswer = () => new Response(JSON.stringify({ id: 's1', status: 'error', error: 'Claude CLI is not approved' }), { status: 202, headers: { 'content-type': 'application/json' } });
    await pick('Posting URL', 'https://boards.greenhouse.io/acme/jobs/1');
    await act(async () => {
      panel.onSessionId!('s1');
      panel.onStatus!('done');
      panel.onEnvelope!('answers', { fields: [{ id: 'name', label: 'Name', type: 'text', required: true, value: 'Jane', needsConfirmation: false }] });
    });
    const fillButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fill real form')!;
    await act(async () => fillButton().click());
    await act(async () => releaseTurn());
    await until(() => host.textContent?.includes('Could not send the fill turn'), 'the failure note');
    expect(host.textContent).toContain('Could not send the fill turn: Claude CLI is not approved');
    expect(host.textContent).not.toContain('Fill turn sent');
    expect(fillButton().disabled).toBe(false);
  });
});

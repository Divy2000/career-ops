import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The advisor session itself is out of scope: the stub hands its envelope callback to the test.
let emitEnvelope: ((kind: string, payload: unknown, turn: number) => void) | null = null;
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: { onEnvelope?: (kind: string, payload: unknown, turn: number) => void }) => {
    emitEnvelope = props.onEnvelope ?? null;
    return null;
  },
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ navigate: async () => undefined }),
  useRouterState: () => '/',
}));

let host: HTMLElement;
let root: Root;

beforeEach(async () => {
  document.body.innerHTML = '';
  emitEnvelope = null;
  const { AskDrawer } = await import('@web/components/AskDrawer');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(AskDrawer, { open: true, onClose: () => undefined })))));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

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

  it('an allowlisted act envelope is offered to run with its label', async () => {
    await act(async () => emitEnvelope!('act', { action: 'navigate', params: { to: '/pipeline' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    expect(item.dataset.proposalState).toBe('pending');
    expect(item.textContent).toContain('Open /pipeline');
    expect([...item.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Run', 'Dismiss']);
  });
});

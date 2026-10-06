// An action the registry marks confirm runs only with the request's explicit confirmation (the server answers 428
// otherwise): the page sends it once the user confirmed the dialog, and never when the user cancels.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import type { ActionMeta } from '@shared/api';
import { ActionButton } from '@web/components/ActionBar';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { useRunAction } from '@web/lib/actions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAILY: ActionMeta = { id: 'daily.runNow', label: 'Run the daily job now', cost: 'tokens', confirm: 'Runs the full daily job. Continue?', resources: [], claude: true, sync: false, params: {} } as unknown as ActionMeta;
const PLAIN: ActionMeta = { ...DAILY, id: 'tracker.verify', label: 'Verify tracker', confirm: null } as unknown as ActionMeta;

let host: HTMLElement;
let root: Root;
let bodies: Array<{ url: string; body: Record<string, unknown> }>;

function Harness({ meta }: { meta: ActionMeta }) {
  const { run } = useRunAction();
  return createElement(ActionButton, { meta, onRun: (p, opts) => void run(meta.id, p, undefined, opts) });
}

async function mount(meta: ActionMeta) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(Harness, { meta })))));
}

const press = async (name: string, within: ParentNode = document.body) => {
  const button = [...within.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(name))!;
  await act(async () => button.click());
};

beforeEach(() => {
  document.body.innerHTML = '';
  bodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ runId: 'r1' }), { status: 202, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('a confirm action from a page button', () => {
  it('sends the confirmation once the user confirms the dialog', async () => {
    await mount(DAILY);
    await press('Run the daily job now', host);
    await press('Run', await until(() => document.querySelector('[role="dialog"]'), 'the confirm dialog'));
    await until(() => bodies.length === 1, 'the action request');
    expect(bodies).toEqual([{ url: '/api/actions/daily.runNow', body: { params: {}, confirmed: true } }]);
  });

  it('sends nothing when the user cancels', async () => {
    await mount(DAILY);
    await press('Run the daily job now', host);
    await press('Cancel', await until(() => document.querySelector('[role="dialog"]'), 'the confirm dialog'));
    await until(() => !document.querySelector('[role="dialog"]'), 'the dialog to close');
    expect(bodies).toEqual([]);
  });

  it('an action with no confirm text carries no confirmation', async () => {
    await mount(PLAIN);
    await press('Verify tracker', host);
    await until(() => bodies.length === 1, 'the action request');
    expect(bodies[0]!.body).toEqual({ params: {} });
  });
});

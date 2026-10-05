// Settings > Health and Portals > Health show what a sync action printed under the action buttons. A later action
// that starts a background run, or fails without output, must not leave the earlier action's output under its own
// message (SW-web-b-05, fixed by R8-06; this pins the two cases the sweep reproduced).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunAction } from '@web/lib/actions';
import { ActionOutput, Message } from '@web/components/ActionBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let runAction: (id: string) => Promise<unknown>;

/** The Health tab's composition: buttons call run, the message and the output sit below them. */
function Health() {
  const { run, message, output } = useRunAction();
  runAction = (id) => run(id, {});
  return createElement('div', null, createElement(Message, { message }), createElement(ActionOutput, { text: output }));
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answers: Record<string, Response> = {};
const output = () => host.querySelector('[aria-label="Action output"]')?.textContent ?? null;

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => answers[url.replace('/api/actions/', '')] ?? json(200, [])));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Health))));
  answers['system.doctor'] = json(200, { result: { ok: true, checks: ['node 22'] } });
  await act(async () => void (await runAction('system.doctor')));
  expect(output()).toContain('node 22');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Health output after a later action', () => {
  it('given Doctor printed its JSON, when Verify tracker and pipeline starts a background run, then the output area clears', async () => {
    answers['tracker.verify'] = json(202, { runId: 'r-9' });
    await act(async () => void (await runAction('tracker.verify')));
    expect(host.textContent).toContain('Started run r-9');
    expect(output()).toBeNull();
  });

  it('given Doctor printed its JSON, when a later action fails with no output, then Doctor\'s JSON is not shown under the failure', async () => {
    answers['portals.validate'] = json(500, { error: 'portals.validate could not start' });
    await act(async () => void (await runAction('portals.validate')));
    expect(host.textContent).toContain('Could not run portals.validate');
    expect(output()).toBeNull();
  });
});

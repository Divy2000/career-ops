// Switching a tab unmounts its editor, and with it the pending edits. With edits pending, the switch asks first:
// Cancel stays on the tab with the edits, Discard switches (SW3-web-b-02).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { UnsavedProvider } from '@web/lib/unsaved';
import { PortalsTab } from '@web/features/settings/PortalsEditor';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const PORTALS = { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'max_posting_age_days: 30\n', etag: 'p1', doc: { max_posting_age_days: 30 }, parseError: null };

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PORTALS), { status: 200, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(UnsavedProvider, null, createElement(PortalsTab))))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** An enabled control: a button that is still waiting on its data does nothing when clicked. */
const named = (selector: string, name: string) => until(() => [...document.querySelectorAll<HTMLButtonElement>(selector)].find((b) => b.textContent?.trim() === name && !b.disabled), `an enabled ${selector} named ${name}`);
const button = (name: string) => named('button', name);
const tab = (name: string) => named('[role="tab"]', name);
const inDialog = (name: string) => named('[role="dialog"] button', name);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const asked = () => until(dialog, 'the discard question');
const selected = (name: string) => until(() => [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some((t) => t.textContent?.trim() === name), `the ${name} tab to be selected`);
const click = (el: HTMLElement) => act(async () => el.click());

describe('switching a Portals view with edits pending', () => {
  it('asks first: Cancel keeps the edits on the Structured view, Discard switches to Raw YAML', async () => {
    await click(await button('Add job_boards'));
    expect(host.textContent).toContain('1 pending change');
    await click(await tab('Raw YAML'));
    expect((await asked()).textContent).toContain('portals.yml');
    await click(await inDialog('Cancel'));
    await until(() => !dialog(), 'the question to close');
    expect((await tab('Structured')).getAttribute('aria-selected')).toBe('true');
    expect(host.textContent).toContain('1 pending change');
    await click(await tab('Raw YAML'));
    await click(await inDialog('Discard changes'));
    await selected('Raw YAML');
  });

  it('switches at once when nothing is pending', async () => {
    await click(await tab('Raw YAML'));
    await selected('Raw YAML');
    expect(dialog()).toBeNull();
  });
});

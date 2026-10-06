// Switching a tab unmounts its editor, and with it the pending edits. With edits pending, the switch asks first:
// Cancel stays on the tab with the edits, Discard switches (SW3-web-b-02).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { UnsavedProvider } from '@web/lib/unsaved';
import { PortalsTab } from '@web/features/settings/PortalsEditor';

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
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name);
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === name)!;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe('switching a Portals view with edits pending', () => {
  it('asks first: Cancel keeps the edits on the Structured view, Discard switches to Raw YAML', async () => {
    await click(button('Add job_boards')!);
    expect(host.textContent).toContain('1 pending change');
    await click(tab('Raw YAML'));
    expect(dialog()?.textContent).toContain('portals.yml');
    await click([...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!);
    expect(tab('Structured').getAttribute('aria-selected')).toBe('true');
    expect(host.textContent).toContain('1 pending change');
    await click(tab('Raw YAML'));
    await click([...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Discard changes')!);
    expect(tab('Raw YAML').getAttribute('aria-selected')).toBe('true');
  });

  it('switches at once when nothing is pending', async () => {
    await click(tab('Raw YAML'));
    expect(dialog()).toBeNull();
    expect(tab('Raw YAML').getAttribute('aria-selected')).toBe('true');
  });
});

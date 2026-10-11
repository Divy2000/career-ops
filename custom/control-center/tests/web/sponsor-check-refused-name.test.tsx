// A sponsorship check for a name with no company-file slug ("Ltd") is refused by the server with 400 before any paid
// turn (R25-FU-03). The launchers show that refusal itself, not a generic failure, and give the button back.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sponsorCheckRefusal } from '@shared/company-slug';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

let host: HTMLElement;
let root: Root;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const starts: unknown[] = [];

beforeEach(() => {
  starts.length = 0;
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { target: { value: string } };
        starts.push(body);
        return json({ error: sponsorCheckRefusal(body.target.value) }, 400);
      }
      return json({ error: 'not stubbed' }, 404);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Sponsorship > Lookup > Run sponsorship check for "Ltd"', () => {
  it('shows the server refusal saying why and how to fix the name, and gives the button back', async () => {
    const { SponsorCheckLauncher } = await import('@web/features/sponsorship/LookupTab');
    root = createRoot(host);
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(SponsorCheckLauncher, { company: 'Ltd' }))));
    const button = () => [...host.querySelectorAll('button')].find((b) => /^(Run sponsorship check|Sponsorship check running)/.test(b.textContent ?? ''));
    await until(() => button(), 'the check button');
    await act(async () => button()!.click());
    const alert = await until(() => [...host.querySelectorAll('[role="alert"]')].find((a) => a.textContent?.includes('company file')), 'the refusal');
    expect(starts).toHaveLength(1);
    expect(alert.textContent).toBe(sponsorCheckRefusal('Ltd'));
    expect(alert.textContent).toContain('"Ltd" has no Latin letters or digits');
    await until(() => button()?.textContent?.startsWith('Run sponsorship check') && !button()!.disabled, 'the button back');
  });
});

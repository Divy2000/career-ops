// Profile > Projects links a project's title only when its URL is http(s) (R35-web1-FC-03). article-digest.md is
// hand-edited and filled by imports, so a javascript: or data: URL there renders as text instead of a link that would
// run in the Control Center's origin when clicked. Any http(s) URL is a valid project link, not just a posting.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectsRead } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const entry = (id: string, title: string, url: string | null, line: number): ProjectsRead['entries'][number] =>
  ({ id, title, url, tagline: null, tags: [], kind: 'project', dates: null, source: null, bullets: ['One.'], line, editProblem: null, inCv: false }) as ProjectsRead['entries'][number];
const READ: ProjectsRead = {
  path: 'article-digest.md', kind: 'ok', etag: 'e1', validation: { ok: true, errors: [], warnings: [] },
  entries: [entry('good', 'Good Project', 'https://github.com/alex-example/good', 5), entry('evil', 'Evil Project', 'javascript:alert(document.domain)', 9), entry('data', 'Data Project', 'data:text/html,<script>alert(1)</script>', 13)],
} as ProjectsRead;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function mount() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input) === '/api/projects' ? json(200, READ) : json(404, { error: 'not stubbed' }))));
  const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(ProjectsLibrary)))));
}
const linkTo = (text: string) => [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === text);

describe('Profile > Projects titles', () => {
  it('given projects with javascript: and data: URLs, then their titles are text while an http(s) project stays a link', async () => {
    await mount();
    await until(() => linkTo('Good Project'), 'the Good Project link');
    expect(linkTo('Good Project')!.getAttribute('href')).toBe('https://github.com/alex-example/good');
    expect(host.textContent).toContain('Evil Project');
    expect(host.textContent).toContain('Data Project');
    expect(linkTo('Evil Project')).toBeUndefined();
    expect(linkTo('Data Project')).toBeUndefined();
  });
});

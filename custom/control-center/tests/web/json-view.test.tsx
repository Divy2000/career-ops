// Insights > Reposts & legitimacy renders detect-reposts.mjs and company-history.mjs through JsonView. Their rows carry
// nested evidence (a cluster's appearances, a company's responsiveness, churn and explanations), which a table must
// still show, not drop because the value is not a plain one (SW-web-b-01).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { JsonView } from '@web/features/insights/ScriptTab';
import { DEFAULT_CODE_ROOT } from '../../server/config';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = async (value: unknown) => act(async () => root.render(createElement(JsonView, { value })));
/** The outermost table's column headers; a nested value's own table sits inside a cell. */
const headers = () => [...(host.querySelector('table')?.querySelectorAll(':scope > thead th') ?? [])].map((th) => th.textContent);

describe('JsonView tables with nested values', () => {
  it('given a reposts cluster with its appearances, when rendered, then the table keeps an appearances column listing each URL and date', async () => {
    // The cluster shape detect-reposts.mjs prints (clusterRows -> { company, role, ..., appearances }).
    await render([
      {
        company: 'Pied Piper',
        role: 'Backend Engineer',
        repostCount: 2,
        firstSeen: '2026-09-01',
        lastSeen: '2026-09-20',
        daysSpan: 19,
        appearances: [
          { url: 'https://jobs.example.com/pp/1', date: '2026-09-01', title: 'Backend Engineer' },
          { url: 'https://jobs.example.com/pp/2', date: '2026-09-20', title: 'Backend Engineer' },
        ],
      },
    ]);
    expect(headers()).toEqual(['company', 'role', 'repostCount', 'firstSeen', 'lastSeen', 'daysSpan', 'appearances']);
    const cell = host.querySelector('table > tbody > tr > td:last-child');
    expect(cell?.textContent).toContain('https://jobs.example.com/pp/1');
    expect(cell?.textContent).toContain('2026-09-20');
  });

  it('given company-history cards, when rendered, then each company shows its responsiveness, posting churn and explanations', async () => {
    // The card shape company-history.mjs builds: real responsiveness labels, and postingChurn from its own
    // computePostingChurn, whose clusters are a list of objects (SW3-tests-12).
    // Run in node: the web project's module graph does not reach the upstream scripts.
    const cluster = { company: 'Hooli', role: 'Backend Engineer', repostCount: 3, daysSpan: 40, lastSeen: '2026-09-20', firstSeen: '2026-08-11', appearances: [] };
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `const { computePostingChurn } = await import(${JSON.stringify(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'company-history.mjs')).href)}); process.stdout.write(JSON.stringify(computePostingChurn([${JSON.stringify(cluster)}], true)));`], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const postingChurn = JSON.parse(run.stdout) as unknown;
    await render({
      companies: [
        {
          company: 'Hooli',
          key: 'hooli',
          responsiveness: { label: 'silent-on-you', facts: [{ num: 7, silentDays: 41 }], medianResponseDays: null },
          postingChurn,
          explanations: ['No reply 28+ days after applying.'],
        },
      ],
    });
    expect(headers()).toEqual(['company', 'key', 'responsiveness', 'postingChurn', 'explanations']);
    const row = host.querySelector('table > tbody > tr');
    expect(row?.textContent).toContain('silent-on-you');
    expect(row?.textContent).toContain('41');
    expect(row?.textContent).toContain('reposts-detected');
    expect(row?.textContent).toContain('Backend Engineer');
    expect(row?.textContent).toContain('No reply 28+ days after applying.');
  });

  it('given rows where only some carry a nested value, when rendered, then the others show n/a in that column', async () => {
    await render([{ company: 'Soylent', tags: ['a', 'b'] }, { company: 'Initech' }]);
    expect(headers()).toEqual(['company', 'tags']);
    const cells = [...host.querySelectorAll('table > tbody > tr:last-child > td')].map((td) => td.textContent);
    expect(cells).toEqual(['Initech', 'n/a']);
  });
});

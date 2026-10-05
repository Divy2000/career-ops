import { test, expect, type Page, type Route } from '@playwright/test';
import { E2E_TOKEN } from '../../playwright.config.js';

// The viewer is in Los Angeles at 19:00 on 2026-10-05, when UTC is already 02:00 on 2026-10-06.
test.use({ timezoneId: 'America/Los_Angeles' });
const EVENING = new Date('2026-10-06T02:00:00.000Z');
const STAMP = '2026-10-06T02:07:09.000Z';
const STAMP_LOCAL_MINUTE = '2026-10-05 19:07';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

/** Answers a GET with the server's own JSON, changed by `edit`. */
const rewrite = (edit: (body: unknown) => unknown) => async (route: Route) => {
  const res = await route.fetch();
  await route.fulfill({ response: res, json: edit(await res.json()) });
};

test.describe('dates are the viewer\'s local day', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(EVENING);
    await login(page);
  });

  test('Today shows the local date', async ({ page }) => {
    await expect(page.locator('.page-header .mono').first()).toHaveText('2026-10-05');
  });

  test('Follow-ups: a logged follow-up defaults to the local day and +7d pins seven local days out', async ({ page }) => {
    const pins: unknown[] = [];
    await page.route('**/api/followups/override', async (route) => {
      pins.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto('/followups');
    await page.getByRole('button', { name: 'Log follow-up for Acme Robotics' }).click();
    await expect(page.getByLabel('Follow-up date')).toHaveValue('2026-10-05');
    await page.getByRole('button', { name: 'Pin next follow-up for Acme Robotics in 7 days' }).click();
    await expect.poll(() => pins).toEqual([{ appNum: 1, date: '2026-10-12' }]);
  });

  test('a new blacklist row is dated the local day', async ({ page }) => {
    await page.goto('/settings?tab=blacklist');
    await expect(page.getByLabel('Blacklist since')).toHaveValue('2026-10-05');
  });

  test('two digest sections with the same date (a manual pass and the daily run) both render, without a duplicate React key', async ({ page }) => {
    const keyErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /same key/i.test(m.text())) keyErrors.push(m.text());
    });
    await page.route('**/api/immigration/overview', rewrite((body) => {
      const b = body as { digest: { kind: string; sections?: Array<{ date: string; body: string }> } };
      b.digest = { ...b.digest, kind: 'ok', sections: [{ date: '2026-10-06', body: 'Morning run notes.' }, { date: '2026-10-06', body: 'Evening pass notes.' }] };
      return b;
    }));
    await page.goto('/sponsorship');
    await expect(page.getByText('Morning run notes.')).toBeAttached();
    await expect(page.getByText('Evening pass notes.')).toBeAttached();
    await expect(page.getByRole('heading', { level: 2, name: '2026-10-06' })).toHaveCount(2);
    expect(keyErrors).toEqual([]);
  });

  test('an interview prep document is dated by the local day it changed', async ({ page }) => {
    await page.route('**/api/interviews', rewrite((body) => {
      const b = body as { prepDocs: Array<{ path: string; mtimeMs: number }>; sessions: unknown[] };
      b.prepDocs = [{ path: 'interview-prep/e2e-local.md', mtimeMs: Date.parse(STAMP) }];
      return b;
    }));
    await page.goto('/interviews');
    await expect(page.getByRole('listitem').filter({ hasText: 'interview-prep/e2e-local.md' })).toContainText('2026-10-05');
  });
});

test.describe('times are the viewer\'s local wall clock', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('Sessions list and an application\'s sessions show when each session was updated in local time', async ({ page }) => {
    const session = { id: 'e2e-local-time', claudeSessionId: '33333333-3333-4333-8333-333333333333', mode: 'deep', policyClass: 'research', target: { type: 'app', value: '1' }, model: null, status: 'done', createdAt: STAMP, updatedAt: STAMP, turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], reportNum: null, policyVersion: 2 };
    await page.route('**/api/sessions', rewrite((body) => [session, ...(body as Array<Record<string, unknown>>).map((s) => ({ ...s, updatedAt: STAMP }))]));
    await page.goto('/sessions');
    await expect(page.getByRole('row').filter({ hasText: 'deep' }).getByRole('cell', { name: STAMP_LOCAL_MINUTE }).first()).toBeVisible();
    await expect(page.getByText('2026-10-06 02:07')).toHaveCount(0);
    await page.goto('/tracker/1');
    await page.getByRole('tab', { name: 'Sessions' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: STAMP_LOCAL_MINUTE })).toHaveCount(1);
  });

  test('Runs shows a run\'s start and its log lines in local time', async ({ page }) => {
    const run = { id: 'e2e-local-run', actionId: 'pipeline.prioritize', label: 'Prioritize pipeline', status: 'done', createdAt: STAMP, startedAt: STAMP, endedAt: STAMP, exitCode: 0, cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: 'node', args: [], cwd: '/' } };
    await page.route('**/api/runs', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([run]) }));
    const line = { seq: 1, ts: STAMP, stream: 'stdout', line: 'prioritized 2 pending rows' };
    await page.route('**/api/runs/e2e-local-run/events', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: line\ndata: ${JSON.stringify(line)}\n\nevent: run.done\ndata: {"status":"done"}\n\n` }));
    await page.goto('/runs');
    const row = page.getByRole('row').filter({ hasText: 'pipeline.prioritize' });
    await expect(row.getByRole('cell', { name: STAMP_LOCAL_MINUTE })).toBeVisible();
    await row.click();
    await expect(page.getByLabel('Run log')).toContainText('19:07:09 prioritized 2 pending rows');
  });

  test('an insights script says when it was computed in local time', async ({ page }) => {
    await page.route('**/api/insights/funnelVelocity', rewrite((body) => ({ ...(body as object), computedAt: STAMP })));
    await page.goto('/insights?tab=velocity');
    await expect(page.getByText(`computed ${STAMP_LOCAL_MINUTE}`)).toBeVisible();
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_PORT, E2E_TOKEN } from '../../playwright.config.js';
import { localDate } from '../../shared/local-date.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function axeClean(page: Page) {
  const axe = await (await axeBuilder(page)).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.describe('read-only pages render fixture data', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('Today shows the shortlist, the failed daily job, policy bullets, an evaluated row under Decisions and a fresh match', async ({ page }) => {
    // Each feature is checked inside its own card, on data this test sets up and restores (SW2-tests-08): #2 waiting for a
    // decision (an earlier spec may have decided it), and a posting first seen today (the fixture's dated rows age out).
    const setStatus = (row: number, state: string) => page.request.post('/api/actions/tracker.setStatus', { data: { params: { row, state } }, headers: { 'x-cc': '1', origin: `http://127.0.0.1:${E2E_PORT}` } });
    const before = ((await (await page.request.get('/api/tracker')).json()) as { rows: Array<{ num: number; status: string }> }).rows.find((r) => r.num === 2)!.status;
    const history = path.join(process.env.CC_E2E_TMP!, 'root', 'data', 'scan-history.tsv');
    const original = fs.readFileSync(history, 'utf8');
    fs.appendFileSync(history, `https://careers.example.com/today-e2e/1\t${localDate()}\tgreenhouse\tSite Reliability Lead\tToday E2E Co\tadded\tRemote\tf-today\t\t0.7\t\ttoday e2e co\n`);
    try {
      if (before !== 'Evaluated') expect((await setStatus(2, 'Evaluated')).status()).toBe(200);
      await page.reload();
      await expect(page.getByText('Daily job 2026-10-03: failed')).toBeVisible();
      await expect(page.getByRole('cell', { name: 'Globex Payments' })).toBeVisible();
      await expect(page.getByText('Proposed rule on a new petition fee')).toBeVisible();
      await expect(page.getByRole('list', { name: 'Decisions' }).getByRole('link', { name: 'Northwind Analytics' })).toBeVisible();
      const fresh = page.locator('.card', { has: page.getByRole('heading', { name: 'Fresh matches this week' }) });
      await expect(fresh.getByRole('listitem').filter({ hasText: 'Today E2E Co' })).toContainText(`Site Reliability Lead Today E2E Co ${localDate()}`);
      await axeClean(page);
    } finally {
      fs.writeFileSync(history, original);
      if (before !== 'Evaluated') expect((await setStatus(2, before)).status()).toBe(200);
    }
  });

  test('Tracker lists rows, filters by tab and search, previews and opens an application', async ({ page }) => {
    await page.getByRole('link', { name: 'Tracker' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tracker' })).toBeVisible();
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(6);
    await page.getByRole('tab', { name: /^Interview/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(page).toHaveURL(/tab=interview/);
    await page.getByRole('tab', { name: /^All/ }).click();
    await page.getByLabel('Search tracker').fill('vandelay');
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Search tracker').fill('');
    await page.getByRole('button', { name: /^Score/ }).click();
    await expect(page.locator('th[aria-sort="ascending"]')).toHaveCount(1);
    await rows.first().click();
    await expect(page.getByRole('complementary', { name: 'Preview' }).getByText('TL;DR')).toBeVisible();
    await page.getByRole('button', { name: 'Flat list' }).click();
    await expect(page.locator('.group-row')).not.toHaveCount(0);
    await axeClean(page);
    await page.getByRole('link', { name: 'Open Acme Robotics' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Acme Robotics' })).toBeVisible();
  });

  test('Enter on a focused link or sort button in the tracker table does what that control does, not what the selected row does (SW-web-a-01)', async ({ page }) => {
    await page.goto('/tracker');
    await expect(page.locator('tbody tr')).not.toHaveCount(0);
    await page.getByRole('link', { name: 'Open Acme Robotics' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Acme Robotics' })).toBeVisible();

    await page.goto('/tracker');
    await page.getByRole('row', { name: /Globex Payments/ }).getByRole('cell', { name: 'Globex Payments', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Preview' }).getByRole('heading', { name: 'Globex Payments' })).toBeVisible();
    await page.getByRole('button', { name: /^Company/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('th[aria-sort="ascending"]')).toHaveText(/Company/);
    await expect(page).toHaveURL(/\/tracker\?/);
    await page.getByRole('link', { name: 'Open Northwind Analytics' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Northwind Analytics' })).toBeVisible();

    // The table itself still takes the shortcuts: j selects the first row and Enter opens it.
    await page.goto('/tracker');
    const first = (await page.locator('tbody tr').first().getByRole('cell').nth(2).textContent())!;
    await page.getByLabel('Tracker rows, use j and k to move, x to select').focus();
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: first })).toBeVisible();
  });

  test('typing a tracker search adds no history entries: Back leaves the search at once (SW3-web-a-06)', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Tracker' }).click();
    await page.getByLabel('Search tracker').pressSequentially('vandelay');
    await expect(page).toHaveURL(/q=vandelay/);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  });

  test('Application shows the verdict, report sections, timeline and sponsorship', async ({ page }) => {
    await page.goto('/tracker/1');
    await expect(page.getByRole('heading', { level: 1, name: 'Acme Robotics' })).toBeVisible();
    await expect(page.getByText('At or above the 4.0 apply line')).toBeVisible();
    await expect(page.getByText('Recommendation: Apply')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A) Role Summary' })).toBeVisible();
    await expect(page.getByText('sponsor: sponsoring')).toBeVisible();
    await axeClean(page);
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await expect(page.getByRole('heading', { name: 'Status log' })).toBeVisible();
    await expect(page.getByText('asked about timeline')).toBeVisible();
    await expect(page.getByText('Next pinned to')).toBeVisible();
    await page.goto('/tracker/4');
    // The report holds codes (salary_too_low), shown as words (SW4-tests-16).
    await expect(page.getByText('Discard reasons: salary too low, staffing agency')).toBeVisible();
    await page.goto('/tracker/5');
    await expect(page.getByText('This row has no report linked.')).toBeVisible();
  });

  test('Pipeline opened with a query (the advisor\'s "Filter the pipeline") shows the Inbox filtered by it (SW-web-a-07)', async ({ page }) => {
    await page.goto('/pipeline?q=soylent');
    await expect(page.getByLabel('Filter inbox')).toHaveValue('soylent');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('row', { name: /Soylent Foods/ })).toBeVisible();
    await page.getByLabel('Filter inbox').fill('');
    await expect(page.locator('tbody tr')).toHaveCount(4);
    await expect(page).not.toHaveURL(/q=soylent/);
  });

  test('Pipeline inbox and shortlist tabs', async ({ page }) => {
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
    await expect(page.getByText('Soylent Foods')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(4);
    await page.getByLabel('Show done').check();
    await expect(page.locator('tbody tr')).toHaveCount(6);
    await axeClean(page);
    await page.getByRole('tab', { name: 'Shortlist' }).click();
    await expect(page).toHaveURL(/tab=shortlist/);
    await expect(page.getByText('Initech pauses visa sponsorship for new hires')).toBeVisible();
    // shortlist.mjs writes a non-blocking alert after the tier ("strong; resumed 2026-09-25"): the pill keeps the tier's
    // color and the note sits beside it (SW2-tests-09).
    const globex = page.getByRole('row', { name: /Globex Payments/ });
    await expect(globex.getByText('sponsor: strong', { exact: true })).toHaveClass(/chip--ok/);
    await expect(globex).toContainText('resumed 2026-09-25');
    // The shortlist score is rank plus the sponsorship adjustment, so 5.3 is a plain number, not "5.3/5" (SW3-libs-02).
    await expect(globex.getByText('5.3', { exact: true })).toBeVisible();
    await expect(globex).not.toContainText('/5');
  });

  test('Today: a shortlist row with a non-blocking sponsorship alert keeps its tier color (SW2-tests-09)', async ({ page }) => {
    const shortlist = page.locator('.card', { has: page.getByRole('heading', { name: /^Shortlist/ }) });
    const globex = shortlist.getByRole('row', { name: /Globex Payments/ });
    await expect(globex.getByText('sponsor: strong', { exact: true })).toHaveClass(/chip--ok/);
    await expect(globex).toContainText('resumed 2026-09-25');
    await expect(globex.getByText('5.3', { exact: true })).toBeVisible();
    await expect(globex).not.toContainText('5.3/5');
  });

  test('Sponsorship tabs', async ({ page }) => {
    await page.goto('/sponsorship');
    await expect(page.getByRole('heading', { level: 1, name: 'Sponsorship' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '2026-10-02' })).toBeVisible();
    const watcher = page.getByRole('heading', { name: 'Watcher state' }).locator('..');
    await expect(watcher.getByText('Last run')).toBeVisible();
    await expect(watcher.getByText('Items seen')).toBeVisible();
    // seen.json in the shape watch.mjs writes: a last success per source (SW2-tests-30).
    await expect(watcher.getByText('Last success: federal-register').locator('..')).toContainText('2026-10-02');
    await expect(watcher.getByText('Last success: uscis').locator('..')).toContainText('2026-10-01');
    await expect(watcher.getByText('"ids"')).toBeHidden();
    await watcher.getByText('Raw seen.json').click();
    await expect(watcher.getByText('"ids"')).toBeVisible();
    await page.getByRole('tab', { name: /Company alerts/ }).click();
    await expect(page.getByRole('link', { name: 'Initech pauses visa sponsorship for new hires' })).toBeVisible();
    await page.getByRole('tab', { name: /Company checks/ }).click();
    await expect(page.getByRole('cell', { name: 'Acme Robotics', exact: true })).toBeVisible();
    // A paused sponsor is a hard blocker (SW-tests-01): its verdict pill is the danger tone, not the grey of an unknown value.
    const initech = page.getByRole('row', { name: /Initech Cloud/ });
    await expect(initech.getByText('sponsor: paused')).toHaveClass(/chip--danger/);
    await expect(page.getByRole('row', { name: /Acme Robotics/ }).getByText('sponsor: sponsoring')).toHaveClass(/chip--ok/);
    await axeClean(page);
  });

  test('Insights overview, progress and breakdown', async ({ page }) => {
    await page.goto('/insights');
    await expect(page.getByRole('heading', { level: 1, name: 'Insights' })).toBeVisible();
    await expect(page.getByText('Average score').locator('..').getByText('3.9')).toBeVisible();
    // The figures the page shows are the dashboard's, not just its labels (SW4-tests-17): a page stuck at 0 or n/a fails.
    const { dashboard } = (await (await page.request.get('/api/insights/dashboard')).json()) as {
      dashboard: { funnel: Array<{ stage: string; count: number }>; rates: { appliedToInterview: number | null }; archetypes: Array<{ archetype: string; count: number; averageScore: number | null }> };
    };
    const interview = dashboard.funnel.find((f) => f.stage === 'Interview')!;
    expect(interview.count).toBeGreaterThan(0);
    expect(dashboard.rates.appliedToInterview).not.toBeNull();
    expect(dashboard.archetypes.length).toBeGreaterThan(0);
    await page.getByRole('tab', { name: 'Progress' }).click();
    await expect(page.getByRole('heading', { name: 'Funnel' })).toBeVisible();
    await expect(page.getByRole('img', { name: `Interview: ${interview.count}`, exact: true })).toBeVisible();
    await expect(page.locator('dt', { hasText: 'Applied to interview' }).locator('xpath=following-sibling::dd[1]')).toHaveText(`${dashboard.rates.appliedToInterview}%`);
    await page.getByRole('tab', { name: 'Breakdown' }).click();
    await expect(page.getByRole('heading', { name: 'Archetypes' })).toBeVisible();
    const top = dashboard.archetypes[0]!;
    await expect(page.getByRole('img', { name: `${top.archetype} (avg ${top.averageScore ?? 'n/a'}): ${top.count}`, exact: true })).toBeVisible();
    await axeClean(page);
  });

  test('Follow-ups cadence table', async ({ page }) => {
    await page.goto('/followups');
    await expect(page.getByRole('heading', { level: 1, name: 'Follow-ups' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'overdue' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Globex Payments' })).toBeVisible();
    await axeClean(page);
  });

  test('Follow-ups > Contacts: Export vCard downloads the cards, named for caller id when that box is ticked (R8-03)', async ({ page }) => {
    await page.goto('/followups?tab=contacts');
    await expect(page.getByRole('cell', { name: 'Pat Example' })).toBeVisible();
    const save = async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export vCard/ }).click()]);
      expect(download.suggestedFilename()).toBe('career-ops-contacts.vcf');
      return fs.readFileSync((await download.path())!, 'utf8');
    };
    const plain = await save();
    expect(plain.startsWith('BEGIN:VCARD\r\n')).toBe(true);
    expect(plain.match(/BEGIN:VCARD/g)).toHaveLength(2);
    expect(plain).toContain('FN:Pat Example\r\n');
    await page.getByRole('checkbox', { name: /caller ID/i }).check();
    expect(await save()).toContain('FN:Pat Example (Acme Robotics recruiter)\r\n');
    await axeClean(page);
  });

  test('a malformed company-alerts.tsv or policy-changes.tsv line is reported where its data would show, and the pages still load (SW2-server-01)', async ({ page }) => {
    const imm = `${process.env.CC_E2E_TMP!}/root/data/immigration`;
    const files = ['company-alerts.tsv', 'policy-changes.tsv'].map((f) => `${imm}/${f}`);
    const originals = files.map((f) => fs.readFileSync(f, 'utf8'));
    fs.appendFileSync(files[0]!, '2026-10-05\tAcme Robotics\tacme-robotics\tpause\tAcme pauses H-1B\thttps://news.example/acme\n');
    fs.appendFileSync(files[1]!, 'Oct 5\t\tagency\tA title\thttps://agency.example/x\tnone\n');
    try {
      await page.goto('/tracker/1');
      await expect(page.getByRole('heading', { level: 1, name: 'Acme Robotics' })).toBeVisible();
      await page.getByRole('tab', { name: 'Sponsorship' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'company-alerts.tsv line 4: status must be one of' })).toBeVisible();
      await page.goto('/sponsorship?tab=alerts');
      await expect(page.getByRole('alert').filter({ hasText: 'company-alerts.tsv line 4' })).toBeVisible();
      await page.goto('/sponsorship?tab=changes');
      await expect(page.getByRole('alert').filter({ hasText: 'policy-changes.tsv line 4' })).toBeVisible();
      await axeClean(page);
    } finally {
      files.forEach((f, k) => fs.writeFileSync(f, originals[k]!));
    }
  });
});

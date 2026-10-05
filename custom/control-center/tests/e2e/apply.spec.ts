import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_TOKEN } from '../../playwright.config.js';

// Synthetic Greenhouse link: prepare-application.mjs only parses it and prints the prefill, it never fetches it.
const GREENHOUSE = 'https://boards.greenhouse.io/acmerobotics/jobs/12345';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function axeClean(page: Page) {
  const axe = await (await axeBuilder(page)).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.describe('Apply: zero-token prefill', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('with the tailored CV on disk, prefill sends the link and that PDF and shows the summary', async ({ page }) => {
    await page.goto('/apply/1');
    await expect(page.getByLabel('CV PDF to attach')).toHaveValue('output/acme-robotics-cv.pdf');
    await page.getByLabel('Posting URL').fill(GREENHOUSE);
    const button = page.getByRole('button', { name: /Zero-token prefill/ });
    await expect(button).toBeEnabled();
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/actions/docs.prepareApplication'));
    await button.click();
    expect((await sent).postDataJSON()).toEqual({ params: { url: GREENHOUSE, pdf: 'output/acme-robotics-cv.pdf' } });
    const summary = page.getByLabel('Prefill summary');
    await expect(summary).toContainText('Greenhouse · acmerobotics · job 12345');
    await expect(summary).toContainText(/resume\s+acme-robotics-cv\.pdf/);
    await expect(page.getByRole('status').filter({ hasText: 'Prefill summary ready' })).toBeVisible();
    await axeClean(page);
  });

  test('without a tailored CV, prefill is disabled with the reason and Generate starts the pdf session', async ({ page }) => {
    await page.goto('/apply/2');
    await page.getByLabel('Posting URL').fill(GREENHOUSE);
    await expect(page.getByRole('button', { name: /Zero-token prefill/ })).toBeDisabled();
    await expect(page.getByText('No tailored CV PDF for Northwind Analytics yet. Generate it first, or choose another PDF to attach.')).toBeVisible();
    await axeClean(page);
    await page.getByRole('button', { name: /Generate CV PDF/ }).click();
    await expect(page).toHaveURL(/\/sessions\/s/);
    const id = page.url().split('/sessions/')[1]!;
    const session = await (await page.request.get(`/api/sessions/${id}`)).json();
    expect(session.meta).toMatchObject({ mode: 'pdf', target: { type: 'app', value: '2' } });
  });

  test('a job-board listing link is explained instead of failing in the script', async ({ page }) => {
    await page.goto('/apply');
    await page.getByLabel('Posting URL').fill('https://www.builtinaustin.com/job/associate-software-engineer-python-ai/10931484');
    await expect(page.getByText('Choose the CV PDF to attach.')).toBeVisible();
    await page.getByLabel('CV PDF to attach').selectOption('output/acme-robotics-cv.pdf');
    await expect(page.getByRole('button', { name: /Zero-token prefill/ })).toBeDisabled();
    await expect(page.getByText(/Greenhouse, Ashby and Lever apply links only, and www\.builtinaustin\.com is not one/)).toBeVisible();
  });
});

test.describe('Apply: draft session prompt', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('a URL typed into Posting URL fills the draft prompt and enables Draft answers', async ({ page }) => {
    await page.goto('/apply');
    const prompt = page.getByLabel('Prompt for apply');
    await expect(prompt).toHaveValue('');
    await page.getByLabel('Posting URL').fill(GREENHOUSE);
    await expect(prompt).toHaveValue(`Read the application form at ${GREENHOUSE}, draft every answer from my CV and profile, and emit the answers envelope. Do not fill anything yet.`);
    await expect(page.getByRole('button', { name: 'Draft answers' })).toBeEnabled();
  });

  test("editing an application's URL moves the prompt to the new URL, until the user edits the prompt", async ({ page }) => {
    await page.goto('/apply/1');
    const prompt = page.getByLabel('Prompt for apply');
    await page.getByLabel('Posting URL').fill(GREENHOUSE);
    await expect(prompt).toHaveValue(new RegExp(`^Read the application form at ${GREENHOUSE.replaceAll('.', '\\.')}, `));
    await prompt.fill('Only read the form, my own words.');
    await page.getByLabel('Posting URL').fill(`${GREENHOUSE}0`);
    await expect(prompt).toHaveValue('Only read the form, my own words.');
  });
});

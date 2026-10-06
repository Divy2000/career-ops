import { test, expect } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import http from 'node:http';
import { E2E_PORT, E2E_TOKEN } from '../../playwright.config.js';

function rawRequest(opts: { path: string; host: string; cookie?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host };
    if (opts.cookie) headers.cookie = opts.cookie;
    const req = http.request({ host: '127.0.0.1', port: E2E_PORT, path: opts.path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('an API call without the cookie is rejected with 401', async () => {
  const r = await rawRequest({ path: '/api/system/status', host: `127.0.0.1:${E2E_PORT}` });
  expect(r.status).toBe(401);
});

test('a request with a foreign Host header is rejected with 403', async () => {
  const r = await rawRequest({ path: '/api/system/status', host: 'attacker.example' });
  expect(r.status).toBe(403);
});

test('the token URL sets the cookie and the shell renders without serious axe violations', async ({ page }) => {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page).toHaveURL(/\/$/);
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'cc_session');
  expect(session).toBeTruthy();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');

  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tracker' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  // The e2e server has the fake approved CLI and a token, so setup is OK; settings.spec covers the attention state.
  await expect(page.getByRole('link', { name: 'Setup OK' })).toBeVisible();
  await expect(page.getByText('Setup needs attention')).toHaveCount(0);

  const axe = await (await axeBuilder(page)).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

test('navigation reaches every sidebar page', async ({ page }) => {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const links = await nav.locator('a.nav-link').evaluateAll((els) => els.map((el) => ({ name: (el.textContent ?? '').trim(), href: el.getAttribute('href')! })));
  expect(links.length).toBeGreaterThan(10);
  for (const { name, href } of links) {
    await nav.getByRole('link', { name, exact: true }).click();
    await expect(page, name).toHaveURL((url) => url.pathname === href);
    await expect(nav.getByRole('link', { name, exact: true }), name).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1 }), name).toBeVisible();
    await expect(page.getByText(/Not Found|Something went wrong/), name).toHaveCount(0);
  }
  await nav.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  // Settings keeps its tab in the URL (URL is the state for tabs), defaulting to Portals.
  await expect(page).toHaveURL(/\/settings\?tab=portals$/);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, TEST_HOST, TEST_TOKEN, type TestApp } from '../helpers/app.js';
import { SESSION_COOKIE, safeEqual } from '../../server/auth/plugin.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('auth and request hardening', () => {
  it('healthz is reachable without a cookie or a matching Host', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'anything:1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('an API request without the cookie gets 401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/system/status', headers: { host: TEST_HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('a foreign Host header gets 403 even with the cookie', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/system/status', headers: { ...t.authed, host: 'evil.example:4317' } });
    expect(res.statusCode).toBe(403);
  });

  it('localhost is an accepted Host alias', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz', headers: { ...t.authed, host: 'localhost:4317' } });
    expect(res.statusCode).toBe(200);
  });

  it('a wrong token on /auth gets 403 and no cookie', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/auth?t=nope', headers: { host: TEST_HOST } });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('the right token sets an HttpOnly SameSite=Strict cookie and redirects to /', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/auth?t=${TEST_TOKEN}`, headers: { host: TEST_HOST } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it('the cookie unlocks the API and responses carry the CSP', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/system/status', headers: t.authed });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.json()).toMatchObject({ node: process.version, roots: { data: t.cfg.dataRoot } });
  });

  it('a mutating request without Origin and X-CC is refused with 403', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/system/status', headers: t.authed, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('a mutating request with a foreign Origin is refused even with X-CC', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/system/status',
      headers: { ...t.authedWrite, origin: 'http://evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('a non-API page without the cookie gets the locked page, not the app', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/tracker', headers: { host: TEST_HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('/auth?t=');
  });
});

describe('safeEqual', () => {
  it('is false for undefined, different lengths and different bytes', () => {
    expect(safeEqual(undefined, 'a')).toBe(false);
    expect(safeEqual('ab', 'abc')).toBe(false);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
  it('is true for equal strings', () => {
    expect(safeEqual('same-token', 'same-token')).toBe(true);
  });
});

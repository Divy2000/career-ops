import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelSession, forkSession, sendTurn, startSession } from '@web/lib/sessions';

function captureFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: 's1' }), { status: 202, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

describe('session client: the blacklist unlock is an explicit, per-request gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends X-CC-Explicit: blacklist only on the requests that unlock the blacklist', async () => {
    const calls = captureFetch();
    await startSession({ mode: 'devchat', prompt: 'Blacklist Initech', blacklistAllowed: true });
    await sendTurn('s1', 'and Globex', true);
    await startSession({ mode: 'devchat', prompt: 'No unlock', blacklistAllowed: false });
    await sendTurn('s1', 'plain turn');
    await forkSession('s1', 'fork with the unlock', true);
    await forkSession('s1', 'plain fork');
    expect(calls.map((c) => [c.headers['X-CC-Explicit'] ?? null, c.body.blacklistAllowed ?? null])).toEqual([
      ['blacklist', true],
      ['blacklist', true],
      [null, null],
      [null, null],
      ['blacklist', true],
      [null, null],
    ]);
  });
});

describe('session client: a request without a payload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cancel sends no body and no JSON content-type, so the server has nothing to reject', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ id: 's1', status: 'cancelled' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await cancelSession('s1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toBeUndefined();
    expect(Object.keys(calls[0]!.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain('content-type');
    expect(calls[0]!.headers).toMatchObject({ 'X-CC': '1' });
  });
});

describe('targetFor (Sessions > New session, command palette)', () => {
  it('reads a row number, a URL or a company, and a projects-ingest source as the documents/ path the route takes', async () => {
    const { targetFor } = await import('@web/features/sessions/SessionsPage');
    expect(targetFor('3')).toEqual({ type: 'app', value: '3' });
    expect(targetFor('https://jobs.example.com/1')).toEqual({ type: 'url', value: 'https://jobs.example.com/1' });
    expect(targetFor('Acme')).toEqual({ type: 'company', value: 'Acme' });
    expect(targetFor(' projects/router.pdf ', 'projects-ingest')).toEqual({ type: 'text', value: 'projects/router.pdf' });
    expect(targetFor('', 'projects-ingest')).toEqual({ type: 'none', value: null });
  });
});

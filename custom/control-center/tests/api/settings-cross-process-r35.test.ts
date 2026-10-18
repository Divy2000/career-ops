import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { holdPeerLock, settlesWithin } from '../helpers/peer-lock.js';
import { SETTINGS_REL } from '../../server/domains/settings.js';
import { BLACKLIST_REL } from '../../server/domains/blacklist.js';

// The settings and blacklist ETag checks ran synchronously with their writes, which made them atomic only inside one
// server process: the other child of a blue/green handover could read the same ETag and write between them, and both
// saves answered 200 with one of them lost (R33 leftover, fixed with R35-srv-core-X-01's lock).
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const send = (url: string, payload: unknown, headers: Record<string, string>) => t.app.inject({ method: 'PUT', url, headers: { ...t.authedWrite, ...headers }, payload: payload as Record<string, unknown> });

describe('settings saves across two server processes', () => {
  it('given another process saving settings.json, when this process saves with the ETag both read, then it waits and answers 409 without overwriting it', async () => {
    const etag = (await t.app.inject({ method: 'GET', url: '/api/settings/app', headers: t.authed })).json().etag as string;
    const file = path.join(t.cfg.dataRoot, SETTINGS_REL);
    const peer = await holdPeerLock(t.cfg.codeRoot, file);
    try {
      const put = send('/api/settings/app', { retention: 700 }, { 'if-match': etag });
      expect(await settlesWithin(put, 500)).toBe(false);
      const peerRaw = `${JSON.stringify({ retention: 900 }, null, 2)}\n`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await peer.release(peerRaw);
      const res = await put;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('settings-changed');
      expect(fs.readFileSync(file, 'utf8')).toBe(peerRaw);
    } finally {
      peer.stop();
    }
  });

  it('given another process saving data/blacklist.md, when this process saves with the ETag both read, then it waits and answers 409 without overwriting it', async () => {
    const current = (await t.app.inject({ method: 'GET', url: '/api/blacklist', headers: t.authed })).json();
    const file = path.join(t.cfg.dataRoot, BLACKLIST_REL);
    const peer = await holdPeerLock(t.cfg.codeRoot, file);
    try {
      const rows = [...current.rows, { company: 'Evil Corp', since: '2026-10-03', scope: 'company', reason: 'test' }];
      const put = send('/api/blacklist', { confirm: true, rows }, { 'if-match': current.etag, 'x-cc-explicit': 'blacklist' });
      expect(await settlesWithin(put, 500)).toBe(false);
      const peerRaw = `${fs.readFileSync(file, 'utf8')}\n<!-- saved by the other process -->\n`;
      await peer.release(peerRaw);
      const res = await put;
      expect(res.statusCode, res.body).toBe(409);
      expect(fs.readFileSync(file, 'utf8')).toBe(peerRaw);
    } finally {
      peer.stop();
    }
  });
});

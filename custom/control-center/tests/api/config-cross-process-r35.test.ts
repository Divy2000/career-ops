import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, testConfig } from '../helpers/app.js';
import { holdPeerLock, settlesWithin } from '../helpers/peer-lock.js';
import { readConfigFile, saveConfigFile } from '../../server/routes/config.js';
import { readPluginsConfig, PLUGINS_CONFIG_REL } from '../../server/domains/plugins.js';
import type { Exec } from '../../server/routes/system.js';
import type { EventBus } from '../../server/watch/bus.js';

// R35-srv-core-X-01: during a blue/green handover two server children are alive, and each one's save lock was a
// process-local map. Both read the same ETag, both passed If-Match and both wrote, so one edit was lost and both
// answered 200. The peer here is a second process holding the same cross-process lock the other child takes.
const bus = { publish: () => undefined } as unknown as EventBus;
const validatorOk: Exec = async () => ({ code: 0, stdout: '', stderr: '' });

describe('config saves across two server processes (R35-srv-core-X-01)', () => {
  it('given another process saving portals.yml, when this process saves with the ETag both read, then it waits, sees the other save and answers 409 without overwriting it', async () => {
    const cfg = testConfig();
    const file = path.join(cfg.dataRoot, 'portals.yml');
    const before = readConfigFile(cfg.dataRoot, 'portals');
    const peer = await holdPeerLock(cfg.codeRoot, file);
    try {
      const save = saveConfigFile(cfg, validatorOk, bus, 'portals', { raw: `# this process\n${before.raw}` }, before.etag);
      expect(await settlesWithin(save, 500)).toBe(false);
      const peerRaw = `# the other process\n${before.raw}`;
      await peer.release(peerRaw);
      const r = await save;
      expect(r.status).toBe(409);
      expect(fs.readFileSync(file, 'utf8')).toBe(peerRaw);
    } finally {
      peer.stop();
    }
  });

  it('given another process saving config/plugins.yml, when this process toggles a plugin with the ETag both read, then it waits and answers 409 without overwriting it', async () => {
    const t = await makeTestApp();
    try {
      const plugins = (await t.app.inject({ method: 'GET', url: '/api/plugins', headers: t.authed })).json() as { plugins: Array<{ id: string }> };
      const id = plugins.plugins[0]!.id;
      const file = path.join(t.cfg.dataRoot, PLUGINS_CONFIG_REL);
      const before = readPluginsConfig(t.cfg.dataRoot);
      const peer = await holdPeerLock(t.cfg.codeRoot, file);
      try {
        const put = t.app.inject({ method: 'PUT', url: `/api/config/plugins/${id}`, headers: { ...t.authedWrite, ...(before.etag ? { 'if-match': before.etag } : {}) }, payload: { enabled: true } });
        expect(await settlesWithin(put, 500)).toBe(false);
        const peerRaw = `# the other process\n${before.raw}plugins: {}\n`;
        await peer.release(peerRaw);
        const res = await put;
        expect(res.statusCode).toBe(409);
        expect(fs.readFileSync(file, 'utf8')).toBe(peerRaw);
      } finally {
        peer.stop();
      }
    } finally {
      await t.close();
    }
  });
});

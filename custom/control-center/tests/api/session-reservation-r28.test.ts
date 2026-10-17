import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';

type App = Awaited<ReturnType<typeof makeTestApp>>;
const reportPath = (app: App, file: string) => path.join(app.cfg.dataRoot, 'reports', file);

describe('a credited report that holds its number (R27-mgr-rev-01)', () => {
  it('given a waiting session credited a report that was renamed since and whose sentinel is gone, when the user deletes it, then nothing claims the number was lost', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 74);
      app.sessions.store.setCreditedReport(meta.id, { num: 74, file: '074-acme-2026-10-11.md' });
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });
      fs.writeFileSync(reportPath(app, '074-acme-corp-2026-10-11.md'), '# Acme Corp\n');

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/already lost/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('given a waiting session whose credited report was deleted and whose sentinel is gone, when the user deletes it, then the number reads as lost', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 75);
      app.sessions.store.setCreditedReport(meta.id, { num: 75, file: '075-acme-2026-10-11.md' });
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(warn.mock.calls.flat().join('\n')).toMatch(/report number 75 was already lost/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
});


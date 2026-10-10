// The tr, zh and zh-TW evaluation modes write the report's PDF header as a bare mark, `**PDF:** ✅` or `**PDF:** ❌`,
// with no path (modes/tr/is-ilani.md, modes/zh/oferta.md). Upstream reconcile-pipeline.mjs reads anything that is not
// "not generated" as generated, so a bare ✅ is a generated PDF (R15-tests-custom-L1-02).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { markPipelineEvaluated, pdfGenerated } from '../../server/domains/pipelineProcessed.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { tempDir } from '../helpers/tmp.js';

const URL = 'https://boards.greenhouse.io/acme/jobs/1';

describe('a report PDF header written as a bare mark', () => {
  it('a bare ✅ is a generated PDF', () => {
    const dir = tempDir('cc-pdf-mark-');
    for (const header of ['✅', ' ✅ ']) expect(pdfGenerated(header, dir), header).toBe(true);
  });

  it('a bare ❌, or the template left unfilled as ✅/❌, is not a generated PDF', () => {
    const dir = tempDir('cc-pdf-mark-');
    for (const header of ['❌', '✅/❌', '❌ ✅']) expect(pdfGenerated(header, dir), header).toBe(false);
  });

  it('a ✅ next to a PDF path that does not exist is still not a generated PDF', () => {
    const dir = tempDir('cc-pdf-mark-');
    expect(pdfGenerated('✅ output/cv-missing.pdf', dir)).toBe(false);
  });

  it('moves a tr-style report row to Processed as PDF ✅', async () => {
    const root = tempDir('cc-pdf-mark-root-');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `## Pending\n\n- [ ] ${URL} | Acme | Eng\n`);
    fs.writeFileSync(path.join(root, 'reports', '042-acme.md'), `# Değerlendirme: Acme - Eng\n\n**Score:** 4.2/5\n**PDF:** ✅\n`);
    expect(await markPipelineEvaluated(DEFAULT_CODE_ROOT, root, URL, '042-acme.md')).toBe(true);
    expect(fs.readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8')).toContain(`- [x] #042 | ${URL} | Acme | Eng | 4.2/5 | PDF ✅`);
  });
});

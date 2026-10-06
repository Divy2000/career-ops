// A completed evaluation moves its pipeline row from Pending to Processed in the form pipeline mode writes
// (modes/pipeline.md, Workflow 2f), with reconcile-pipeline.mjs's section handling (SW-web-a-09).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { markPipelineEvaluated, moveToProcessed, pdfGenerated, type EvaluatedPosting } from '../../server/domains/pipelineProcessed.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { tempDir } from '../helpers/tmp.js';

const URL = 'https://boards.greenhouse.io/acme/jobs/1';
const POSTING: EvaluatedPosting = { report: '042', company: 'Acme (report)', role: 'Engineer (report)', score: 4.2, pdf: false };

describe('moving an evaluated posting to Processed', () => {
  it('moves the Pending row to the top of Processed as #NNN | URL | Company | Role | Score/5 | PDF', () => {
    const md = [
      '## Pending',
      '',
      `- [ ] ${URL} | Acme | Backend Engineer | Remote | rank: 4.4/5 - strong | posted: 2026-09-15`,
      '- [ ] https://jobs.example.com/other | Other | Role',
      '',
      '## Processed',
      '',
      '- [x] #041 | https://jobs.example.com/old | Old | Role | 3.0/5 | PDF ❌',
      '',
    ].join('\n');
    const r = moveToProcessed(md, URL, POSTING);
    expect(r.moved).toBe(true);
    expect(r.text).toBe(
      [
        '## Pending',
        '',
        '- [ ] https://jobs.example.com/other | Other | Role',
        '',
        '## Processed',
        '',
        `- [x] #042 | ${URL} | Acme | Backend Engineer | 4.2/5 | PDF ❌`,
        '- [x] #041 | https://jobs.example.com/old | Old | Role | 3.0/5 | PDF ❌',
        '',
      ].join('\n'),
    );
  });

  it('takes company and role from the report for a bare pasted URL, and marks a generated PDF', () => {
    const md = `## Pendientes\n\n- [ ] ${URL}\n\n## Procesadas\n`;
    const r = moveToProcessed(md, URL, { ...POSTING, score: 4, pdf: true });
    expect(r.text).toBe(`## Pendientes\n\n\n## Procesadas\n\n- [x] #042 | ${URL} | Acme (report) | Engineer (report) | 4.0/5 | PDF ✅\n`);
  });

  it('a report with no generated PDF, or no readable score, says so', () => {
    const r = moveToProcessed(`## Pending\n- [ ] ${URL} | Acme | Eng\n## Processed\n`, URL, { ...POSTING, score: null, pdf: false });
    expect(r.text).toContain(`- [x] #042 | ${URL} | Acme | Eng | N/A | PDF ❌`);
  });

  it('creates a Processed section in the Pending section language when there is none', () => {
    const md = `## Pending\n\n- [ ] ${URL} | Acme | Eng\n\n## Done\n\n- [x] https://jobs.example.com/old | Old | Role\n`;
    expect(moveToProcessed(md, URL, POSTING).text).toBe(`## Pending\n\n\n## Done\n\n- [x] https://jobs.example.com/old | Old | Role\n\n## Processed\n\n- [x] #042 | ${URL} | Acme | Eng | 4.2/5 | PDF ❌\n`);
  });

  it('a row whose URL scan.mjs escaped moves when evaluated by its posting URL, and keeps the escaped form (SW3-libs-04 review)', () => {
    const escaped = 'https://jobs.example.com/apply?ids\\[0\\]=7&path=a\\\\b';
    const posting = 'https://jobs.example.com/apply?ids[0]=7&path=a\\b';
    const md = `## Pending\n\n- [ ] ${escaped} | Acme | Eng\n\n## Processed\n`;
    const r = moveToProcessed(md, posting, POSTING);
    expect(r.moved).toBe(true);
    expect(r.text).toBe(`## Pending\n\n\n## Processed\n\n- [x] #042 | ${escaped} | Acme | Eng | 4.2/5 | PDF ❌\n`);
  });

  it('an escaped URL Processed already lists only drops its Pending copy (SW3-libs-04 review)', () => {
    const escaped = 'https://jobs.example.com/apply?ids\\[0\\]=7';
    const md = `## Pending\n- [ ] ${escaped} | Acme | Eng\n## Processed\n- [x] #040 | ${escaped} | Acme | Eng | 4.0/5 | PDF ✅\n`;
    expect(moveToProcessed(md, 'https://jobs.example.com/apply?ids[0]=7', POSTING).text).toBe(`## Pending\n## Processed\n- [x] #040 | ${escaped} | Acme | Eng | 4.0/5 | PDF ✅\n`);
  });

  it('a ranked bare-URL row moves with the report\'s company and role, never a rank, posted or note segment as the company (SW5-server-02)', () => {
    const dash = String.fromCharCode(0x2014);
    const md = `## Pending\n- [ ] ${URL} | rank: 4.0/5 ${dash} strong backend match | posted: 2026-09-15 | note: from a friend\n## Processed\n`;
    expect(moveToProcessed(md, URL, POSTING).text).toBe(`## Pending\n## Processed\n\n- [x] #042 | ${URL} | Acme (report) | Engineer (report) | 4.2/5 | PDF ❌\n`);
    // A row with its own company keeps it, with the segments after it ignored.
    const named = `## Pending\n- [ ] ${URL} | Acme | rank: 4.0/5 ${dash} fit\n## Processed\n`;
    expect(moveToProcessed(named, URL, POSTING).text).toContain(`- [x] #042 | ${URL} | Acme | Engineer (report) | 4.2/5 | PDF ❌`);
  });

  it('only drops the Pending copy of a URL Processed already lists', () => {
    const md = `## Pending\n- [ ] ${URL} | Acme | Eng\n## Processed\n- [x] #040 | ${URL} | Acme | Eng | 4.0/5 | PDF ✅\n`;
    expect(moveToProcessed(md, URL, POSTING).text).toBe(`## Pending\n## Processed\n- [x] #040 | ${URL} | Acme | Eng | 4.0/5 | PDF ✅\n`);
  });

  it('leaves the file alone when the URL is not pending: skipped, flagged, another URL, or no Pending section', () => {
    for (const md of [`## Pending\n- [x] ${URL} | Acme | Eng\n`, `## Pending\n- [!] ${URL} - Error: login required\n`, `## Pending\n- [ ] ${URL}?gh_src=x | Acme | Eng\n`, `- [ ] ${URL}\n`]) {
      expect(moveToProcessed(md, URL, POSTING)).toEqual({ text: md, moved: false });
    }
  });

  it('keeps CRLF line endings', () => {
    const r = moveToProcessed(`## Pending\r\n- [ ] ${URL} | Acme | Eng\r\n## Processed\r\n`, URL, POSTING);
    expect(r.text).toBe(`## Pending\r\n## Processed\r\n\r\n- [x] #042 | ${URL} | Acme | Eng | 4.2/5 | PDF ❌\r\n`);
  });
});

describe('whether a report header names a generated PDF', () => {
  function root() {
    const dir = tempDir('cc-pdf-root-');
    fs.mkdirSync(path.join(dir, 'output'));
    fs.writeFileSync(path.join(dir, 'output', 'cv-acme.pdf'), '%PDF-1.7\n');
    return dir;
  }

  it('pending, the header oferta writes before the CV is built, is not a PDF', () => {
    expect(pdfGenerated('pending', root())).toBe(false);
  });

  it('a localized "not generated" header is not a PDF', () => {
    const dir = root();
    for (const header of ['nicht generiert - /career-ops pdf acme', 'no generado - ejecuta /career-ops pdf acme', 'ausstehend', '❌']) expect(pdfGenerated(header, dir), header).toBe(false);
  });

  it('a header naming a PDF that exists under the data root is a PDF, written bare, in backticks or as a link', () => {
    const dir = root();
    for (const header of ['output/cv-acme.pdf', '`output/cv-acme.pdf`', '✅ [cv-acme.pdf](output/cv-acme.pdf)', path.join(dir, 'output', 'cv-acme.pdf')]) expect(pdfGenerated(header, dir), header).toBe(true);
  });

  it('a PDF path that does not exist, is not a file, or resolves outside the data root is not a PDF', () => {
    const dir = root();
    const outside = path.join(tempDir('cc-pdf-outside-'), 'cv.pdf');
    fs.writeFileSync(outside, '%PDF-1.7\n');
    fs.mkdirSync(path.join(dir, 'output', 'folder.pdf'));
    fs.symlinkSync(outside, path.join(dir, 'output', 'linked.pdf'));
    for (const header of ['output/cv-other.pdf', 'output/folder.pdf', outside, `../${path.basename(path.dirname(outside))}/cv.pdf`, 'output/linked.pdf', null]) expect(pdfGenerated(header, dir), String(header)).toBe(false);
  });
});

describe('a PDF header path that cannot be resolved', () => {
  // output/ exists, so the over-long name itself is what fails (ENAMETOOLONG), not a missing parent (ENOENT).
  const LONG = `output/${'x'.repeat(300)}.pdf`;
  function longRoot() {
    const dir = tempDir('cc-pdf-long-');
    fs.mkdirSync(path.join(dir, 'output'));
    return dir;
  }
  function loopRoot() {
    const dir = tempDir('cc-pdf-loop-');
    fs.mkdirSync(path.join(dir, 'output'));
    fs.symlinkSync(path.join(dir, 'output', 'b.pdf'), path.join(dir, 'output', 'a.pdf'));
    fs.symlinkSync(path.join(dir, 'output', 'a.pdf'), path.join(dir, 'output', 'b.pdf'));
    return dir;
  }

  it('a path part over 255 characters, or a symlink loop, is not a PDF', () => {
    expect(pdfGenerated(LONG, longRoot())).toBe(false);
    expect(pdfGenerated('output/a.pdf', loopRoot())).toBe(false);
  });

  it('still moves the row to Processed, as PDF ❌, when the header path cannot be resolved', async () => {
    for (const [header, root] of [[LONG, longRoot()], ['output/a.pdf', loopRoot()]] as const) {
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `## Pending\n\n- [ ] ${URL} | Acme | Eng\n`);
      fs.writeFileSync(path.join(root, 'reports', '042-acme.md'), `# Evaluation: Acme - Eng\n\n**Score:** 4.2/5\n**PDF:** ${header}\n`);
      expect(await markPipelineEvaluated(DEFAULT_CODE_ROOT, root, URL, '042-acme.md'), header).toBe(true);
      expect(fs.readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8')).toContain(`- [x] #042 | ${URL} | Acme | Eng | 4.2/5 | PDF ❌`);
    }
  });
});

// A completed evaluation moves its pipeline row from Pending to Processed in the form pipeline mode writes
// (modes/pipeline.md, Workflow 2f), with reconcile-pipeline.mjs's section handling (SW-web-a-09).
import { describe, expect, it } from 'vitest';
import { moveToProcessed, type EvaluatedPosting } from '../../server/domains/pipelineProcessed.js';

const URL = 'https://boards.greenhouse.io/acme/jobs/1';
const POSTING: EvaluatedPosting = { report: '042', company: 'Acme (report)', role: 'Engineer (report)', score: 4.2, pdf: null };

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
    const r = moveToProcessed(md, URL, { ...POSTING, score: 4, pdf: 'output/cv-acme.pdf' });
    expect(r.text).toBe(`## Pendientes\n\n\n## Procesadas\n\n- [x] #042 | ${URL} | Acme (report) | Engineer (report) | 4.0/5 | PDF ✅\n`);
  });

  it('a report that says its PDF was not generated, or has no readable score, says so', () => {
    const r = moveToProcessed(`## Pending\n- [ ] ${URL} | Acme | Eng\n## Processed\n`, URL, { ...POSTING, score: null, pdf: 'not generated - run /career-ops pdf acme to create on demand' });
    expect(r.text).toContain(`- [x] #042 | ${URL} | Acme | Eng | N/A | PDF ❌`);
  });

  it('creates a Processed section in the Pending section language when there is none', () => {
    const md = `## Pending\n\n- [ ] ${URL} | Acme | Eng\n\n## Done\n\n- [x] https://jobs.example.com/old | Old | Role\n`;
    expect(moveToProcessed(md, URL, POSTING).text).toBe(`## Pending\n\n\n## Done\n\n- [x] https://jobs.example.com/old | Old | Role\n\n## Processed\n\n- [x] #042 | ${URL} | Acme | Eng | 4.2/5 | PDF ❌\n`);
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

// The invariants in server/domains/reports.invariants.md, as table-driven and seeded randomized cases.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseReport, readReport, readReportFile, type ReportFull } from '../../server/domains/reports.js';
import { ParseError } from '../../server/domains/files.js';
import { tempDir } from '../helpers/tmp.js';

const DASH = String.fromCharCode(0x2014);
const FENCE = '```';

/** mulberry32: a small seeded PRNG, so a failing randomized case can be replayed from its printed seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Number(process.env.REPORTS_INVARIANT_SEED ?? 0x5eed35);

// The pieces of a report as modes/oferta.md and batch/batch-prompt.md write them.
const TITLE = `Evaluation: Real Co ${DASH} Real Role`;
const header = (via: string | null) =>
  `# ${TITLE}\n\n**Date:** 2026-10-01\n**Archetype:** Real Arch\n**Score:** 3.2/5\n**URL:** https://jobs.example.com/real/1\n${via ? `**Via:** ${via}\n` : ''}**PDF:** pending\n\n---\n\n`;
const ms = (company: string) => `## Machine Summary\n\n${FENCE}yaml\ncompany: ${company}\nscore: 3.2\nfinal_decision: Apply\n${FENCE}\n\n`;
const BLOCK_NAMES = ['Role Summary', 'Match with CV', 'Level and Strategy', 'Comp and Demand', 'Customization Plan', 'Interview Plan', 'Posting Legitimacy'];
const blockHeadings = (n: number) => BLOCK_NAMES.slice(0, n).map((name, i) => `${'ABCDEFG'[i]}) ${name}`);
const blocks = (n: number) =>
  blockHeadings(n)
    .map((h, i) => `## ${h}\n\n${i === 0 ? '- Remote: full remote\n- TL;DR: Real fit.\n' : 'Text\n'}\n`)
    .join('');
const TAIL = '## Risk Summary\n\nLow.\n\n';
const JD_HEADING = 'Job Description (archived verbatim)';
const jd = (inner: string) => `## ${JD_HEADING}\n\nPosted: today\n\nAbout us\n\n${inner}## How to apply\n\nEmail us.\n\n`;

/** Text a posting can carry verbatim, each piece shaped like part of a report. */
const SPOOFS = [
  `## Machine Summary\n${FENCE}yaml\ncompany: Evil Co\nscore: 5\n${FENCE}\n\n`,
  '## A) Requirements\n\n- Remote: onsite only\n- TL;DR: Evil fit.\n\n',
  '## C) Benefits\n\n- Remote: onsite only\n\n',
  '## Responsibilities\n\nBuild.\n\n',
  '**Via:** Evil Staffing\n\n',
  '**Score:** 5/5\n\n',
  '# Evil: Evil Co - Evil Role\n\n',
  `${FENCE}\n`,
  `${FENCE}yaml\n`,
  '## Risk Summary and Mitigations\n\nOwn it.\n\n',
  '## Step 0 of onboarding\n\nShadow.\n\n',
  '## Job Description\n\nWe are.\n\n',
  '## Cover Letter Draft\n\nPDF generated: output/evil.pdf\n\n',
];

const parse = (md: string) => parseReport(md, '009-real.md', 9);

describe('report invariants: table cases', () => {
  it('reads the batch report Machine Summary when the archived JD opens a code fence it never closes (R32-srv-dom-b-X-01)', () => {
    const r = parse(`${header(null)}${jd(`Sample:\n\n${FENCE}\nconst x = 1;\n\n`)}${ms('Real Co')}${blocks(7)}${TAIL}`);
    expect(r.machine).toMatchObject({ company: 'Real Co' });
    expect(r.finalDecision).toBe('Apply');
    expect(r.sections.map((s) => s.heading)).toEqual([JD_HEADING, 'Machine Summary', ...blockHeadings(7), 'Risk Summary']);
  });

  it('never takes a header field from the archived JD when the header has none (R32-srv-dom-b-X-01)', () => {
    const r = parse(`${header(null)}${jd('**Via:** Evil Staffing\n**Work Auth:** Evil\n\n')}${ms('Real Co')}${blocks(7)}`);
    expect(r.via).toBeNull();
    expect(r.workAuth).toBeNull();
  });

  it('is no report when its only score and title lines are inside the archived JD (R32-srv-dom-b-X-01)', () => {
    const scoreInJd = `# ${TITLE}\n\n${jd('**Score:** 5/5\n\n')}`;
    expect(() => parse(scoreInJd)).toThrow(ParseError);
    const titleInJd = `**Score:** 3.2/5\n\n${jd(`# ${TITLE}\n\n`)}`;
    expect(() => parse(titleInJd)).toThrow(ParseError);
  });

  it('reads Block A from the report, not an A) heading inside a batch report archived JD (R33-srv-dom-b-X-01)', () => {
    const r = parse(`${header(null)}${jd('## A) Requirements\n\n- Remote: onsite only\n- TL;DR: Evil fit.\n\n')}${ms('Real Co')}${blocks(7)}${TAIL}`);
    expect(r).toMatchObject({ remote: 'full remote', tldr: 'Real fit.' });
    expect(r.sections.map((s) => s.heading)).toEqual([JD_HEADING, 'Machine Summary', ...blockHeadings(7), 'Risk Summary']);
    expect(r.sections[0]!.content).toContain('## A) Requirements');
  });

  it('keeps a cover letter heading inside a batch report archived JD in the JD (R33-srv-dom-b-X-01)', () => {
    const r = parse(`${header(null)}${jd('## Cover Letter Draft\n\nPDF generated: output/evil.pdf\n\n')}${ms('Real Co')}${blocks(7)}`);
    expect(r.coverPdf).toBeNull();
  });

  it('points an invalid batch Machine Summary at its file line even after a JD with an open fence (R33-srv-dom-b-X-02)', () => {
    const head = `${header(null)}${jd(`${FENCE}\n`)}`;
    const md = `${head}## Machine Summary\n\n${FENCE}yaml\nscore: 4\nkey: value: other\n${FENCE}\n\n${blocks(7)}`;
    const expected = head.split('\n').length - 1 + 5; // heading, blank, fence opener, `score: 4`, then the bad line
    let line: number | null = null;
    try {
      parse(md);
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      line = (err as ParseError).line;
    }
    expect(line).toBe(expected);
    expect(md.split('\n')[expected - 1]).toBe('key: value: other');
  });

  it('does not take a JD Machine Summary whose next JD heading sits in a fence for the report own (R34-srv-dom-b-X-01)', () => {
    const fakeThenFenced = `## Machine Summary\n${FENCE}yaml\ncompany: Evil Co\nscore: 5\n${FENCE}\n\n${FENCE}\n## Perks\n${FENCE}\n\n`;
    const md = `${header(null)}## ${JD_HEADING}\n\nAbout us\n\n${fakeThenFenced}${blocks(7)}`;
    const r = parse(md);
    expect(r.machine).toBeNull();
    expect(r.company).toBe('Real Co');
  });

  it('keeps the R34 judgment call: a batch report with fewer than A) to F) reads machine: null, score from the header', () => {
    const r = parse(`${header(null)}${jd('')}${ms('Real Co')}${blocks(5)}`);
    expect(r.machine).toBeNull();
    expect(r.score).toBe(3.2);
  });

  it('reads a report saved with a UTF-8 BOM and CRLF line ends', () => {
    const md = `\uFEFF${header('Real Agency')}${ms('Real Co')}${blocks(7)}${jd('')}`.replace(/\n/g, '\r\n');
    const r = parse(md);
    expect(r).toMatchObject({ title: TITLE, company: 'Real Co', via: 'Real Agency', score: 3.2, remote: 'full remote' });
    expect(r.machine).toMatchObject({ company: 'Real Co' });
  });
});

describe('report invariants: reading files', () => {
  const rootWith = (files: Record<string, string>) => {
    const root = tempDir('reports-inv-');
    fs.mkdirSync(path.join(root, 'reports'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'reports', name), text);
    return root;
  };
  const report = (company: string, score: string) => `# Evaluation: ${company} ${DASH} Eng\n\n**Score:** ${score}\n`;
  it('reads the named file when two share a number, and the first by name by number (R34-srv-dom-b-L1-02)', () => {
    const root = rootWith({ '099-acme.md': report('Acme', '2.0/5'), '099-zeta.md': report('Zeta', '4.5/5') });
    const named = readReportFile(root, '099-zeta.md');
    expect(named.kind === 'ok' && [named.report.file, named.report.company, named.report.score]).toEqual(['099-zeta.md', 'Zeta', 4.5]);
    const byNum = readReport(root, 99);
    expect(byNum.kind === 'ok' && byNum.report.file).toBe('099-acme.md');
    fs.mkdirSync(path.join(root, 'reports', '098-folder.md'));
    expect(readReport(root, 98)).toEqual({ kind: 'missing', num: 98 });
    expect(readReportFile(root, '098-folder.md')).toEqual({ kind: 'missing', num: 98 });
  });
});

describe('report invariants: randomized layouts and spoofed JDs', () => {
  type Shape = { batch: boolean; ownMs: boolean; nBlocks: number; spoofs: string[]; crlf: boolean; bom: boolean };

  function generate(rand: () => number): Shape {
    const batch = rand() < 0.5;
    const spoofs = Array.from({ length: Math.floor(rand() * 6) }, () => SPOOFS[Math.floor(rand() * SPOOFS.length)]!);
    // A batch report always carries its full A) to G) run here; with fewer, its JD ends at the first template heading by design.
    return { batch, ownMs: rand() < 0.7, nBlocks: batch ? 7 : rand() < 0.5 ? 7 : 5, spoofs, crlf: rand() < 0.2, bom: rand() < 0.2 };
  }

  function render(s: Shape): string {
    const body = s.batch
      ? `${header(null)}${jd(s.spoofs.join(''))}---\n\n${s.ownMs ? ms('Real Co') : ''}${blocks(s.nBlocks)}${TAIL}`
      : `${header('Real Agency')}${s.ownMs ? ms('Real Co') : ''}${blocks(s.nBlocks)}${TAIL}${jd(s.spoofs.join(''))}`;
    const md = s.crlf ? body.replace(/\n/g, '\r\n') : body;
    return s.bom ? `\uFEFF${md}` : md;
  }

  function check(s: Shape, r: ReportFull) {
    expect(r.title).toBe(TITLE);
    expect(r.score).toBe(3.2);
    expect([r.company, r.role]).toEqual(['Real Co', 'Real Role']);
    expect([r.remote, r.tldr]).toEqual(['full remote', 'Real fit.']);
    if (s.ownMs) expect(r.machine).toMatchObject({ company: 'Real Co', score: 3.2 });
    else expect(r.machine).toBeNull();
    expect(r.via).toBe(s.batch ? null : 'Real Agency');
    if (s.batch) {
      expect(r.sections.map((x) => x.heading)).toEqual([JD_HEADING, ...(s.ownMs ? ['Machine Summary'] : []), ...blockHeadings(s.nBlocks), 'Risk Summary']);
      expect(r.coverPdf).toBeNull();
    }
  }

  it('holds the ownership invariants for 400 generated reports', () => {
    for (let k = 0; k < 400; k++) {
      const seed = SEED + k;
      const shape = generate(prng(seed));
      try {
        check(shape, parse(render(shape)));
      } catch (err) {
        throw new Error(`seed ${seed} (REPORTS_INVARIANT_SEED=${seed}) shape ${JSON.stringify(shape)}: ${(err as Error).message}`, { cause: err });
      }
    }
  });
});

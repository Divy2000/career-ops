// Sponsorship > Run AI policy pass runs the daily policy pass the way custom/immigration/run-daily.sh does: the
// queued official items are snapshotted into a batch file, the pass gets daily-prompt.md filled in with them, and
// only that batch is acknowledged once the pass is done (SW-web-b-02).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { PendingUnreadableError, preparePolicyPass } from '../../server/domains/policyPass.js';
import { tempDir } from '../helpers/tmp.js';

const ITEMS = [
  { id: 'fr:2026-21001', source: 'Federal Register (Rule; USCIS)', title: 'H-1B weighted selection final rule', url: 'https://www.federalregister.gov/d/2026-21001', published: '2026-10-01' },
  { id: 'uscis:https://www.uscis.gov/news/x', source: 'USCIS news', title: 'USCIS updates H-1B fee guidance', url: 'https://www.uscis.gov/news/x', published: '2026-10-02' },
];

function dataRoot(pending?: string, seen?: string): string {
  const root = tempDir('cc-policy-pass-');
  const imm = path.join(root, 'data', 'immigration');
  fs.mkdirSync(imm, { recursive: true });
  if (pending !== undefined) fs.writeFileSync(path.join(imm, 'pending.json'), pending);
  if (seen !== undefined) fs.writeFileSync(path.join(imm, 'seen.json'), seen);
  return root;
}
// 19:00 on 2026-10-05 in Los Angeles (vitest's pinned TZ), when UTC is already 2026-10-06: the pass is dated the
// local day, as run-daily.sh dates it with `date +%Y-%m-%d` (this moved here from the client's prompt, local-time.spec.ts).
const EVENING = new Date('2026-10-06T02:00:00.000Z');

describe('preparePolicyPass', () => {
  it('given queued items, when a pass is prepared, then a batch file holds exactly those items in the shape watch.mjs --ack reads', () => {
    const root = dataRoot(JSON.stringify(ITEMS));
    const pass = preparePolicyPass(DEFAULT_CODE_ROOT, root, EVENING);
    expect(pass.batch).toMatch(/^data\/immigration\/batches\/20261005T190000-cc-[0-9a-f]{8}\.json$/);
    const batch = JSON.parse(fs.readFileSync(path.join(root, pass.batch!), 'utf8')) as { date: string; new_items: unknown[] };
    expect(batch).toEqual({ date: '2026-10-05', news_since: '2026-10-02', new_items: ITEMS });
  });

  it('given a last successful pass weeks ago in seen.json, when a pass is prepared, then its prompt searches the news back to that day (SW8-scripts-01)', () => {
    const root = dataRoot(JSON.stringify(ITEMS), JSON.stringify({ ids: [], last_pass: '2026-09-20' }));
    const { prompt } = preparePolicyPass(DEFAULT_CODE_ROOT, root, EVENING);
    expect(prompt).toContain('"news_since": "2026-09-20"');
  });

  it('given no recorded pass (no seen.json, or one without last_pass) or one from yesterday, when a pass is prepared, then its prompt searches at least the last three days', () => {
    for (const seen of [undefined, JSON.stringify({ ids: [] }), JSON.stringify({ ids: [], last_pass: '2026-10-04' })]) {
      const { prompt } = preparePolicyPass(DEFAULT_CODE_ROOT, dataRoot(JSON.stringify(ITEMS), seen), EVENING);
      expect(prompt).toContain('"news_since": "2026-10-02"');
    }
  });

  it('given a seen.json that cannot be read for its last pass, when a pass is prepared, then it is refused with the reason', () => {
    expect(() => preparePolicyPass(DEFAULT_CODE_ROOT, dataRoot('[]', '{ not json'), EVENING)).toThrow(PendingUnreadableError);
    expect(() => preparePolicyPass(DEFAULT_CODE_ROOT, dataRoot('[]', '{ not json'), EVENING)).toThrow('data/immigration/seen.json is not valid JSON; fix or remove it, then run the pass again');
    expect(() => preparePolicyPass(DEFAULT_CODE_ROOT, dataRoot('[]', '{"ids": [], "last_pass": "yesterday"}'), EVENING)).toThrow('data/immigration/seen.json has a last_pass that is not a YYYY-MM-DD date; fix or remove it, then run the pass again');
    expect(() => preparePolicyPass(DEFAULT_CODE_ROOT, dataRoot('[]', '{"ids": [], "last_pass": "2026-02-30"}'), EVENING)).toThrow('data/immigration/seen.json has a last_pass that is not a YYYY-MM-DD date; fix or remove it, then run the pass again');
  });

  it('given queued items, when a pass is prepared, then its prompt is daily-prompt.md with today, the data paths and the items filled in', () => {
    const root = dataRoot(JSON.stringify(ITEMS));
    const { prompt } = preparePolicyPass(DEFAULT_CODE_ROOT, root, EVENING);
    expect(prompt).not.toContain('{{');
    expect(prompt).toContain('Today is 2026-10-05.');
    expect(prompt).toContain(`\`${path.join(root, 'config', 'profile.yml')}\``);
    expect(prompt).toContain(`\`${path.join(root, 'data', 'immigration')}/policy-changes.tsv\``);
    expect(prompt).toContain('"title": "H-1B weighted selection final rule"');
    expect(prompt).toContain('SUMMARY: <n> policy changes, <m> company alerts');
  });

  it('given a prompt-like value in an item, when it is filled in, then replacement patterns such as $& stay literal', () => {
    const root = dataRoot(JSON.stringify([{ ...ITEMS[0], title: 'Fee rule $& {{TODAY}} $1' }]));
    const { prompt } = preparePolicyPass(DEFAULT_CODE_ROOT, root, EVENING);
    expect(prompt).toContain('"title": "Fee rule $& {{TODAY}} $1"');
  });

  it('given nothing queued (no pending.json, or an empty list), when a pass is prepared, then it still runs the news search with no items and writes no batch', () => {
    for (const root of [dataRoot(), dataRoot('[]\n')]) {
      const pass = preparePolicyPass(DEFAULT_CODE_ROOT, root, EVENING);
      expect(pass.batch).toBeNull();
      expect(pass.prompt).toContain('"new_items": []');
      expect(fs.existsSync(path.join(root, 'data', 'immigration', 'batches'))).toBe(false);
    }
  });

  it('given a pending.json that is not a list of items, when a pass is prepared, then it is refused with the reason', () => {
    const malformed = dataRoot('{ not json');
    expect(() => preparePolicyPass(DEFAULT_CODE_ROOT, malformed, EVENING)).toThrow(PendingUnreadableError);
    expect(() => preparePolicyPass(DEFAULT_CODE_ROOT, malformed, EVENING)).toThrow('data/immigration/pending.json is not valid JSON; fix or remove it, then run the pass again');
    expect(() => preparePolicyPass(DEFAULT_CODE_ROOT, dataRoot('{"items": []}'), EVENING)).toThrow('data/immigration/pending.json is not a list of items; fix or remove it, then run the pass again');
  });
});

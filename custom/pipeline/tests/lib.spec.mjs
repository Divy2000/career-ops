import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRow, orderPending, sponsorAdjustment, buildShortlist, pickSearchMatch } from '../lib.mjs';

const ROW = '- [ ] https://jobs.example.com/1 | Snap Inc. | Software Engineer, Backend | New York, NY | posted: 2026-09-30';
const RANKED = `${ROW} | rank: 4.4/5 — Backend Python fit`;

test('parseRow reads url, company, title, location, posted date and rank', () => {
  const r = parseRow(RANKED);
  assert.equal(r.pending, true);
  assert.equal(r.url, 'https://jobs.example.com/1');
  assert.equal(r.company, 'Snap Inc.');
  assert.equal(r.title, 'Software Engineer, Backend');
  assert.equal(r.location, 'New York, NY');
  assert.equal(r.posted, '2026-09-30');
  assert.equal(r.rank, 4.4);
  assert.equal(r.rankReason, 'Backend Python fit');
});

test('parseRow handles an unranked row with no posted date', () => {
  const r = parseRow('- [ ] https://x/2 | Acme | Data Engineer | Remote');
  assert.equal(r.rank, null);
  assert.equal(r.posted, null);
  assert.equal(r.location, 'Remote');
});

test('parseRow returns null for headings and processed rows are not pending', () => {
  assert.equal(parseRow('## Pending'), null);
  assert.equal(parseRow('- [x] https://x/3 | Acme | SWE | Remote').pending, false);
});

test('orderPending puts rows first seen today ahead of the backlog', () => {
  const rows = [
    '- [ ] https://x/old | A | Backend Engineer | Remote | posted: 2026-10-01',
    '- [ ] https://x/new | B | Data Analyst Engineer | Remote | posted: 2026-10-02',
  ];
  const firstSeen = new Map([['https://x/old', '2026-10-01'], ['https://x/new', '2026-10-03']]);
  const out = orderPending(rows, { today: '2026-10-03', firstSeen });
  assert.equal(out[0], rows[1]);
});

test('orderPending: within the same day, fresher postings and backend/AI titles come first', () => {
  const rows = [
    '- [ ] https://x/1 | A | Data Engineer | Remote | posted: 2026-09-01',
    '- [ ] https://x/2 | B | Frontend Engineer | Remote | posted: 2026-10-02',
    '- [ ] https://x/3 | C | Backend Engineer (Python) | Remote | posted: 2026-10-02',
  ];
  const out = orderPending(rows, { today: '2026-10-03', firstSeen: new Map() });
  assert.deepEqual(out.map((r) => parseRow(r).url), ['https://x/3', 'https://x/2', 'https://x/1']);
});

test('orderPending keeps rows with no posted date in the fresh band', () => {
  const rows = [
    '- [ ] https://x/1 | A | Backend Engineer | Remote | posted: 2026-06-01',
    '- [ ] https://x/2 | B | Backend Engineer | Remote',
  ];
  const out = orderPending(rows, { today: '2026-10-03', firstSeen: new Map() });
  assert.equal(parseRow(out[0]).url, 'https://x/2');
});

test('sponsorAdjustment: an alert that paused or stopped sponsorship excludes the job', () => {
  for (const status of ['paused', 'stopped', 'restricted']) {
    const a = sponsorAdjustment({ tier: 'strong', alert: { status, headline: 'h', date: '2026-10-01' } });
    assert.equal(a.exclude, true, status);
    assert.match(a.label, new RegExp(status));
  }
});

test('sponsorAdjustment: a resumed alert does not exclude', () => {
  const a = sponsorAdjustment({ tier: 'strong', alert: { status: 'resumed', headline: 'h', date: '2026-10-01' } });
  assert.equal(a.exclude, false);
});

test('sponsorAdjustment scores tiers from strong (boost) to none (heavy penalty)', () => {
  const d = (tier) => sponsorAdjustment({ tier, alert: null }).delta;
  assert.ok(d('strong') > d('moderate'));
  assert.ok(d('moderate') > d('unknown'));
  assert.ok(d('unknown') > d('weak'));
  assert.ok(d('weak') > d('none'));
  assert.equal(d('staffing-shop'), d('none'));
});

test('sponsorAdjustment rejects an unrecognised tier', () => {
  assert.throws(() => sponsorAdjustment({ tier: 'great', alert: null }), /tier/);
});

test('buildShortlist combines rank with sponsorship, sorts, and separates exclusions', () => {
  const rows = [
    '- [ ] https://x/1 | Strongco | Backend Engineer | Remote | posted: 2026-10-01 | rank: 4.0/5 — fit',
    '- [ ] https://x/2 | Noneco | Backend Engineer | Remote | posted: 2026-10-01 | rank: 4.5/5 — great fit',
    '- [ ] https://x/3 | Pausedco | AI Engineer | Remote | posted: 2026-10-01 | rank: 4.8/5 — best fit',
    '- [ ] https://x/4 | Lowco | Backend Engineer | Remote | posted: 2026-10-01 | rank: 2.0/5 — weak fit',
    '- [ ] https://x/5 | Unranked | Backend Engineer | Remote',
  ].map(parseRow);
  const tiers = new Map([['Strongco', 'strong'], ['Noneco', 'none'], ['Pausedco', 'strong'], ['Lowco', 'strong']]);
  const alerts = new Map([['Pausedco', { status: 'paused', headline: 'paused H-1B', date: '2026-10-02' }]]);
  const { shortlist, excluded } = buildShortlist(rows, { tiers, alerts, minRank: 3 });
  assert.deepEqual(shortlist.map((s) => s.company), ['Strongco', 'Noneco']);
  assert.ok(shortlist[0].score > shortlist[1].score, 'strong sponsor at 4.0 beats no-history sponsor at 4.5');
  assert.deepEqual(excluded.map((s) => s.company), ['Pausedco']);
});

test('buildShortlist keeps one row per company+title, the highest ranked', () => {
  const rows = [
    '- [ ] https://builtin.com/a | Affirm | Software Engineer II, Backend | Remote | rank: 3.7/5 — ok',
    '- [ ] https://builtinaustin.com/a | Affirm | Software Engineer II, Backend | Remote | rank: 4.0/5 — better',
  ].map(parseRow);
  const { shortlist } = buildShortlist(rows, { tiers: new Map([['Affirm', 'strong']]), alerts: new Map(), minRank: 3 });
  assert.equal(shortlist.length, 1);
  assert.equal(shortlist[0].url, 'https://builtinaustin.com/a');
});

test('buildShortlist drops rows the keep() predicate rejects', () => {
  const rows = [
    '- [ ] https://x/1 | Pinterest | University Grad ML Engineer | SF | rank: 4.6/5 — fit',
    '- [ ] https://x/2 | Snap | Backend Engineer | NY | rank: 4.0/5 — fit',
  ].map(parseRow);
  const { shortlist } = buildShortlist(rows, {
    tiers: new Map(), alerts: new Map(), minRank: 3, keep: (r) => !/grad/i.test(r.title),
  });
  assert.deepEqual(shortlist.map((s) => s.company), ['Snap']);
});

test('pickSearchMatch chooses the first candidate whose name extends the company name', () => {
  const candidates = ['JPMORGAN CHASE & CO', 'JPMORGAN CHASE BANK, N.A.', 'CHASE MANHATTAN'];
  assert.equal(pickSearchMatch('JPMorganChase', candidates), 'JPMORGAN CHASE & CO');
  assert.equal(pickSearchMatch('Snap Inc.', ['SNAPCHAT LLC', 'SNAP INC.']), 'SNAP INC.');
  assert.equal(pickSearchMatch('Acme', ['ACMEX LABS']), null, 'must not match a longer different word');
  assert.equal(pickSearchMatch('Acme', []), null);
});

test('buildShortlist treats a company missing from the tier map as unknown', () => {
  const rows = [parseRow('- [ ] https://x/1 | Mystery | Backend Engineer | Remote | rank: 4.0/5 — fit')];
  const { shortlist } = buildShortlist(rows, { tiers: new Map(), alerts: new Map(), minRank: 3 });
  assert.equal(shortlist[0].tier, 'unknown');
});

// --- fork review (gpt-5.6-terra) ---
test('parseRow reads labeled segments on a bare-URL row instead of treating them as company/title', () => {
  const r = parseRow('- [ ] https://jobs.example.test/42 | rank: 4.2/5 — strong fit');
  assert.equal(r.url, 'https://jobs.example.test/42');
  assert.equal(r.company, '');
  assert.equal(r.title, '');
  assert.equal(r.rank, 4.2);
  assert.equal(r.rankReason, 'strong fit');
});

test('parseRow keeps positional fields when labeled segments come last', () => {
  const r = parseRow('- [ ] https://x/1 | Acme | Backend Engineer | posted: 2026-10-01 | rank: 3.5/5 — ok');
  assert.equal(r.company, 'Acme');
  assert.equal(r.title, 'Backend Engineer');
  assert.equal(r.location, '');
  assert.equal(r.posted, '2026-10-01');
});

test('parseRow keeps trust: and note: labels out of the positional fields', () => {
  const r = parseRow('- [ ] https://x | Acme | Backend Engineer | trust: 60 missing_apply_url | note: reposted | rank: 4.0/5 — fit');
  assert.equal(r.company, 'Acme');
  assert.equal(r.title, 'Backend Engineer');
  assert.equal(r.location, '');
  assert.equal(r.labels.trust, '60 missing_apply_url');
  assert.equal(r.labels.note, 'reposted');
  assert.equal(r.rank, 4.0);
});

test('parseRow only treats trailing segments as labels', () => {
  const r = parseRow('- [ ] https://x | Acme | note: Backend Engineer | Remote');
  assert.equal(r.title, 'note: Backend Engineer');
  assert.equal(r.location, 'Remote');
  assert.deepEqual(r.labels, {});
});

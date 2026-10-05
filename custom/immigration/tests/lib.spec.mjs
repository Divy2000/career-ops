import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  companySlug,
  parseRssItems,
  isRelevantPolicyItem,
  parsePolicyChanges,
  readCheckedAt,
  decideRefresh,
  noteSkippedPass,
} from '../lib.mjs';

test('companySlug lowercases, strips punctuation and legal suffixes', () => {
  assert.equal(companySlug('Stripe, Inc.'), 'stripe');
  assert.equal(companySlug('Capital One (Plano)'), 'capital-one-plano');
  assert.equal(companySlug('Weights & Biases'), 'weights-and-biases');
  assert.equal(companySlug('  Amazon.com Services LLC '), 'amazon-com-services');
});

test('companySlug rejects an empty name', () => {
  assert.throws(() => companySlug('   '), /company name/i);
});

test('parseRssItems extracts title, link and pubDate from each item', () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>Feed</title>
    <item><title>USCIS Updates H-1B Fee Guidance</title><link>https://www.uscis.gov/a</link><pubDate>Thu, 01 Oct 2026 12:00:00 -0400</pubDate></item>
    <item><title><![CDATA[Visa Bulletin & Notes]]></title><link>https://www.uscis.gov/b</link><pubDate>Wed, 30 Sep 2026 09:00:00 -0400</pubDate></item>
  </channel></rss>`;
  const items = parseRssItems(xml);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    title: 'USCIS Updates H-1B Fee Guidance',
    url: 'https://www.uscis.gov/a',
    date: '2026-10-01',
  });
  assert.equal(items[1].title, 'Visa Bulletin & Notes');
  assert.equal(items[1].date, '2026-09-30');
});

test('parseRssItems returns [] for a feed with no items', () => {
  assert.deepEqual(parseRssItems('<rss><channel></channel></rss>'), []);
});

test('isRelevantPolicyItem keeps work-visa topics and drops unrelated news', () => {
  assert.equal(isRelevantPolicyItem('DHS proposes $103,265 H-1B fee'), true);
  assert.equal(isRelevantPolicyItem('Changes to the H1B weighted selection'), true);
  assert.equal(isRelevantPolicyItem('Labor Condition Application review'), true);
  assert.equal(isRelevantPolicyItem('Employment-Based Immigrant Visa backlog'), true);
  assert.equal(isRelevantPolicyItem('STEM OPT extension rule'), true);
  assert.equal(isRelevantPolicyItem('Former prison official sentenced for torture'), false);
  assert.equal(isRelevantPolicyItem('EB-5 regional center fee rule'), false);
});

test('parsePolicyChanges reads the TSV and skips the header and blank lines', () => {
  const tsv = [
    'detected_date\tannounced_date\tsource\ttitle\turl\timpact',
    '2026-10-01\t2026-09-30\tFederal Register\tH-1B fee rule\thttps://x/1\tCosts up',
    '',
    '2026-10-02\t\tnews\tCourt blocks fee\thttps://x/2\tFee paused',
  ].join('\n');
  const rows = parsePolicyChanges(tsv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].announced, '2026-09-30');
  assert.equal(rows[1].announced, '2026-10-02', 'falls back to detected date');
});

test('parsePolicyChanges rejects a malformed date loudly', () => {
  const tsv = 'detected_date\tannounced_date\tsource\ttitle\turl\timpact\n10/01/2026\t\tx\ty\tz\tw';
  assert.throws(() => parsePolicyChanges(tsv), /line 2/);
});

test('readCheckedAt reads the checked_at line from a saved company file', () => {
  assert.equal(readCheckedAt('# Stripe\n\nchecked_at: 2026-09-20\nverdict: sponsoring\n'), '2026-09-20');
  assert.equal(readCheckedAt('# Stripe\nno date here'), null);
});

const changes = (...rows) => rows.map(([detected, announced]) => ({ detected, announced }));

test('decideRefresh: no saved check means refresh', () => {
  const d = decideRefresh({ today: '2026-10-03', checkedAt: null, changes: [] });
  assert.equal(d.refresh, true);
  assert.match(d.reason, /no saved check/);
});

test('decideRefresh: a policy change detected after the last check forces a refresh', () => {
  const d = decideRefresh({
    today: '2026-10-03', checkedAt: '2026-10-01', changes: changes(['2026-10-02', '2026-10-02']),
  });
  assert.equal(d.refresh, true);
  assert.match(d.reason, /policy change/);
});

test('decideRefresh: inside the 15-day window after a change, refresh daily', () => {
  const d = decideRefresh({
    today: '2026-10-10', checkedAt: '2026-10-09', changes: changes(['2026-10-01', '2026-10-01']),
  });
  assert.equal(d.refresh, true);
  assert.match(d.reason, /15-day window/);
});

test('decideRefresh: inside the window but already checked today, no refresh', () => {
  const d = decideRefresh({
    today: '2026-10-10', checkedAt: '2026-10-10', changes: changes(['2026-10-01', '2026-10-01']),
  });
  assert.equal(d.refresh, false);
});

test('decideRefresh: the window ends 15 days after the announcement', () => {
  const day15 = decideRefresh({
    today: '2026-10-16', checkedAt: '2026-10-15', changes: changes(['2026-10-01', '2026-10-01']),
  });
  assert.equal(day15.refresh, true, 'day 15 is still inside the window');
  const day16 = decideRefresh({
    today: '2026-10-17', checkedAt: '2026-10-16', changes: changes(['2026-10-01', '2026-10-01']),
  });
  assert.equal(day16.refresh, false, 'day 16 is outside the window and the check is 1 day old');
});

test('decideRefresh: outside any window, refresh once the check is 7 days old', () => {
  const fresh = decideRefresh({ today: '2026-10-08', checkedAt: '2026-10-02', changes: [] });
  assert.equal(fresh.refresh, false);
  const stale = decideRefresh({ today: '2026-10-09', checkedAt: '2026-10-02', changes: [] });
  assert.equal(stale.refresh, true);
  assert.match(stale.reason, /7 days/);
});

test('decideRefresh: the window runs from the announced date, not the detected date', () => {
  const d = decideRefresh({
    today: '2026-10-20', checkedAt: '2026-10-19', changes: changes(['2026-10-10', '2026-09-30']),
  });
  assert.equal(d.refresh, false, 'announced 2026-09-30, so the window closed on 2026-10-15');
});

test('decideRefresh: future-dated changes are ignored', () => {
  const d = decideRefresh({
    today: '2026-10-03', checkedAt: '2026-10-02', changes: changes(['2026-11-01', '2026-11-01']),
  });
  assert.equal(d.refresh, false);
});

test('decideRefresh rejects a malformed date', () => {
  assert.throws(() => decideRefresh({ today: '2026/10/03', checkedAt: null, changes: [] }), /today/);
});

// --- review fixes (gpt-5.6-terra review, 2026-10-03) ---
import { parseCompanyAlerts, readSeenChangeCount, sinceForSource } from '../lib.mjs';

test('parsePolicyChanges keeps the first data row when the file has no header', () => {
  const rows = parsePolicyChanges('2026-10-03\t2026-10-01\tFR\tH-1B fee rule\thttps://x\tcosts up');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'H-1B fee rule');
});

test('parseCompanyAlerts reads rows with or without a header and keeps the newest per slug', () => {
  const noHeader = '2026-10-03\tAcme\tacme\tpaused\tAcme pauses H-1B\thttps://x/1';
  assert.equal(parseCompanyAlerts(noHeader).get('acme').status, 'paused');
  const withHeader = [
    'date\tcompany\tslug\tstatus\theadline\turl',
    '2026-10-01\tAcme\tacme\tpaused\told\thttps://x/1',
    '2026-10-05\tAcme\tacme\tresumed\tnew\thttps://x/2',
  ].join('\n');
  const a = parseCompanyAlerts(withHeader);
  assert.equal(a.size, 1);
  assert.equal(a.get('acme').status, 'resumed');
});

test('parseCompanyAlerts rejects an unknown status loudly', () => {
  assert.throws(() => parseCompanyAlerts('2026-10-03\tAcme\tacme\tmaybe\th\tu'), /line 1.*status/);
});

test('date validation rejects calendar-impossible dates', () => {
  assert.throws(() => decideRefresh({ today: '2026-02-30', checkedAt: null, changes: [] }), /today/);
  assert.throws(() => decideRefresh({ today: '2026-03-01', checkedAt: '2026-02-30', changes: [] }), /checkedAt/);
});

test('readSeenChangeCount reads policy_changes_seen, null when absent', () => {
  assert.equal(readSeenChangeCount('checked_at: 2026-10-03\npolicy_changes_seen: 7\n'), 7);
  assert.equal(readSeenChangeCount('checked_at: 2026-10-03\n'), null);
});

test('decideRefresh: a change recorded later the same day as the check forces a refresh', () => {
  const sameDay = [{ detected: '2026-10-03', announced: '2026-09-01' }, { detected: '2026-10-03', announced: '2026-09-02' }];
  const d = decideRefresh({ today: '2026-10-03', checkedAt: '2026-10-03', seenChangeCount: 1, changes: sameDay });
  assert.equal(d.refresh, true);
  assert.match(d.reason, /policy change/);
});

test('decideRefresh: no new rows since the check means no forced refresh', () => {
  const old = [{ detected: '2026-08-01', announced: '2026-08-01' }];
  const d = decideRefresh({ today: '2026-10-03', checkedAt: '2026-10-01', seenChangeCount: 1, changes: old });
  assert.equal(d.refresh, false);
});

test('sinceForSource reaches back to the last success after an outage longer than 14 days', () => {
  assert.equal(sinceForSource({ lastSuccess: '2026-10-01', today: '2026-10-17' }), '2026-10-01');
  assert.equal(sinceForSource({ lastSuccess: '2026-10-16', today: '2026-10-17' }), '2026-10-03');
  assert.equal(sinceForSource({ lastSuccess: null, today: '2026-10-17' }), '2026-10-03');
});

// --- second review round (gpt-5.6-terra) ---
import { sourceCursor } from '../lib.mjs';

test('sourceCursor falls back to the legacy last_run when no per-source history exists', () => {
  assert.equal(sourceCursor({ ids: [], last_run: '2026-01-01' }, 'uscis'), '2026-01-01');
  assert.equal(sourceCursor({ last_run: '2026-01-01', last_success: { uscis: '2026-10-02' } }, 'uscis'), '2026-10-02');
  assert.equal(sourceCursor({ last_run: '2026-01-01', last_success: { uscis: '2026-10-02' } }, 'federal-register'), '2026-01-01');
  assert.equal(sourceCursor({ ids: [] }, 'uscis'), null);
});

test('decideRefresh: future-dated rows do not count as new changes', () => {
  const rows = [{ detected: '2026-10-01', announced: '2026-10-01' }, { detected: '2026-11-01', announced: '2026-11-01' }];
  const d = decideRefresh({ today: '2026-10-03', checkedAt: '2026-10-03', seenChangeCount: 1, changes: rows });
  assert.equal(d.refresh, false);
});

test('decideRefresh: a legacy file without a count still refreshes after a change logged the same day', () => {
  const rows = [{ detected: '2026-10-03', announced: '2026-10-03' }];
  const d = decideRefresh({ today: '2026-10-03', checkedAt: '2026-10-03', seenChangeCount: null, changes: rows });
  assert.equal(d.refresh, true);
});

// --- fork review: pending queue (gpt-5.6-terra) ---
import { mergePending } from '../lib.mjs';

test('mergePending keeps unacknowledged items and adds new ones once', () => {
  const pending = [{ id: 'a', title: 'A' }];
  const out = mergePending(pending, [{ id: 'a', title: 'A again' }, { id: 'b', title: 'B' }]);
  assert.deepEqual(out.map((i) => i.id), ['a', 'b']);
  assert.equal(out[0].title, 'A', 'the original pending entry wins');
});

test('mergePending with nothing pending returns the fresh items', () => {
  assert.deepEqual(mergePending([], [{ id: 'x' }]).map((i) => i.id), ['x']);
});

test('noteSkippedPass puts a dated "pass skipped" section directly under the digest title, once', () => {
  const digest = '# Immigration policy digest\n\n## 2026-10-04\n- Fee rule published.\n';
  const once = noteSkippedPass(digest, '2026-10-05', 'Claude Code 2.1.290 is not approved.');
  assert.equal(once, '# Immigration policy digest\n\n## 2026-10-05\n- AI policy pass skipped: Claude Code 2.1.290 is not approved.\n\n## 2026-10-04\n- Fee rule published.\n');
  assert.equal(noteSkippedPass(once, '2026-10-05', 'Claude Code 2.1.290 is not approved.'), once, 'a second skip the same day adds nothing');
  assert.equal(noteSkippedPass('', '2026-10-05', 'x.'), '# Immigration policy digest\n\n## 2026-10-05\n- AI policy pass skipped: x.\n');
  assert.equal(noteSkippedPass('## 2026-10-01\n- old\n', '2026-10-05', 'x.'), '# Immigration policy digest\n\n## 2026-10-05\n- AI policy pass skipped: x.\n\n## 2026-10-01\n- old\n');
  // The reason is one bullet: a line break in it cannot start a heading of its own.
  assert.equal(noteSkippedPass('', '2026-10-05', 'a\n## 2099-01-01 b'), '# Immigration policy digest\n\n## 2026-10-05\n- AI policy pass skipped: a ## 2099-01-01 b\n');
});

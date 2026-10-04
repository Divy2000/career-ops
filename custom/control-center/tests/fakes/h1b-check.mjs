#!/usr/bin/env node
// Test double for plugins/h1b-sponsor/check.mjs. It speaks the same argv and
// prints the same JSON envelopes, over a small synthetic employer table, so no
// test depends on the real DOL index. Pointed at by CC_H1B_CHECK_SCRIPT (only
// honored under NODE_ENV=test) or by the h1bCheckScript config override.
//
// Query names that trigger the non-happy paths:
//   "Index Missing Probe"  no local index: exit 1 with the install-the-index error envelope
//   "Exploding Corp"       backend failure: exit 1 with a different error envelope
//   "Garbage Corp"         exit 0 with text that is not JSON
//   "Mega Holdings"        --search only: a truncated list, 2 shown of 12345 matches
//
// Brand versus legal name works like the real index: "JPMorganChase" matches
// nothing, while --search "jpmorgan" lists the two legal entities.
const argv = process.argv.slice(2);
const search = argv.includes('--search');
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--cache-dir') i++;
  else if (!a.startsWith('-')) rest.push(a);
}
const name = rest.join(' ').trim();
const NOW = '2026-10-03T12:00:00.000Z';
const SOURCE = 'h1b-index:fake-2026Q3';
const NO_INDEX = 'no local H-1B index and no H1B_API_BASE. Install the index with: node plugins/h1b-sponsor/install-h1b-index.mjs (about 8 MiB of public DOL data; lookups then stay on this machine).';

const EMPLOYERS = [
  { id: '1001', name: 'Acme Robotics, Inc.', totals: { n_lca: 412, n_certified: 398, n_pwd: 31, n_perm: 22, first_year: 2019, last_year: 2026, does_gc: true }, staffing: null, tier: 'strong' },
  { id: '1002', name: 'JPMorgan Chase & Co.', totals: { n_lca: 5210, n_certified: 5101, n_pwd: 640, n_perm: 515, first_year: 2012, last_year: 2026, does_gc: true }, staffing: null, tier: 'strong' },
  { id: '1003', name: 'JPMorgan Chase Bank, N.A.', totals: { n_lca: 133, n_certified: null, n_pwd: 4, n_perm: 2, first_year: 2020, last_year: 2025, does_gc: false }, staffing: null, tier: 'moderate' },
  { id: '1005', name: 'Globex Payments Ltd.', totals: { n_lca: 64, n_certified: 60, n_pwd: 3, n_perm: 1, first_year: 2021, last_year: 2026, does_gc: true }, staffing: null, tier: 'moderate' },
  { id: '1004', name: 'Vandelay Staffing Solutions LLC', totals: { n_lca: 900, n_certified: 880, n_pwd: 0, n_perm: 0, first_year: 2016, last_year: 2026, does_gc: false }, staffing: { value: true, share: 0.82, n_secondary: 738, n_total: 900 }, tier: 'staffing-shop' },
];

const SUFFIX = /\b(inc|llc|co|corp|corporation|ltd|na)\b/g;
const normalize = (s) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function failure(message) {
  if (search) out({ query: name, total: 0, shown: 0, results: [], error: message });
  else out({ ...notFound(), error: message });
  process.exitCode = 1;
}

function notFound() {
  return {
    found: false,
    employerId: null,
    displayName: name,
    hasSponsorshipHistory: false,
    totals: { n_lca: 0, n_certified: null, n_pwd: 0, n_perm: 0, first_year: null, last_year: null, does_gc: false },
    redFlags: { staffing_shop: null },
    friendlinessTier: 'unknown',
    source: SOURCE,
    fetchedAt: NOW,
  };
}

if (!name) {
  process.stderr.write('Usage: node plugins/h1b-sponsor/check.mjs <company-name> [--json|--summary] [--search]\n');
  process.exit(2);
} else if (name === 'Index Missing Probe') {
  failure(NO_INDEX);
} else if (name === 'Exploding Corp') {
  failure('H1B API returned 503');
} else if (name === 'Garbage Corp') {
  process.stdout.write('this is not json\n');
} else if (search && name === 'Mega Holdings') {
  out({ query: name, total: 12345, shown: 2, results: [{ id: '2001', name: 'Mega Holdings One Inc.' }, { id: '2002', name: 'Mega Holdings Two Inc.' }] });
} else if (search) {
  const q = normalize(name);
  const hits = q.length < 2 ? [] : EMPLOYERS.filter((e) => normalize(e.name).includes(q));
  out({ query: name, total: hits.length, shown: hits.length, results: hits.map((e) => ({ id: e.id, name: e.name })) });
} else {
  const hit = EMPLOYERS.find((e) => normalize(e.name) === normalize(name));
  if (!hit) out(notFound());
  else {
    out({
      found: true,
      employerId: hit.id,
      displayName: hit.name,
      hasSponsorshipHistory: true,
      totals: hit.totals,
      redFlags: { staffing_shop: hit.staffing },
      friendlinessTier: hit.tier,
      source: SOURCE,
      fetchedAt: NOW,
    });
  }
}

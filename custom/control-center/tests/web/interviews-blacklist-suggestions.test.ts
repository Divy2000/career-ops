// Interviews > Rejection latency (R35-feat-b-L2-01): rejection-latency.mjs names a silent application whose employer
// cell is a placeholder by its channel, "? (via Hays)". data/blacklist.md is matched by name, so that label must not
// become an "Add to blacklist" suggestion: the row it prefills would block no real company.
import { describe, expect, it } from 'vitest';
import { companySuggestions } from '@web/features/interviews/InterviewsPage';

// The shape `node rejection-latency.mjs` prints for an agency application (company `?`, via Hays) and a named one.
const flag = (company: string) => ({
  company,
  role: 'Data Engineer',
  trackerNums: [1],
  lastInterviewDate: '2026-07-10',
  daysSinceLastInterview: 100,
  tier: 'courtesy',
  thresholdDays: 30,
  courtesyDays: 30,
  reason: '100 days post-interview silence exceeds the 30-day courtesy threshold',
  reasonCode: 'courtesy-threshold-exceeded',
  blacklistSuggestion: `| ${company} | 2026-10-18 | company | 100 days post-interview silence exceeds the 30-day courtesy threshold |`,
});
const output = (...companies: string[]) => ({ metadata: { today: '2026-10-18', courtesyDays: 30, flagged: companies.length }, flags: companies.map(flag), warnings: [] });

describe('blacklist suggestions from rejection-latency output', () => {
  it('given a flag for an unknown employer named by its channel, then it is not offered for the blacklist', () => {
    expect(companySuggestions(output('? (via Hays)', 'Acme'))).toEqual(['Acme']);
  });

  for (const placeholder of ['?', '\u2014', '-', '? (via Recruiter Co)']) {
    it(`given a company of ${JSON.stringify(placeholder)}, then it is not offered`, () => {
      expect(companySuggestions(output(placeholder))).toEqual([]);
    });
  }

  it('given named companies, including one with a question mark inside its name, then each is offered once', () => {
    expect(companySuggestions(output('Acme', 'Why? Labs', 'Acme'))).toEqual(['Acme', 'Why? Labs']);
  });
});

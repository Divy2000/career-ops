// describeError is what a page shows when a request fails. A schema refusal carries zod's issues (where and why),
// which used to be dropped, leaving only "invalid params" or "invalid body" (SW3-web-a-04).
import { describe, expect, it } from 'vitest';
import { ApiError } from '@web/lib/api';
import { describeError } from '@web/lib/actions';

const refused = (body: unknown) => new ApiError(400, '400 Bad Request', body);

describe('describeError', () => {
  it('names each refused field with the schema\'s own message', () => {
    const err = refused({ error: 'invalid params', issues: [{ code: 'custom', path: ['range'], message: 'one number (12) or one range (12-14), as reserve-report-num.mjs --release takes' }] });
    expect(describeError(err)).toBe('invalid params: range: one number (12) or one range (12-14), as reserve-report-num.mjs --release takes');
  });

  it('says which list item is wrong, and lists at most three issues', () => {
    const issue = (i: number) => ({ code: 'custom', path: ['urls', i], message: 'must be an http(s) posting URL' });
    expect(describeError(refused({ error: 'invalid body', issues: [issue(2)] }))).toBe('invalid body: urls item 3: must be an http(s) posting URL');
    expect(describeError(refused({ error: 'invalid body', issues: [0, 1, 2, 3, 4].map(issue) }))).toBe(
      'invalid body: urls item 1: must be an http(s) posting URL; urls item 2: must be an http(s) posting URL; urls item 3: must be an http(s) posting URL; and 2 more',
    );
  });

  it('a whole-body issue has no field to name', () => {
    expect(describeError(refused({ error: 'invalid body', issues: [{ code: 'invalid_type', path: [], message: 'Invalid input: expected object, received null' }] }))).toBe('invalid body: Invalid input: expected object, received null');
  });

  it('an error that already describes the issues in its own words is shown once, not followed by them again (SW3-web-a-04 review)', () => {
    const issues = [{ code: 'invalid_format', path: ['bullets', 1], message: 'one line' }, { code: 'too_big', path: ['name'], maximum: 120, origin: 'string', message: 'Too big: expected string to have <=120 characters' }];
    expect(describeError(refused({ error: 'bullet 2 must be one line; name must be at most 120 characters', issues }))).toBe('bullet 2 must be one line; name must be at most 120 characters');
  });

  it('keeps the plain error, the stderr tail and the fallbacks as they were', () => {
    expect(describeError(new ApiError(500, '500 Internal Server Error', { error: 'exited 2', stderr: 'boom\n' }))).toBe('exited 2 (boom)');
    expect(describeError(new ApiError(502, '502 Bad Gateway', null))).toBe('502 Bad Gateway');
    expect(describeError(refused({ error: 'invalid body', issues: 'not a list' }))).toBe('invalid body');
  });
});

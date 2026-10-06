import { describe, expect, it } from 'vitest';
import { describeIssues, draftFromEntry, draftProblems, emptyDraft, entryFromDraft, findRenamed, hostOf, moveItem, rebaseDraft } from '@web/features/profile/projectsDraft';
import type { ProjectView } from '@shared/api';

const entry: ProjectView = {
  id: 'event-router',
  title: 'Event Router',
  url: 'https://github.com/alex-example/event-router',
  tagline: 'Streaming backbone',
  source: null,
  tags: ['python', 'kafka'],
  kind: 'project',
  dates: '2024',
  bullets: ['One.', 'Two.'],
  line: 5,
  editProblem: null,
  inCv: false,
};

describe('project drafts', () => {
  it('round-trips an entry through the form draft, keeping the tagline and source the form does not edit', () => {
    const draft = draftFromEntry(entry);
    expect(draft).toEqual({ title: 'Event Router', url: 'https://github.com/alex-example/event-router', tags: 'python, kafka', kind: 'project', dates: '2024', bullets: ['One.', 'Two.'] });
    expect(entryFromDraft(draft, { tagline: entry.tagline, source: 'documents/projects/router.pdf' })).toEqual({ title: 'Event Router', url: 'https://github.com/alex-example/event-router', tagline: 'Streaming backbone', source: 'documents/projects/router.pdf', tags: ['python', 'kafka'], kind: 'project', dates: '2024', bullets: ['One.', 'Two.'] });
  });

  it('trims fields, drops empty tags and bullets, and sends an empty link or date as null', () => {
    const input = entryFromDraft({ title: '  Kite Tracker ', url: ' ', tags: ' rust, , go ,', kind: 'project', dates: '', bullets: [' Tracked kites. ', '   '] });
    expect(input).toEqual({ title: 'Kite Tracker', url: null, tagline: null, source: null, tags: ['rust', 'go'], kind: 'project', dates: null, bullets: ['Tracked kites.'] });
  });

  it('flags a missing title, a non-http(s) link and a project with no bullet before anything is sent', () => {
    expect(draftProblems(emptyDraft())).toEqual(['Add a title.', 'Add at least one bullet.']);
    expect(draftProblems({ ...emptyDraft(), title: 'X', url: 'javascript:alert(1)', bullets: ['a'] })).toEqual(['The link must start with http:// or https://.']);
    expect(draftProblems({ ...emptyDraft(), title: 'Paper', kind: 'publication' })).toEqual([]);
  });

  it('names a bullet that spans two lines before the server refuses it with a bare "invalid entry" (SW-web-b-03)', () => {
    expect(draftProblems({ ...emptyDraft(), title: 'X', bullets: ['One line.', 'Built X\nShipped Y', 'Also\r\nthis'] })).toEqual([
      'Bullet 2 spans more than one line; give each point its own bullet.',
      'Bullet 3 spans more than one line; give each point its own bullet.',
    ]);
    expect(draftProblems({ ...emptyDraft(), title: 'X', bullets: ['  Trailing newline only.\n'] })).toEqual([]);
  });

  it('names a field over the library\'s limits (routes/projects.ts) before the server refuses it with a bare "invalid entry" (SW-web-b-11)', () => {
    const ok = { ...emptyDraft(), title: 'X', bullets: ['a'] };
    expect(draftProblems({ ...ok, title: 'T'.repeat(300) })).toEqual([]);
    expect(draftProblems({ ...ok, title: 'T'.repeat(301) })).toEqual(['The title is longer than 300 characters.']);
    expect(draftProblems({ ...ok, tags: `${'k'.repeat(60)}, ${'langchain-community-0.3.x-'.repeat(3)}` })).toEqual(['Tag 2 is longer than 60 characters.']);
    expect(draftProblems({ ...ok, tags: Array.from({ length: 31 }, (_, i) => `t${i}`).join(',') })).toEqual(['Use at most 30 tags.']);
    expect(draftProblems({ ...ok, dates: 'd'.repeat(101) })).toEqual(['The dates are longer than 100 characters.']);
    expect(draftProblems({ ...ok, url: `https://e.com/${'p'.repeat(2048)}` })).toEqual(['The link is longer than 2048 characters.']);
    expect(draftProblems({ ...ok, bullets: Array.from({ length: 21 }, (_, i) => `b${i}`) })).toEqual(['Use at most 20 bullets.']);
    expect(draftProblems({ ...ok, bullets: ['a', 'b'.repeat(2001)] })).toEqual(['Bullet 2 is longer than 2000 characters.']);
  });

  it('names the fields of a 400 the server sends anyway, by the labels the form uses', () => {
    const issues = [
      { path: ['tags', 1], message: 'Too big: expected string to have <=60 characters' },
      { path: ['bullets', 0], message: 'one line' },
      { path: ['title'], message: 'Too big: expected string to have <=300 characters' },
      { path: ['kind'], message: 'Invalid option' },
    ];
    expect(describeIssues(issues)).toEqual(['Tag 2: Too big: expected string to have <=60 characters', 'Bullet 1: one line', 'Title: Too big: expected string to have <=300 characters', 'kind: Invalid option']);
    expect(describeIssues(undefined)).toEqual([]);
  });

  it('rebases a draft on the version on disk after a conflict: fields only the other writer changed are taken in (SW2-tests-01)', () => {
    const base = draftFromEntry(entry);
    const draft = { ...base, title: 'Event Router v2' };
    const current = { ...base, bullets: ['One.', 'Two.', 'Added elsewhere.'], tags: 'python, kafka, go' };
    expect(rebaseDraft(base, draft, current)).toEqual({ draft: { ...current, title: 'Event Router v2' }, conflicts: [] });
  });

  it('keeps the draft where both sides changed a field, and names that field', () => {
    const base = draftFromEntry(entry);
    const draft = { ...base, bullets: ['One, reworded.', 'Two.'] };
    const current = { ...base, bullets: ['One.', 'Two.', 'Added elsewhere.'] };
    expect(rebaseDraft(base, draft, current)).toEqual({ draft, conflicts: ['bullets'] });
    // The same change on both sides is no conflict.
    expect(rebaseDraft(base, { ...base, title: 'Same' }, { ...base, title: 'Same' })).toEqual({ draft: { ...base, title: 'Same' }, conflicts: [] });
  });

  it('finds an entry another writer renamed: a new id with the same bullets, or a new id at the same position', () => {
    const e = (id: string, bullets: string[]) => ({ id, bullets });
    const origin = { ids: ['a', 'b', 'c'], index: 1, bullets: ['B one.'] };
    // Same bullets under a new id.
    expect(findRenamed(origin, [e('a', ['A.']), e('c', ['C.']), e('b-renamed', ['B one.'])])?.id).toBe('b-renamed');
    // Bullets changed too, but a new id sits where the entry was, the library kept its size, and a bullet is still there.
    expect(findRenamed(origin, [e('a', ['A.']), e('b2', ['B one.', 'B two.']), e('c', ['C.'])])?.id).toBe('b2');
    // A new id at its position with nothing in common is a removal plus an addition, not a rename.
    expect(findRenamed(origin, [e('a', ['A.']), e('kites', ['Kites.']), e('c', ['C.'])])).toBeNull();
    // Removed: one entry fewer, nothing with its bullets.
    expect(findRenamed(origin, [e('a', ['A.']), e('c', ['C.'])])).toBeNull();
    // An article with no bullets, removed while an unrelated bullet-less one was added: no bullets prove nothing.
    const article = { ids: ['a', 'paper'], index: 1, bullets: [] };
    expect(findRenamed(article, [e('a', ['A.']), e('other-paper', [])])).toBeNull();
    expect(findRenamed(article, [e('other-paper', []), e('a', ['A.'])])).toBeNull();
    // Two new entries with its bullets is no proof of which one it became.
    expect(findRenamed(origin, [e('a', ['A.']), e('x', ['B one.']), e('y', ['B one.']), e('c', ['C.'])])).toBeNull();
  });

  it('moves a bullet up or down and ignores moves past either end', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 3)).toEqual(['a', 'b', 'c']);
  });

  it('shows a link by its host without www', () => {
    expect(hostOf('https://www.github.com/a/b')).toBe('github.com');
    expect(hostOf(null)).toBeNull();
    expect(hostOf('not a url')).toBeNull();
  });
});

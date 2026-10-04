import { describe, expect, it } from 'vitest';
import { draftFromEntry, draftProblems, emptyDraft, entryFromDraft, hostOf, moveItem } from '@web/features/profile/projectsDraft';
import type { ProjectView } from '@shared/api';

const entry: ProjectView = {
  id: 'event-router',
  title: 'Event Router',
  url: 'https://github.com/alex-example/event-router',
  tagline: 'Streaming backbone',
  tags: ['python', 'kafka'],
  kind: 'project',
  dates: '2024',
  bullets: ['One.', 'Two.'],
  line: 5,
  inCv: false,
};

describe('project drafts', () => {
  it('round-trips an entry through the form draft, keeping the tagline the form does not edit', () => {
    const draft = draftFromEntry(entry);
    expect(draft).toEqual({ title: 'Event Router', url: 'https://github.com/alex-example/event-router', tags: 'python, kafka', kind: 'project', dates: '2024', bullets: ['One.', 'Two.'] });
    expect(entryFromDraft(draft, entry.tagline)).toEqual({ title: 'Event Router', url: 'https://github.com/alex-example/event-router', tagline: 'Streaming backbone', tags: ['python', 'kafka'], kind: 'project', dates: '2024', bullets: ['One.', 'Two.'] });
  });

  it('trims fields, drops empty tags and bullets, and sends an empty link or date as null', () => {
    const input = entryFromDraft({ title: '  Kite Tracker ', url: ' ', tags: ' rust, , go ,', kind: 'project', dates: '', bullets: [' Tracked kites. ', '   '] });
    expect(input).toEqual({ title: 'Kite Tracker', url: null, tagline: null, tags: ['rust', 'go'], kind: 'project', dates: null, bullets: ['Tracked kites.'] });
  });

  it('flags a missing title, a non-http(s) link and a project with no bullet before anything is sent', () => {
    expect(draftProblems(emptyDraft())).toEqual(['Add a title.', 'Add at least one bullet.']);
    expect(draftProblems({ ...emptyDraft(), title: 'X', url: 'javascript:alert(1)', bullets: ['a'] })).toEqual(['The link must start with http:// or https://.']);
    expect(draftProblems({ ...emptyDraft(), title: 'Paper', kind: 'publication' })).toEqual([]);
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

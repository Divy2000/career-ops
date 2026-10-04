import { describe, expect, it } from 'vitest';
import { inside } from '../../server/lib/paths.js';

describe('inside', () => {
  it('accepts a strict descendant of a normal root', () => {
    expect(inside('/a/b', '/a/b/c')).toBe(true);
    expect(inside('/a/b', '/a/b/c/d.mp4')).toBe(true);
  });

  it('accepts any path below the filesystem root', () => {
    expect(inside('/', '/tutorials/one/video.mp4')).toBe(true);
    expect(inside('/', '/x')).toBe(true);
  });

  it('rejects a sibling that only shares a name prefix', () => {
    expect(inside('/a/b', '/a/bc')).toBe(false);
    expect(inside('/a/b', '/a/bc/d')).toBe(false);
  });

  it('rejects the root itself, including the filesystem root', () => {
    expect(inside('/a/b', '/a/b')).toBe(false);
    expect(inside('/', '/')).toBe(false);
  });

  it('rejects paths that escape the root through the parent', () => {
    expect(inside('/a/b', '/a')).toBe(false);
    expect(inside('/a/b', '/a/b/../c')).toBe(false);
    expect(inside('/a/b', '/')).toBe(false);
  });

  it('accepts a child whose name merely starts with two dots', () => {
    expect(inside('/a/b', '/a/b/..hidden')).toBe(true);
  });
});

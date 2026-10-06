// Dev Chat reopens the tab's last session from sessionStorage; deleting that session on the Sessions page forgets it,
// so a plain /dev does not reopen a session that is gone (SW3-web-b-03 review).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetDevSession, readLastDevSession, writeLastDevSession } from '@web/lib/devchatSession';

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('the last Dev Chat session', () => {
  it('forgets the stored session when that session is deleted, and only that one', () => {
    writeLastDevSession('s-1');
    forgetDevSession('s-2');
    expect(readLastDevSession()).toBe('s-1');
    forgetDevSession('s-1');
    expect(readLastDevSession()).toBeNull();
  });

  it('ignores a stored value that is not a session id, and a storage that throws', () => {
    sessionStorage.setItem('cc.devchat.session', '../x');
    expect(readLastDevSession()).toBeNull();
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } });
    expect(readLastDevSession()).toBeNull();
    expect(() => writeLastDevSession('s-1')).not.toThrow();
  });
});

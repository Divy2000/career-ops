// Follow-ups > history: followup-cadence.mjs lists legacy bullet follow-ups (`- date · #N Company`) with num null.
// They have no row to delete by number, so they get no Delete button; table rows keep theirs.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { FollowupEntry } from '@shared/api';
import { FollowupHistory } from '@web/features/followups/FollowupsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('follow-up history', () => {
  it('lists a legacy bullet follow-up without a Delete button, and deletes a table row by its number', async () => {
    const deleted: number[] = [];
    const followups: FollowupEntry[] = [
      { num: 4, appNum: 1, date: '2026-09-28', company: 'Acme', role: 'Eng', channel: 'Email', contact: 'Pat', notes: 'asked' },
      { num: null, appNum: 1, date: '2026-10-02', company: 'Acme', role: '', channel: 'Other', contact: '', notes: 'nudged' },
    ];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(FollowupHistory, { company: 'Acme', followups, onDelete: (n: number) => deleted.push(n) })));
    const items = [...host.querySelectorAll('li')];
    expect(items.map((li) => li.textContent?.includes('2026-10-02'))).toEqual([false, true]);
    expect(items[1]!.querySelector('button')).toBeNull();
    await act(async () => items[0]!.querySelector('button')!.click());
    expect(deleted).toEqual([4]);
  });
});

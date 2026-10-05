// Follow-ups > Log follow-up: the route appends every request it gets, and two entries can retire an application as
// cold (applied_max_followups), so a double click on Save must log once (SW-web-a-15).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowupCadenceEntry } from '@shared/api';
import { LogForm } from '@web/features/followups/FollowupsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY: FollowupCadenceEntry = {
  num: 1, company: 'Acme Robotics', role: 'Senior Backend Engineer', status: 'Applied', score: '4.3/5', appliedDate: '2026-09-20', daysSinceApplication: 15,
  daysSinceLastFollowup: 7, followupCount: 1, urgency: 'overdue', nextFollowupDate: '2026-10-01', daysUntilNext: -4, nextOverride: null, contacts: [], followups: [],
};

let host: HTMLElement;
let root: Root;
let posts: number;
let answer: (r: Response) => void;
let done: string[];

beforeEach(async () => {
  posts = 0;
  done = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      posts++;
      return new Promise<Response>((resolve) => (answer = resolve));
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(LogForm, { entry: ENTRY, onDone: (m: string) => void done.push(m) })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const save = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save follow-up')!;

describe('Log follow-up', () => {
  it('a second click while the first save is in flight logs nothing more', async () => {
    await act(async () => save().click());
    await act(async () => save().click());
    expect(posts).toBe(1);
    expect(save().disabled).toBe(true);
    await act(async () => answer(new Response(JSON.stringify({ ok: true, num: 3 }), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(done).toEqual(['Logged follow-up #3 for Acme Robotics']);
  });

  it('a failed save can be retried', async () => {
    await act(async () => save().click());
    await act(async () => answer(new Response(JSON.stringify({ error: 'follow-ups are busy' }), { status: 409, headers: { 'content-type': 'application/json' } })));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('follow-ups are busy');
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    expect(posts).toBe(2);
  });
});

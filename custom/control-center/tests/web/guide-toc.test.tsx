import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuideContentsSelect, GuideToc } from '../../web/features/tutorials/guide/GuideToc';
import type { GuideLocation } from '../../web/lib/guide';
import type { GuideDocs, GuideSubsectionView } from '../../shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sub = (id: string, title: string, short = title): GuideSubsectionView => ({ id, title, short, summary: '', route: null, chapter: null, blocks: [{ type: 'text', text: 'x' }] });

const docs: GuideDocs = {
  version: 2,
  legacy: false,
  sections: [
    { id: 'start', title: 'Getting started', short: 'Basics', summary: 's', subsections: [sub('launch', 'Launch and sign in', 'Launch & login'), sub('layout', 'Find your way around', 'Layout')] },
    { id: 'track', title: 'Tracking applications', short: 'Track', summary: 's', subsections: [sub('status', 'Change a status', 'Status'), sub('follow', 'Follow-ups and replies', 'Follow-ups')] },
  ],
};

const legacy: GuideDocs = {
  version: 1,
  legacy: true,
  sections: [
    { id: 'today', title: 'Today', short: 'Today', summary: 's', subsections: [sub('today', 'Today')] },
    { id: 'tracker', title: 'Tracker', short: 'Tracker', summary: 's', subsections: [sub('tracker', 'Tracker')] },
  ],
};

let host: HTMLElement;
let root: Root;
let onGo: ReturnType<typeof vi.fn<(loc: GuideLocation) => void>>;

const at = (sectionId: string, subId: string | null = null): GuideLocation => ({ sectionId, subId });

async function render(loc: GuideLocation, opts: { guide?: GuideDocs; reviewed?: string[] } = {}) {
  await act(async () =>
    root.render(createElement(GuideToc, { docs: opts.guide ?? docs, loc, reviewed: new Set(opts.reviewed ?? []), hrefFor: (l: GuideLocation) => `/tutorials?section=${l.sectionId}${l.subId ? `&sub=${l.subId}` : ''}`, onGo })),
  );
}

const toggle = (sectionId: string) => host.querySelector<HTMLButtonElement>(`button[aria-controls="guide-toc-subs-${sectionId}"]`);
const subList = (sectionId: string) => host.querySelector<HTMLOListElement>(`#guide-toc-subs-${sectionId}`)!;
const subLink = (text: string) => [...host.querySelectorAll<HTMLAnchorElement>('a.guide-toc__sub')].find((a) => a.querySelector('.guide-toc__sub-title')?.textContent === text)!;
const sectionLink = (sectionId: string) => host.querySelector<HTMLAnchorElement>(`a.guide-toc__section[href="/tutorials?section=${sectionId}"]`)!;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onGo = vi.fn<(loc: GuideLocation) => void>();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('GuideToc rows', () => {
  it('shows the short label of each section and subsection, with the full title as a tooltip', async () => {
    await render(at('start', 'launch'));
    expect(sectionLink('start').querySelector('.guide-toc__title')!.textContent).toBe('Basics');
    expect(sectionLink('start').title).toBe('Getting started');
    expect(subLink('Launch & login').title).toBe('Launch and sign in');
  });

  it('names each row by its visible label first, so the accessible name contains what is on screen', async () => {
    await render(at('start', 'launch'));
    expect(sectionLink('start').textContent).toMatch(/^Basics, 0 of 2 reviewed$/);
    expect(subLink('Layout').textContent).toBe('Layout');
  });
});

describe('GuideToc expand rule', () => {
  it('given the reader is in section B, when the contents render, then only B is open and A shows aria-expanded=false', async () => {
    await render(at('track', 'status'));
    expect(subList('track').hidden).toBe(false);
    expect(subList('start').hidden).toBe(true);
    expect(toggle('start')!.getAttribute('aria-expanded')).toBe('false');
    expect(toggle('track')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('given A is collapsed, when its chevron is clicked, then A opens and nothing navigates', async () => {
    await render(at('track', 'status'));
    await act(async () => toggle('start')!.click());
    expect(subList('start').hidden).toBe(false);
    expect(toggle('start')!.getAttribute('aria-expanded')).toBe('true');
    expect(subList('track').hidden).toBe(false);
    expect(onGo).not.toHaveBeenCalled();
  });

  it('given a section is open, when its chevron is clicked, then it closes, even the section being read', async () => {
    await render(at('track', 'status'));
    await act(async () => toggle('track')!.click());
    expect(subList('track').hidden).toBe(true);
    expect(toggle('track')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('given the reader moves from the last subsection of A to B (as J does), when the location changes, then B opens and A closes', async () => {
    await render(at('start', 'layout'));
    expect(subList('start').hidden).toBe(false);
    await render(at('track', 'status'));
    expect(subList('track').hidden).toBe(false);
    expect(subList('start').hidden).toBe(true);
  });

  it('given another section was opened by hand, when the reader moves to a third place, then only the new section stays open', async () => {
    await render(at('start', 'launch'));
    await act(async () => toggle('track')!.click());
    await render(at('track', 'follow'));
    expect(subList('start').hidden).toBe(true);
    expect(subList('track').hidden).toBe(false);
  });

  it('given a move inside the same section, when the location changes, then a section opened by hand stays open', async () => {
    await render(at('start', 'launch'));
    await act(async () => toggle('track')!.click());
    await render(at('start', 'layout'));
    expect(subList('track').hidden).toBe(false);
  });

  it('given a version 1 guide, when rendered, then no row has a toggle and no subsection list is drawn', async () => {
    await render(at('today'), { guide: legacy });
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.querySelectorAll('a.guide-toc__sub')).toHaveLength(0);
  });
});

describe('GuideToc ticks', () => {
  it('given a reviewed subsection, when rendered, then it shows a check and the text ", reviewed"', async () => {
    await render(at('start', 'launch'), { reviewed: ['start/launch'] });
    const link = subLink('Launch & login');
    expect(link.querySelector('.guide-toc__tick')!.getAttribute('data-reviewed')).toBe('true');
    expect(link.textContent).toBe('Launch & login, reviewed');
  });

  it('given an unreviewed subsection, when rendered, then it shows an empty tick and no reviewed text', async () => {
    await render(at('start', 'launch'), { reviewed: ['start/launch'] });
    const link = subLink('Layout');
    expect(link.querySelector('.guide-toc__tick')!.getAttribute('data-reviewed')).toBe('false');
    expect(link.textContent).toBe('Layout');
  });

  it('puts the tick first in the row, before the label', async () => {
    await render(at('start', 'launch'));
    expect(subLink('Layout').firstElementChild!.classList.contains('guide-toc__tick')).toBe(true);
  });
});

describe('GuideContentsSelect (phone)', () => {
  it('uses the short labels for the groups and the options', async () => {
    await act(async () => root.render(createElement(GuideContentsSelect, { docs, loc: at('start', 'launch'), reviewed: new Set(['start/layout']), onGo })));
    expect([...host.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Basics', 'Track']);
    expect([...host.querySelectorAll('optgroup')[0]!.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Overview', 'Launch & login', 'Layout (reviewed)']);
  });
});

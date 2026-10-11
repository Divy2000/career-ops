import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Md } from '@web/components/Md';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT = 'See [row 12](/tracker/12), [elsewhere](//other.example/x), [the report](reports/012-acme.md) and [mail](mailto:pat@example.com).';

let host: HTMLElement;
let root: Root;
let router: ReturnType<typeof createRouter>;

beforeEach(async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const today = createRoute({ getParentRoute: () => rootRoute, path: '/today', component: () => createElement(Md, { text: TEXT }) });
  const row = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: () => null });
  router = createRouter({ routeTree: rootRoute.addChildren([today, row]), history: createMemoryHistory({ initialEntries: ['/today'] }) });
  await act(async () => root.render(createElement(RouterProvider, { router })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const link = (name: string) => [...host.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.textContent === name)!;
const click = async (a: HTMLAnchorElement, init: MouseEventInit = {}) => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  await act(async () => void a.dispatchEvent(event));
  return event;
};

describe('links in rendered markdown keep the app and its in-memory state (R21-shared-comp-L3-01)', () => {
  it('an app path navigates inside the app, without a full page load', async () => {
    const event = await click(link('row 12'));
    expect(event.defaultPrevented).toBe(true);
    expect(router.state.location.pathname).toBe('/tracker/12');
  });

  it('a modified click on an app path is left to the browser (open in a new tab)', async () => {
    const event = await click(link('row 12'), { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(router.state.location.pathname).toBe('/today');
  });

  it('a protocol-relative link leaves the app in a new tab', () => {
    const a = link('elsewhere');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('a relative link, which no app route stands for, opens in a new tab', () => {
    const a = link('the report');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('a mail link stays as written', () => {
    expect(link('mail').getAttribute('target')).toBeNull();
  });
});

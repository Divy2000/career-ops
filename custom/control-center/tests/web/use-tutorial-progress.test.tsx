import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTutorialProgress } from '../../web/features/tutorials/useTutorialProgress';
import { savePartProgress, type PartProgress, type TutorialProgress } from '../../web/lib/tutorial-progress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useTutorialProgress>;
let host: HTMLElement;
let root: Root;
let latest: Hook;

function Harness({ id }: { id: string }) {
  latest = useTutorialProgress(id);
  return null;
}
const render = (id: string) => act(async () => root.render(createElement(Harness, { id })));
const progress = (): TutorialProgress => latest.progress;
const at = (seconds: number): PartProgress => ({ at: seconds, max: seconds, done: false });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
});

describe('useTutorialProgress', () => {
  it('reads the stored progress of the tutorial it is given', async () => {
    savePartProgress('a', 'main', at(40));
    await render('a');
    expect(progress()).toEqual({ main: at(40) });
  });

  it('records a save of the tutorial on screen', async () => {
    await render('a');
    await act(async () => latest.record('a', 'main', at(12)));
    expect(progress()).toEqual({ main: at(12) });
  });

  it('given the page moved from tutorial A to B, when the player of A saves on its way out, then B does not show it', async () => {
    savePartProgress('b', 'main', at(5));
    await render('a');
    const recordOfA = latest.record;
    await render('b');
    await act(async () => recordOfA('a', 'main', at(99)));
    expect(progress()).toEqual({ main: at(5) });
  });
});

// A registry action with a confirm text (tracker.delete, portals.fixSlugs, system.updateApply, system.rollback,
// daily.runNow, devchat.installDeps) runs only after the user confirms it, and the run carries confirmed: true, which
// the action route requires for those actions (428 without it) (SW2-tests-06).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionButton } from '@web/components/ActionBar';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import type { ActionMeta } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const meta = (confirm: string | null): ActionMeta => ({ id: 'daily.runNow', label: 'Run the daily job now', cost: 'tokens', confirm, resources: [], claude: true, sync: false, params: {} });
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const press = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};
const inDialog = (name: string) => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;

async function render(confirm: string | null) {
  const onRun = vi.fn();
  await act(async () => root.render(createElement(ConfirmProvider, null, createElement(ActionButton, { meta: meta(confirm), onRun, params: { dryRun: false } }))));
  return { onRun, button: host.querySelector('button')! };
}

describe('ActionButton with a confirm text', () => {
  it('given the user cancels the confirm, then the action does not run', async () => {
    const { onRun, button } = await render('Runs the full daily job. Continue?');
    await press(button);
    expect(dialog()?.textContent).toContain('Runs the full daily job. Continue?');
    await press(inDialog('Cancel'));
    expect(dialog()).toBeNull();
    expect(onRun).not.toHaveBeenCalled();
  });

  it('given the user confirms, then the action runs once with its params, marked confirmed', async () => {
    const { onRun, button } = await render('Runs the full daily job. Continue?');
    await press(button);
    expect(inDialog('Run').className).toContain('button--danger');
    await press(inDialog('Run'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith({ dryRun: false }, { confirmed: true });
  });

  it('given no confirm text, then a click runs the action without asking', async () => {
    const { onRun, button } = await render(null);
    await press(button);
    expect(dialog()).toBeNull();
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith({ dryRun: false }, { confirmed: false });
  });
});

describe('ActionButton while its run is in flight (R27-shared-comp-X-01)', () => {
  async function renderPending() {
    const releases: Array<(ok: boolean) => void> = [];
    const onRun = vi.fn(() => new Promise<void>((resolve, reject) => releases.push((ok) => (ok ? resolve() : reject(new Error('refused'))))));
    await act(async () => root.render(createElement(ConfirmProvider, null, createElement(ActionButton, { meta: meta(null), onRun }))));
    return { onRun, releases, button: host.querySelector('button')! };
  }

  it('given the run has not settled, then a second click does not start it again', async () => {
    const { onRun, button } = await renderPending();
    await press(button);
    await press(button);
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('given the run has not settled, then the button shows it is busy until it does', async () => {
    const { releases, button } = await renderPending();
    await press(button);
    expect(button.disabled).toBe(true);
    await act(async () => releases[0]!(true));
    await settle();
    expect(button.disabled).toBe(false);
  });

  it('given the disabled button lost focus to the page during its run, then focus is back on it once the run settles', async () => {
    const { releases, button } = await renderPending();
    button.focus();
    await press(button);
    // A browser moves focus off a focused button that becomes disabled; jsdom does not (and ignores blur() on one), so
    // the test drops focus to the page through an element that goes away.
    const gone = document.createElement('input');
    document.body.append(gone);
    gone.focus();
    gone.remove();
    expect(document.activeElement).toBe(document.body);
    await act(async () => releases[0]!(true));
    await settle();
    expect(document.activeElement).toBe(button);
  });

  it('given the user moved focus elsewhere during the run, then the settled run leaves it there', async () => {
    const { releases, button } = await renderPending();
    const other = document.createElement('input');
    document.body.append(other);
    try {
      button.focus();
      await press(button);
      other.focus();
      await act(async () => releases[0]!(true));
      await settle();
      expect(document.activeElement).toBe(other);
    } finally {
      other.remove();
    }
  });

  it('given the run settled, then the next click starts it again', async () => {
    const { onRun, releases, button } = await renderPending();
    await press(button);
    await act(async () => releases[0]!(true));
    await press(button);
    expect(onRun).toHaveBeenCalledTimes(2);
  });

  it('given the run failed, then the failure is logged and the next click starts it again', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { onRun, releases, button } = await renderPending();
    await press(button);
    await act(async () => releases[0]!(false));
    await settle();
    expect(logged).toHaveBeenCalledWith('daily.runNow failed:', expect.objectContaining({ message: 'refused' }));
    logged.mockRestore();
    await press(button);
    expect(onRun).toHaveBeenCalledTimes(2);
  });
});

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

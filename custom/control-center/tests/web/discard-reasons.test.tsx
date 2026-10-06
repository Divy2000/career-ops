// Reports carry discard reasons as the writer's codes (batch-prompt.md: salary_too_low, seniority_mismatch, ...). The
// pages show them as words; the Skip and Discard picker offers them, and the TUI's own list of codes, as words but
// records the code, as the TUI does, so analyze-patterns counts one reason under one key (SW4-tests-16).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrackerRow } from '@shared/api';
import { DISCARD_REASONS, DiscardReasonPicker } from '@web/features/tracker/StatusControl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const ROW = { num: 4, company: 'Initech Cloud', summary: { discardReasons: ['salary_too_low', 'staffing_agency'] } } as unknown as TrackerRow;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('discard reason picker', () => {
  it('offers the predicted reasons as words, once each, and records the code', async () => {
    const notes: string[] = [];
    await act(async () => root.render(createElement(DiscardReasonPicker, { state: 'SKIP', row: ROW, busy: false, onConfirm: (n: string) => void notes.push(n), onCancel: () => undefined })));
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Discard reason"]')!;
    const options = [...select.options].map((o) => o.textContent);
    expect(options.slice(1, 3)).toEqual(['salary too low', 'staffing agency']);
    expect(options.filter((o) => o === 'staffing agency')).toHaveLength(1);
    expect(options.some((o) => o?.includes('_'))).toBe(false);
    expect([...select.options].find((o) => o.textContent === 'staffing agency')!.value).toBe('staffing_agency');
    await act(async () => {
      select.value = [...select.options].find((o) => o.textContent === 'salary too low')!.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Confirm'))!.click());
    expect(notes).toEqual(['DISCARD: salary_too_low']);
  });

  it('offers exactly the TUI picker\'s reason codes, so both write the same keys', () => {
    const go = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../dashboard/internal/ui/screens/pipeline.go'), 'utf8');
    const block = /canonicalDiscardReasons = \[\]string\{([^}]*)\}/.exec(go)?.[1];
    expect(block, 'canonicalDiscardReasons in pipeline.go').toBeDefined();
    const tui = [...block!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(tui.length).toBeGreaterThan(0);
    expect(DISCARD_REASONS).toEqual(tui);
  });

  it('shows a listed code as words and records the code', async () => {
    const notes: string[] = [];
    const row = { num: 9, company: 'Plain Co', summary: null } as unknown as TrackerRow;
    await act(async () => root.render(createElement(DiscardReasonPicker, { state: 'Discarded', row, busy: false, onConfirm: (n: string) => void notes.push(n), onCancel: () => undefined })));
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Discard reason"]')!;
    const option = [...select.options].find((o) => o.textContent === 'seniority mismatch')!;
    expect(option.value).toBe('seniority_mismatch');
    await act(async () => {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Confirm'))!.click());
    expect(notes).toEqual(['DISCARD: seniority_mismatch']);
  });
});

// Interviews > Story provenance: lowConfidence is a diagnosis ({reason, message}) or null, not a list of claims, so it
// shows as a note saying the result is inconclusive, and not as a claim count (R13-feat-b-L2-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ProvenancePills } from '@web/features/interviews/InterviewsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(json: unknown) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ProvenancePills, { json })));
}

describe('story provenance pills', () => {
  it('a conclusive run counts the four claim lists and shows no lowConfidence pill', async () => {
    await render({ existing: [{}], supportedByResume: [{}, {}], derivedUnverified: [], userCannotConfirm: [], lowConfidence: null });
    expect(host.textContent).toContain('supportedByResume: 2');
    expect(host.textContent).not.toContain('lowConfidence');
    expect(host.textContent).not.toContain('null');
  });

  it('an inconclusive run says why nothing could be checked, instead of a count', async () => {
    await render({ existing: [], supportedByResume: [], derivedUnverified: [], userCannotConfirm: [], lowConfidence: { reason: 'no-story-bank', message: 'interview-prep/story-bank.md not found, nothing was checked.' } });
    expect(host.textContent).toContain('Low confidence: interview-prep/story-bank.md not found, nothing was checked.');
    expect(host.textContent).not.toContain('lowConfidence: 2');
  });
});

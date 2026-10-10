import { describe, expect, it } from 'vitest';
import { ASK_ACTION_SPECS } from '../../shared/ask-actions.js';

describe('the advisor action contract', () => {
  it('names the exact statuses tracker.setStatus accepts, not the lowercase states.yml ids (R17-shared-comp-L2-02)', () => {
    const setStatus = ASK_ACTION_SPECS.find((a) => a.name === 'setStatus')!;
    const state = setStatus.params.find((p) => p.name === 'state')!;
    // The server action's zod enum is exact-case: it accepts only these labels, not the states.yml ids or aliases.
    for (const label of ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP']) {
      expect(state.about, label).toContain(label);
    }
  });
});

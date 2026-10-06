// Settings > Profile > Add location inserts this skeleton as is. needs_sponsorship: false tells modes/oferta.md that
// sponsorship is "Not needed", which hides a JD's "we do not sponsor" hard blocker, and tells the daily policy pass
// to stop assuming the user needs H-1B sponsorship. Of the values upstream reads, only true means "needs
// sponsorship" everywhere (config/profile.example.yml documents an omitted key as false), so the skeleton starts at
// true and the user unticks it if it does not apply (SW-web-b-09).
import { describe, expect, it } from 'vitest';
import { PROFILE_SECTIONS } from '@web/features/settings/ProfileForm';

describe('the location skeleton', () => {
  it('starts with needs_sponsorship true, never a false the user did not choose', () => {
    const location = PROFILE_SECTIONS.find((s) => s.key === 'location')!.empty as Record<string, unknown>;
    expect(location.needs_sponsorship).toBe(true);
  });
});

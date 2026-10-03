import { describe, expect, it } from 'vitest';
import { groupQuickActions } from '../../web/features/runs/quickActions';

const a = (id: string, label = id) => ({ id, label });

describe('groupQuickActions', () => {
  it('groups actions by the category of their id prefix, in a fixed category order', () => {
    const groups = groupQuickActions([a('insights.funnelVelocity', 'Funnel velocity'), a('scan.hn', 'Scan Hacker News hiring'), a('tracker.verify', 'Verify tracker'), a('insights.salaryGap', 'Salary gap'), a('pipeline.prioritize', 'Prioritize pipeline')]);
    expect(groups.map((g) => [g.label, g.actions.map((x) => x.id)])).toEqual([
      ['Tracker and pipeline', ['tracker.verify', 'pipeline.prioritize']],
      ['Scans', ['scan.hn']],
      ['Insights', ['insights.funnelVelocity', 'insights.salaryGap']],
    ]);
  });

  it('puts portals with scans and plugins with system', () => {
    const groups = groupQuickActions([a('plugins.audit'), a('portals.verify')]);
    expect(groups.map((g) => g.label)).toEqual(['Scans', 'System']);
  });

  it('keeps an unknown prefix in its own titled group after the known ones', () => {
    const groups = groupQuickActions([a('weird.thing'), a('scan.hn')]);
    expect(groups.map((g) => g.label)).toEqual(['Scans', 'Weird']);
  });

  it('returns nothing for no actions', () => {
    expect(groupQuickActions([])).toEqual([]);
  });
});

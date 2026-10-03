const CATEGORIES: Array<{ label: string; prefixes: string[] }> = [
  { label: 'Tracker and pipeline', prefixes: ['tracker', 'pipeline'] },
  { label: 'Scans', prefixes: ['scan', 'portals'] },
  { label: 'Insights', prefixes: ['insights'] },
  { label: 'Follow-ups', prefixes: ['followups'] },
  { label: 'System', prefixes: ['system', 'plugins', 'docs', 'daily'] },
];

export interface ActionGroup<T> {
  label: string;
  actions: T[];
}

/** Groups one-click actions by the prefix of their id so the Runs header is not a wall of buttons. */
export function groupQuickActions<T extends { id: string }>(actions: T[]): Array<ActionGroup<T>> {
  const groups: Array<ActionGroup<T>> = CATEGORIES.map((c) => ({ label: c.label, actions: [] }));
  const extra = new Map<string, ActionGroup<T>>();
  for (const action of actions) {
    const prefix = action.id.split('.')[0]!;
    const known = CATEGORIES.findIndex((c) => c.prefixes.includes(prefix));
    if (known >= 0) {
      groups[known]!.actions.push(action);
      continue;
    }
    const label = prefix.charAt(0).toUpperCase() + prefix.slice(1);
    const group = extra.get(label) ?? { label, actions: [] };
    group.actions.push(action);
    extra.set(label, group);
  }
  return [...groups, ...extra.values()].filter((g) => g.actions.length > 0);
}

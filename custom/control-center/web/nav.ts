export interface NavItem {
  to: string;
  label: string;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Work',
    items: [
      { to: '/', label: 'Today' },
      { to: '/pipeline', label: 'Pipeline' },
      { to: '/tracker', label: 'Tracker' },
      { to: '/apply', label: 'Apply' },
      { to: '/followups', label: 'Follow-ups' },
      { to: '/interviews', label: 'Interviews' },
    ],
  },
  {
    label: 'Intel',
    items: [
      { to: '/discover', label: 'Discover' },
      { to: '/sponsorship', label: 'Sponsorship' },
      { to: '/insights', label: 'Insights' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/sessions', label: 'Sessions' },
      { to: '/runs', label: 'Runs & Schedule' },
      { to: '/profile', label: 'Profile & CV' },
      { to: '/settings', label: 'Settings' },
      { to: '/dev', label: 'Dev Chat' },
      { to: '/tutorials', label: 'Tutorials' },
    ],
  },
];

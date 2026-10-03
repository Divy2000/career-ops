import { createRootRoute, createRoute, createRouter, type SearchSchemaInput } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { TodayPage } from './features/today/TodayPage';
import { TrackerPage, type TrackerSearch, type TrackerTab, type SortKey } from './features/tracker/TrackerPage';
import { ApplicationPage } from './features/tracker/ApplicationPage';
import { PipelinePage, type PipelineTab } from './features/pipeline/PipelinePage';
import { SponsorshipPage, type SponsorshipTab } from './features/sponsorship/SponsorshipPage';
import { InsightsPage, type InsightsTab } from './features/insights/InsightsPage';
import { FollowupsPage } from './features/followups/FollowupsPage';
import { RunsPage } from './features/runs/RunsPage';
import { DiscoverPage, type DiscoverTab } from './features/discover/DiscoverPage';
import { PlaceholderPage } from './components/PlaceholderPage';

const rootRoute = createRootRoute({ component: Shell });

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Search params are optional on links and always normalized on read. */
type Loose = Record<string, unknown> & SearchSchemaInput;

function placeholder<const P extends string>(path: P, title: string) {
  return createRoute({ getParentRoute: () => rootRoute, path, component: () => <PlaceholderPage title={title} /> });
}

const TRACKER_TABS: TrackerTab[] = ['all', 'evaluated', 'interview', 'responded', 'applied', 'top', 'skip', 'rejected', 'discarded'];
const SORT_KEYS: SortKey[] = ['num', 'company', 'role', 'score', 'status', 'date', 'location', 'pay', 'lastContact', 'posted'];

const todayRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: TodayPage });

const trackerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tracker',
  component: TrackerPage,
  validateSearch: (s: Loose): TrackerSearch => ({
    tab: oneOf(TRACKER_TABS, s.tab, 'all'),
    q: typeof s.q === 'string' ? s.q : '',
    sort: oneOf(SORT_KEYS, s.sort, 'num'),
    dir: oneOf(['asc', 'desc'] as const, s.dir, 'desc'),
    view: oneOf(['flat', 'grouped'] as const, s.view, 'flat'),
  }),
});

const applicationRoute = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: ApplicationPage });

const pipelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pipeline',
  component: PipelinePage,
  validateSearch: (s: Loose): { tab: PipelineTab } => ({ tab: oneOf(['inbox', 'shortlist', 'batch'] as const, s.tab, 'inbox') }),
});

const sponsorshipRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sponsorship',
  component: SponsorshipPage,
  validateSearch: (s: Loose): { tab: SponsorshipTab } => ({
    tab: oneOf(['overview', 'changes', 'feed', 'alerts', 'companies', 'lookup', 'tiers'] as const, s.tab, 'overview'),
  }),
});

const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/insights',
  component: InsightsPage,
  validateSearch: (s: Loose): { tab: InsightsTab } => ({
    tab: oneOf(['overview', 'progress', 'breakdown', 'velocity', 'patterns', 'salary', 'skills', 'legitimacy', 'ai'] as const, s.tab, 'overview'),
  }),
});

const followupsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/followups', component: FollowupsPage });

const discoverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/discover',
  component: DiscoverPage,
  validateSearch: (s: Loose): { tab: DiscoverTab } => ({ tab: oneOf(['network', 'portal', 'ai', 'fresh', 'funded', 'reposts'] as const, s.tab, 'network') }),
});

const routeTree = rootRoute.addChildren([
  todayRoute,
  trackerRoute,
  applicationRoute,
  pipelineRoute,
  sponsorshipRoute,
  insightsRoute,
  followupsRoute,
  placeholder('/apply', 'Apply'),
  placeholder('/interviews', 'Interviews'),
  discoverRoute,
  placeholder('/sessions', 'Sessions'),
  createRoute({ getParentRoute: () => rootRoute, path: '/runs', component: RunsPage }),
  placeholder('/profile', 'Profile & CV'),
  placeholder('/settings', 'Settings'),
  placeholder('/dev', 'Dev Chat'),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

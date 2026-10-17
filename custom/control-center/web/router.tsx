import { createRootRoute, createRoute, createRouter, notFound, type SearchSchemaInput } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { TodayPage } from './features/today/TodayPage';
import { TrackerPage, type TrackerSearch, type TrackerTab, type SortKey } from './features/tracker/TrackerPage';
import { ApplicationPage } from './features/tracker/ApplicationPage';
import { PipelinePage, type PipelineSearch } from './features/pipeline/PipelinePage';
import { SponsorshipPage, type SponsorshipTab } from './features/sponsorship/SponsorshipPage';
import { InsightsPage, type InsightsTab } from './features/insights/InsightsPage';
import { FollowupsPage, type FollowupsTab } from './features/followups/FollowupsPage';
import { RunsPage } from './features/runs/RunsPage';
import { DiscoverPage, type DiscoverTab } from './features/discover/DiscoverPage';
import { SessionsPage, SessionDetailPage } from './features/sessions/SessionsPage';
import { ApplyPage, ApplyRowPage } from './features/apply/ApplyPage';
import { ProfilePage } from './features/profile/ProfilePage';
import { DevChatPage, validateDevSearch } from './features/dev/DevChatPage';
import { InterviewsPage } from './features/interviews/InterviewsPage';
import { TutorialsPage } from './features/tutorials/TutorialsPage';
import { SettingsPage, SETTINGS_TABS, type SettingsTab } from './features/settings/SettingsPage';

const rootRoute = createRootRoute({ component: Shell });

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Search params are optional on links and always normalized on read. */
type Loose = Record<string, unknown> & SearchSchemaInput;

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

/**
 * A tracker row number, normalized ("05" is row 5), or not found. The pages put it in fetch paths, session prompts and
 * per-row guard keys, so `5%23<text>` (decoded to `5#<text>`) must not load row 5 and carry its text along.
 */
const rowParams = {
  parse: ({ n }: { n: string }): { n: string } => {
    if (!/^\d{1,9}$/.test(n) || Number(n) === 0) throw notFound();
    return { n: String(Number(n)) };
  },
  stringify: ({ n }: { n: string }) => ({ n }),
};

/**
 * A session id (the shape lastSession.ts keeps), or not found. The page puts it in /api/sessions/ fetch paths, so it
 * must not name another route there (engine answers with no session record) or decode into a sibling path.
 */
const NOT_SESSIONS = new Set(['engine', 'fanout']);
const sessionParams = {
  parse: ({ id }: { id: string }): { id: string } => {
    if (!/^[\w-]{1,80}$/.test(id) || NOT_SESSIONS.has(id)) throw notFound();
    return { id };
  },
  stringify: ({ id }: { id: string }) => ({ id }),
};

// A different row is a different page: without the remount, its tab and a delete preview carry over to the next row.
const applicationRoute = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: ApplicationPage, params: rowParams, remountDeps: ({ params }) => params });

const pipelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pipeline',
  component: PipelinePage,
  validateSearch: (s: Loose): PipelineSearch => ({
    tab: oneOf(['inbox', 'shortlist', 'batch'] as const, s.tab, 'inbox'),
    ...(typeof s.q === 'string' && s.q ? { q: s.q.slice(0, 200) } : {}),
  }),
});

const sponsorshipRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sponsorship',
  component: SponsorshipPage,
  validateSearch: (s: Loose): { tab: SponsorshipTab; q?: string; mode?: 'lookup' | 'search' } => ({
    tab: oneOf(['overview', 'changes', 'feed', 'alerts', 'companies', 'lookup', 'tiers'] as const, s.tab, 'overview'),
    ...(typeof s.q === 'string' && s.q ? { q: s.q.slice(0, 200), mode: oneOf(['lookup', 'search'] as const, s.mode, 'lookup') } : {}),
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

const followupsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/followups',
  component: FollowupsPage,
  validateSearch: (s: Loose): { tab: FollowupsTab } => ({ tab: oneOf(['cadence', 'replies', 'contacts'] as const, s.tab, 'cadence') }),
});

const discoverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/discover',
  component: DiscoverPage,
  validateSearch: (s: Loose): { tab: DiscoverTab } => ({ tab: oneOf(['network', 'portal', 'ai', 'fresh', 'funded', 'reposts'] as const, s.tab, 'network') }),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
  validateSearch: (s: Loose): { tab: SettingsTab; add?: string } => ({ tab: oneOf(SETTINGS_TABS, s.tab, 'portals'), ...(typeof s.add === 'string' && s.add ? { add: s.add.slice(0, 200) } : {}) }),
});

const tutorialsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tutorials',
  component: TutorialsPage,
  validateSearch: (s: Loose): { t?: string; part?: string; view?: 'guide'; section?: string; sub?: string } => ({
    ...(typeof s.t === 'string' && s.t ? { t: s.t.slice(0, 64) } : {}),
    ...(typeof s.part === 'string' && s.part ? { part: s.part.slice(0, 64) } : {}),
    ...(s.view === 'guide' ? { view: 'guide' as const } : {}),
    ...(typeof s.section === 'string' && s.section ? { section: s.section.slice(0, 64) } : {}),
    ...(typeof s.sub === 'string' && s.sub ? { sub: s.sub.slice(0, 64) } : {}),
  }),
});

export const routeTree = rootRoute.addChildren([
  todayRoute,
  trackerRoute,
  applicationRoute,
  pipelineRoute,
  sponsorshipRoute,
  insightsRoute,
  followupsRoute,
  createRoute({ getParentRoute: () => rootRoute, path: '/apply', component: ApplyPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/apply/$n', component: ApplyRowPage, params: rowParams }),
  createRoute({ getParentRoute: () => rootRoute, path: '/interviews', component: InterviewsPage }),
  discoverRoute,
  createRoute({ getParentRoute: () => rootRoute, path: '/sessions', component: SessionsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$id', component: SessionDetailPage, params: sessionParams }),
  createRoute({ getParentRoute: () => rootRoute, path: '/runs', component: RunsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/profile', component: ProfilePage }),
  settingsRoute,
  createRoute({ getParentRoute: () => rootRoute, path: '/dev', component: DevChatPage, validateSearch: validateDevSearch }),
  tutorialsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

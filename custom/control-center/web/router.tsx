import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { TodayPage } from './features/today/TodayPage';
import { PlaceholderPage } from './components/PlaceholderPage';
import { NAV_GROUPS } from './nav';

const rootRoute = createRootRoute({ component: Shell });

const todayRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: TodayPage });

const placeholderRoutes = NAV_GROUPS.flatMap((g) => g.items)
  .filter((item) => item.to !== '/')
  .map((item) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: item.to,
      component: () => <PlaceholderPage title={item.label} />,
    }),
  );

const routeTree = rootRoute.addChildren([todayRoute, ...placeholderRoutes]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

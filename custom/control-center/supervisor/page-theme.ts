/**
 * Colors for the server-rendered pages (the locked page and the recovery page). They cannot run the app's
 * theme boot script or read its stored choice, so they follow the system: dark by default, light when the
 * system asks for it. Values are the app's own tokens (tests/unit/page-theme.test.ts keeps them identical).
 * It lives under supervisor/, which Dev Chat cannot write, because the supervisor runs it to draw /__recovery.
 */
export const PAGE_THEME_CSS =
  ':root{color-scheme:dark light;--bg:#0b0d12;--surface-1:#11141a;--surface-2:#171b23;--border:#262c38;--border-strong:#343b4a;--text:#e7eaf0;--text-muted:#a9b1c0;--accent:#8b9dff}' +
  '@media (prefers-color-scheme:light){:root{--bg:#f4f6fa;--surface-1:#ffffff;--surface-2:#f8f9fc;--border:#e1e5ee;--border-strong:#c9cfdc;--text:#151a26;--text-muted:#4a5266;--accent:#4a55d6}}';

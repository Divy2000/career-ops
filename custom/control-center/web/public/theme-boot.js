/* Runs before first paint (render-blocking, same-origin so the CSP allows it): sets data-theme from the
 * stored choice and the system preference so a reload never flashes the wrong theme. Keep in step with
 * web/lib/theme.ts (resolveTheme); tests/web/theme.test.ts runs this file against it. */
(function () {
  var COLORS = { light: '#fbfcfe', dark: '#11141a' };
  var mode = 'auto';
  try {
    var stored = localStorage.getItem('cc.theme');
    if (stored === 'light' || stored === 'dark') mode = stored;
  } catch {
    /* blocked storage: stay on auto */
  }
  var systemDark = true;
  try {
    systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    /* no matchMedia: the app's historic default is dark */
  }
  var resolved = mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;
  var root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-mode', mode);
  root.style.colorScheme = resolved;
  ['light', 'dark'].forEach(function (scheme) {
    var meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', COLORS[scheme]);
    meta.setAttribute('data-scheme', scheme);
    meta.setAttribute('media', mode === 'auto' ? '(prefers-color-scheme: ' + scheme + ')' : scheme === resolved ? 'all' : 'not all');
    document.head.appendChild(meta);
  });
})();

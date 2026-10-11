// Preloaded with `node --import` into every process the app starts (server/system/child-env.ts) and into the renders
// custom/cv/render-pdf.mjs runs. HTML a session wrote is rendered by Playwright from a file:// URL, and a file:// page
// may frame, embed or navigate to any other local file (<iframe src="file:///Users/me/.ssh/id_rsa">), which then prints
// into the PDF. Here every browser context a script opens routes its requests: a page loads the file:// documents it was
// sent to with page.goto, and no other file:// URL (subresource, frame, popup or script-driven navigation). Web URLs are
// left alone. Templates need no local subresources: generate-pdf.mjs inlines their fonts as data: URLs.
//
// Nothing is loaded until a script imports Playwright: a resolve hook sees the import and patches the BrowserType
// prototype it is about to get (Playwright's ESM entry wraps the CommonJS one, so both share it). A Node without
// module.registerHooks (20.6 to 22.14, which do take --import) patches the Playwright the main script would
// load at once instead, which costs the load on every process.
import * as nodeModule from 'node:module';
import { pathToFileURL } from 'node:url';

const PATCHED = Symbol.for('career-ops.local-file-guard');
const PLAYWRIGHT = new Set(['playwright', 'playwright-core', '@playwright/test', 'playwright-chromium']);

const isFile = (url) => /^file:/i.test(url);
const documentKey = (url) => {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
};

/** A file:// request passes only as a page's main-frame navigation to a URL it was sent to; web URLs always pass. */
function deniedFile(request, sentTo) {
  if (!isFile(request.url())) return false;
  let frame;
  let page;
  try {
    frame = request.frame();
    page = frame.page();
  } catch {
    return true; // a worker's request has no frame
  }
  return !(request.isNavigationRequest() && frame === page.mainFrame() && sentTo.get(page)?.has(documentKey(request.url())));
}

const reported = new Set();
/** Aborts a denied request, naming it once on stderr so a CV that meant to load a local asset is told why it is missing. */
function refuse(route) {
  const url = route.request().url();
  if (!reported.has(url)) {
    reported.add(url);
    process.stderr.write(`local-file-guard: blocked ${url} (a rendered page loads no local file but itself; inline the asset as a data: URL)\n`);
  }
  return route.abort('accessdenied');
}

/**
 * Routes the script registers on `target` run before the guard's own context route (Playwright runs page routes, then
 * the newest context routes first), and generate-pdf.mjs continues every file: URL in its own, so each handler it
 * registers is wrapped to refuse a denied request before the handler sees it.
 */
function wrapRouting(target, sentTo) {
  const wrapped = new WeakMap();
  const route = target.route.bind(target);
  const unroute = target.unroute.bind(target);
  target.route = (url, handler, ...rest) => {
    const guarded = (r, ...more) => (deniedFile(r.request(), sentTo) ? refuse(r) : handler(r, ...more));
    if (typeof handler === 'function') wrapped.set(handler, guarded);
    return route(url, guarded, ...rest);
  };
  target.unroute = (url, handler, ...rest) => unroute(url, handler === undefined ? undefined : (wrapped.get(handler) ?? handler), ...rest);
}

function guardPage(page, sentTo) {
  const goto = page.goto.bind(page);
  page.goto = (url, ...rest) => {
    if (typeof url === 'string' && isFile(url)) {
      if (!sentTo.has(page)) sentTo.set(page, new Set());
      sentTo.get(page).add(documentKey(url));
    }
    return goto(url, ...rest);
  };
  wrapRouting(page, sentTo);
  return page;
}

export async function guardContext(context) {
  if (context[PATCHED]) return context;
  context[PATCHED] = true;
  const sentTo = new WeakMap();
  const newPage = context.newPage.bind(context);
  context.newPage = async (...args) => guardPage(await newPage(...args), sentTo);
  await context.route('**/*', (route) => (deniedFile(route.request(), sentTo) ? refuse(route) : route.fallback()));
  wrapRouting(context, sentTo);
  return context;
}

async function guardBrowser(browser) {
  if (browser[PATCHED]) return browser;
  browser[PATCHED] = true;
  // Browser.newPage opens its context through this.newContext, so it is guarded too.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => guardContext(await newContext(...args));
  for (const context of browser.contexts()) await guardContext(context);
  return browser;
}

/** Patches the BrowserType prototype behind `playwright.chromium` (shared by firefox and webkit). */
export function patchPlaywright(playwright) {
  const proto = Object.getPrototypeOf(playwright?.chromium ?? {});
  if (typeof proto?.launch !== 'function') throw new Error('local-file-guard: this Playwright build has no BrowserType.launch to guard');
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  for (const name of ['launch', 'connect', 'connectOverCDP']) {
    const original = proto[name];
    if (typeof original === 'function') proto[name] = async function guarded(...args) { return guardBrowser(await original.apply(this, args)); };
  }
  const persistent = proto.launchPersistentContext;
  if (typeof persistent === 'function') proto.launchPersistentContext = async function guarded(...args) { return guardContext(await persistent.apply(this, args)); };
}

const requireFrom = (parentUrl) => nodeModule.createRequire(parentUrl?.startsWith('file:') ? parentUrl : pathToFileURL(`${process.cwd()}/`).href);

if (typeof nodeModule.registerHooks === 'function') {
  let patching = false;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!patching && PLAYWRIGHT.has(specifier)) {
        patching = true;
        try {
          patchPlaywright(requireFrom(context.parentURL)(specifier));
        } finally {
          patching = false;
        }
      }
      return result;
    },
  });
} else {
  const main = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
  let playwright = null;
  try {
    playwright = requireFrom(main)('playwright');
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND') throw err; // nothing this process can import to render with
  }
  if (playwright) patchPlaywright(playwright);
}

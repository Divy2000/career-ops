// The Playwright MCP server a session gets (playwright-mcp.json runs this file from the code root, the CLI's working
// directory). It starts browser-egress-proxy.mjs and the pinned MCP with every browser request sent through it, so
// no page load, redirect, frame or click reaches a loopback, private or link-local address. The guard's navigate
// check stays as the early refusal. The MCP speaks on this process's stdin and stdout.
import { spawn } from 'node:child_process';
import { isMainModule } from '../../../../lib/is-main-module.mjs';
import { startEgressProxy } from './browser-egress-proxy.mjs';

export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.41';

/** npx arguments; the proxy comes last, so it is the one the MCP's option parser keeps. */
export function playwrightMcpArgs(proxyPort, extra = []) {
  return ['-y', PLAYWRIGHT_MCP_PACKAGE, '--browser', 'chromium', ...extra, '--proxy-server', `http://127.0.0.1:${proxyPort}`];
}

/**
 * What npx, the MCP and its browser need from this process's environment, and nothing else: the CLI hands the launcher
 * its own environment, which in an apply session holds the session's OAuth token (invocation.ts buildEnv), and npx runs
 * registry code that also loads web pages. An allowlist, so a credential, a CC_* internal or a PLAYWRIGHT_MCP_* option
 * (a proxy, a bypass list, a config file, a remote browser) cannot pass by a name nobody listed. Names compare in upper
 * case because Windows keeps them case-insensitive.
 */
const MCP_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'TZ', 'LANG', 'LANGUAGE',
  // The local file guard is preloaded through it (server/system/child-env.ts).
  'NODE_OPTIONS',
  // npx's download through a corporate proxy or CA; the browser's proxy is the --proxy-server argument.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
]);
/** npm settings pass (registry, cache, userconfig), except one that carries a secret; ~/.npmrc still applies. */
const NPM_SECRET = /AUTH|TOKEN|PASSWORD|(^|[_-])(KEY|CERT)($|[_-])/;

export function playwrightMcpEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const name = k.toUpperCase();
    const npm = name.startsWith('NPM_CONFIG_') && !NPM_SECRET.test(name.slice('NPM_CONFIG_'.length));
    if (MCP_ENV_NAMES.has(name) || name.startsWith('LC_') || npm) out[k] = v;
  }
  return out;
}

/** Starts the proxy and the MCP; exits with the MCP's status, and stops the MCP when this process is told to stop. */
export async function launch(extra = []) {
  const proxy = await startEgressProxy();
  const child = spawn('npx', playwrightMcpArgs(proxy.port, extra), { stdio: 'inherit', env: playwrightMcpEnv(process.env) });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', async (err) => {
    process.stderr.write(`playwright-mcp-launcher: could not start npx ${PLAYWRIGHT_MCP_PACKAGE}: ${err.message}\n`);
    await proxy.close();
    process.exit(1);
  });
  child.on('exit', async (code, signal) => {
    await proxy.close();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

if (isMainModule(import.meta.url)) {
  launch().catch((err) => {
    process.stderr.write(`playwright-mcp-launcher: ${err && err.message}\n`);
    process.exit(1);
  });
}

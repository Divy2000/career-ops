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
 * The MCP's environment without the settings that could replace or bypass the proxy: every PLAYWRIGHT_MCP_* option
 * (a proxy, a bypass list, a config file, a remote browser) and Playwright's switch that lets loopback skip the proxy.
 */
export function playwrightMcpEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('PLAYWRIGHT_MCP_') || k === 'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK') continue;
    out[k] = v;
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

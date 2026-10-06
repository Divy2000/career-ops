// Every process the server starts (runs, sync actions, core modules, Claude
// sessions) gets the server's environment minus its CC_* internals: the
// supervisor puts CC_TOKEN and CC_SESSION_SECRET (the auth cookie value) there,
// and a child that can read them can drive the local API. Variables a caller
// passes explicitly (the guard hook's CC_POLICY_FILE and friends, a session's own token) are kept. Claude and
// Anthropic credentials exported in the shell are dropped as well (see CREDENTIALS).
/**
 * Claude and Anthropic credentials a shell may export (claude setup-token suggests exporting the OAuth token). No child
 * needs an inherited copy: a session sets its own token and an empty API key in `extra`, and run-daily.sh reads the
 * Keychain and drops an inherited one, because scan.mjs loads third-party provider and plugin code into its process.
 */
const CREDENTIALS = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

export function childEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('CC_') && !CREDENTIALS.has(k)) out[k] = v;
  return { ...out, ...extra };
}

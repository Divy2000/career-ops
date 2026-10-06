// Every process the server starts (runs, sync actions, core modules, Claude
// sessions) gets the server's environment minus its CC_* internals: the
// supervisor puts CC_TOKEN and CC_SESSION_SECRET (the auth cookie value) there,
// and a child that can read them can drive the local API. Variables a caller
// passes explicitly (the guard hook's CC_POLICY_FILE and friends, a session's own token) are kept. Claude and
// Anthropic credentials exported in the shell are dropped as well (see isCredential).
/**
 * Claude and Anthropic credentials a shell may export (claude setup-token suggests exporting the OAuth token). No child
 * needs an inherited copy: a session sets its own token and an empty API key in `extra`, and run-daily.sh reads the
 * Keychain and drops an inherited one, because scan.mjs loads third-party provider and plugin code into its process.
 * Every ANTHROPIC_* variable goes (keys, tokens, custom headers, and the endpoint they are sent to), and every
 * CLAUDE_CODE_* variable named for a secret (a TOKEN, KEY, SECRET, PASSWORD, PASSPHRASE, CREDENTIAL, CERT or HEADER
 * segment); CLAUDE_CODE_* settings such as CLAUDE_CODE_MAX_OUTPUT_TOKENS pass.
 */
const SECRET_SEGMENT = /(^|_)(TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?|CERT|HEADERS?)(_|$)/;
export const isCredential = (name: string): boolean => name.startsWith('ANTHROPIC_') || (name.startsWith('CLAUDE_CODE_') && SECRET_SEGMENT.test(name.slice('CLAUDE_CODE_'.length)));

export function childEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('CC_') && !isCredential(k)) out[k] = v;
  return { ...out, ...extra };
}

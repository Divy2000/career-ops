// Every process the server starts (runs, sync actions, core modules, Claude
// sessions) gets the server's environment minus its CC_* internals: the
// supervisor puts CC_TOKEN and CC_SESSION_SECRET (the auth cookie value) there,
// and a child that can read them can drive the local API. Variables a caller
// passes explicitly (the guard hook's CC_POLICY_FILE and friends, a session's own token) are kept. Claude and
// Anthropic credentials exported in the shell are dropped as well (see isCredential).
import { pathToFileURL } from 'node:url';
import { LOCAL_FILE_GUARD_PATH } from '../claude/confinement.mjs';

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

/**
 * scan.mjs and its siblings put these ahead of the data root (a second search lane, #2271), from the shell or from the
 * data root's .env. The app reads and edits only the data root's data/pipeline.md, data/scan-history.tsv, portals.yml
 * and config/profile.yml, so a scan it starts must read and write those: an empty value keeps each script's default (they read it with ||), and dotenv never
 * overwrites a variable that is already set. A caller may still pass one explicitly.
 * The same holds for every other data file or folder a script the app starts lets the environment move: reply
 * candidates (paste-reply), follow-ups (followup-seed), documents and intake state (intake), reports and batch state
 * (reserve-report-num, verify-pipeline), jds (verify-pipeline), tracker additions (merge-tracker), and cv.md and
 * article-digest.md (add-entry). CAREER_OPS_TRACKER and CAREER_OPS_PDF_INDEX pass, since the app follows them too; lock
 * locations pass so the app's writers still exclude the user's own CLI.
 */
const PINNED_TO_DATA_ROOT = {
  CAREER_OPS_PIPELINE: '',
  CAREER_OPS_SCAN_HISTORY: '',
  CAREER_OPS_PORTALS: '',
  CAREER_OPS_PROFILE: '',
  CAREER_OPS_REPLY_CANDIDATES: '',
  CAREER_OPS_FOLLOWUPS: '',
  CAREER_OPS_DOCUMENTS_DIR: '',
  CAREER_OPS_INTAKE_STATE: '',
  CAREER_OPS_REPORTS_DIR: '',
  CAREER_OPS_REPORTS: '',
  CAREER_OPS_JDS: '',
  CAREER_OPS_ADDITIONS: '',
  CAREER_OPS_BATCH_STATE: '',
  CAREER_OPS_CV: '',
  CAREER_OPS_ARTICLE_DIGEST: '',
};

/**
 * Preloaded into every Node child (and, through a session's environment, every script a session runs): a page Playwright
 * renders from a file:// URL loads no other local file, so session-written HTML cannot frame ~/.ssh/id_rsa into a PDF
 * (server/claude/local-file-guard.mjs).
 */
const LOCAL_FILE_GUARD_FLAG = `--import=${pathToFileURL(LOCAL_FILE_GUARD_PATH).href}`;

function withLocalFileGuard(nodeOptions: string | undefined): string {
  const given = (nodeOptions ?? '').trim();
  if (given.split(/\s+/).includes(LOCAL_FILE_GUARD_FLAG)) return given;
  return given ? `${given} ${LOCAL_FILE_GUARD_FLAG}` : LOCAL_FILE_GUARD_FLAG;
}

/**
 * The server looks up a session's tool-results under CLAUDE_CONFIG_DIR read trimmed, blank meaning unset
 * (server/config.ts), so the claude child gets that same value: a blank one would send it to another config folder.
 */
function withClaudeConfigDir(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CLAUDE_CONFIG_DIR === undefined) return env;
  const { CLAUDE_CONFIG_DIR: given, ...rest } = env;
  const dir = given.trim();
  return dir ? { ...rest, CLAUDE_CONFIG_DIR: dir } : rest;
}

export function childEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('CC_') && !isCredential(k)) out[k] = v;
  const env = withClaudeConfigDir({ ...out, ...PINNED_TO_DATA_ROOT, ...extra });
  return { ...env, NODE_OPTIONS: withLocalFileGuard(env.NODE_OPTIONS) };
}

// Every process the server starts (runs, sync actions, core modules, Claude
// sessions) gets the server's environment minus its CC_* internals: the
// supervisor puts CC_TOKEN and CC_SESSION_SECRET (the auth cookie value) there,
// and a child that can read them can drive the local API. Variables a caller
// passes explicitly (the guard hook's CC_POLICY_FILE and friends) are kept.
export function childEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('CC_')) out[k] = v;
  return { ...out, ...extra };
}

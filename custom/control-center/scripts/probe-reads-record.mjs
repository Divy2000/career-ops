// The --record decision and write for claude-probe-reads.mjs (invariants 9 and 10 in claude-probe-reads.invariants.md).
import fs from 'node:fs';
import path from 'node:path';

const settled = (result) => result === 'pass' || result === 'info';
/** JSON with object keys sorted, so two shapes compare equal whatever order their keys were written in. */
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/**
 * The contract with this run's read-probe record, or a throw naming why nothing may be recorded. Never mutates
 * `contract`. `run` is { version, probedAt, model, shape, cases, info, runs, only: Set|null, stopped, incomplete: string[] }:
 * a signal (stopped) or any call that did not run to its end (incomplete) would replace the last real record with
 * cases that never ran, and a targeted re-run (--only) merges only into a record of the same version, model and shape.
 * Returns { contract, cases } with the merged cases and C0 recomputed from the approved versions.
 */
export function recordReadProbe(contract, run) {
  if (run.stopped) throw new Error('stopped by a signal; nothing recorded');
  if (run.incomplete.length) throw new Error(`calls that did not run to their end: ${run.incomplete.join('; ')}; nothing recorded, rerun`);
  const next = structuredClone(contract);
  const approved = next.claude.approvedVersions ?? [];
  const prev = next.claude.readProbe;
  // A previous case says something about this run only if it ran on the same CLI version, model and invocation shape.
  const merging = Boolean(run.only) && prev?.version === run.version && prev.model === run.model && prev.shape !== undefined && canonical(prev.shape) === canonical(run.shape);
  if (run.only && !merging) throw new Error(`--record with --only needs an existing record for ${run.version} with this model (${run.model}) and invocation shape; run every case first`);
  const cases = { ...(merging ? prev.cases : {}), ...run.cases };
  const info = { ...(merging ? prev.info : {}), ...run.info };
  const history = [...(merging ? (prev.history ?? []) : []), { probedAt: run.probedAt, cases: Object.keys(run.cases).filter((id) => id !== 'C0').sort(), runs: run.runs }];
  const gatePassed = Object.entries(cases).every(([id, r]) => id === 'C0' || settled(r));
  if (gatePassed && !approved.includes(run.version)) next.claude.approvedVersions = [...approved, run.version];
  cases.C0 = (next.claude.approvedVersions ?? []).includes(run.version) ? 'pass' : 'fail';
  next.claude.readProbe = { version: run.version, probedAt: run.probedAt, model: run.model, shape: run.shape, cases, info, history };
  return { contract: next, cases };
}

/** Replaces `file` with `contract` whole: a sibling temp file renamed over it, removed again when the write fails. */
export function writeContract(file, contract) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(contract, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

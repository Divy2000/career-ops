// Runs intake.mjs's own PDF extractor in a worker thread: its helpers call pdftotext synchronously
// (execFileSync), which would block the server's event loop. The text is the one intake --commit
// fingerprints, because it is the same function.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const { intakePath, abs, probed } = workerData;
// pdftotext inherits this thread's environment (intake calls execFileSync without env), which starts as a copy of the
// server's: drop the server internals (CC_TOKEN, CC_SESSION_SECRET) and Claude credentials as childEnv does for every
// other child (server/system/child-env.ts, whose rule a test keeps this in step with; plain .mjs cannot import it).
const SECRET_SEGMENT = /(^|_)(TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?|CERT|HEADERS?)(_|$)/;
for (const name of Object.keys(process.env)) {
  const credential = name.startsWith('ANTHROPIC_') || (name.startsWith('CLAUDE_CODE_') && SECRET_SEGMENT.test(name.slice('CLAUDE_CODE_'.length)));
  if (name.startsWith('CC_') || credential) delete process.env[name];
}
try {
  const intake = await import(pathToFileURL(intakePath).href);
  // Once an extractor has answered its version probe, skip the probe (intake's injectable probe).
  const extractor = probed ? intake.detectPdfExtractor(() => true) : intake.detectPdfExtractor();
  if (!extractor) parentPort.postMessage({ ok: false, missing: true });
  else parentPort.postMessage({ ok: true, name: extractor.name, text: extractor.extract(abs) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.message ?? err).split('\n')[0] });
}

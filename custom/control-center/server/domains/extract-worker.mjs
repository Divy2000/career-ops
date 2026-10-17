// Runs intake.mjs's own PDF extractor in a worker thread: its helpers call pdftotext synchronously
// (execFileSync), which would block the server's event loop. The text is the one intake --commit
// fingerprints, because it is the same function.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const { intakePath, abs, probed } = workerData;
// pdftotext inherits this thread's environment (intake calls execFileSync without env), which starts as a copy of the
// server's, credentials included. The extractor needs only a search path (for libraries too), locale, temp dir and home, and intake reads
// the data root and its own paths at import (path-resolver.mjs, intake.mjs), so every other variable is dropped: the
// server internals (CC_TOKEN, CC_SESSION_SECRET), the Claude credentials childEnv drops (server/system/child-env.ts),
// and any other key or token the shell exported (OpenAI, GitHub, cloud providers).
const NEEDED = /^(PATH|PATHEXT|HOME|USERPROFILE|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|COMSPEC|FONTCONFIG_(FILE|PATH)|LD_LIBRARY_PATH|DYLD_(FALLBACK_)?LIBRARY_PATH|CAREER_OPS_(ROOT|DATA_DIR|DOCUMENTS_DIR|INTAKE_STATE))$/i;
for (const name of Object.keys(process.env)) {
  if (!NEEDED.test(name)) delete process.env[name];
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

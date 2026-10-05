// Runs intake.mjs's own PDF extractor in a worker thread: its helpers call pdftotext synchronously
// (execFileSync), which would block the server's event loop. The text is the one intake --commit
// fingerprints, because it is the same function.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const { intakePath, abs, probed } = workerData;
try {
  const intake = await import(pathToFileURL(intakePath).href);
  // Once an extractor has answered its version probe, skip the probe (intake's injectable probe).
  const extractor = probed ? intake.detectPdfExtractor(() => true) : intake.detectPdfExtractor();
  if (!extractor) parentPort.postMessage({ ok: false, missing: true });
  else parentPort.postMessage({ ok: true, name: extractor.name, text: extractor.extract(abs) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.message ?? err).split('\n')[0] });
}

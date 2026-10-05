// pending.json is read, changed and rewritten by watch.mjs (queueing new official items) and by watch.mjs --ack
// (dropping the items a finished policy pass was given). The daily job, the "Check official feeds" action and the
// Control Center's manual pass can run these at the same time, so each read-change-write holds the same lock on
// pending.json; without it an ack's stale write drops an item the watcher had just queued and marked seen, for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { acquirePipelineLock } from '../../../pipeline-lock.mjs';
import { localToday } from '../../../lib/local-today.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WATCH = path.join(REPO, 'custom', 'immigration', 'watch.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dated now: the watcher only keeps items inside its lookback window, so a fixed date would age out of it.
const PUB_DATE = new Date().toUTCString();
// Ids as watch.mjs makes them for the USCIS feed: the source and the item URL.
const item = (slug, title) => ({ id: `uscis:https://www.uscis.gov/news/${slug}`, source: 'USCIS news', title, url: `https://www.uscis.gov/news/${slug}`, published: localToday() });
const A = item('a', 'H-1B fee rule A');
const C = item('c', 'H-1B registration rule C');

/** A data root with A queued, a batch file holding A (what a pass was given), and an offline feed that answers with C. */
function world() {
  const root = tempDir('imm-pending-lock-');
  const imm = path.join(root, 'data', 'immigration');
  fs.mkdirSync(imm, { recursive: true });
  fs.writeFileSync(path.join(imm, 'pending.json'), JSON.stringify([A], null, 2) + '\n');
  fs.writeFileSync(path.join(imm, 'seen.json'), JSON.stringify({ ids: [A.id] }) + '\n');
  const batch = path.join(imm, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify({ new_items: [A] }));
  const preload = path.join(root, 'feeds.mjs');
  const rss = `<rss><channel><item><title>${C.title}</title><link>${C.url}</link><pubDate>${PUB_DATE}</pubDate></item></channel></rss>`;
  fs.writeFileSync(preload, `globalThis.fetch = async (url) => new Response(String(url).includes('federalregister') ? JSON.stringify({ results: [] }) : ${JSON.stringify(rss)}, { status: 200 });\n`);
  return { root, pending: path.join(imm, 'pending.json'), batch, preload };
}

function run(w, args, { preload = false } = {}) {
  const child = spawn(process.execPath, [...(preload ? ['--import', w.preload] : []), WATCH, ...args], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: w.root, NO_COLOR: '1' } });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })));
  return { done };
}
const ids = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).map((i) => i.id);

test('watch.mjs --ack waits for the pending.json lock before it rewrites the queue', async () => {
  const w = world();
  const lock = await acquirePipelineLock(w.pending);
  const ack = run(w, ['--ack', w.batch]);
  await sleep(1500);
  assert.deepEqual(ids(w.pending), [A.id], 'the ack wrote pending.json while another writer held its lock');
  // The holder queues C, as a watcher run would, then lets go.
  fs.writeFileSync(w.pending, JSON.stringify([A, C], null, 2) + '\n');
  lock.release();
  const r = await ack.done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(w.pending), [C.id]);
});

test('watch.mjs waits for the pending.json lock before it queues new items', async () => {
  const w = world();
  const lock = await acquirePipelineLock(w.pending);
  const watch = run(w, [], { preload: true });
  await sleep(1500);
  assert.deepEqual(ids(w.pending), [A.id], 'the watcher wrote pending.json while another writer held its lock');
  // The holder acknowledges A, as a finished pass would, then lets go.
  fs.writeFileSync(w.pending, '[]\n');
  lock.release();
  const r = await watch.done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(w.pending), [C.id], 'the acknowledged A came back, or the fresh C was lost');
});

test('an ack and a watcher run started together keep the fresh item and drop only the acknowledged one', async () => {
  const w = world();
  const lock = await acquirePipelineLock(w.pending);
  const both = [run(w, ['--ack', w.batch]), run(w, [], { preload: true })];
  await sleep(500);
  lock.release();
  for (const r of await Promise.all(both.map((b) => b.done))) assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(w.pending), [C.id]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(w.root, 'data', 'immigration', 'seen.json'), 'utf8')).ids.includes(C.id));
});

/** An offline USCIS feed that answers with `items` after `delayMs`; the Federal Register answers with nothing, at once. */
function feed(w, name, items, delayMs = 0) {
  const file = path.join(w.root, `${name}.mjs`);
  const rss = `<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.url}</link><pubDate>${PUB_DATE}</pubDate></item>`).join('')}</channel></rss>`;
  fs.writeFileSync(file, `globalThis.fetch = async (url) => String(url).includes('federalregister') ? new Response(JSON.stringify({ results: [] }), { status: 200 }) : new Promise((r) => setTimeout(() => r(new Response(${JSON.stringify(rss)}, { status: 200 })), ${delayMs}));\n`);
  return file;
}

test('a watcher that read seen.json before another run queued and an ack cleared an item neither re-queues it nor drops that run\'s seen ids', async () => {
  const w = world();
  const seenFile = path.join(w.root, 'data', 'immigration', 'seen.json');
  fs.writeFileSync(w.pending, '[]\n');
  const X = item('x', 'H-1B wage rule X');
  const D = item('d', 'H-1B lottery rule D');
  // W2 reads the stale seen.json (A only) as it starts, then its fetch is slow.
  const w2 = run({ ...w, preload: feed(w, 'w2-feeds', [C, D], 4000) }, [], { preload: true });
  await sleep(1500);
  // Meanwhile W1 queues C and X and marks them seen, and a pass is given C and acknowledges it.
  const w1 = await run({ ...w, preload: feed(w, 'w1-feeds', [C, X]) }, [], { preload: true }).done;
  assert.equal(w1.code, 0, w1.stderr);
  fs.writeFileSync(w.batch, JSON.stringify({ new_items: [C] }));
  const ack = await run(w, ['--ack', w.batch]).done;
  assert.equal(ack.code, 0, ack.stderr);
  assert.deepEqual(ids(w.pending), [X.id]);
  const r = await w2.done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(w.pending), [X.id, D.id], 'the acknowledged C was queued again');
  const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  assert.deepEqual([...seen.ids].sort(), [A.id, C.id, D.id, X.id].sort(), 'a stale snapshot overwrote the seen ids');
  assert.deepEqual(Object.keys(seen.last_success).sort(), ['federal-register', 'uscis']);
});

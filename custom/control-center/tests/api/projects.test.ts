import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { makePdf } from '../helpers/pdf.js';
import { installPdftotextStub } from '../helpers/pdftotext-stub.js';

let t: TestApp;
beforeEach(async () => {
  if (t) await t.close();
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const file = () => path.join(t.cfg.dataRoot, 'article-digest.md');
const read = () => fs.readFileSync(file(), 'utf8');
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, ifMatch?: string) =>
  t.app.inject({ method, url, headers: { ...t.authedWrite, ...(ifMatch ? { 'if-match': ifMatch } : {}) }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
const current = async () => (await get('/api/projects')).json();

describe('GET /api/projects', () => {
  it('returns the parsed entries, the ETag and the validation of the fixture file', async () => {
    const res = await get('/api/projects');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ path: 'article-digest.md', kind: 'ok', validation: { ok: true, errors: [] } });
    expect(body.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(['event-router', 'expense-splitter', 'ranking-notes']);
    expect(body.entries[0]).toMatchObject({ title: 'Event Router', url: 'https://github.com/alex-example/event-router', kind: 'project', tags: ['python', 'kafka'], inCv: false });
    expect(body.entries[0].bullets).toHaveLength(2);
    expect(body.entries[2].kind).toBe('article');
  });

  it('marks a project that cv.md lists as inCv', async () => {
    fs.appendFileSync(path.join(t.cfg.dataRoot, 'cv.md'), '\n## Projects\n\n- **Event Router** -- Built an event router.\n');
    const body = await current();
    expect(body.entries.find((e: { id: string }) => e.id === 'event-router').inCv).toBe(true);
    expect(body.entries.find((e: { id: string }) => e.id === 'expense-splitter').inCv).toBe(false);
  });

  it('reports a missing file as missing with no entries', async () => {
    fs.rmSync(file());
    expect(await current()).toMatchObject({ kind: 'missing', etag: null, entries: [], validation: { ok: true } });
  });
});

describe('POST /api/projects', () => {
  const entry = { title: 'Chess Engine', url: 'https://example.org/chess', tags: ['rust'], bullets: ['Wrote a chess engine in Rust.'] };

  it('appends an entry with a matching If-Match and returns the new ETag', async () => {
    const before = await current();
    const res = await send('POST', '/api/projects', entry, before.etag);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('chess-engine');
    expect(res.json().etag).toMatch(/^[0-9a-f]{64}$/);
    expect(res.json().etag).not.toBe(before.etag);
    expect(read()).toMatch(/\n---\n\n## Chess Engine -- https:\/\/example\.org\/chess\nTags: rust\n- Wrote a chess engine in Rust\.\n$/);
  });

  it('gives 422 and writes nothing for an entry with no bullets or a duplicate title', async () => {
    const before = await current();
    const text = read();
    const empty = await send('POST', '/api/projects', { ...entry, bullets: [] }, before.etag);
    expect(empty.statusCode).toBe(422);
    expect(empty.json().errors.join('\n')).toMatch(/no copy-paste points/);
    const dup = await send('POST', '/api/projects', { ...entry, title: 'event router' }, before.etag);
    expect(dup.statusCode).toBe(422);
    expect(dup.json().errors.join('\n')).toMatch(/already in the library/);
    expect(read()).toBe(text);
  });

  it('gives 422 for a title with no letter or digit, on add and on edit, writing nothing', async () => {
    const before = await current();
    const text = read();
    const add = await send('POST', '/api/projects', { ...entry, title: '!!!' }, before.etag);
    expect(add.statusCode).toBe(422);
    expect(add.json().errors.join('\n')).toMatch(/letter or digit/);
    const edit = await send('PUT', '/api/projects/event-router', { title: '!!!', bullets: ['x'] }, before.etag);
    expect(edit.statusCode).toBe(422);
    expect(read()).toBe(text);
  });

  it('gives 409 with the current file on a stale If-Match', async () => {
    const text = read();
    const res = await send('POST', '/api/projects', entry, 'deadbeef');
    expect(res.statusCode).toBe(409);
    expect(res.json().current.text).toBe(text);
    expect(read()).toBe(text);
  });

  it('creates the file when it is missing and no If-Match is sent', async () => {
    fs.rmSync(file());
    const res = await send('POST', '/api/projects', entry);
    expect(res.statusCode).toBe(200);
    expect(read()).toBe('# Projects library\n\n## Chess Engine -- https://example.org/chess\nTags: rust\n- Wrote a chess engine in Rust.\n');
  });

  it('gives 400 for a body that is not an entry', async () => {
    const before = await current();
    expect((await send('POST', '/api/projects', { title: 5 }, before.etag)).statusCode).toBe(400);
  });
});

describe('PUT /api/projects/:id', () => {
  it('replaces one entry and leaves every other byte unchanged', async () => {
    const before = await current();
    const text = read();
    const res = await send('PUT', '/api/projects/expense-splitter', { title: 'Expense Splitter', url: 'https://example.org/expense-splitter', tags: ['react'], bullets: ['Rebuilt the app.'] }, before.etag);
    expect(res.statusCode).toBe(200);
    const after = read();
    const start = text.indexOf('## [Expense Splitter]');
    const end = text.indexOf('\n\n---\n\n## Ranking Notes');
    expect(after.slice(0, start)).toBe(text.slice(0, start));
    expect(after.endsWith(text.slice(end))).toBe(true);
    expect(after).toContain('## Expense Splitter -- https://example.org/expense-splitter\nTags: react\n- Rebuilt the app.\n\n---');
  });

  it('gives 404 for an unknown id, 409 for a stale If-Match and 422 for an invalid entry, writing nothing', async () => {
    const before = await current();
    const text = read();
    expect((await send('PUT', '/api/projects/nope', { title: 'X', bullets: ['x'] }, before.etag)).statusCode).toBe(404);
    const stale = await send('PUT', '/api/projects/event-router', { title: 'Event Router', bullets: ['x'] }, 'deadbeef');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().current.text).toBe(text);
    const bad = await send('PUT', '/api/projects/event-router', { title: 'Event Router', url: 'javascript:alert(1)', bullets: ['x'] }, before.etag);
    expect(bad.statusCode).toBe(422);
    expect(read()).toBe(text);
  });
});

describe('editing an upstream digest block', () => {
  const DIGEST = [
    '# Article Digest',
    '',
    '## FraudShield -- Real-Time Fraud Detection',
    '',
    '**Hero metrics:** 99.7% precision',
    '',
    '**Key decisions:**',
    '- Chose streaming over batch',
    '',
    '**Proof points:**',
    '- Handles 10K transactions/second',
    '- Cut false positives 60%',
    '',
    '---',
    '',
    '## Nested Notes',
    '- One.',
    '  - a nested detail',
    '- Two.',
    '',
  ].join('\n');

  it('rewrites only the edited proof point and keeps the sections the form does not show', async () => {
    fs.writeFileSync(file(), DIGEST);
    const before = await current();
    const fraud = before.entries.find((e: { id: string }) => e.id === 'fraudshield');
    expect(fraud.editProblem).toBeNull();
    const res = await send('PUT', '/api/projects/fraudshield', { title: 'FraudShield', tagline: fraud.tagline, bullets: ['Handles 12K transactions/second', 'Cut false positives 60%'] }, before.etag);
    expect(res.statusCode).toBe(200);
    expect(read()).toBe(DIGEST.replace('10K', '12K'));
  });

  it('reports a block it cannot rewrite in place as not editable and refuses a PUT with 422, writing nothing', async () => {
    fs.writeFileSync(file(), DIGEST);
    const before = await current();
    const nested = before.entries.find((e: { id: string }) => e.id === 'nested-notes');
    expect(nested.editProblem).toMatch(/edit article-digest\.md directly/);
    const res = await send('PUT', '/api/projects/nested-notes', { title: 'Nested Notes', bullets: ['One.'] }, before.etag);
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0]).toMatch(/cannot be edited here/);
    expect(read()).toBe(DIGEST);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('removes one entry, and gives 404 for an unknown id and 409 for a stale If-Match', async () => {
    const before = await current();
    expect((await send('DELETE', '/api/projects/nope', {}, before.etag)).statusCode).toBe(404);
    expect((await send('DELETE', '/api/projects/event-router', {}, 'deadbeef')).statusCode).toBe(409);
    const res = await send('DELETE', '/api/projects/expense-splitter', {}, before.etag);
    expect(res.statusCode).toBe(200);
    expect((await current()).entries.map((e: { id: string }) => e.id)).toEqual(['event-router', 'ranking-notes']);
  });
});

describe('POST /api/projects/validate and /convert', () => {
  it('validates library text without writing', async () => {
    const text = read();
    const bad = await send('POST', '/api/projects/validate', { text: '## Empty\nTags: go\n' });
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toMatchObject({ ok: false });
    expect(bad.json().errors.join('\n')).toMatch(/"Empty".*no copy-paste points/);
    expect((await send('POST', '/api/projects/validate', { text: '## Fine\n- One.\n' })).json()).toMatchObject({ ok: true, entries: 1 });
    expect(read()).toBe(text);
  });

  it('converts a projects JSON into library markdown, lists titles already in the library, and writes nothing', async () => {
    const text = read();
    const json = JSON.stringify([
      { id: 'a', name: 'Event Router', description: 'Dup.', highlights: [] },
      { id: 'b', name: 'Chess Engine', url: 'https://example.org/chess', description: 'Wrote a chess engine.', highlights: ['Beat a 1,800-rated bot.'], keywords: ['rust'] },
    ]);
    const res = await send('POST', '/api/projects/convert', { format: 'json', text: json });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.duplicates).toEqual(['Event Router']);
    expect(body.markdown).toBe('## Chess Engine -- https://example.org/chess\nTags: rust\n- Wrote a chess engine.\n- Beat a 1,800-rated bot.\n');
    expect(body.entries.map((e: { title: string }) => e.title)).toEqual(['Event Router', 'Chess Engine']);
    expect(read()).toBe(text);
  });

  it('reports the errors the merged library would have, for an entry with no bullets or names repeated in the import', async () => {
    const empty = await send('POST', '/api/projects/convert', { format: 'json', text: '[{"name":"Empty","highlights":[]}]' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().errors.join('\n')).toMatch(/"Empty".*no copy-paste points/);
    const twice = await send('POST', '/api/projects/convert', { format: 'json', text: JSON.stringify([{ name: 'Kite Tracker', description: 'One.' }, { name: 'kite tracker', description: 'Two.' }]) });
    expect(twice.json().errors.join('\n')).toMatch(/duplicate/);
    const md = await send('POST', '/api/projects/convert', { format: 'markdown', text: '## Kite Tracker\n- One.\n\n## Kite  Tracker\n- Two.\n' });
    expect(md.json().errors.join('\n')).toMatch(/duplicate/);
    // What /convert calls clean, /append accepts.
    const clean = await send('POST', '/api/projects/convert', { format: 'json', text: JSON.stringify([{ name: 'Kite Tracker', description: 'One.' }]) });
    expect(clean.json().errors).toEqual([]);
    const before = await current();
    expect((await send('POST', '/api/projects/append', { markdown: clean.json().markdown }, before.etag)).statusCode).toBe(200);
  });

  it('reports errors only the append would cause, against the current library', async () => {
    fs.writeFileSync(file(), '## Broken\nTags: go\n');
    const res = await send('POST', '/api/projects/convert', { format: 'json', text: JSON.stringify([{ name: 'Kite Tracker', description: 'One.' }]) });
    expect(res.json().errors.join('\n')).toMatch(/after the append, article-digest\.md: .*"Broken"/);
  });

  it('converts pasted library markdown and gives 422 for JSON that is not a projects list', async () => {
    const md = await send('POST', '/api/projects/convert', { format: 'markdown', text: '## Chess Engine\n- Wrote it.\n' });
    expect(md.statusCode).toBe(200);
    expect(md.json()).toMatchObject({ markdown: '## Chess Engine\n- Wrote it.\n', duplicates: [] });
    const bad = await send('POST', '/api/projects/convert', { format: 'json', text: '{"basics":{}}' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatch(/projects/);
    expect((await send('POST', '/api/projects/convert', { format: 'json', text: '{ nope' })).statusCode).toBe(422);
  });
});

describe('POST /api/projects/append', () => {
  it('appends converted blocks with a matching If-Match, keeping their full text', async () => {
    const before = await current();
    const text = read();
    const markdown = '## Chess Engine\n\n**Hero metrics:** 1,800 Elo\n\n**Proof points:**\n- Wrote it in Rust.\n\n---\n\n## Kite Tracker\n- Tracked kites.\n';
    const res = await send('POST', '/api/projects/append', { markdown }, before.etag);
    expect(res.statusCode).toBe(200);
    expect(read()).toBe(`${text.replace(/\s+$/, '')}\n\n---\n\n${markdown}`);
    expect((await current()).entries.map((e: { id: string }) => e.id)).toEqual(['event-router', 'expense-splitter', 'ranking-notes', 'chess-engine', 'kite-tracker']);
  });

  it('gives 422 for blocks that would not validate and 409 for a stale If-Match, writing nothing', async () => {
    const before = await current();
    const text = read();
    const dup = await send('POST', '/api/projects/append', { markdown: '## Event Router\n- Again.\n' }, before.etag);
    expect(dup.statusCode).toBe(422);
    expect(dup.json().errors.join('\n')).toMatch(/duplicate/);
    expect((await send('POST', '/api/projects/append', { markdown: '## Kite Tracker\n- Tracked kites.\n' }, 'deadbeef')).statusCode).toBe(409);
    expect((await send('POST', '/api/projects/append', { markdown: '' }, before.etag)).statusCode).toBe(400);
    expect(read()).toBe(text);
  });
});

describe('PDF uploads enter as intake sources under documents/projects', () => {
  // A stub pdftotext, so these run where Poppler is not installed; projects-extract.test.ts covers the real one.
  let restorePath: () => void;
  beforeAll(() => {
    restorePath = installPdftotextStub().restore;
  });
  afterAll(() => restorePath());

  const upload = (name: string, body: Buffer, type = 'application/pdf') =>
    t.app.inject({ method: 'POST', url: `/api/projects/upload?name=${encodeURIComponent(name)}`, headers: { ...t.authedWrite, 'content-type': type }, payload: body });
  const docs = (...p: string[]) => path.join(t.cfg.dataRoot, 'documents', ...p);

  it('stores the PDF under documents/projects, reuses an identical copy and never overwrites a different one', async () => {
    const a = makePdf(['Kite Tracker', 'Tracked kites.']);
    const b = makePdf(['Chess Engine', 'Wrote it.']);
    const res = await upload('My Projects.pdf', a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: 'projects/My_Projects.pdf', file: 'documents/projects/My_Projects.pdf', bytes: a.length, chars: expect.any(Number) });
    expect(fs.readFileSync(docs('projects', 'My_Projects.pdf')).equals(a)).toBe(true);
    expect((await upload('My Projects.pdf', a)).json().path).toBe('projects/My_Projects.pdf');
    expect((await upload('My Projects.pdf', b)).json().path).toBe('projects/My_Projects-1.pdf');
    expect(fs.readFileSync(docs('projects', 'My_Projects.pdf')).equals(a)).toBe(true);
    expect(fs.existsSync(path.join(t.cfg.dataRoot, 'data', 'control-center', 'uploads'))).toBe(false);
  });

  it('refuses a PDF with no text layer the way intake does, and does not keep it', async () => {
    const res = await upload('scan.pdf', makePdf([]));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/no text extracted.*scanned or image-only PDF/i);
    expect(fs.existsSync(docs('projects', 'scan.pdf'))).toBe(false);
  });

  it('refuses DOCX with the reason intake gives, writing nothing', async () => {
    const res = await upload('p.docx', Buffer.from('PK'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatch(/export to PDF or \.md\/\.txt first/);
    expect(fs.existsSync(docs('projects'))).toBe(false);
  });

  it('stamps every proposed block with a Source line naming the document, replacing one the parser wrote', async () => {
    fs.mkdirSync(docs('projects'), { recursive: true });
    fs.writeFileSync(docs('projects', 'notes.md'), 'Kite Tracker: tracked kites.\n');
    const text = '## Kite Tracker\nSource: somewhere/else.pdf\nTags: python\n- Tracked kites.\n\n## Chess Engine -- https://example.org/chess\n- Wrote it.\n';
    const res = await send('POST', '/api/projects/convert', { format: 'markdown', text, source: 'projects/notes.md' });
    expect(res.statusCode).toBe(200);
    expect(res.json().markdown).toBe('## Kite Tracker\nSource: documents/projects/notes.md\nTags: python\n- Tracked kites.\n\n---\n\n## Chess Engine -- https://example.org/chess\nSource: documents/projects/notes.md\n- Wrote it.\n');
    expect(res.json().errors).toEqual([]);
  });

  it('refuses a source that is not a file under documents/', async () => {
    for (const source of ['../cv.md', 'projects/missing.pdf', '/etc/passwd']) {
      expect((await send('POST', '/api/projects/convert', { format: 'markdown', text: '## A\n- b.\n', source })).statusCode, source).toBe(400);
      expect((await send('POST', '/api/projects/append', { markdown: '## A\n- b.\n', source }, (await current()).etag)).statusCode, source).toBe(400);
    }
  });

  it('records the source as ingested with intake.mjs only after the append is written', async () => {
    fs.mkdirSync(docs('projects'), { recursive: true });
    fs.writeFileSync(docs('projects', 'notes.md'), 'Kite Tracker: tracked kites.\n');
    const state = path.join(t.cfg.dataRoot, 'data', 'intake-state.json');
    const ingested = () => (fs.existsSync(state) ? Object.keys(JSON.parse(fs.readFileSync(state, 'utf8')).ingested ?? {}) : []);
    const refused = await send('POST', '/api/projects/append', { markdown: '## Event Router\n- Again.\n', source: 'projects/notes.md' }, (await current()).etag);
    expect(refused.statusCode).toBe(422);
    expect(ingested()).toEqual([]);
    const res = await send('POST', '/api/projects/append', { markdown: '## Kite Tracker\nSource: documents/projects/notes.md\n- Tracked kites.\n', source: 'projects/notes.md' }, (await current()).etag);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, recorded: true });
    expect(ingested()).toEqual(['projects/notes.md']);
  });

  it('records nothing for an append without a source', async () => {
    const res = await send('POST', '/api/projects/append', { markdown: '## Kite Tracker\n- Tracked kites.\n' }, (await current()).etag);
    expect(res.json().recorded).toBeUndefined();
    expect(fs.existsSync(path.join(t.cfg.dataRoot, 'data', 'intake-state.json'))).toBe(false);
  });
});

describe('projects.rank action', () => {
  it('ranks the library against pasted JD text', async () => {
    const res = await send('POST', '/api/actions/projects.rank', { params: { text: 'We need Python and Kafka experience.' } });
    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    expect(result.recommended[0]).toBe('event-router');
    expect(result.excluded).toEqual([{ id: 'ranking-notes', title: 'Ranking Notes', kind: 'article' }]);
  });

  it('gives 422 when the library is invalid', async () => {
    fs.writeFileSync(file(), '## Empty\nTags: go\n');
    const res = await send('POST', '/api/actions/projects.rank', { params: { text: 'Python.' } });
    expect(res.statusCode).toBe(422);
  });
});

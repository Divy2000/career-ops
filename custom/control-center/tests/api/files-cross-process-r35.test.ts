import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { holdPeerLock, settlesWithin } from '../helpers/peer-lock.js';
import { readUserFile, USER_FILES, type UserFileKey } from '../../server/routes/files.js';

// R35-srv-core-X-02: only article-digest.md held a cross-process lock around the editor's read-compare-write. The
// other user files were compared and written with nothing held, so the two server children of a blue/green handover
// could both accept one If-Match and both answer 200, the later rename discarding the earlier save.
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('user-file saves across two server processes (R35-srv-core-X-02)', () => {
  it.each(Object.keys(USER_FILES) as UserFileKey[])('given another process saving %s, when this process saves with the ETag both read, then it waits and answers 409 without overwriting it', async (key) => {
    const file = path.join(t.cfg.dataRoot, USER_FILES[key]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${key} as both tabs loaded it\n`);
    const before = readUserFile(t.cfg.dataRoot, key);
    const peer = await holdPeerLock(t.cfg.codeRoot, file);
    try {
      const put = t.app.inject({ method: 'PUT', url: `/api/files/user/${key}`, headers: { ...t.authedWrite, 'if-match': before.etag! }, payload: { text: `# ${key} from this process\n` } });
      expect(await settlesWithin(put, 500)).toBe(false);
      await peer.release(`# ${key} from the other process\n`);
      const res = await put;
      expect(res.statusCode).toBe(409);
      expect(fs.readFileSync(file, 'utf8')).toBe(`# ${key} from the other process\n`);
    } finally {
      peer.stop();
    }
  });
});

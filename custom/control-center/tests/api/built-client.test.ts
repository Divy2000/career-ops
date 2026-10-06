// Built mode (CC_CLIENT=dist) serves the files `npm run build` wrote to dist/. A rebuild while the server runs (a Dev
// Chat turn may run it) replaces the hashed assets, and the reloaded page must load them (SW6-server-01).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

function writeBuild(dist: string, hash: string): void {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><script type="module" src="/assets/index-${hash}.js"></script>`);
  fs.writeFileSync(path.join(dist, 'assets', `index-${hash}.js`), `console.log('${hash}');`);
}

describe('built client', () => {
  it('serves the assets of a rebuild made while it runs, and answers a missing asset 404, never index.html', async () => {
    const dist = path.join(tempDir('cc-dist-'), 'dist');
    writeBuild(dist, 'old111');
    t = await makeTestApp({ client: 'dist', distDir: dist });
    const get = (url: string) => t!.app.inject({ method: 'GET', url, headers: t!.authed });
    expect((await get('/assets/index-old111.js')).statusCode).toBe(200);
    writeBuild(dist, 'new222');
    const page = await get('/');
    expect(page.body).toContain('/assets/index-new222.js');
    const asset = await get('/assets/index-new222.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.body).toBe("console.log('new222');");
    const gone = await get('/assets/index-old111.js');
    expect(gone.statusCode).toBe(404);
    expect(gone.headers['content-type']).not.toMatch(/html/);
    expect((await get('/favicon.svg')).statusCode).toBe(404);
    // A page route still gets the app.
    const route = await get('/pipeline?tab=batch');
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('index-new222.js');
  });
});

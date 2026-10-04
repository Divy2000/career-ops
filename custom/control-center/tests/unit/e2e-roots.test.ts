import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTutorials } from '../../server/domains/tutorials.js';
import { writeDemoTutorials } from '../e2e/roots.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-roots-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('writeDemoTutorials', () => {
  it('writes a demo tour with a light video and poster that the listing accepts, and a second tour with none', () => {
    writeDemoTutorials(dir);
    const { tutorials } = listTutorials(dir);
    const demo = tutorials.find((t) => t.id === 'demo-tour')!;
    expect(demo.warnings).toEqual([]);
    expect(demo.videoLight).toMatchObject({ file: 'demo-tour-light.mp4' });
    expect(demo.videoLight!.bytes).toBeGreaterThan(1000);
    expect(demo.posterLight).toMatchObject({ file: 'poster-light.jpg' });
    const second = tutorials.find((t) => t.id === 'second-tour')!;
    expect(second.videoLight).toBeNull();
  });

  it('makes the light video a different file from the dark one', () => {
    writeDemoTutorials(dir);
    const root = path.join(dir, 'data', 'control-center', 'tutorials', 'demo-tour');
    expect(fs.readFileSync(path.join(root, 'demo-tour-light.mp4')).equals(fs.readFileSync(path.join(root, 'demo-tour.mp4')))).toBe(false);
  });
});

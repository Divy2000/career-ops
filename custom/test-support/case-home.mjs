// A temp home folder on a case-insensitive volume, for specs that check a path spelled in another letter case resolves
// like the confinement resolves it (fs.realpathSync.native). Only macOS volumes are case-insensitive by default, and the
// test TMPDIR may sit on a case-sensitive one: each base is probed by creating a folder there and checking whether its
// case-flipped spelling exists. Null when none is (Linux, or only case-sensitive bases); nothing is left behind then.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Flips a letter in the folder's own name: an earlier component (/Volumes, say) can sit on another volume than the base.
const flip = (p) => {
  const dir = path.dirname(p);
  const name = path.basename(p);
  const i = name.search(/[a-z]/i);
  if (i === -1) return p;
  return path.join(dir, name.slice(0, i) + (name[i] === name[i].toLowerCase() ? name[i].toUpperCase() : name[i].toLowerCase()) + name.slice(i + 1));
};

export function caseFlippedHome({ platform = process.platform, bases = [os.tmpdir(), '/private/tmp'] } = {}) {
  if (platform !== 'darwin') return null;
  for (const base of bases) {
    let home;
    try {
      home = fs.realpathSync(fs.mkdtempSync(path.join(base, 'ci-case-home-')));
    } catch {
      continue;
    }
    const flipped = flip(home);
    if (flipped !== home && fs.existsSync(flipped)) {
      return { home, flipped, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
  return null;
}

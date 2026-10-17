import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dataRootOnly, writeFileAtomic } from '../../server/lib/atomic-write.js';
import { tempDir } from '../helpers/tmp.js';

describe('writeFileAtomic temp cleanup (R27-srv-core-L2-01)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('given the temp write fails part way (ENOSPC), when writing, then it throws and leaves no temp file beside the target', () => {
    const dir = tempDir('cc-atomic-enospc-');
    const real = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data) => {
      real(file, String(data).slice(0, 4));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    expect(() => writeFileAtomic(path.join(dir, 'cv.md'), '# CV with a long body\n', dataRootOnly(dir))).toThrow(/ENOSPC/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

// Removes every tempDir() a test file made once the file is done.
import { afterAll } from 'vitest';
import { removeTempDirs } from './helpers/tmp.js';

afterAll(() => removeTempDirs());

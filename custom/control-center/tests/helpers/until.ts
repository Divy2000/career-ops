// Polls a React test until a condition holds, letting effects and fetches settle between tries, instead of sleeping a
// fixed time and hoping the work is done. Returns the condition's value; fails with what it was waiting for.
import { act } from 'react';

export async function until<T>(fn: () => T | null | undefined | false, what: string, tries = 100): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = fn();
    if (value) return value;
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

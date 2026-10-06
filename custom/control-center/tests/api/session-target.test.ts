// Sessions > New session (and the command palette) send the Target field as the session's target. Claude only gets
// the prompt and the preamble, so a target the prompt does not already name must reach it in the first message, or
// the session runs, and pays for tokens, without it (SW-web-b-07).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function firstPrompt(payload: Record<string, unknown>): Promise<string> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sessions', headers: t.authedWrite, payload });
  expect(res.statusCode, res.body).toBe(202);
  const id = res.json().id as string;
  for (let i = 0; i < 300; i++) {
    const meta = (await t.app.inject({ method: 'GET', url: `/api/sessions/${id}`, headers: t.authed })).json().meta as { status: string; turns: Array<{ userText: string }> };
    if (!['queued', 'running'].includes(meta.status)) return meta.turns[0]!.userText;
    await wait(100);
  }
  throw new Error(`session ${id} did not settle`);
}

describe('a session target the prompt does not name', () => {
  it('given a URL target, when the session starts, then its first message names the URL', async () => {
    const prompt = await firstPrompt({ mode: 'advisor', target: { type: 'url', value: 'https://boards.greenhouse.io/acme/jobs/123' }, prompt: 'Evaluate this posting' });
    expect(prompt).toBe('Evaluate this posting\n\nTarget: https://boards.greenhouse.io/acme/jobs/123');
  });

  it('given a tracker row or a company, when the session starts, then its first message says which', async () => {
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'app', value: '3' }, prompt: 'Prepare me' })).toBe('Prepare me\n\nTarget: tracker row #3');
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'company', value: 'Acme Robotics' }, prompt: 'Research them' })).toBe('Research them\n\nTarget: company Acme Robotics');
  });

  it('given a prompt that already names its target, or no target, when the session starts, then the prompt is sent as written', async () => {
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'url', value: 'https://jobs.example.com/acme/1' }, prompt: 'Evaluate https://jobs.example.com/acme/1' })).toBe('Evaluate https://jobs.example.com/acme/1');
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'company', value: 'Acme Robotics' }, prompt: 'Is Acme Robotics sponsoring?' })).toBe('Is Acme Robotics sponsoring?');
    expect(await firstPrompt({ mode: 'advisor', prompt: 'hello' })).toBe('hello');
  });
});

describe('a row target and a number in the prompt', () => {
  it('given row 3 and a prompt that only mentions the number 3, then the row is still named', async () => {
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'app', value: '3' }, prompt: 'Give me 3 questions' })).toBe('Give me 3 questions\n\nTarget: tracker row #3');
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'app', value: '3' }, prompt: 'Prepare me for #3' })).toBe('Prepare me for #3');
  });
});

describe('a target that only appears inside a longer word or number', () => {
  it('given row 3 and a prompt that names row #30, then row 3 is still named', async () => {
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'app', value: '3' }, prompt: 'Compare with #30' })).toBe('Compare with #30\n\nTarget: tracker row #3');
  });

  it('given company Meta and a prompt that only says "Metadata", then the company is still named', async () => {
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'company', value: 'Meta' }, prompt: 'Summarize the Metadata fields' })).toBe('Summarize the Metadata fields\n\nTarget: company Meta');
  });

  it('given a company the prompt names as a word in any case, or one ending in punctuation, then nothing is added', async () => {
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'company', value: 'Meta' }, prompt: 'Is meta hiring?' })).toBe('Is meta hiring?');
    expect(await firstPrompt({ mode: 'advisor', target: { type: 'company', value: 'Stripe, Inc.' }, prompt: 'Research Stripe, Inc. today' })).toBe('Research Stripe, Inc. today');
  });
});

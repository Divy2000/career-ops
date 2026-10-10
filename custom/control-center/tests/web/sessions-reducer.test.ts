import { describe, expect, it } from 'vitest';
import { EMPTY_TRANSCRIPT, isTerminal, reduceAll, reduceEvent } from '@web/lib/sessions';
import type { StoredEvent } from '@shared/api';

const at = (seq: number, event: StoredEvent['event']): StoredEvent => ({ seq, ts: 't', event });

describe('session transcript reducer', () => {
  it('builds turns, tools, envelopes, totals and status from the normalized stream', () => {
    const t = reduceAll([
      at(1, { type: 'status', status: 'running', turn: 1 }),
      at(2, { type: 'session.init', model: 'm', tools: [], claudeSessionId: 'c' }),
      at(3, { type: 'text.delta', text: 'Hel' }),
      at(4, { type: 'text.delta', text: 'lo' }),
      at(5, { type: 'tool.use', id: 't1', name: 'Write', summary: 'reports/008.md' }),
      at(6, { type: 'tool.result', id: 't1', ok: true, summary: 'written' }),
      at(7, { type: 'envelope', kind: 'answers', payload: { fields: [] } }),
      at(8, { type: 'permission.denied', tool: 'Bash', input: {} }),
      at(9, { type: 'text.done', text: 'Hello (clean)' }),
      at(10, { type: 'turn.done', costUsd: 0.1, tokens: 50, numTurns: 1, isError: false }),
      at(11, { type: 'files.changed', paths: ['reports/008.md'] }),
      at(12, { type: 'evaluation', reports: [{ num: 8, file: '008.md', score: 4.1 }] }),
      at(13, { type: 'status', status: 'done', reason: 'report created', turn: 1 }),
      at(14, { type: 'status', status: 'running', turn: 2 }),
      at(15, { type: 'text.delta', text: 'Again' }),
      at(16, { type: 'turn.done', costUsd: 0.05, tokens: 10, numTurns: 1, isError: false }),
      at(17, { type: 'status', status: 'awaiting_user', reason: 'question', turn: 2 }),
    ]);
    expect(t.turns).toHaveLength(2);
    expect(t.turns[0]).toMatchObject({ n: 1, text: 'Hello (clean)' });
    expect(t.turns[0]!.tools[0]).toMatchObject({ id: 't1', name: 'Write', ok: true, result: 'written' });
    expect(t.turns[1]).toMatchObject({ n: 2, text: 'Again' });
    expect(t.envelopes).toEqual([{ kind: 'answers', payload: { fields: [] }, turn: 1 }]);
    expect(t.denials).toHaveLength(1);
    expect(t.files).toEqual(['reports/008.md']);
    expect(t.evaluation[0]).toMatchObject({ num: 8, score: 4.1 });
    expect(t.costUsd).toBeCloseTo(0.15);
    expect(t.tokens).toBe(60);
    expect(t.model).toBe('m');
    expect(t.status).toBe('awaiting_user');
    expect(t.reason).toBe('question');
  });

  it('hides envelopes while a turn streams, a half-written one included, and keeps the text around them (SW7-web-a-04)', () => {
    const text = (events: StoredEvent[]) => reduceAll([at(1, { type: 'status', status: 'running', turn: 1 }), ...events]).turns[0]!.text;
    expect(text([at(2, { type: 'text.delta', text: 'Found one:\n<<cc:offer {"url":"https://jobs.example.com/1","company":"C","title":"T"}>>\nLet me' })])).toBe('Found one:\nLet me');
    expect(text([at(2, { type: 'text.delta', text: 'Found one:\n<<cc:offer {"url":"https://jo' })])).toBe('Found one:\n');
    // A fenced example is the model's text, not an envelope.
    expect(text([at(2, { type: 'text.delta', text: '```\n<<cc:act {"action":"navigate","params":{}}>>\n```' })])).toBe('```\n<<cc:act {"action":"navigate","params":{}}>>\n```');
  });

  it('does not mutate the previous transcript and surfaces errors', () => {
    const first = reduceEvent(EMPTY_TRANSCRIPT, { type: 'text.delta', text: 'a' });
    const second = reduceEvent(first, { type: 'text.delta', text: 'b' });
    expect(first.turns[0]!.text).toBe('a');
    expect(second.turns[0]!.text).toBe('ab');
    expect(EMPTY_TRANSCRIPT.turns).toEqual([]);
    const errored = reduceEvent(second, { type: 'error', message: 'Keychain missing' });
    expect(errored).toMatchObject({ status: 'error', error: 'Keychain missing' });
    expect(['done', 'awaiting_user', 'error', 'cancelled'].every(isTerminal)).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });

  it('a later turn that runs clears an earlier turn\'s error, so its alert does not sit under the new answer (SW3-web-a-02)', () => {
    const t = reduceAll([
      at(1, { type: 'status', status: 'running', turn: 1 }),
      at(2, { type: 'error', message: 'the stream ended without a result event' }),
      at(3, { type: 'status', status: 'error', reason: 'the stream ended without a result event', turn: 1 }),
      at(4, { type: 'status', status: 'running', turn: 2 }),
      at(5, { type: 'text.done', text: 'Second answer.' }),
      at(6, { type: 'status', status: 'done', reason: 'clean exit with output', turn: 2 }),
    ]);
    expect(t).toMatchObject({ status: 'done', error: null });
  });

  it('an error reported during the running turn stays shown', () => {
    const t = reduceAll([at(1, { type: 'status', status: 'running', turn: 1 }), at(2, { type: 'error', message: 'claude exited 1' })]);
    expect(t).toMatchObject({ status: 'error', error: 'claude exited 1' });
  });
});

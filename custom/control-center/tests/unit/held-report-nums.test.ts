import { describe, expect, it } from 'vitest';
import { bashCommandsIn, printedReservation, toolResultsIn } from '../../server/claude/manager.js';

// R28-cl2-rev-01 review: the tool.use event keeps only a command's first 200 characters, so the manager reads which
// reserve-report-num.mjs runs a session made from the whole command in the stream line.
describe('bashCommandsIn', () => {
  const line = (blocks: unknown[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });

  it('given an assistant line with a Bash call longer than the event summary, when read, then the whole command comes back by tool id', () => {
    const command = `${' '.repeat(240)}node reserve-report-num.mjs`;
    expect(bashCommandsIn(line([{ type: 'text', text: 'Reserving.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }]))).toEqual(new Map([['toolu_1', command]]));
  });

  it('given lines that hold no Bash call, when read, then nothing comes back', () => {
    for (const l of ['not json', JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'node reserve-report-num.mjs' } }] } }), line([{ type: 'tool_use', id: 'y', name: 'Write', input: { file_path: '/x' } }]), line([{ type: 'tool_use', id: 'z', name: 'Bash', input: {} }])]) {
      expect(bashCommandsIn(l), l).toEqual(new Map());
    }
  });
});

// R28-cl2-rev-01 review: the CLI's Bash result puts stderr after stdout, so the reservation is not always the last line.
describe('printedReservation', () => {
  it('given a reserve run whose output ends in a stderr line, when read, then the printed numbers still come back', () => {
    expect(printedReservation('exit 0\n061\n(node:123) ExperimentalWarning: something')).toEqual([61]);
    expect(printedReservation('042-044\nnote: lock waited 20ms')).toEqual([42, 43, 44]);
  });

  it('given output with no reservation line, when read, then nothing comes back', () => {
    for (const out of ['', 'exit 1\nreserve-report-num: lock busy', '061 reserved']) expect(printedReservation(out), out).toEqual([]);
  });
});

// R28-cl2-rev-01 review: the tool.result event keeps only a result's first 400 characters, so stderr printed before the
// allocator's line can push the reservation out of it; the manager reads the whole result from the stream line.
describe('toolResultsIn', () => {
  const line = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content }] } });

  it('given a user line with a tool result longer than the event summary, when read, then the whole text comes back by tool id', () => {
    const text = `${'GC stale sentinel 001\n'.repeat(40)}061`;
    expect(toolResultsIn(line(text))).toEqual(new Map([['toolu_1', text]]));
    expect(toolResultsIn(line([{ type: 'text', text: 'a' }, { type: 'text', text: '061' }]))).toEqual(new Map([['toolu_1', 'a\n061']]));
  });

  it('given lines that hold no tool result, when read, then nothing comes back', () => {
    for (const l of ['not json', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '061' }] } })]) expect(toolResultsIn(l), l).toEqual(new Map());
  });
});

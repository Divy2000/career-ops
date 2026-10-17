import { describe, expect, it } from 'vitest';
import { bashCommandsIn } from '../../server/claude/manager.js';

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

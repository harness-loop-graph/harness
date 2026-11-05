import { describe, it, expect } from 'vitest';
import type { ModelRequest, ModelResponse, ToolResult } from '../src/index.js';
import { summarizeTurn, MAX_TURN_SUMMARY_CHARS } from '../src/loop/turn-summary.js';

const request = {} as ModelRequest;

function write(path: string, success = true): { response: ModelResponse; toolResult: ToolResult } {
  return {
    response: { type: 'tool_call', tool: 'write_file', args: { path, content: 'x' } },
    toolResult: { type: 'tool_result', tool: 'write_file', success, result: success ? { path, bytes: 1 } : 'boom' },
  };
}

function run(command: string, exitCode: number): { response: ModelResponse; toolResult: ToolResult } {
  return {
    response: { type: 'tool_call', tool: 'run_command', args: { command } },
    toolResult: { type: 'tool_result', tool: 'run_command', success: true, result: { exitCode, stdout: '', stderr: '' } },
  };
}

function denied(tool: string, args: Record<string, unknown>): { response: ModelResponse; toolResult: ToolResult } {
  return {
    response: { type: 'tool_call', tool, args },
    toolResult: { type: 'tool_result', tool, success: false, result: 'Denied by guardrails: nope' },
  };
}

function record(turns: Array<{ response: ModelResponse; toolResult?: ToolResult }>, finalResponse: ModelResponse) {
  return { finalResponse, turns: turns.map((t) => ({ request, ...t })) };
}

describe('summarizeTurn', () => {
  it('returns undefined when the run has no activity', () => {
    expect(summarizeTurn({ finalResponse: { type: 'finish', content: 'x' }, turns: [] })).toBeUndefined();
  });

  it('lists ending, files, commands and denials in that order', () => {
    const final: ModelResponse = { type: 'error', code: 'max_tool_rounds', message: 'Reached the limit of 8' };
    const summary = summarizeTurn(
      record(
        [
          write('src/a.ts'),
          run('npm test', 1),
          denied('run_command', { command: 'curl evil' }),
          write('src/b.ts'),
          { response: final },
        ],
        final,
      ),
    )!;

    const ended = summary.indexOf("error 'max_tool_rounds'");
    const files = summary.indexOf('src/a.ts, src/b.ts');
    const commands = summary.indexOf('npm test');
    const deniedAt = summary.indexOf('Denied tool calls: 1');
    expect(summary.startsWith('Previous turn summary')).toBe(true);
    expect(summary).toContain('Reached the limit of 8');
    expect(ended).toBeGreaterThan(-1);
    expect(files).toBeGreaterThan(ended);
    expect(commands).toBeGreaterThan(files);
    expect(deniedAt).toBeGreaterThan(commands);
    expect(summary).toContain('[exit 1] npm test');
    // The denied command is not reported as a run command.
    expect(summary).not.toContain('curl evil');
  });

  it('reports a finish ending and omits sections with nothing to say', () => {
    const final: ModelResponse = { type: 'finish', content: 'done' };
    const summary = summarizeTurn(record([write('x.txt'), { response: final }], final))!;
    expect(summary).toContain('finish');
    expect(summary).toContain('x.txt');
    expect(summary).not.toContain('Commands');
    expect(summary).not.toContain('Denied');
  });

  it('deduplicates repeated writes keeping first-write order and skips failed writes', () => {
    const final: ModelResponse = { type: 'finish', content: 'done' };
    const summary = summarizeTurn(
      record([write('a'), write('b'), write('a'), write('failed-write.ts', false), { response: final }], final),
    )!;
    expect(summary).toContain('a, b');
    expect(summary).not.toContain('failed-write.ts');
  });

  it('lists files edited with search_replace and skips failed edits', () => {
    const final: ModelResponse = { type: 'finish', content: 'done' };
    const edit = (path: string, success: boolean) => ({
      response: { type: 'tool_call', tool: 'search_replace', args: { path, search: 'a', replace: 'b' } } as ModelResponse,
      toolResult: { type: 'tool_result', tool: 'search_replace', success, result: success ? { path, replacements: 1 } : 'not found' } as ToolResult,
    });
    const summary = summarizeTurn(
      record([write('a.ts'), edit('b.ts', true), edit('missed.ts', false), { response: final }], final),
    )!;
    expect(summary).toContain('a.ts, b.ts');
    expect(summary).not.toContain('missed.ts');
  });

  it('lists files read and skills loaded so the next turn does not repeat them', () => {
    const final: ModelResponse = { type: 'finish', content: 'done' };
    const call = (tool: string, args: Record<string, unknown>, success = true) => ({
      response: { type: 'tool_call', tool, args } as ModelResponse,
      toolResult: { type: 'tool_result', tool, success, result: success ? 'ok' : 'boom' } as ToolResult,
    });
    const summary = summarizeTurn(
      record(
        [
          call('read_file', { path: 'SPEC.md' }),
          call('read_file', { path: 'SPEC.md' }),
          call('read_file', { path: 'backend/src/main.ts' }),
          call('read_file', { path: 'missing.ts' }, false),
          call('load_skill', { name: 'nestjs-best-practices' }),
          call('load_skill', { name: 'nestjs-best-practices' }),
          { response: final },
        ],
        final,
      ),
    )!;
    expect(summary).toContain('Files read: SPEC.md, backend/src/main.ts');
    expect(summary).not.toContain('missing.ts');
    expect(summary).toContain('Skills loaded: nestjs-best-practices');
    expect(summary).toMatch(/do not (re-?read|reload)/i);
  });

  it('caps files at 40 with a "+N more" marker', () => {
    const final: ModelResponse = { type: 'finish', content: 'done' };
    const writes = Array.from({ length: 45 }, (_, i) => write(`f${i}.ts`));
    const summary = summarizeTurn(record([...writes, { response: final }], final))!;
    expect(summary).toContain('f39.ts');
    expect(summary).not.toContain('f40.ts');
    expect(summary).toContain('+5 more');
  });

  it('keeps only the last 10 commands, truncating long lines', () => {
    const final: ModelResponse = { type: 'finish', content: 'done' };
    const cmds = Array.from({ length: 12 }, (_, i) => run(`cmd-${i}`, 0));
    cmds.push(run('echo ' + 'z'.repeat(1000), 2));
    const summary = summarizeTurn(record([...cmds, { response: final }], final))!;
    expect(summary).not.toContain('cmd-0');
    expect(summary).not.toContain('cmd-2 ');
    expect(summary).toContain('cmd-3');
    expect(summary).toContain('cmd-11');
    expect(summary).not.toContain('z'.repeat(400));
    expect(summary).toContain('[exit 2]');
  });

  it('never exceeds the total character budget', () => {
    const final: ModelResponse = { type: 'error', code: 'x', message: 'm'.repeat(5000) };
    const writes = Array.from({ length: 40 }, (_, i) => write(`${'d/'.repeat(30)}file-${i}.ts`));
    const cmds = Array.from({ length: 10 }, (_, i) => run(`${i} ${'c'.repeat(500)}`, 1));
    const summary = summarizeTurn(record([...writes, ...cmds, { response: final }], final))!;
    expect(summary.length).toBeLessThanOrEqual(MAX_TURN_SUMMARY_CHARS);
  });
});

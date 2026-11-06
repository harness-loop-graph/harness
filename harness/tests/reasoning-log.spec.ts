import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenAICompatibleModelAdapter } from '../src/components/openai-compatible-adapter.js';
import type { Context, ModelRequest } from '../src/contracts/core.js';

function request(): ModelRequest {
  const context: Context = { projectRoot: '/tmp/ws', files: ['a.txt'], language: 'typescript' };
  return {
    task: 'do something',
    context,
    availTools: [{ name: 'write_file', description: 'Write.', inputSchema: { type: 'object' } }],
    instructions: 'Be brief.',
    history: [],
  };
}

function reply(message: Record<string, unknown>, extra: Record<string, unknown> = {}): typeof fetch {
  return vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify({ model: 'm', provider: 'DeepInfra', choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...message } }], ...extra }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function toolCall(name: string, args: unknown): Record<string, unknown> {
  return { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

let dir: string;
let logFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'reasoning-log-'));
  logFile = path.join(dir, 'reasoning.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function adapter(fetchImpl: typeof fetch, reasoningLogFile: string | null = logFile) {
  return new OpenAICompatibleModelAdapter({
    apiKey: 'k',
    baseUrl: 'https://x.test/v1',
    model: 'm',
    fetchImpl,
    ...(reasoningLogFile !== null && { reasoningLogFile }),
  });
}

function lines(): Array<Record<string, unknown>> {
  return readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('OpenAICompatibleModelAdapter reasoning log', () => {
  it('logs message.reasoning with time, model, provider, size and a finish action', async () => {
    const res = await adapter(reply({ content: 'done', reasoning: 'Compare decimals first.' })).complete(request());
    expect(res).toEqual({ type: 'finish', content: 'done' });
    const [line] = lines();
    expect(line).toMatchObject({
      model: 'm',
      provider: 'DeepInfra',
      reasoningChars: 'Compare decimals first.'.length,
      reasoning: 'Compare decimals first.',
      action: 'finish',
    });
    expect(Number.isNaN(Date.parse(line.at as string))).toBe(false);
  });

  it('falls back to reasoning_details texts and summaries, joined', async () => {
    await adapter(
      reply({
        content: 'done',
        reasoning_details: [
          { type: 'reasoning.text', text: 'first' },
          { type: 'reasoning.summary', summary: 'second' },
          { type: 'reasoning.encrypted', data: 'xxx' },
        ],
      }),
    ).complete(request());
    expect(lines()[0].reasoning).toBe('first\nsecond');
  });

  it('prefers message.reasoning over reasoning_details', async () => {
    await adapter(reply({ content: 'x', reasoning: 'plain', reasoning_details: [{ type: 'reasoning.text', text: 'detail' }] })).complete(request());
    expect(lines()[0].reasoning).toBe('plain');
  });

  it('clips the reasoning to 2000 chars with a trailing ellipsis but reports the full size', async () => {
    await adapter(reply({ content: 'x', reasoning: 'a'.repeat(5000) })).complete(request());
    const [line] = lines();
    expect(line.reasoningChars).toBe(5000);
    expect(line.reasoning).toBe(`${'a'.repeat(2000)}…`);
  });

  it('writes nothing when there is no reasoning text', async () => {
    await adapter(reply({ content: 'x' })).complete(request());
    await adapter(reply({ content: 'x', reasoning: '', reasoning_details: [{ type: 'reasoning.encrypted', data: 'zz' }] })).complete(request());
    expect(existsSync(logFile)).toBe(false);
  });

  it('writes nothing when reasoningLogFile is not set', async () => {
    const res = await adapter(reply({ content: 'x', reasoning: 'thinking' }), null).complete(request());
    expect(res.type).toBe('finish');
    expect(existsSync(logFile)).toBe(false);
  });

  it('describes a tool call with its path', async () => {
    const res = await adapter(reply({ ...toolCall('write_file', { path: 'src/a.ts', content: 'secret body' }), reasoning: 'Need the file.' })).complete(request());
    expect(res).toEqual({ type: 'tool_call', tool: 'write_file', args: { path: 'src/a.ts', content: 'secret body' } });
    expect(lines()[0].action).toBe('tool_call write_file src/a.ts');
  });

  it('describes a tool call with its name argument (load_skill)', async () => {
    await adapter(reply({ ...toolCall('load_skill', { name: 'tdd' }), reasoning: 'r' })).complete(request());
    expect(lines()[0].action).toBe('tool_call load_skill tdd');
  });

  it('describes run_command with at most the first 200 chars of the command', async () => {
    await adapter(reply({ ...toolCall('run_command', { command: 'x'.repeat(500) }), reasoning: 'r' })).complete(request());
    expect(lines()[0].action).toBe(`tool_call run_command ${'x'.repeat(200)}`);
  });

  it('describes a tool call without path, name or command by its tool name only', async () => {
    await adapter(reply({ ...toolCall('list_files', {}), reasoning: 'r' })).complete(request());
    expect(lines()[0].action).toBe('tool_call list_files');
  });

  it('logs an error action with the error code', async () => {
    const res = await adapter(
      vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'cut', reasoning: 'long thought' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    ).complete(request());
    expect(res).toMatchObject({ type: 'error', code: 'output_truncated' });
    expect(lines()[0]).toMatchObject({ action: 'error output_truncated', reasoning: 'long thought' });
  });

  it('appends one line per completion', async () => {
    const a = adapter(reply({ content: 'x', reasoning: 'one' }));
    await a.complete(request());
    await a.complete(request());
    expect(lines()).toHaveLength(2);
  });

  it('never breaks the call when the log cannot be written', async () => {
    const bad = path.join(dir, 'missing-dir', 'reasoning.jsonl');
    const a = adapter(reply({ content: 'ok', reasoning: 'thinking' }), bad);
    await expect(a.complete(request())).resolves.toEqual({ type: 'finish', content: 'ok' });
    expect(a.getUsage().calls).toBe(1);
  });

  it('does not change the request body', async () => {
    const withLog = reply({ content: 'x', reasoning: 'r' });
    const without = reply({ content: 'x', reasoning: 'r' });
    await adapter(withLog).complete(request());
    await adapter(without, null).complete(request());
    const bodyOf = (f: typeof fetch): unknown => (vi.mocked(f).mock.calls[0][1] as RequestInit).body;
    expect(bodyOf(withLog)).toBe(bodyOf(without));
  });
});

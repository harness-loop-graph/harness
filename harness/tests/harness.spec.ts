import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelRequest, ModelResponse } from '../src/index.js';
import {
  DEFAULT_MAX_REPEATED_TOOL_CALLS,
  MAX_EMPTY_RESPONSE_RETRIES,
  Harness,
  FsContextManager,
  LocalExecutionManager,
  PolicyGuardrails,
  RegistryToolManager,
  RecordingVerificationManager,
  registerBuiltinTools,
} from '../src/index.js';
import type { HarnessOptions, ModelAdapter } from '../src/index.js';

/** Scripted model: replays a fixed sequence of responses. */
class ScriptedModelAdapter implements ModelAdapter {
  private calls = 0;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.calls];
    this.calls += 1;
    if (!response) {
      return { type: 'error', code: 'script_exhausted', message: 'No more scripted responses' };
    }
    return response;
  }
}

describe('C1 harness end-to-end', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-c1-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function buildHarness(model: ModelAdapter, options: Partial<HarnessOptions> = {}) {
    const execution = new LocalExecutionManager({ workspaceRoot: workspace, timeoutMs: 10_000 });
    const guardrails = new PolicyGuardrails(
      {
        workspaceRoot: workspace,
        allowedTools: ['write_file', 'read_file', 'search_replace', 'run_command'],
        allowedCommandPrefixes: ['npm', 'node', 'npx', 'git', 'ls', 'cat', 'echo', 'mkdir'],
        maxFileBytes: 1024 * 1024,
      },
      path.join(workspace, 'audit.jsonl'),
    );
    const tools = new RegistryToolManager(guardrails);
    const availTools = registerBuiltinTools(tools, { execution, workspaceRoot: workspace });

    return new Harness(
      {
        context: new FsContextManager(),
        model,
        tools,
        execution,
        verification: new RecordingVerificationManager(path.join(workspace, 'verifications.jsonl')),
        guardrails,
      },
      { workspaceRoot: workspace, availTools, instructions: 'Stay inside the workspace.', ...options },
    );
  }

  it('runs a full cycle: tool call -> file written -> finish', async () => {
    const model = new ScriptedModelAdapter([
      { type: 'tool_call', tool: 'write_file', args: { path: 'notes/hello.txt', content: 'hola harness' } },
      { type: 'finish', content: 'File created successfully.' },
    ]);
    const harness = buildHarness(model);

    const result = await harness.run('Create a hello note');

    expect(result.finalResponse.type).toBe('finish');
    const content = await fs.readFile(path.join(workspace, 'notes/hello.txt'), 'utf8');
    expect(content).toBe('hola harness');

    // Two model turns: the tool call and the final answer.
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0].response.type).toBe('tool_call');
    expect(result.turns[0].toolResult?.success).toBe(true);

    // The guardrail allowed the write and the audit trail records it.
    expect(result.audit.at(-1)?.decision).toBe('allowed');
    const auditOnDisk = await fs.readFile(path.join(workspace, 'audit.jsonl'), 'utf8');
    expect(auditOnDisk).toContain('"decision":"allowed"');
  });

  it('feeds the tool result back to the model as history', async () => {
    const seenRequests: ModelRequest[] = [];
    const capturing = new (class implements ModelAdapter {
      constructor(private inner: ModelAdapter) {}
      async complete(request: ModelRequest): Promise<ModelResponse> {
        seenRequests.push(request);
        return this.inner.complete(request);
      }
    })(new ScriptedModelAdapter([
      { type: 'tool_call', tool: 'write_file', args: { path: 'b.txt', content: 'y' } },
      { type: 'finish', content: 'done' },
    ]));
    const harness = buildHarness(capturing);
    await harness.run('write a file');

    expect(seenRequests[1].history).toBeDefined();
    const history = seenRequests[1].history!;
    expect(history.some((h) => h.type === 'tool_call')).toBe(true);
    expect(history.some((h) => h.type === 'tool_result')).toBe(true);
  });

  it('denies path escapes through the guardrails and reports it to the model', async () => {
    const model = new ScriptedModelAdapter([
      { type: 'tool_call', tool: 'write_file', args: { path: '../escape.txt', content: 'nope' } },
      { type: 'finish', content: 'Understood, the write was denied.' },
    ]);
    const harness = buildHarness(model);

    const result = await harness.run('try to escape');

    expect(result.turns[0].toolResult?.success).toBe(false);
    expect(String(result.turns[0].toolResult?.result)).toContain('escape');
    expect(result.audit.at(-1)?.decision).toBe('denied');
    // Nothing was written outside the workspace.
    await expect(fs.readFile(path.join(workspace, '..', 'escape.txt'))).rejects.toThrow();
  });

  it('runs an allowed command, verifies it and stores the verification', async () => {
    const model = new ScriptedModelAdapter([
      { type: 'tool_call', tool: 'run_command', args: { command: 'echo harness-live' } },
      { type: 'finish', content: 'Command executed.' },
    ]);
    const harness = buildHarness(model);

    const result = await harness.run('echo something');

    const toolResult = result.turns[0].toolResult;
    expect(toolResult?.success).toBe(true);
    const execution = toolResult?.result as { stdout: string };
    expect(execution.stdout.trim()).toBe('harness-live');

    // The execution went through the verification manager.
    expect(result.turns[0].verification?.passed).toBe(true);
    expect(result.verifications).toHaveLength(1);
  });

  it('denies commands outside the allowed prefix list', async () => {
    const model = new ScriptedModelAdapter([
      { type: 'tool_call', tool: 'run_command', args: { command: 'curl http://example.com' } },
      { type: 'finish', content: 'ok' },
    ]);
    const harness = buildHarness(model);

    const result = await harness.run('run curl');

    expect(result.turns[0].toolResult?.success).toBe(false);
    expect(String(result.turns[0].toolResult?.result)).toContain('Denied by guardrails');
    expect(result.audit.at(-1)?.decision).toBe('denied');
  });

  it('returns a max_tool_rounds error when the model never finishes', async () => {
    const model = new ScriptedModelAdapter([
      { type: 'tool_call', tool: 'write_file', args: { path: 'c.txt', content: 'z' } },
      { type: 'tool_call', tool: 'write_file', args: { path: 'd.txt', content: 'z' } },
    ]);
    const harness = buildHarness(model);

    const result = await harness.run('never finish');

    expect(result.finalResponse.type).toBe('error');
    if (result.finalResponse.type === 'error') {
      expect(result.finalResponse.code).toBe('max_tool_rounds');
    }
  });

  describe('empty response retry', () => {
    const empty: ModelResponse = {
      type: 'error',
      code: 'empty_content',
      message: 'The model returned neither content nor tool calls',
    };
    const write = { type: 'tool_call', tool: 'write_file', args: { path: 'e.txt', content: 'x' } } as const;
    const write2 = { type: 'tool_call', tool: 'write_file', args: { path: 'f.txt', content: 'y' } } as const;
    const NUDGE =
      'Your previous reply contained no content and no tool call. Continue the task now: call a tool, or give your final answer if the task is complete.';

    it('retries up to 2 consecutive empty replies', () => {
      expect(MAX_EMPTY_RESPONSE_RETRIES).toBe(2);
    });

    it('nudges once after an empty reply, then continues normally', async () => {
      const model = new ScriptedModelAdapter([empty, write, { type: 'finish', content: 'done' }]);
      const harness = buildHarness(model);

      const result = await harness.run('flaky model', { maxToolRounds: 5 });

      expect(result.finalResponse).toEqual({ type: 'finish', content: 'done' });
      expect(model.requests).toHaveLength(3);
      expect(model.requests[0].nudge).toBeUndefined();
      expect(model.requests[1].nudge).toBe(NUDGE);
      expect(model.requests[2].nudge).toBeUndefined();
      expect(result.turns[0].response).toEqual(empty);
      expect(model.requests[1].history).toEqual([]);
    });

    it('ends with empty_content after 3 consecutive empty replies', async () => {
      const model = new ScriptedModelAdapter([empty, empty, empty, { type: 'finish', content: 'never reached' }]);
      const harness = buildHarness(model);

      const result = await harness.run('hopeless model', { maxToolRounds: 10 });

      expect(result.finalResponse).toEqual(empty);
      expect(model.requests).toHaveLength(3);
      expect(model.requests.map((r) => r.nudge)).toEqual([undefined, NUDGE, NUDGE]);
      expect(result.turns).toHaveLength(3);
    });

    it('resets the retry counter after a non-empty reply', async () => {
      const model = new ScriptedModelAdapter([empty, write, empty, { type: 'finish', content: 'done' }]);
      const harness = buildHarness(model);

      const result = await harness.run('flaky twice', { maxToolRounds: 10 });

      expect(result.finalResponse).toEqual({ type: 'finish', content: 'done' });
      expect(model.requests.map((r) => r.nudge)).toEqual([undefined, NUDGE, undefined, NUDGE]);
    });

    it('does not retry other errors', async () => {
      const apiError: ModelResponse = { type: 'error', code: 'http_500', message: 'boom' };
      const model = new ScriptedModelAdapter([apiError, { type: 'finish', content: 'never reached' }]);
      const harness = buildHarness(model);

      const result = await harness.run('api failure', { maxToolRounds: 10 });

      expect(result.finalResponse).toEqual(apiError);
      expect(model.requests).toHaveLength(1);
    });

    it('spends a tool round on each retry: maxToolRounds 1 allows a single retry', async () => {
      const model = new ScriptedModelAdapter([empty, empty, { type: 'finish', content: 'never reached' }]);
      const harness = buildHarness(model);

      const result = await harness.run('tight budget', { maxToolRounds: 1 });

      expect(result.finalResponse).toEqual(empty);
      expect(model.requests).toHaveLength(2);
    });

    it('does not retry at all when maxToolRounds is 0', async () => {
      const model = new ScriptedModelAdapter([empty, { type: 'finish', content: 'never reached' }]);
      const harness = buildHarness(model);

      const result = await harness.run('no rounds', { maxToolRounds: 0 });

      expect(result.finalResponse).toEqual(empty);
      expect(model.requests).toHaveLength(1);
    });

    it('lets the retry recover within the budget but reports max_tool_rounds if it then calls a tool', async () => {
      const model = new ScriptedModelAdapter([empty, write2, { type: 'finish', content: 'never reached' }]);
      const harness = buildHarness(model);

      const result = await harness.run('tight budget', { maxToolRounds: 1 });

      expect(result.finalResponse.type === 'error' && result.finalResponse.code).toBe('max_tool_rounds');
      expect(model.requests).toHaveLength(2);
    });

    it('sends feedback only on the first request, not on the nudged one', async () => {
      const model = new ScriptedModelAdapter([empty, { type: 'finish', content: 'done' }]);
      const harness = buildHarness(model);

      await harness.run('retry with feedback', { maxToolRounds: 5, feedback: 'previous attempt failed' });

      expect(model.requests[0].feedback).toBe('previous attempt failed');
      expect(model.requests[1].feedback).toBeUndefined();
      expect(model.requests[1].nudge).toBe(NUDGE);
    });
  });

  describe('repeated tool call cap', () => {
    const readA = { type: 'tool_call', tool: 'read_file', args: { path: 'a.txt' } } as const;
    const readB = { type: 'tool_call', tool: 'read_file', args: { path: 'b.txt' } } as const;

    function executedCalls(result: Awaited<ReturnType<Harness['run']>>): number {
      return result.turns.filter((turn) => turn.toolResult !== undefined).length;
    }

    it('defaults to 3 identical consecutive calls', () => {
      expect(DEFAULT_MAX_REPEATED_TOOL_CALLS).toBe(3);
    });

    it('stops before executing the 3rd identical consecutive call', async () => {
      const model = new ScriptedModelAdapter([readA, readA, readA, { type: 'finish', content: 'never reached' }]);
      const harness = buildHarness(model);

      const result = await harness.run('loop forever', { maxToolRounds: 10 });

      expect(result.finalResponse.type).toBe('error');
      if (result.finalResponse.type === 'error') {
        expect(result.finalResponse.code).toBe('repeated_tool_call');
        expect(result.finalResponse.message).toContain('read_file');
        expect(result.finalResponse.message).toContain('3 times in a row');
        expect(result.finalResponse.message).toContain('identical arguments');
      }
      expect(executedCalls(result)).toBe(2);
      expect(result.audit).toHaveLength(2);
      // 3 model turns + the recorded error turn, same shape as max_tool_rounds
      expect(result.turns).toHaveLength(4);
      expect(result.turns[3].response).toEqual(result.finalResponse);
    });

    it('treats argument key order as irrelevant', async () => {
      const model = new ScriptedModelAdapter([
        { type: 'tool_call', tool: 'run_command', args: { command: 'ls', cwd: '.' } },
        { type: 'tool_call', tool: 'run_command', args: { cwd: '.', command: 'ls' } },
        { type: 'tool_call', tool: 'run_command', args: { command: 'ls', cwd: '.' } },
      ]);
      const harness = buildHarness(model);

      const result = await harness.run('loop forever', { maxToolRounds: 10 });

      expect(result.finalResponse.type === 'error' && result.finalResponse.code).toBe('repeated_tool_call');
      expect(executedCalls(result)).toBe(2);
    });

    it('resets the counter when a different call comes in between', async () => {
      const model = new ScriptedModelAdapter([readA, readA, readB, readA, readA, { type: 'finish', content: 'done' }]);
      const harness = buildHarness(model);

      const result = await harness.run('varied calls', { maxToolRounds: 10 });

      expect(result.finalResponse.type).toBe('finish');
      expect(executedCalls(result)).toBe(5);
    });

    it('does not treat the same tool with different args as a repeat', async () => {
      const model = new ScriptedModelAdapter([readA, readB, readA, readB, { type: 'finish', content: 'done' }]);
      const harness = buildHarness(model);

      const result = await harness.run('alternating calls', { maxToolRounds: 10 });

      expect(result.finalResponse.type).toBe('finish');
      expect(executedCalls(result)).toBe(4);
    });

    it('honours a custom maxRepeatedToolCalls', async () => {
      const model = new ScriptedModelAdapter([readA, readA, { type: 'finish', content: 'never reached' }]);
      const harness = buildHarness(model, { maxRepeatedToolCalls: 2 });

      const result = await harness.run('loop forever', { maxToolRounds: 10 });

      expect(result.finalResponse.type === 'error' && result.finalResponse.code).toBe('repeated_tool_call');
      if (result.finalResponse.type === 'error') {
        expect(result.finalResponse.message).toContain('2 times in a row');
      }
      expect(executedCalls(result)).toBe(1);
    });

    it('lets max_tool_rounds win when the round limit is reached first', async () => {
      const model = new ScriptedModelAdapter([readA, readA]);
      const harness = buildHarness(model);

      const result = await harness.run('limited', { maxToolRounds: 1 });

      expect(result.finalResponse.type === 'error' && result.finalResponse.code).toBe('max_tool_rounds');
    });

    it.each([1, 0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'throws in the constructor for an invalid maxRepeatedToolCalls (%s)',
      (value) => {
        expect(() => buildHarness(new ScriptedModelAdapter([]), { maxRepeatedToolCalls: value })).toThrow(
          /maxRepeatedToolCalls/,
        );
      },
    );
  });
});

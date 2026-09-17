import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelRequest, ModelResponse } from '../src/index.js';
import {
  Harness,
  FsContextManager,
  LocalExecutionManager,
  PolicyGuardrails,
  RegistryToolManager,
  RecordingVerificationManager,
  registerBuiltinTools,
} from '../src/index.js';
import type { ModelAdapter } from '../src/index.js';

/** Scripted model: replays a fixed sequence of responses. */
class ScriptedModelAdapter implements ModelAdapter {
  private calls = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
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

  function buildHarness(model: ModelAdapter) {
    const execution = new LocalExecutionManager({ workspaceRoot: workspace, timeoutMs: 10_000 });
    const guardrails = new PolicyGuardrails(
      {
        workspaceRoot: workspace,
        allowedTools: ['write_file', 'read_file', 'run_command'],
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
      { workspaceRoot: workspace, availTools, instructions: 'Stay inside the workspace.' },
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
});

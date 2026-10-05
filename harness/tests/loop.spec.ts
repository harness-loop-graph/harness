import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelRequest, ModelResponse } from '../src/index.js';
import {
  AgentLoop,
  FsContextManager,
  Harness,
  LocalExecutionManager,
  PolicyGuardrails,
  RegistryToolManager,
  RecordingVerificationManager,
  registerBuiltinTools,
} from '../src/index.js';
import type { ModelAdapter } from '../src/index.js';

/**
 * Model that plays a script PER LOOP TURN: each entry is the list of
 * responses the model gives during that turn's harness run.
 */
class TurnScriptedModelAdapter implements ModelAdapter {
  private turn = 0;
  private callInTurn = 0;
  readonly seenRequests: ModelRequest[] = [];

  constructor(private readonly script: ModelResponse[][]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.seenRequests.push(request);
    const responses = this.script[this.turn] ?? [];
    const response = responses[this.callInTurn] ?? { type: 'error', code: 'script_exhausted', message: 'no more scripted responses' };
    this.callInTurn += 1;
    return response;
  }

  /** Called by the loop between turns (via harness run boundaries). */
  advanceTurn(): void {
    this.turn += 1;
    this.callInTurn = 0;
  }
}

describe('C2 corrective loop', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-c2-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function buildLoop(model: ModelAdapter) {
    const execution = new LocalExecutionManager({ workspaceRoot: workspace, timeoutMs: 10_000 });
    const guardrails = new PolicyGuardrails({
      workspaceRoot: workspace,
      allowedTools: ['write_file', 'read_file', 'run_command'],
      allowedCommandPrefixes: ['npm', 'node', 'npx', 'git', 'ls', 'cat', 'echo', 'mkdir', 'test'],
      maxFileBytes: 1024 * 1024,
    });
    const tools = new RegistryToolManager(guardrails);
    const availTools = registerBuiltinTools(tools, { execution, workspaceRoot: workspace });
    const verification = new RecordingVerificationManager();

    const harness = new Harness(
      {
        context: new FsContextManager(),
        model,
        tools,
        execution,
        verification,
        guardrails,
      },
      { workspaceRoot: workspace, availTools, instructions: 'Stay inside the workspace.' },
    );

    return new AgentLoop({ harness, execution, verification, workspaceRoot: workspace });
  }

  it('FINISH on first turn when the model produces a passing workspace', async () => {
    const model = new TurnScriptedModelAdapter([
      [
        { type: 'tool_call', tool: 'write_file', args: { path: 'out.txt', content: 'ok' } },
        { type: 'finish', content: 'Created out.txt' },
      ],
    ]);
    const loop = buildLoop(model);

    const result = await loop.run({
      task: 'Create out.txt with content "ok"',
      maxTurns: 3,
      verification: { command: 'test -f out.txt' },
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.turns).toBe(1);
    expect(result.decision.action).toBe('FINISH');
    expect(result.trace[0].verification?.passed).toBe(true);
  });

  it('RETRY: failed verification produces feedback that reaches the next turn', async () => {
    const model = new TurnScriptedModelAdapter([
      // Turn 1: the model claims done but writes nothing -> verification fails.
      [{ type: 'finish', content: 'I am done' }],
      // Turn 2: corrected attempt writes the file.
      [
        { type: 'tool_call', tool: 'write_file', args: { path: 'out.txt', content: 'fixed' } },
        { type: 'finish', content: 'Fixed it' },
      ],
    ]);
    const loop = buildLoop(model);

    // Advance the script between harness turns by watching feedback: the
    // harness calls complete() again with feedback on the retry turn.
    const originalComplete = model.complete.bind(model);
    let sawFeedback = false;
    (model as TurnScriptedModelAdapter).complete = async (request: ModelRequest) => {
      if (request.feedback && !sawFeedback) {
        sawFeedback = true;
        model.advanceTurn();
      }
      return originalComplete(request);
    };

    const result = await loop.run({
      task: 'Create out.txt',
      maxTurns: 3,
      verification: { command: 'test -f out.txt' },
    });

    expect(sawFeedback).toBe(true);
    expect(result.status).toBe('SUCCESS');
    expect(result.turns).toBe(2);
    expect(result.trace[0].decision.action).toBe('RETRY');
    expect(result.trace[0].verification?.passed).toBe(false);
    expect(result.trace[1].decision.action).toBe('FINISH');
    // The file exists after the corrective turn.
    const content = await fs.readFile(path.join(workspace, 'out.txt'), 'utf8');
    expect(content).toBe('fixed');
  });

  it('FAIL when maxTurns is exhausted without a passing verification', async () => {
    const model = new TurnScriptedModelAdapter([
      [{ type: 'finish', content: 'done (but nothing happened)' }],
      [{ type: 'finish', content: 'done again (still nothing)' }],
    ]);
    const loop = buildLoop(model);

    let calls = 0;
    const originalComplete = model.complete.bind(model);
    (model as TurnScriptedModelAdapter).complete = async (request: ModelRequest) => {
      calls += 1;
      if (calls === 2) model.advanceTurn();
      return originalComplete(request);
    };

    const result = await loop.run({
      task: 'Create out.txt',
      maxTurns: 2,
      verification: { command: 'test -f out.txt' },
    });

    expect(result.status).toBe('FAILED');
    expect(result.turns).toBe(2);
    expect(result.decision.action).toBe('FAIL');
    expect(result.failure).toContain('max_turns');
    expect(result.verifications).toHaveLength(2);
    expect(result.verifications.every((v) => !v.passed)).toBe(true);
  });

  it('RETRY after a model error, then SUCCESS', async () => {
    const model = new TurnScriptedModelAdapter([
      [{ type: 'error', code: 'max_tool_rounds', message: 'ran out of rounds' }],
      [
        { type: 'tool_call', tool: 'write_file', args: { path: 'out.txt', content: 'ok' } },
        { type: 'finish', content: 'Created' },
      ],
    ]);
    const loop = buildLoop(model);

    let calls = 0;
    const originalComplete = model.complete.bind(model);
    (model as TurnScriptedModelAdapter).complete = async (request: ModelRequest) => {
      calls += 1;
      if (calls === 2) model.advanceTurn();
      return originalComplete(request);
    };

    const result = await loop.run({
      task: 'Create out.txt',
      maxTurns: 3,
      verification: { command: 'test -f out.txt' },
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.turns).toBe(2);
    expect(result.trace[0].decision.action).toBe('RETRY');
  });

  it('accepts a finish without verification configured', async () => {
    const model = new TurnScriptedModelAdapter([[{ type: 'finish', content: 'done' }]]);
    const loop = buildLoop(model);

    const result = await loop.run({ task: 'Do something', maxTurns: 2 });

    expect(result.status).toBe('SUCCESS');
    expect(result.turns).toBe(1);
    expect(result.decision.reason).toContain('no verification');
    expect(result.verifications).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import {
  StubModelAdapter,
  StubGuardrails,
  StubContextManager,
  StubToolManager,
  StubExecutionManager,
  StubVerificationManager,
} from '../src/index.js';
import type { ModelRequest, Context, ToolSpec, ExecutionRequest, ExecutionResult } from '../src/index.js';

describe('C1 harness contracts', () => {
  it('stub model adapter returns a valid finish response', async () => {
    const adapter = new StubModelAdapter();
    const context: Context = { projectRoot: '.', files: [] };
    const request: ModelRequest = {
      task: 'write a test',
      context,
      availTools: [],
    };

    const response = await adapter.complete(request);

    expect(response.type).toBe('finish');
    if (response.type === 'finish') {
      expect(typeof response.content).toBe('string');
    }
  });

  it('stub guardrail allows whitelisted tools and denies others', async () => {
    const guardrails = new StubGuardrails();

    const allowed = await guardrails.evaluate({ kind: 'tool', tool: 'read_file', args: {} });
    expect(allowed.decision).toBe('allowed');

    const denied = await guardrails.evaluate({ kind: 'tool', tool: 'delete', args: {} });
    expect(denied.decision).toBe('denied');

    const log = guardrails.getAuditLog();
    expect(log).toHaveLength(2);
  });

  it('stub context manager prepares a context object', async () => {
    const manager = new StubContextManager();
    const ctx = await manager.prepare('add feature', '/tmp/project');

    expect(ctx.projectRoot).toBe('/tmp/project');
    expect(Array.isArray(ctx.files)).toBe(true);
  });

  it('stub tool manager registers and executes tools', async () => {
    const manager = new StubToolManager();
    const spec: ToolSpec = { name: 'echo', description: 'Echo', inputSchema: {} };
    manager.register(spec);

    const result = await manager.execute({ type: 'tool_call', tool: 'echo', args: { msg: 'hi' } });
    expect(result.success).toBe(true);
    expect(result.tool).toBe('echo');
  });

  it('stub execution manager returns an execution result', async () => {
    const manager = new StubExecutionManager();
    const req: ExecutionRequest = { command: 'echo hello', cwd: '.' };
    const result: ExecutionResult = await manager.run(req);

    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
  });

  it('stub verification manager evaluates execution results', async () => {
    const manager = new StubVerificationManager();
    const passed = await manager.verify({ exitCode: 0, stdout: '', stderr: '' });
    expect(passed.passed).toBe(true);

    const failed = await manager.verify({ exitCode: 1, stdout: '', stderr: 'error' });
    expect(failed.passed).toBe(false);
  });
});

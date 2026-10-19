import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalExecutionManager, PolicyGuardrails, RegistryToolManager, registerBuiltinTools } from '../src/index.js';

describe('run_command builtin tool', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-run-command-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function setup() {
    const guardrails = new PolicyGuardrails({
      workspaceRoot: workspace,
      allowedTools: ['run_command'],
      allowedCommandPrefixes: ['cd', 'mkdir', 'pwd'],
      maxFileBytes: 1024,
    });
    const tools = new RegistryToolManager(guardrails);
    const specs = registerBuiltinTools(tools, {
      execution: new LocalExecutionManager({ workspaceRoot: workspace, timeoutMs: 10_000 }),
      workspaceRoot: workspace,
    });
    return { tools, spec: specs.find((s) => s.name === 'run_command')! };
  }

  it('tells the model every call starts at the workspace root and cd does not persist', () => {
    const { spec } = setup();
    expect(spec.description).toMatch(/new shell/i);
    expect(spec.description).toMatch(/workspace root/i);
    expect(spec.description).toMatch(/cd.*does not persist/i);
  });

  it('really starts each call at the workspace root (the behavior the description documents)', async () => {
    const { tools } = setup();
    await fs.mkdir(path.join(workspace, 'backend'));
    await tools.execute({ tool: 'run_command', args: { command: 'cd backend' } });
    await tools.execute({ tool: 'run_command', args: { command: 'mkdir -p made-here' } });
    await expect(fs.stat(path.join(workspace, 'made-here'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(workspace, 'backend', 'made-here'))).rejects.toThrow();
  });
});

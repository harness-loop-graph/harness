import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_ALLOWED_TOOLS,
  LocalExecutionManager,
  PolicyGuardrails,
  RegistryToolManager,
  registerBuiltinTools,
} from '../src/index.js';

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

describe('search_replace builtin tool', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-search-replace-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function setup(maxFileBytes = 1024) {
    const guardrails = new PolicyGuardrails({
      workspaceRoot: workspace,
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      allowedCommandPrefixes: [],
      maxFileBytes,
    });
    const tools = new RegistryToolManager(guardrails);
    const specs = registerBuiltinTools(tools, {
      execution: new LocalExecutionManager({ workspaceRoot: workspace, timeoutMs: 10_000 }),
      workspaceRoot: workspace,
    });
    return { tools, specs, guardrails };
  }

  async function seed(content: string): Promise<string> {
    const file = path.join(workspace, 'a.txt');
    await fs.writeFile(file, content, 'utf8');
    return file;
  }

  it('is listed in the returned specs and tells the model to prefer it over write_file', () => {
    const { specs } = setup();
    const spec = specs.find((s) => s.name === 'search_replace');
    expect(spec).toBeDefined();
    expect(spec!.description).toMatch(/prefer/i);
    expect(spec!.description).toMatch(/write_file/);
    expect(spec!.inputSchema.required).toEqual(['path', 'search', 'replace']);
  });

  it('replaces a unique match', async () => {
    const { tools } = setup();
    const file = await seed('alpha beta gamma');
    const result = await tools.execute({
      tool: 'search_replace',
      args: { path: 'a.txt', search: 'beta', replace: 'BETA' },
    });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ path: 'a.txt', replacements: 1 });
    expect(await fs.readFile(file, 'utf8')).toBe('alpha BETA gamma');
  });

  it('fails and leaves the file untouched when the text is not found', async () => {
    const { tools } = setup();
    const file = await seed('alpha beta');
    const result = await tools.execute({
      tool: 'search_replace',
      args: { path: 'a.txt', search: 'delta', replace: 'x' },
    });
    expect(result.success).toBe(false);
    expect(String(result.result)).toMatch(/not found/i);
    expect(String(result.result)).toMatch(/read the file again/i);
    expect(await fs.readFile(file, 'utf8')).toBe('alpha beta');
  });

  it('fails with the occurrence count when the text matches more than once', async () => {
    const { tools } = setup();
    const file = await seed('x = 1;\nx = 1;\nx = 1;\n');
    const result = await tools.execute({
      tool: 'search_replace',
      args: { path: 'a.txt', search: 'x = 1;', replace: 'x = 2;' },
    });
    expect(result.success).toBe(false);
    expect(String(result.result)).toMatch(/3 occurrences/);
    expect(String(result.result)).toMatch(/surrounding context/i);
    expect(await fs.readFile(file, 'utf8')).toBe('x = 1;\nx = 1;\nx = 1;\n');
  });

  it('inserts $-patterns in the replacement literally', async () => {
    const { tools } = setup();
    const file = await seed('price: PLACEHOLDER');
    const result = await tools.execute({
      tool: 'search_replace',
      args: { path: 'a.txt', search: 'PLACEHOLDER', replace: '$& $1 $$ $`' },
    });
    expect(result.success).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('price: $& $1 $$ $`');
  });

  it('deletes the text when replace is the empty string', async () => {
    const { tools } = setup();
    const file = await seed('keep REMOVE keep');
    const result = await tools.execute({
      tool: 'search_replace',
      args: { path: 'a.txt', search: 'REMOVE ', replace: '' },
    });
    expect(result.success).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('keep keep');
  });

  it('rejects an empty search string', async () => {
    const { tools } = setup();
    await seed('abc');
    const result = await tools.execute({
      tool: 'search_replace',
      args: { path: 'a.txt', search: '', replace: 'x' },
    });
    expect(result.success).toBe(false);
    expect(String(result.result)).toMatch(/search/);
  });

  it('rejects a missing replace argument', async () => {
    const { tools } = setup();
    await seed('abc');
    const result = await tools.execute({ tool: 'search_replace', args: { path: 'a.txt', search: 'a' } });
    expect(result.success).toBe(false);
    expect(String(result.result)).toMatch(/replace/);
  });

  it('is allowed by default and confined to the workspace like write_file', async () => {
    const { guardrails } = setup();
    expect(DEFAULT_ALLOWED_TOOLS).toContain('search_replace');
    const inside = await guardrails.evaluate({
      kind: 'tool',
      tool: 'search_replace',
      args: { path: 'src/a.txt', search: 'a', replace: 'b' },
    });
    expect(inside.decision).toBe('allowed');
    const outside = await guardrails.evaluate({
      kind: 'tool',
      tool: 'search_replace',
      args: { path: '../escape.txt', search: 'a', replace: 'b' },
    });
    expect(outside.decision).toBe('denied');
    const missing = await guardrails.evaluate({
      kind: 'tool',
      tool: 'search_replace',
      args: { search: 'a', replace: 'b' },
    });
    expect(missing.decision).toBe('denied');
  });

  it('denies a replacement larger than the write size limit', async () => {
    const { guardrails } = setup(10);
    const decision = await guardrails.evaluate({
      kind: 'tool',
      tool: 'search_replace',
      args: { path: 'a.txt', search: 'a', replace: 'x'.repeat(11) },
    });
    expect(decision.decision).toBe('denied');
    expect(decision.reason).toMatch(/exceeds the limit/);
  });
});

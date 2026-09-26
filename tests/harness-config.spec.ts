import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHarnessConfig, wireHarnessConfig } from '../src/harness-config.js';
import { McpToolProvider } from '../src/components/mcp-tool-provider.js';
import { RegistryToolManager } from '../src/components/tool-manager.js';
import { StubGuardrails } from '../src/components/guardrails.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_CONFIG = path.resolve(__dirname, '..', 'examples', 'harness-config.json');

describe('loadHarnessConfig', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-config-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('resolves mcpServers and skillsDirs relative to the config file', async () => {
    const config = await loadHarnessConfig(EXAMPLE_CONFIG);
    expect(config.mcpServers.fixture.command).toBe('node');
    expect(config.mcpServers.fixture.args?.[0]).toContain('mcp-fixture-server.mjs');
    expect(config.skillsDirs).toEqual([path.resolve(path.dirname(EXAMPLE_CONFIG), 'skills')]);
  });

  it('errors clearly on missing file', async () => {
    await expect(loadHarnessConfig(path.join(workspace, 'missing.json'))).rejects.toThrow(/Cannot read harness config/);
  });

  it('errors clearly on invalid JSON', async () => {
    const file = path.join(workspace, 'bad.json');
    await fs.writeFile(file, '{ not json');
    await expect(loadHarnessConfig(file)).rejects.toThrow(/not valid JSON/);
  });

  it('errors clearly when a server is missing a command', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(file, JSON.stringify({ mcpServers: { bad: {} } }));
    await expect(loadHarnessConfig(file)).rejects.toThrow(/must have a non-empty 'command'/);
  });

  it('errors clearly when args is not an array of strings', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(file, JSON.stringify({ mcpServers: { bad: { command: 'node', args: ['ok', 42] } } }));
    await expect(loadHarnessConfig(file)).rejects.toThrow(/mcpServers\.bad\.args must be an array of strings/);
  });

  it('errors clearly when env is not a string record', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(file, JSON.stringify({ mcpServers: { bad: { command: 'node', env: { KEY: 1 } } } }));
    await expect(loadHarnessConfig(file)).rejects.toThrow(/mcpServers\.bad\.env must be an object of string values/);
  });

  it('errors clearly when cwd is not a string', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(file, JSON.stringify({ mcpServers: { bad: { command: 'node', cwd: 123 } } }));
    await expect(loadHarnessConfig(file)).rejects.toThrow(/mcpServers\.bad\.cwd must be a string/);
  });
});

describe('wireHarnessConfig', () => {
  const wired: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(wired.splice(0).map((w) => w.close()));
  });

  it('registers MCP tools and load_skill, and returns allowed tool names + close()', async () => {
    const config = await loadHarnessConfig(EXAMPLE_CONFIG);
    const manager = new RegistryToolManager(new StubGuardrails());
    const result = await wireHarnessConfig(config, manager);
    wired.push(result);

    expect(result.allowedToolNames).toEqual(expect.arrayContaining(['mcp__fixture__echo', 'mcp__fixture__fail', 'load_skill']));
    expect(result.catalog?.list()).toEqual([
      { name: 'greeter', description: 'Write a friendly greeting file when the task asks for one' },
    ]);

    const guardrails = new StubGuardrails(result.allowedToolNames);
    const manager2 = new RegistryToolManager(guardrails);
    const result2 = await wireHarnessConfig(config, manager2);
    wired.push(result2);
    const skillResult = await manager2.execute({ type: 'tool_call', tool: 'load_skill', args: { name: 'greeter' } });
    expect(skillResult.success).toBe(true);
  });

  it('denies MCP and load_skill tool calls when the guardrail allowlist omits them, recording denials in the audit log', async () => {
    const config = await loadHarnessConfig(EXAMPLE_CONFIG);
    const guardrails = new StubGuardrails([]); // allowlist omits every MCP/skill tool
    const manager = new RegistryToolManager(guardrails);
    const result = await wireHarnessConfig(config, manager);
    wired.push(result);

    const mcpResult = await manager.execute({ type: 'tool_call', tool: 'mcp__fixture__echo', args: { text: 'hi' } });
    const skillResult = await manager.execute({ type: 'tool_call', tool: 'load_skill', args: { name: 'greeter' } });

    expect(mcpResult.success).toBe(false);
    expect(String(mcpResult.result)).toContain('Denied by guardrails');
    expect(skillResult.success).toBe(false);
    expect(String(skillResult.result)).toContain('Denied by guardrails');

    const denials = guardrails.getAuditLog().filter((d) => d.decision === 'denied');
    expect(denials.length).toBe(2);
  });

  it('closes the MCP provider when SkillCatalog.load() fails after a successful connect()', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wire-fail-'));
    try {
      const file = path.join(workspace, 'config.json');
      await fs.writeFile(
        file,
        JSON.stringify({
          mcpServers: {
            fixture: { command: 'node', args: [path.resolve(__dirname, 'fixtures', 'mcp-fixture-server.mjs')] },
          },
          skillsDirs: ['./no-such-skills-dir'],
        }),
      );
      const config = await loadHarnessConfig(file);
      const manager = new RegistryToolManager(new StubGuardrails());
      const closeSpy = vi.spyOn(McpToolProvider.prototype, 'close');

      await expect(wireHarnessConfig(config, manager)).rejects.toThrow(/Cannot read skills directory/);
      expect(closeSpy).toHaveBeenCalledTimes(1);

      closeSpy.mockRestore();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

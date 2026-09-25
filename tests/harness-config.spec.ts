import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHarnessConfig, wireHarnessConfig } from '../src/harness-config.js';
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
});

describe('wireHarnessConfig', () => {
  it('registers MCP tools and load_skill, and returns allowed tool names + close()', async () => {
    const config = await loadHarnessConfig(EXAMPLE_CONFIG);
    const manager = new RegistryToolManager(new StubGuardrails());
    const wired = await wireHarnessConfig(config, manager);

    expect(wired.allowedToolNames).toEqual(expect.arrayContaining(['mcp__fixture__echo', 'mcp__fixture__fail', 'load_skill']));
    expect(wired.catalog?.list()).toEqual([
      { name: 'greeter', description: 'Write a friendly greeting file when the task asks for one' },
    ]);

    const guardrails = new StubGuardrails(wired.allowedToolNames);
    const manager2 = new RegistryToolManager(guardrails);
    const wired2 = await wireHarnessConfig(config, manager2);
    const skillResult = await manager2.execute({ type: 'tool_call', tool: 'load_skill', args: { name: 'greeter' } });
    expect(skillResult.success).toBe(true);

    await wired.close();
    await wired2.close();
  });
});

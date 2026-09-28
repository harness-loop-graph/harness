import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHarnessConfig, wireHarnessConfig, createRoutedModel } from '../src/harness-config.js';
import { McpToolProvider } from '../src/components/mcp-tool-provider.js';
import { RegistryToolManager } from '../src/components/tool-manager.js';
import { StubGuardrails } from '../src/components/guardrails.js';
import { StubModelAdapter } from '../src/components/model-adapter.js';
import type { ModelAdapter } from '../src/components/model-adapter.js';
import type { GlmAdapterConfig } from '../src/components/glm-adapter.js';

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

  it('resolves a router section, including customRouterPath relative to the config file', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        router: {
          longContextThreshold: 12345,
          routes: { longContext: { model: 'big-model', apiKeyEnv: 'BIG_KEY' }, retry: { model: 'retry-model' } },
          customRouterPath: './my-router.mjs',
        },
      }),
    );
    const config = await loadHarnessConfig(file);
    expect(config.router).toEqual({
      longContextThreshold: 12345,
      routes: {
        longContext: { model: 'big-model', baseUrl: undefined, apiKeyEnv: 'BIG_KEY' },
        retry: { model: 'retry-model', baseUrl: undefined, apiKeyEnv: undefined },
      },
      customRouterPath: path.resolve(workspace, 'my-router.mjs'),
    });
  });

  it('errors clearly when router.routes declares default', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(file, JSON.stringify({ router: { routes: { default: { model: 'x' } } } }));
    await expect(loadHarnessConfig(file)).rejects.toThrow(/router\.routes must not declare 'default'/);
  });

  it('errors clearly when router.routes is empty', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(file, JSON.stringify({ router: { routes: {} } }));
    await expect(loadHarnessConfig(file)).rejects.toThrow(/router\.routes must be a non-empty object/);
  });

  it('errors clearly when a route is missing a model', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(file, JSON.stringify({ router: { routes: { retry: {} } } }));
    await expect(loadHarnessConfig(file)).rejects.toThrow(/router\.routes\.retry\.model must be a non-empty string/);
  });

  it('errors clearly when longContextThreshold is not a positive number', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(file, JSON.stringify({ router: { longContextThreshold: -1, routes: { retry: { model: 'x' } } } }));
    await expect(loadHarnessConfig(file)).rejects.toThrow(/router\.longContextThreshold must be a positive number/);
  });

  it('errors clearly when apiKeyEnv is an empty string', async () => {
    const file = path.join(workspace, 'config.json');
    await fs.writeFile(file, JSON.stringify({ router: { routes: { retry: { model: 'x', apiKeyEnv: '' } } } }));
    await expect(loadHarnessConfig(file)).rejects.toThrow(/router\.routes\.retry\.apiKeyEnv must be a non-empty string/);
  });

  it('errors clearly when a route is named __proto__, instead of mutating the prototype', async () => {
    const file = path.join(workspace, 'config.json');
    // JSON.stringify({ routes: { __proto__: {...} } }) would drop the key (it
    // sets the object's own prototype instead of an own property), so write
    // the JSON text directly to reproduce what an attacker-supplied config
    // file actually contains: a real '__proto__' own key via JSON.parse.
    await fs.writeFile(file, '{"router":{"routes":{"__proto__":{"model":"x"}}}}');
    await expect(loadHarnessConfig(file)).rejects.toThrow(/router\.routes must not declare '__proto__'/);
    // Object.prototype itself must stay untouched regardless.
    expect(Object.prototype).not.toHaveProperty('model');
  });
});

describe('createRoutedModel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubMakeAdapter(created: GlmAdapterConfig[]) {
    return (config: GlmAdapterConfig): ModelAdapter => {
      created.push(config);
      return new StubModelAdapter();
    };
  }

  it('builds a RoutingModelAdapter with the default route plus every configured route', async () => {
    vi.stubEnv('MODEL_API_KEY', 'default-key');
    vi.stubEnv('BIG_KEY', 'big-key');
    // No route sets its own baseUrl, and MODEL_BASE_URL must not be
    // ambiently set for this run, or every created adapter would fall back
    // to it instead of the expected `undefined` below.
    vi.stubEnv('MODEL_BASE_URL', undefined);
    const created: GlmAdapterConfig[] = [];
    const defaultAdapter = new StubModelAdapter();

    const model = await createRoutedModel(
      {
        routes: {
          longContext: { model: 'big-model', apiKeyEnv: 'BIG_KEY' },
          retry: { model: 'retry-model' },
        },
      },
      defaultAdapter,
      { sessionId: 'sess-1', makeAdapter: stubMakeAdapter(created) },
    );

    expect(typeof model.getUsage).toBe('function');
    expect(typeof model.getRouting).toBe('function');
    expect(created).toEqual([
      { apiKey: 'big-key', model: 'big-model', baseUrl: undefined, sessionId: 'sess-1' },
      { apiKey: 'default-key', model: 'retry-model', baseUrl: undefined, sessionId: 'sess-1' },
    ]);
  });

  it('falls back to MODEL_BASE_URL when a route sets no baseUrl of its own', async () => {
    vi.stubEnv('MODEL_API_KEY', 'default-key');
    vi.stubEnv('BIG_KEY', 'big-key');
    vi.stubEnv('MODEL_BASE_URL', 'https://example.test');
    const created: GlmAdapterConfig[] = [];

    await createRoutedModel(
      { routes: { longContext: { model: 'big-model', apiKeyEnv: 'BIG_KEY' } } },
      new StubModelAdapter(),
      { sessionId: 'sess-1', makeAdapter: stubMakeAdapter(created) },
    );

    expect(created).toEqual([{ apiKey: 'big-key', model: 'big-model', baseUrl: 'https://example.test', sessionId: 'sess-1' }]);
  });

  it('throws a clear error naming the route and the missing env var', async () => {
    vi.stubEnv('BIG_KEY', undefined);
    vi.stubEnv('MODEL_API_KEY', 'default-key');
    await expect(
      createRoutedModel(
        { routes: { longContext: { model: 'big-model', apiKeyEnv: 'BIG_KEY' } } },
        new StubModelAdapter(),
        { makeAdapter: stubMakeAdapter([]) },
      ),
    ).rejects.toThrow(/route 'longContext' needs env var 'BIG_KEY'/);
  });

  it('throws when apiKeyEnv is omitted and MODEL_API_KEY is also unset', async () => {
    vi.stubEnv('MODEL_API_KEY', undefined);
    await expect(
      createRoutedModel({ routes: { retry: { model: 'retry-model' } } }, new StubModelAdapter(), {
        makeAdapter: stubMakeAdapter([]),
      }),
    ).rejects.toThrow(/route 'retry' needs env var 'MODEL_API_KEY'/);
  });

  it('loads a customRouterPath module and wires its default export as the custom router', async () => {
    vi.stubEnv('MODEL_API_KEY', 'default-key');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'router-module-'));
    try {
      const modulePath = path.join(workspace, 'my-router.mjs');
      await fs.writeFile(modulePath, 'export default (request, ctx) => (request.task === "route-me" ? "retry" : null);\n');

      const model = await createRoutedModel(
        { routes: { retry: { model: 'retry-model' } }, customRouterPath: modulePath },
        new StubModelAdapter(),
        { makeAdapter: stubMakeAdapter([]) },
      );

      await model.complete({ task: 'route-me', context: { projectRoot: '/tmp', files: [] }, availTools: [] });
      expect(model.getRouting().decisions).toEqual([{ route: 'retry', reason: 'custom' }]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('throws a clear error when customRouterPath does not export a function', async () => {
    vi.stubEnv('MODEL_API_KEY', 'default-key');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'router-module-'));
    try {
      const modulePath = path.join(workspace, 'bad-router.mjs');
      await fs.writeFile(modulePath, 'export const notAFunction = 42;\n');

      await expect(
        createRoutedModel({ routes: { retry: { model: 'retry-model' } }, customRouterPath: modulePath }, new StubModelAdapter(), {
          makeAdapter: stubMakeAdapter([]),
        }),
      ).rejects.toThrow(/must export a function as default or 'route'/);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
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
      try {
        await expect(wireHarnessConfig(config, manager)).rejects.toThrow(/Cannot read skills directory/);
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        closeSpy.mockRestore();
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

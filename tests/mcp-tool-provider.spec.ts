import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpToolProvider } from '../src/components/mcp-tool-provider.js';
import { RegistryToolManager } from '../src/components/tool-manager.js';
import { StubGuardrails } from '../src/components/guardrails.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(__dirname, 'fixtures', 'mcp-fixture-server.mjs');

function buildProvider() {
  return new McpToolProvider({
    mcpServers: {
      fixture: { command: 'node', args: [FIXTURE_SERVER] },
    },
  });
}

describe('McpToolProvider', () => {
  let provider: McpToolProvider | undefined;

  afterEach(async () => {
    await provider?.close();
    provider = undefined;
  });

  it('connects, lists tools and registers them with namespaced names', async () => {
    provider = buildProvider();
    const specs = await provider.connect();

    expect(specs.map((s) => s.name).sort()).toEqual(['mcp__fixture__echo', 'mcp__fixture__fail']);
    const echoSpec = specs.find((s) => s.name === 'mcp__fixture__echo')!;
    expect(echoSpec.inputSchema).toMatchObject({ type: 'object', required: ['text'] });
  });

  it('executes a registered MCP tool end to end through the manager, guardrails and audit', async () => {
    provider = buildProvider();
    const specs = await provider.connect();
    const guardrails = new StubGuardrails(specs.map((s) => s.name));
    const manager = new RegistryToolManager(guardrails);
    provider.registerInto(manager);

    const result = await manager.execute({ type: 'tool_call', tool: 'mcp__fixture__echo', args: { text: 'hola' } });

    expect(result.success).toBe(true);
    expect(result.result).toContain('echo: hola');
    expect(guardrails.getAuditLog().at(-1)?.decision).toBe('allowed');
  });

  it('turns an isError MCP result into a failed ToolResult', async () => {
    provider = buildProvider();
    const specs = await provider.connect();
    const guardrails = new StubGuardrails(specs.map((s) => s.name));
    const manager = new RegistryToolManager(guardrails);
    provider.registerInto(manager);

    const result = await manager.execute({ type: 'tool_call', tool: 'mcp__fixture__fail', args: {} });

    expect(result.success).toBe(false);
    expect(String(result.result)).toContain('fixture failure');
  });

  it('shares one connection across multiple tool managers (C3-style)', async () => {
    provider = buildProvider();
    await provider.connect();
    const managerA = new RegistryToolManager(new StubGuardrails(['mcp__fixture__echo']));
    const managerB = new RegistryToolManager(new StubGuardrails(['mcp__fixture__echo']));
    provider.registerInto(managerA);
    provider.registerInto(managerB);

    const [a, b] = await Promise.all([
      managerA.execute({ type: 'tool_call', tool: 'mcp__fixture__echo', args: { text: 'a' } }),
      managerB.execute({ type: 'tool_call', tool: 'mcp__fixture__echo', args: { text: 'b' } }),
    ]);

    expect(a.result).toContain('echo: a');
    expect(b.result).toContain('echo: b');
  });

  it('fails fast with a clear error when a server cannot be started', async () => {
    provider = new McpToolProvider({
      mcpServers: { broken: { command: '/nonexistent-binary-xyz' } },
    });
    await expect(provider.connect()).rejects.toThrow(/Failed to connect to MCP server 'broken'/);
  });

  it('closes the already-connected server when a later one fails to connect (no leaked client)', async () => {
    provider = new McpToolProvider({
      mcpServers: {
        fixture: { command: 'node', args: [FIXTURE_SERVER] },
        broken: { command: '/nonexistent-binary-xyz' },
      },
    });

    await expect(provider.connect()).rejects.toThrow(/Failed to connect to MCP server 'broken'/);

    // Internal state must be leak-free: nothing left tracked to close later.
    expect((provider as unknown as { clients: Map<string, unknown> }).clients.size).toBe(0);
    expect((provider as unknown as { registrations: unknown[] }).registrations.length).toBe(0);
  });

  it('throws a clear collision error when two servers sanitize to the same tool name, and closes both', async () => {
    provider = new McpToolProvider({
      mcpServers: {
        // '.' sanitizes to '_', so both server names collapse to the same
        // 'fx_1' segment and therefore the same 'mcp__fx_1__echo' tool name.
        'fx.1': { command: 'node', args: [FIXTURE_SERVER] },
        'fx_1': { command: 'node', args: [FIXTURE_SERVER] },
      },
    });

    await expect(provider.connect()).rejects.toThrow(/Tool name collision on 'mcp__fx_1__echo'/);
    expect((provider as unknown as { clients: Map<string, unknown> }).clients.size).toBe(0);
  });

  it('registerInto throws a clear collision error against an already-registered tool, naming both origins', async () => {
    provider = buildProvider();
    await provider.connect();
    const manager = new RegistryToolManager(new StubGuardrails());
    manager.register({
      name: 'mcp__fixture__echo',
      description: 'A pre-existing tool with the same name',
      inputSchema: { type: 'object', properties: {} },
    });

    expect(() => provider!.registerInto(manager)).toThrow(
      /Tool name collision on 'mcp__fixture__echo': MCP tool 'echo' from server 'fixture' collides with the already-registered tool 'mcp__fixture__echo' \(A pre-existing tool with the same name\)/,
    );
  });
});

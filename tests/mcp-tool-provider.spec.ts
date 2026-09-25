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
});

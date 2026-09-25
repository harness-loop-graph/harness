import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSpec } from '../contracts/core.js';
import type { RegistryToolManager, ToolHandler } from './tool-manager.js';

/** One MCP server entry, matching the common `{ mcpServers: { name: {...} } }` config shape. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolProviderOptions {
  mcpServers: Record<string, McpServerConfig>;
}

const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Connects to one or more MCP servers over stdio and exposes their tools as
 * ToolSpec + handler pairs. `connect()` opens the connections once;
 * `registerInto(manager)` can then be called for every RegistryToolManager
 * that should expose these tools (e.g. C3 builds one manager per graph
 * node, all sharing a single set of MCP connections for the run). Every
 * call still goes through the target manager, so guardrails + audit apply.
 * A server that fails to connect throws immediately: a silently missing
 * server would corrupt an experiment run.
 */
export class McpToolProvider {
  private readonly clients = new Map<string, Client>();
  private readonly registrations: Array<{ spec: ToolSpec; handler: ToolHandler }> = [];

  constructor(private readonly options: McpToolProviderOptions) {}

  /** Connects to every configured server and lists its tools. Returns the resulting specs. */
  async connect(): Promise<ToolSpec[]> {
    for (const [serverName, config] of Object.entries(this.options.mcpServers)) {
      const client = new Client({ name: `harness-mcp-${serverName}`, version: '0.1.0' }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      });

      try {
        await client.connect(transport);
      } catch (err) {
        throw new Error(
          `Failed to connect to MCP server '${serverName}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.clients.set(serverName, client);

      const { tools } = await client.listTools();
      for (const tool of tools) {
        const spec: ToolSpec = {
          name: sanitizeToolName(serverName, tool.name),
          description: tool.description ?? `MCP tool '${tool.name}' from server '${serverName}'`,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        };
        const handler: ToolHandler = async (args) => {
          const result = await client.callTool({ name: tool.name, arguments: args });
          if ('isError' in result && result.isError) {
            throw new Error(extractText(result.content) || `MCP tool '${tool.name}' returned an error`);
          }
          return 'content' in result ? extractText(result.content) : result;
        };
        this.registrations.push({ spec, handler });
      }
    }
    return this.registrations.map((r) => r.spec);
  }

  /** Registers every discovered MCP tool into the given manager. Call once per harness. */
  registerInto(manager: RegistryToolManager): ToolSpec[] {
    for (const { spec, handler } of this.registrations) {
      manager.register(spec, handler);
    }
    return this.registrations.map((r) => r.spec);
  }

  /** Closes every open server connection. Safe to call even if connect() partially failed. */
  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close().catch(() => undefined);
    }
    this.clients.clear();
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => (part as { type?: string })?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** `mcp__<server>__<tool>`, sanitized to [a-zA-Z0-9_-] and capped at 64 chars. */
function sanitizeToolName(serverName: string, toolName: string): string {
  const raw = `mcp__${serverName}__${toolName}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return sanitized.slice(0, MAX_TOOL_NAME_LENGTH);
}

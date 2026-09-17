import type { ToolCallResponse, ToolResult, ToolSpec } from '../contracts/core.js';
import type { Guardrails } from './guardrails.js';
import type { ExecutionManager } from './execution-manager.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Handler that performs the actual work behind a registered tool. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** Validates tool calls against a registry and executes them. */
export interface ToolManager {
  register(spec: ToolSpec, handler?: ToolHandler): void;
  execute(call: ToolCallResponse): Promise<ToolResult>;
}

const MAX_READ_BYTES = 256 * 1024;

/**
 * Real tool manager: every call is checked against the guardrails
 * before execution, unknown tools are rejected, and handler failures
 * become failed ToolResults instead of exceptions.
 */
export class RegistryToolManager implements ToolManager {
  private readonly specs = new Map<string, ToolSpec>();
  private readonly handlers = new Map<string, ToolHandler>();

  constructor(private readonly guardrails: Guardrails) {}

  register(spec: ToolSpec, handler: ToolHandler = async () => undefined): void {
    this.specs.set(spec.name, spec);
    this.handlers.set(spec.name, handler);
  }

  getSpecs(): ToolSpec[] {
    return [...this.specs.values()];
  }

  async execute(call: ToolCallResponse): Promise<ToolResult> {
    const spec = this.specs.get(call.tool);
    if (!spec) {
      return {
        type: 'tool_result',
        tool: call.tool,
        success: false,
        result: `Unknown tool '${call.tool}'`,
      };
    }

    const decision = await this.guardrails.evaluate({ kind: 'tool', tool: call.tool, args: call.args });
    if (decision.decision === 'denied') {
      return {
        type: 'tool_result',
        tool: call.tool,
        success: false,
        result: `Denied by guardrails: ${decision.reason}`,
      };
    }

    try {
      const result = await this.handlers.get(call.tool)!(call.args);
      return { type: 'tool_result', tool: call.tool, success: true, result };
    } catch (err) {
      return {
        type: 'tool_result',
        tool: call.tool,
        success: false,
        result: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/** Dependencies needed to register the built-in workspace tools. */
export interface BuiltinToolDeps {
  execution: ExecutionManager;
  workspaceRoot: string;
}

/** Registers write_file, read_file and run_command; returns their specs. */
export function registerBuiltinTools(manager: RegistryToolManager, deps: BuiltinToolDeps): ToolSpec[] {
  const root = path.resolve(deps.workspaceRoot);

  const writeSpec: ToolSpec = {
    name: 'write_file',
    description: 'Write a text file at a path relative to the workspace root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside the workspace' },
        content: { type: 'string', description: 'UTF-8 file content' },
      },
      required: ['path', 'content'],
    },
  };
  manager.register(writeSpec, async (args) => {
    const rel = requireString(args.path, 'path');
    const content = requireString(args.content, 'content');
    const target = path.resolve(root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return { path: rel, bytes: Buffer.byteLength(content, 'utf8') };
  });

  const readSpec: ToolSpec = {
    name: 'read_file',
    description: 'Read a text file at a path relative to the workspace root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside the workspace' },
      },
      required: ['path'],
    },
  };
  manager.register(readSpec, async (args) => {
    const rel = requireString(args.path, 'path');
    const target = path.resolve(root, rel);
    const content = await fs.readFile(target, 'utf8');
    return content.length > MAX_READ_BYTES ? content.slice(0, MAX_READ_BYTES) : content;
  });

  const runSpec: ToolSpec = {
    name: 'run_command',
    description: 'Run a shell command inside the isolated workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to execute' },
      },
      required: ['command'],
    },
  };
  manager.register(runSpec, async (args) => {
    const command = requireString(args.command, 'command');
    return deps.execution.run({ command, cwd: root });
  });

  return [writeSpec, readSpec, runSpec];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing or invalid '${field}' argument`);
  }
  return value;
}

/** Minimal stub: registers specs and returns a canned success result. Used in unit tests. */
export class StubToolManager implements ToolManager {
  private readonly registry = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    this.registry.set(spec.name, spec);
  }

  async execute(call: ToolCallResponse): Promise<ToolResult> {
    return {
      type: 'tool_result',
      tool: call.tool,
      success: this.registry.has(call.tool),
      result: call.args,
    };
  }
}

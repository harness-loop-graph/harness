import type { ToolCallResponse, ToolResult, ToolSpec } from '../contracts/core.js';

/** Validates tool calls against a registry and executes them. */
export interface ToolManager {
  register(spec: ToolSpec): void;
  execute(call: ToolCallResponse): Promise<ToolResult>;
}

/** Minimal stub: registers specs and returns a canned success result. */
export class StubToolManager implements ToolManager {
  private registry = new Map<string, ToolSpec>();

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

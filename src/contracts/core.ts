/**
 * Core contracts for the agent harness.
 */

/** Relevant project info passed to the model. */
export interface Context {
  projectRoot: string;
  files: string[];
  language?: string;
  framework?: string;
  /** The task this context was prepared for. */
  task?: string;
}

/** Request sent to the model adapter. */
export interface ModelRequest {
  task: string;
  context: Context;
  availTools: ToolSpec[];
  instructions?: string;
  /** Prior responses of this interaction, including tool results fed back. */
  history?: Array<ModelResponse | ToolResult>;
}

/** Discriminated union of possible model responses. */
export type ModelResponse =
  | ToolCallResponse
  | ErrorResponse
  | FinishResponse;

/** The model wants to invoke a tool. */
export interface ToolCallResponse {
  type: 'tool_call';
  tool: string;
  args: Record<string, unknown>;
}

/** The model or adapter encountered an error. */
export interface ErrorResponse {
  type: 'error';
  code: string;
  message: string;
}

/** The model finished without further tool calls. */
export interface FinishResponse {
  type: 'finish';
  content: string;
}

/** Result of a tool execution. */
export interface ToolResult {
  type: 'tool_result';
  tool: string;
  success: boolean;
  result: unknown;
}

/** Request to execute a command inside a workspace. */
export interface ExecutionRequest {
  command: string;
  cwd: string;
  env?: Record<string, string>;
}

/** Result of a command execution. */
export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Evaluation of an execution or artifact. */
export interface VerificationResult {
  passed: boolean;
  details: string;
  metrics?: Record<string, number>;
}

/** Guardrail decision for an action. */
export interface GuardrailDecision {
  decision: 'allowed' | 'denied';
  reason: string;
}

/** Specification for a tool available to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

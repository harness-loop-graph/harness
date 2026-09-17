export interface Context {
  projectRoot: string;
  files: string[];
  language?: string;
  framework?: string;
  task?: string;
}

export interface ModelRequest {
  task: string;
  context: Context;
  availTools: ToolSpec[];
  instructions?: string;
  /** Verification feedback from a previous failed attempt (loop retry). */
  feedback?: string;
  /** Prior responses of this interaction, including tool results fed back. */
  history?: Array<ModelResponse | ToolResult>;
}

export type ModelResponse = ToolCallResponse | ErrorResponse | FinishResponse;

export interface ToolCallResponse {
  type: 'tool_call';
  tool: string;
  args: Record<string, unknown>;
}

export interface ErrorResponse {
  type: 'error';
  code: string;
  message: string;
}

export interface FinishResponse {
  type: 'finish';
  content: string;
}

export interface ToolResult {
  type: 'tool_result';
  tool: string;
  success: boolean;
  result: unknown;
}

export interface ExecutionRequest {
  command: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VerificationResult {
  passed: boolean;
  details: string;
  metrics?: Record<string, number>;
}

export interface GuardrailDecision {
  decision: 'allowed' | 'denied';
  reason: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

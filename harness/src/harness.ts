import type {
  ModelRequest,
  ModelResponse,
  ToolResult,
  ToolSpec,
  VerificationResult,
  GuardrailDecision,
} from './contracts/core.js';
import type { ContextManager } from './components/context-manager.js';
import type { ModelAdapter } from './components/model-adapter.js';
import type { ToolManager } from './components/tool-manager.js';
import type { ExecutionManager } from './components/execution-manager.js';
import type { VerificationManager } from './components/verification-manager.js';
import type { Guardrails } from './components/guardrails.js';

export interface HarnessComponents {
  context: ContextManager;
  model: ModelAdapter;
  tools: ToolManager;
  execution: ExecutionManager;
  verification: VerificationManager;
  guardrails: Guardrails;
}

/** Identical consecutive tool calls tolerated before the run is stopped. */
export const DEFAULT_MAX_REPEATED_TOOL_CALLS = 3;

/** Consecutive `empty_content` replies the harness re-asks (with a nudge) before ending the run. */
export const MAX_EMPTY_RESPONSE_RETRIES = 2;

const EMPTY_RESPONSE_NUDGE =
  'Your previous reply contained no content and no tool call. Continue the task now: call a tool, or give your final answer if the task is complete.';

export interface HarnessOptions {
  workspaceRoot: string;
  availTools: ToolSpec[];
  instructions?: string;
  /**
   * C1 contract: 1 (single interaction, no corrective loop — that is C2).
   * C2 loops override this per run.
   */
  maxToolRounds?: number;
  /**
   * Doom-loop cap: the Nth consecutive identical tool call (same tool, deep-equal
   * args) is not executed and the run ends with a `repeated_tool_call` error.
   * Integer >= 2; defaults to DEFAULT_MAX_REPEATED_TOOL_CALLS.
   */
  maxRepeatedToolCalls?: number;
}

export interface HarnessRunOptions {
  feedback?: string;
  maxToolRounds?: number;
}

export interface InteractionTurn {
  request: ModelRequest;
  response: ModelResponse;
  toolResult?: ToolResult;
  verification?: VerificationResult;
}

export interface HarnessRunResult {
  finalResponse: ModelResponse;
  turns: InteractionTurn[];
  audit: GuardrailDecision[];
  verifications: VerificationResult[];
}

/**
 * C1 harness: one interaction cycle —
 * context -> model -> (tool call -> guardrails -> tool -> verify)
 * -> model with tool result -> final response. No retries.
 */
export class Harness {
  private readonly maxToolRounds: number;
  private readonly maxRepeatedToolCalls: number;

  constructor(
    private readonly components: HarnessComponents,
    private readonly options: HarnessOptions,
  ) {
    this.maxToolRounds = options.maxToolRounds ?? 1;
    const maxRepeatedToolCalls = options.maxRepeatedToolCalls ?? DEFAULT_MAX_REPEATED_TOOL_CALLS;
    if (!Number.isInteger(maxRepeatedToolCalls) || maxRepeatedToolCalls < 2) {
      throw new Error(`maxRepeatedToolCalls must be an integer >= 2, got ${maxRepeatedToolCalls}`);
    }
    this.maxRepeatedToolCalls = maxRepeatedToolCalls;
  }

  async run(task: string, runOptions: HarnessRunOptions = {}): Promise<HarnessRunResult> {
    const { context, model, tools, verification, guardrails } = this.components;
    const maxToolRounds = runOptions.maxToolRounds ?? this.maxToolRounds;

    const ctx = await context.prepare(task, this.options.workspaceRoot);
    const history: Array<ModelResponse | ToolResult> = [];
    const turns: InteractionTurn[] = [];

    let response: ModelResponse | undefined;
    let lastCallKey: string | undefined;
    let repeatedCalls = 0;
    let emptyRetries = 0;
    let nudge: string | undefined;

    for (let round = 0; round <= maxToolRounds; round++) {
      const request: ModelRequest = {
        task,
        context: ctx,
        availTools: this.options.availTools,
        instructions: this.options.instructions,
        history: [...history],
        // Feedback belongs to the previous ATTEMPT: only on the first
        // request of the turn; later requests carry the tool history.
        ...(round === 0 && runOptions.feedback ? { feedback: runOptions.feedback } : {}),
        ...(nudge ? { nudge } : {}),
      };
      nudge = undefined;

      response = await model.complete(request);
      const turn: InteractionTurn = { request, response };
      turns.push(turn);

      // A reasoning model can spend its budget thinking and reply with nothing:
      // re-ask (each retry spends a round) instead of ending the run.
      if (
        response.type === 'error' &&
        response.code === 'empty_content' &&
        emptyRetries < MAX_EMPTY_RESPONSE_RETRIES &&
        round < maxToolRounds
      ) {
        emptyRetries++;
        nudge = EMPTY_RESPONSE_NUDGE;
        continue;
      }
      emptyRetries = 0;

      if (response.type !== 'tool_call') break;

      const callKey = canonicalJson({ tool: response.tool, args: response.args });
      repeatedCalls = callKey === lastCallKey ? repeatedCalls + 1 : 1;
      lastCallKey = callKey;

      if (repeatedCalls >= this.maxRepeatedToolCalls) {
        response = {
          type: 'error',
          code: 'repeated_tool_call',
          message: `Tool '${response.tool}' was requested ${repeatedCalls} times in a row with identical arguments`,
        };
        turns.push({ request: { ...request, history: [...history] }, response });
        break;
      }

      const toolResult = await tools.execute(response);
      turn.toolResult = toolResult;
      history.push(response, toolResult);

      if (this.isExecutionResult(toolResult.result)) {
        turn.verification = await verification.verify(toolResult.result);
      }

      if (round === maxToolRounds) {
        response = {
          type: 'error',
          code: 'max_tool_rounds',
          message: `Reached the limit of ${maxToolRounds} tool round(s) without a final response`,
        };
        turns.push({
          request: { ...request, history: [...history] },
          response,
        });
      }
    }

    return {
      finalResponse: response!,
      turns,
      audit: guardrails.getAuditLog(),
      verifications: this.components.verification.getHistory(),
    };
  }

  private isExecutionResult(result: unknown): result is {
    exitCode: number;
    stdout: string;
    stderr: string;
  } {
    return (
      typeof result === 'object' &&
      result !== null &&
      'exitCode' in result &&
      'stdout' in result &&
      'stderr' in result
    );
  }
}

/** JSON with object keys sorted recursively, so equal values serialize equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

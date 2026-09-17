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

export interface HarnessOptions {
  workspaceRoot: string;
  availTools: ToolSpec[];
  instructions?: string;
  /**
   * C1 contract: 1 (single interaction, no corrective loop — that is C2).
   * C2 loops override this per run.
   */
  maxToolRounds?: number;
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

  constructor(
    private readonly components: HarnessComponents,
    private readonly options: HarnessOptions,
  ) {
    this.maxToolRounds = options.maxToolRounds ?? 1;
  }

  async run(task: string, runOptions: HarnessRunOptions = {}): Promise<HarnessRunResult> {
    const { context, model, tools, verification, guardrails } = this.components;
    const maxToolRounds = runOptions.maxToolRounds ?? this.maxToolRounds;

    const ctx = await context.prepare(task, this.options.workspaceRoot);
    const history: Array<ModelResponse | ToolResult> = [];
    const turns: InteractionTurn[] = [];

    let response: ModelResponse | undefined;

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
      };

      response = await model.complete(request);
      const turn: InteractionTurn = { request, response };
      turns.push(turn);

      if (response.type !== 'tool_call') break;

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

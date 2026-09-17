import type {
  ModelRequest,
  ModelResponse,
  ToolResult,
  ToolSpec,
  VerificationResult,
} from './contracts/core.js';
import type { ContextManager } from './components/context-manager.js';
import type { ModelAdapter } from './components/model-adapter.js';
import type { ToolManager } from './components/tool-manager.js';
import type { ExecutionManager } from './components/execution-manager.js';
import type { VerificationManager } from './components/verification-manager.js';
import type { Guardrails } from './components/guardrails.js';
import type { GuardrailDecision } from './contracts/core.js';

/** The six harness components, injected fully assembled. */
export interface HarnessComponents {
  context: ContextManager;
  model: ModelAdapter;
  tools: ToolManager;
  execution: ExecutionManager;
  verification: VerificationManager;
  guardrails: Guardrails;
}

export interface HarnessOptions {
  /** Absolute path of the isolated workspace the agent operates in. */
  workspaceRoot: string;
  /** Tools offered to the model on every request. */
  availTools: ToolSpec[];
  /** Standing rules and constraints sent with every request. */
  instructions?: string;
  /**
   * How many tool rounds a single run may take. C1 uses the default
   * of 1 (a single interaction cycle, no corrective loop — that is C2).
   */
  maxToolRounds?: number;
}

/** Trace of one interaction step: what was asked, answered, executed, verified. */
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
 * The C1 agent harness: composes the six managers and runs ONE
 * interaction cycle —
 *   context -> model -> (tool call -> guardrails -> tool -> verify)
 *           -> model with tool result -> final response.
 * There is no retry loop; that behavior belongs to C2.
 */
export class Harness {
  private readonly maxToolRounds: number;

  constructor(
    private readonly components: HarnessComponents,
    private readonly options: HarnessOptions,
  ) {
    this.maxToolRounds = options.maxToolRounds ?? 1;
  }

  async run(task: string): Promise<HarnessRunResult> {
    const { context, model, tools, verification, guardrails } = this.components;

    const ctx = await context.prepare(task, this.options.workspaceRoot);
    const history: Array<ModelResponse | ToolResult> = [];
    const turns: InteractionTurn[] = [];

    let response: ModelResponse | undefined;

    for (let round = 0; round <= this.maxToolRounds; round++) {
      const request: ModelRequest = {
        task,
        context: ctx,
        availTools: this.options.availTools,
        instructions: this.options.instructions,
        history: [...history],
      };

      response = await model.complete(request);
      const turn: InteractionTurn = { request, response };
      turns.push(turn);

      if (response.type !== 'tool_call') break;

      const toolResult = await tools.execute(response);
      turn.toolResult = toolResult;
      history.push(response, toolResult);

      // Commands are verified through the verification manager (C1 scope:
      // execute checks and store results; feedback loops arrive in C2).
      if (this.isExecutionResult(toolResult.result)) {
        turn.verification = await verification.verify(toolResult.result);
      }

      if (round === this.maxToolRounds) {
        response = {
          type: 'error',
          code: 'max_tool_rounds',
          message: `Reached the limit of ${this.maxToolRounds} tool round(s) without a final response`,
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

  /** Structural check for an ExecutionResult payload inside a ToolResult. */
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

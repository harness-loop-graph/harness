import type { ModelResponse, VerificationResult } from '../contracts/core.js';
import type { ExecutionManager } from '../components/execution-manager.js';
import type { VerificationManager } from '../components/verification-manager.js';
import type { Harness } from '../harness.js';
import type {
  LoopDecision,
  LoopRequest,
  LoopResult,
  LoopState,
  LoopTurnTrace,
} from './contracts.js';
import { summarizeTurn } from './turn-summary.js';

/**
 * Model errors that every later call would repeat: an exhausted cost cap, no
 * credits left (402) or a rejected key (401). Retrying them only burns turns.
 */
const FATAL_MODEL_ERROR_CODES = new Set(['budget_exceeded', 'http_401', 'http_402']);

/** Error messages recorded in the trace are truncated past this length. */
const MAX_TRACE_MESSAGE_LENGTH = 300;

export interface LoopDeps {
  harness: Harness;
  execution: ExecutionManager;
  verification: VerificationManager;
  workspaceRoot: string;
}

/**
 * C2 corrective loop. Each turn runs a full harness interaction, then the
 * operator-owned verification command runs and the loop decides FINISH /
 * RETRY (verification feedback goes to the next turn) / FAIL. The decision
 * policy is deterministic and lives here, not in the model.
 */
export class AgentLoop {
  constructor(private readonly deps: LoopDeps) {}

  async run(request: LoopRequest): Promise<LoopResult> {
    const state: LoopState = {
      task: request.task,
      turn: 0,
      phase: 'starting',
      verifications: [],
    };
    const trace: LoopTurnTrace[] = [];

    let finalResponse: ModelResponse | undefined;
    let decision: LoopDecision = { action: 'FAIL', reason: 'The loop did not execute any turn' };
    let feedback: string | undefined;

    for (let turn = 1; turn <= request.maxTurns; turn++) {
      state.turn = turn;

      state.phase = 'generating';
      const run = await this.deps.harness.run(request.task, {
        feedback,
        maxToolRounds: request.toolRoundsPerTurn ?? 8,
      });
      finalResponse = run.finalResponse;

      state.phase = 'observing';

      // A fatal model error refuses every later call, so neither verifying
      // nor retrying can change the outcome.
      const budgetError =
        finalResponse.type === 'error' && FATAL_MODEL_ERROR_CODES.has(finalResponse.code) ? finalResponse : undefined;
      const budgetExhausted = budgetError !== undefined;

      let verification: VerificationResult | undefined;
      if (request.verification && !budgetExhausted) {
        state.phase = 'verifying';
        const execution = await this.deps.execution.run({
          command: request.verification.command,
          cwd: this.deps.workspaceRoot,
        });
        verification = await this.deps.verification.verify(execution);
        state.verifications.push(verification);
      }

      state.phase = 'deciding';
      decision = budgetExhausted
        ? { action: 'FAIL', reason: `Model unavailable (${budgetError.code}: ${truncateMessage(budgetError.message)})` }
        : this.decide(finalResponse, verification, request.maxTurns - turn);
      state.lastAction = decision.action;

      trace.push({
        turn,
        phases: ['generating', 'observing', ...(verification ? (['verifying'] as const) : []), 'deciding'],
        response: finalResponse,
        ...(finalResponse.type === 'error'
          ? {
              responseCode: finalResponse.code,
              responseMessage: truncateMessage(finalResponse.message),
            }
          : {}),
        verification,
        decision,
        ...(feedback !== undefined ? { feedback } : {}),
      });

      if (decision.action === 'FINISH') break;

      if (decision.action === 'RETRY') {
        // The next turn is a fresh conversation: verification first, then a
        // harness-built record of what this turn did so it need not re-explore.
        const summary = summarizeTurn(run);
        feedback = [this.buildFeedback(finalResponse, verification), summary]
          .filter((part): part is string => !!part)
          .join('\n\n');
        continue;
      }

      break; // FAIL
    }

    state.phase = 'final';
    const success = decision.action === 'FINISH';

    return {
      status: success ? 'SUCCESS' : 'FAILED',
      turns: state.turn,
      finalResponse,
      decision,
      verifications: state.verifications,
      trace,
      ...(success
        ? {}
        : {
            failure:
              request.maxTurns === state.turn
                ? `max_turns (${request.maxTurns}) reached without success`
                : decision.reason,
          }),
    };
  }

  /**
   * finish + passed (or no) verification -> FINISH; anything failed with
   * turns left -> RETRY; anything with no turns left -> FAIL.
   */
  private decide(
    response: ModelResponse,
    verification: VerificationResult | undefined,
    turnsLeft: number,
  ): LoopDecision {
    if (response.type !== 'finish') {
      const label = response.type === 'error' ? `${response.type} (${response.code})` : response.type;
      return turnsLeft > 0
        ? { action: 'RETRY', reason: `Model returned ${label}; retrying` }
        : { action: 'FAIL', reason: `Model returned ${label} and no turns are left` };
    }
    if (!verification) {
      return { action: 'FINISH', reason: 'Model finished; no verification was configured' };
    }
    if (verification.passed) {
      return { action: 'FINISH', reason: 'Model finished and verification passed' };
    }
    return turnsLeft > 0
      ? { action: 'RETRY', reason: 'Model finished but verification failed; retrying with feedback' }
      : { action: 'FAIL', reason: 'Model finished but verification failed and no turns are left' };
  }

  private buildFeedback(
    response: ModelResponse,
    verification: VerificationResult | undefined,
  ): string {
    const parts: string[] = [];
    if (response.type === 'error') {
      parts.push(`Your last attempt failed with error '${response.code}': ${response.message}.`);
    }
    if (verification && !verification.passed) {
      parts.push(
        `Verification failed: ${verification.details}. ` +
          'Fix the workspace so the verification command passes, then finish.',
      );
    }
    if (verification?.passed && response.type !== 'finish') {
      // Without this the model never learns the check already passes and keeps working until it runs out of turns.
      parts.push(
        'Verification passed: the verification command now succeeds. ' +
          'If the task is complete (see the definition of done in AGENTS.md, if present), finish now with a final answer; ' +
          'otherwise finish the remaining work and then give a final answer.',
      );
    }
    return parts.join(' ');
  }
}

function truncateMessage(message: string): string {
  return message.length <= MAX_TRACE_MESSAGE_LENGTH ? message : message.slice(0, MAX_TRACE_MESSAGE_LENGTH) + '…';
}

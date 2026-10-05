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

      let verification: VerificationResult | undefined;
      if (request.verification) {
        state.phase = 'verifying';
        const execution = await this.deps.execution.run({
          command: request.verification.command,
          cwd: this.deps.workspaceRoot,
        });
        verification = await this.deps.verification.verify(execution);
        state.verifications.push(verification);
      }

      state.phase = 'deciding';
      decision = this.decide(finalResponse, verification, request.maxTurns - turn);
      state.lastAction = decision.action;

      trace.push({
        turn,
        phases: ['generating', 'observing', ...(verification ? (['verifying'] as const) : []), 'deciding'],
        response: finalResponse,
        verification,
        decision,
        ...(decision.action === 'RETRY' ? { feedback } : {}),
      });

      if (decision.action === 'FINISH') break;

      if (decision.action === 'RETRY') {
        feedback = this.buildFeedback(finalResponse, verification);
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
    return parts.join(' ');
  }
}

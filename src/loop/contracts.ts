import type { ModelResponse, VerificationResult } from '../contracts/core.js';

/**
 * C2 contracts — the corrective loop.
 *
 * C1 executes one interaction; the loop decides what happens AFTER
 * verification: finish, retry with feedback, or fail. All harness
 * contracts from C1 are inherited unchanged.
 */

/** Phases of the loop state machine, per the design document. */
export type LoopPhase = 'starting' | 'generating' | 'observing' | 'verifying' | 'deciding' | 'final';

/** Starts the iterative execution of a task and sets its conditions. */
export interface LoopRequest {
  /** Global task forwarded to the harness (and the model) every turn. */
  task: string;
  /** Hard limit of loop turns. Reaching it without success is a FAIL. */
  maxTurns: number;
  /**
   * Operator-specified verification command run inside the workspace
   * after each turn (e.g. a test command). When absent, a finish
   * response is accepted without verification.
   */
  verification?: { command: string };
  /** Tool rounds allowed to the model inside a single turn. Default 8. */
  toolRoundsPerTurn?: number;
  /** Standing instructions forwarded to the model. */
  instructions?: string;
}

/** Current state of the loop execution. */
export interface LoopState {
  task: string;
  /** Turn number, 1-based. */
  turn: number;
  phase: LoopPhase;
  /** Decision taken in the last 'deciding' phase, if any. */
  lastAction?: LoopDecision['action'];
  /** Verification results produced so far, oldest first. */
  verifications: VerificationResult[];
}

/** What the loop does after analyzing a turn's verification. */
export interface LoopDecision {
  action: 'FINISH' | 'RETRY' | 'FAIL';
  reason: string;
}

/** Final outcome of the whole loop execution. */
export interface LoopResult {
  status: 'SUCCESS' | 'FAILED';
  /** Number of turns actually executed. */
  turns: number;
  /** The model's last response of the last turn. */
  finalResponse?: ModelResponse;
  decision: LoopDecision;
  verifications: VerificationResult[];
  /** Per-turn record: what the model did, what verification said, what was decided. */
  trace: LoopTurnTrace[];
  /** Present when status is FAILED. */
  failure?: string;
}

/** Trace of one loop turn. */
export interface LoopTurnTrace {
  turn: number;
  /** Phases traversed by this turn, in order. */
  phases: LoopPhase[];
  response: ModelResponse;
  verification?: VerificationResult;
  decision: LoopDecision;
  /** Feedback handed to the next turn, when the decision was RETRY. */
  feedback?: string;
}

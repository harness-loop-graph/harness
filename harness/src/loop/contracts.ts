import type { ModelResponse, VerificationResult } from '../contracts/core.js';

export type LoopPhase = 'starting' | 'generating' | 'observing' | 'verifying' | 'deciding' | 'final';

export interface LoopRequest {
  task: string;
  /** Reaching this limit without success is a FAIL. */
  maxTurns: number;
  /**
   * Operator-owned verification command run inside the workspace after
   * each turn. Never shown to the model; only its failure feedback is.
   * When absent, a finish response is accepted without verification.
   */
  verification?: { command: string };
  /** Default 8. */
  toolRoundsPerTurn?: number;
  instructions?: string;
}

export interface LoopState {
  task: string;
  /** 1-based. */
  turn: number;
  phase: LoopPhase;
  lastAction?: LoopDecision['action'];
  /** Oldest first. */
  verifications: VerificationResult[];
}

export interface LoopDecision {
  action: 'FINISH' | 'RETRY' | 'FAIL';
  reason: string;
}

export interface LoopResult {
  status: 'SUCCESS' | 'FAILED';
  turns: number;
  finalResponse?: ModelResponse;
  decision: LoopDecision;
  verifications: VerificationResult[];
  trace: LoopTurnTrace[];
  failure?: string;
}

export interface LoopTurnTrace {
  turn: number;
  phases: LoopPhase[];
  response: ModelResponse;
  verification?: VerificationResult;
  decision: LoopDecision;
  /** Present when the decision was RETRY. */
  feedback?: string;
}

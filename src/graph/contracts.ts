import type { ModelResponse, VerificationResult } from '../contracts/core.js';
import type { AgentLoop } from '../loop/agent-loop.js';
import type { LoopResult } from '../loop/contracts.js';

export interface GraphNode {
  id: string;
  /** e.g. 'architect', 'data', 'backend', 'frontend', 'reviewer'. */
  role: string;
  task: string;
  instructions?: string;
  /** Operator-owned; never shown to the model, only its failure feedback. */
  verification?: { command: string };
  /** Default 3. */
  maxTurns?: number;
  /** Default 8. */
  toolRoundsPerTurn?: number;
}

/**
 * The condition is matched against the node's loop outcome:
 * deterministic routing, never a model choice.
 */
export interface GraphEdge {
  from: string;
  to: string;
  condition: 'on_success' | 'on_failure' | 'always';
}

export interface GraphRequest {
  task: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  initialNode: string;
  /** Hard limit of node executions. Default 10. */
  maxSteps?: number;
}

export interface GraphState {
  currentNode: string;
  step: number;
  visits: Record<string, number>;
  /** Oldest first. */
  nodeResults: NodeExecution[];
  /** Final response content each node leaves for the others. */
  shared: Record<string, string>;
}

export interface NodeExecution {
  nodeId: string;
  role: string;
  status: 'SUCCESS' | 'FAILED';
  turns: number;
  finalResponse?: ModelResponse;
  verifications: VerificationResult[];
}

export type GraphDecision =
  | { action: 'NEXT'; node: string; reason: string }
  | { action: 'FINISH'; reason: string }
  | { action: 'FAIL'; reason: string };

export interface GraphResult {
  status: 'SUCCESS' | 'FAILED';
  steps: number;
  decision: GraphDecision;
  state: GraphState;
  trace: GraphStepTrace[];
  totalLoopTurns: number;
  failure?: string;
}

export interface GraphStepTrace {
  step: number;
  nodeId: string;
  loopStatus: 'SUCCESS' | 'FAILED';
  decision: GraphDecision;
}

export type GraphRouter = (nodeId: string, loopResult: LoopResult, state: GraphState) => GraphDecision;

export type LoopFactory = (node: GraphNode) => AgentLoop;

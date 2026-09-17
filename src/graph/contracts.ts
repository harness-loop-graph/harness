import type { ModelResponse, VerificationResult } from '../contracts/core.js';
import type { LoopResult } from '../loop/contracts.js';
import type { AgentLoop } from '../loop/agent-loop.js';

/**
 * C3 contracts — the multi-agent graph.
 *
 * The graph is a state machine that decides which node (agent) runs
 * next and how the flow continues. Each node executes its own C2 loop
 * (plan, act, verify, feedback). All C1 and C2 contracts are inherited.
 */

/**
 * A unit of work executed by its own corrective loop.
 * Mirrors the design document: id, role, task, instructions.
 */
export interface GraphNode {
  id: string;
  /** Node role, e.g. 'architect', 'data', 'backend', 'frontend', 'reviewer'. */
  role: string;
  /** The task this node's loop works on. */
  task: string;
  /** Node-specific instructions forwarded to the model. */
  instructions?: string;
  /** Operator-owned verification for this node's loop. */
  verification?: { command: string };
  /** Loop turn budget for this node. Default 3. */
  maxTurns?: number;
  /** Tool rounds per loop turn. Default 8. */
  toolRoundsPerTurn?: number;
}

/**
 * A transition definition. The condition is evaluated against the
 * node's loop outcome — deterministic routing, not model choice.
 */
export interface GraphEdge {
  from: string;
  to: string;
  condition: 'on_success' | 'on_failure' | 'always';
}

/** Starts a graph execution: global task, nodes, edges, entry point, limits. */
export interface GraphRequest {
  /** Global goal, kept for tracing and reporting. */
  task: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Entry node id. */
  initialNode: string;
  /** Hard limit of node executions (the graph-level max_turns). Default 10. */
  maxSteps?: number;
}

/** Global execution state, shared across nodes. */
export interface GraphState {
  currentNode: string;
  /** Node executions so far. */
  step: number;
  /** Visits per node id. */
  visits: Record<string, number>;
  /** Outcome of every node execution, oldest first. */
  nodeResults: NodeExecution[];
  /** Notes each node leaves for the others (final response content). */
  shared: Record<string, string>;
}

/** Record of one node execution inside the graph. */
export interface NodeExecution {
  nodeId: string;
  role: string;
  status: 'SUCCESS' | 'FAILED';
  turns: number;
  finalResponse?: ModelResponse;
  verifications: VerificationResult[];
}

/** What the graph router decides after a node finishes its loop. */
export type GraphDecision =
  | { action: 'NEXT'; node: string; reason: string }
  | { action: 'FINISH'; reason: string }
  | { action: 'FAIL'; reason: string };

/** Final outcome of the whole graph execution. */
export interface GraphResult {
  status: 'SUCCESS' | 'FAILED';
  /** Node executions performed. */
  steps: number;
  decision: GraphDecision;
  state: GraphState;
  trace: GraphStepTrace[];
  /** Sum of every node's loop turns. */
  totalLoopTurns: number;
  failure?: string;
}

/** Trace of one graph step. */
export interface GraphStepTrace {
  step: number;
  nodeId: string;
  loopStatus: 'SUCCESS' | 'FAILED';
  decision: GraphDecision;
}

/** Builds the corrective loop for one node execution (one visit). */
export type LoopFactory = (node: GraphNode) => AgentLoop;

export type { LoopResult };

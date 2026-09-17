import type {
  GraphDecision,
  GraphRequest,
  GraphResult,
  GraphState,
  GraphStepTrace,
  NodeExecution,
} from './contracts.js';
import type { LoopFactory } from './contracts.js';

/**
 * C3 graph engine: a state machine over nodes. Each step runs one node's
 * corrective loop, then the router follows the edge matching the loop
 * outcome. Routing is deterministic (verification evidence, never model
 * claims); the reviewer pattern is an on_failure edge back to the node
 * responsible for the failure. maxSteps prevents node ping-pong.
 */
export class GraphEngine {
  constructor(
    private readonly createLoop: LoopFactory,
    private readonly request: GraphRequest,
  ) {}

  async run(): Promise<GraphResult> {
    const maxSteps = this.request.maxSteps ?? 10;
    const nodes = new Map(this.request.nodes.map((n) => [n.id, n]));

    const state: GraphState = {
      currentNode: this.request.initialNode,
      step: 0,
      visits: {},
      nodeResults: [],
      shared: {},
    };
    const trace: GraphStepTrace[] = [];
    let totalLoopTurns = 0;

    let decision: GraphDecision = { action: 'FAIL', reason: 'The graph did not execute any step' };

    while (true) {
      if (state.step >= maxSteps) {
        decision = { action: 'FAIL', reason: `maxSteps (${maxSteps}) reached without finishing` };
        break;
      }

      const node = nodes.get(state.currentNode);
      if (!node) {
        decision = { action: 'FAIL', reason: `Unknown node '${state.currentNode}'` };
        break;
      }

      state.step += 1;
      state.visits[node.id] = (state.visits[node.id] ?? 0) + 1;

      const loop = this.createLoop(node);
      const loopResult = await loop.run({
        task: node.task,
        maxTurns: node.maxTurns ?? 3,
        verification: node.verification,
        toolRoundsPerTurn: node.toolRoundsPerTurn ?? 8,
        instructions: node.instructions,
      });
      totalLoopTurns += loopResult.turns;

      const execution: NodeExecution = {
        nodeId: node.id,
        role: node.role,
        status: loopResult.status,
        turns: loopResult.turns,
        finalResponse: loopResult.finalResponse,
        verifications: loopResult.verifications,
      };
      state.nodeResults.push(execution);
      if (loopResult.finalResponse?.type === 'finish') {
        state.shared[node.id] = loopResult.finalResponse.content;
      }

      decision = this.route(node.id, loopResult.status);
      trace.push({ step: state.step, nodeId: node.id, loopStatus: loopResult.status, decision });

      if (decision.action === 'NEXT') {
        state.currentNode = decision.node;
        continue;
      }
      break; // FINISH or FAIL
    }

    return {
      status: decision.action === 'FINISH' ? 'SUCCESS' : 'FAILED',
      steps: state.step,
      decision,
      state,
      trace,
      totalLoopTurns,
      ...(decision.action === 'FINISH' ? {} : { failure: decision.reason }),
    };
  }

      /** A successful node with no matching edge is terminal; a failed node with no on_failure edge fails the graph. */
  private route(nodeId: string, loopStatus: 'SUCCESS' | 'FAILED'): GraphDecision {
    const edges = this.request.edges.filter((e) => e.from === nodeId);
    const wanted = loopStatus === 'SUCCESS' ? 'on_success' : 'on_failure';

    const match = edges.find((e) => e.condition === wanted) ?? edges.find((e) => e.condition === 'always');
    if (match) {
      return {
        action: 'NEXT',
        node: match.to,
        reason: `Node '${nodeId}' ${loopStatus} -> ${match.condition} edge to '${match.to}'`,
      };
    }

    if (loopStatus === 'SUCCESS') {
      return { action: 'FINISH', reason: `Node '${nodeId}' succeeded and has no outgoing edge (terminal)` };
    }
    return { action: 'FAIL', reason: `Node '${nodeId}' failed and has no on_failure edge` };
  }
}

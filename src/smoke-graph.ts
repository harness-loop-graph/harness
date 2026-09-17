import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GraphEngine } from './graph/graph-engine.js';
import type { GraphNode, LoopFactory } from './graph/contracts.js';
import { AgentLoop } from './loop/agent-loop.js';
import { Harness } from './harness.js';
import { FsContextManager } from './components/context-manager.js';
import { GlmModelAdapter } from './components/glm-adapter.js';
import { LocalExecutionManager } from './components/execution-manager.js';
import { PolicyGuardrails } from './components/guardrails.js';
import { RegistryToolManager, registerBuiltinTools } from './components/tool-manager.js';
import { RecordingVerificationManager } from './components/verification-manager.js';

/**
 * Live smoke test for the C3 multi-agent graph against the real model.
 * A minimal architect -> builder graph: the architect node produces the
 * spec, the builder node implements it; each node runs its own C2 loop
 * with operator-owned verification. Requires MODEL_API_KEY/MODEL_ID.
 */
async function main(): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-graph-smoke-'));
  const sessionId = randomUUID();

  const createLoop: LoopFactory = (node: GraphNode) => {
    const execution = new LocalExecutionManager({ workspaceRoot: workspace, timeoutMs: 30_000 });
    const guardrails = new PolicyGuardrails(
      {
        workspaceRoot: workspace,
        allowedTools: ['write_file', 'read_file', 'run_command'],
        allowedCommandPrefixes: ['npm', 'node', 'npx', 'git', 'ls', 'cat', 'echo', 'mkdir', 'test'],
        maxFileBytes: 1024 * 1024,
      },
      path.join(workspace, `audit-${node.id}.jsonl`),
    );
    const tools = new RegistryToolManager(guardrails);
    const availTools = registerBuiltinTools(tools, { execution, workspaceRoot: workspace });
    const verification = new RecordingVerificationManager();

    // Same provider session across nodes: one conversation per graph run
    // keeps provider-side prompt caching effective.
    const model = new GlmModelAdapter({ sessionId });

    const harness = new Harness(
      { context: new FsContextManager(), model, tools, execution, verification, guardrails },
      {
        workspaceRoot: workspace,
        availTools,
        instructions:
          `You are the '${node.role}' agent of a multi-agent graph inside a controlled harness. ` +
          'Use the provided tools to complete your node task. Stay inside the workspace. ' +
          'Finish with a final answer once your task is complete.',
      },
    );
    return new AgentLoop({ harness, execution, verification, workspaceRoot: workspace });
  };

  const engine = new GraphEngine(createLoop, {
    task: 'Produce spec.txt and app.txt',
    initialNode: 'architect',
    nodes: [
      {
        id: 'architect',
        role: 'architect',
        task: 'Create spec.txt containing one line: "artifact: app.txt must contain the text graph alive"',
        verification: { command: 'grep -q "graph alive" spec.txt' },
        maxTurns: 2,
      },
      {
        id: 'builder',
        role: 'backend',
        task: 'Read spec.txt and create app.txt exactly as the spec requires.',
        verification: { command: 'grep -q "graph alive" app.txt' },
        maxTurns: 3,
      },
    ],
    edges: [{ from: 'architect', to: 'builder', condition: 'on_success' }],
    maxSteps: 6,
  });

  console.log(`Workspace: ${workspace}`);
  console.log('Graph: architect --on_success--> builder (terminal)\n');

  const result = await engine.run();

  console.log('--- Graph trace ---');
  for (const step of result.trace) {
    console.log(
      `step ${step.step}: node '${step.nodeId}' loop=${step.loopStatus} -> ${step.decision.action}` +
        (step.decision.action === 'NEXT' ? ` (${step.decision.node})` : ''),
    );
  }

  console.log(`\nStatus: ${result.status} after ${result.steps} step(s), ${result.totalLoopTurns} loop turn(s)`);
  console.log(`Decision: ${result.decision.action} — ${result.decision.reason}`);
  if (result.failure) console.log(`Failure: ${result.failure}`);

  if (result.status !== 'SUCCESS') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

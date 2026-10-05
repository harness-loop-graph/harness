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

/** Live C3 smoke: architect -> builder graph, each node runs its own C2 loop. */
async function main(): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-graph-smoke-'));
  const sessionId = randomUUID();
  const models: GlmModelAdapter[] = [];

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
    models.push(model);

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
        verification: {
          command:
              `node -e "const fs=require('fs'); ` +
              `process.exit(fs.readFileSync('spec.txt','utf8').includes('graph alive') ? 0 : 1)"`,
        },
        maxTurns: 2,
      },
      {
        id: 'builder',
        role: 'backend',
        task: 'Read spec.txt and create app.txt exactly as the spec requires.',
        verification: {
          command:
              `node -e "const fs=require('fs'); ` +
              `process.exit(fs.readFileSync('app.txt','utf8').includes('graph alive') ? 0 : 1)"`,
        },
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

  const totalUsage = models.reduce(
      (total, model) => {const usage = model.getUsage();
        total.calls += usage.calls;
        total.promptTokens += usage.promptTokens;
        total.completionTokens += usage.completionTokens;
        total.cost += usage.cost;
        for (const modelName of usage.modelsUsed) {
          total.modelsUsed.add(modelName);
        }
        return total;
      },
      {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
        modelsUsed: new Set<string>(),
      },
  );
  console.log('\n--- Usage ---');
  console.log(`Calls: ${totalUsage.calls}`);
  console.log(`Prompt tokens: ${totalUsage.promptTokens}`);
  console.log(`Completion tokens: ${totalUsage.completionTokens}`);
  console.log(
      `Total tokens: ${totalUsage.promptTokens + totalUsage.completionTokens}`,
  );
  console.log(`Cost: $${totalUsage.cost.toFixed(6)}`);

  console.log('\n--- Models used ---');
  for (const model of totalUsage.modelsUsed) {
    console.log(`- ${model}`);
  }

  if (result.status !== 'SUCCESS') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

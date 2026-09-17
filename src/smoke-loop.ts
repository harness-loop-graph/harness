import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentLoop } from './loop/agent-loop.js';
import { Harness } from './harness.js';
import { FsContextManager } from './components/context-manager.js';
import { GlmModelAdapter } from './components/glm-adapter.js';
import { LocalExecutionManager } from './components/execution-manager.js';
import { PolicyGuardrails } from './components/guardrails.js';
import { RegistryToolManager, registerBuiltinTools } from './components/tool-manager.js';
import { RecordingVerificationManager } from './components/verification-manager.js';

/**
 * Live smoke test for the C2 corrective loop against the real model.
 * Requires MODEL_API_KEY and MODEL_ID in the environment. The loop's
 * verification is operator-owned: the model never sees it, it only
 * receives its feedback when it fails.
 */
async function main(): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-loop-smoke-'));

  const execution = new LocalExecutionManager({ workspaceRoot: workspace, timeoutMs: 30_000 });
  const guardrails = new PolicyGuardrails(
    {
      workspaceRoot: workspace,
      allowedTools: ['write_file', 'read_file', 'run_command'],
      allowedCommandPrefixes: ['npm', 'node', 'npx', 'git', 'ls', 'cat', 'echo', 'mkdir', 'test'],
      maxFileBytes: 1024 * 1024,
    },
    path.join(workspace, 'audit.jsonl'),
  );
  const tools = new RegistryToolManager(guardrails);
  const availTools = registerBuiltinTools(tools, { execution, workspaceRoot: workspace });
  const verification = new RecordingVerificationManager(path.join(workspace, 'verifications.jsonl'));
  const model = new GlmModelAdapter({ sessionId: randomUUID() });

  const harness = new Harness(
    {
      context: new FsContextManager(),
      model,
      tools,
      execution,
      verification,
      guardrails,
    },
    {
      workspaceRoot: workspace,
      availTools,
      instructions:
        'You are a code-generation agent inside a controlled harness. ' +
        'Use the provided tools to complete the task. Stay inside the workspace. ' +
        'Finish with a final answer once the task is complete.',
    },
  );

  const loop = new AgentLoop({ harness, execution, verification, workspaceRoot: workspace });

  console.log(`Workspace: ${workspace}`);
  console.log('Task: create loop.txt containing exactly "loop alive".');
  console.log('Verification (hidden from the model): grep -q "loop alive" loop.txt\n');

  const result = await loop.run({
    task: 'Create a file named loop.txt containing exactly the text "loop alive".',
    maxTurns: 3,
    toolRoundsPerTurn: 6,
    verification: { command: 'grep -q "loop alive" loop.txt' },
  });

  console.log('--- Loop trace ---');
  for (const turn of result.trace) {
    const responseLabel =
      turn.response.type === 'tool_call'
        ? `tool_call(${turn.response.tool})`
        : turn.response.type;
    console.log(
      `turn ${turn.turn}: ${responseLabel} | verification ${turn.verification ? (turn.verification.passed ? 'passed' : 'FAILED') : 'n/a'} -> ${turn.decision.action}`,
    );
    if (turn.decision.action === 'RETRY') {
      console.log(`  retry reason: ${turn.decision.reason}`);
    }
  }

  console.log(`\nStatus: ${result.status} after ${result.turns} turn(s)`);
  console.log(`Decision: ${result.decision.action} — ${result.decision.reason}`);
  if (result.failure) console.log(`Failure: ${result.failure}`);

  if (result.status !== 'SUCCESS') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

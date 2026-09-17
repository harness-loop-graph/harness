import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Harness } from './harness.js';
import { FsContextManager } from './components/context-manager.js';
import { GlmModelAdapter } from './components/glm-adapter.js';
import { LocalExecutionManager } from './components/execution-manager.js';
import { PolicyGuardrails } from './components/guardrails.js';
import { RegistryToolManager, registerBuiltinTools } from './components/tool-manager.js';
import { RecordingVerificationManager } from './components/verification-manager.js';

/**
 * Live smoke test for the C1 harness against the real GLM endpoint.
 * Requires GLM_API_KEY and GLM_MODEL in the environment; exits with
 * a non-zero code if the cycle does not finish successfully.
 */
async function main(): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-smoke-'));

  const execution = new LocalExecutionManager({ workspaceRoot: workspace, timeoutMs: 30_000 });
  const guardrails = new PolicyGuardrails(
    {
      workspaceRoot: workspace,
      allowedTools: ['write_file', 'read_file', 'run_command'],
      allowedCommandPrefixes: ['npm', 'node', 'npx', 'git', 'ls', 'cat', 'echo', 'mkdir'],
      maxFileBytes: 1024 * 1024,
    },
    path.join(workspace, 'audit.jsonl'),
  );
  const tools = new RegistryToolManager(guardrails);
  const availTools = registerBuiltinTools(tools, { execution, workspaceRoot: workspace });
  const model = new GlmModelAdapter();

  const harness = new Harness(
    {
      context: new FsContextManager(),
      model,
      tools,
      execution,
      verification: new RecordingVerificationManager(path.join(workspace, 'verifications.jsonl')),
      guardrails,
    },
    {
      workspaceRoot: workspace,
      availTools,
      instructions:
        'You are a code-generation agent inside a controlled harness. ' +
        'Use the provided tools to complete the task. Stay inside the workspace.',
    },
  );

  console.log(`Workspace: ${workspace}`);
  console.log('Task: create a file named smoke.txt containing the text "GLM harness alive", then finish.\n');

  const result = await harness.run(
    'Create a file named smoke.txt containing exactly the text "GLM harness alive", then report you are done.',
  );

  console.log('--- Trace ---');
  for (const [i, turn] of result.turns.entries()) {
    const label =
      turn.response.type === 'tool_call'
        ? `tool_call(${turn.response.tool})`
        : turn.response.type;
    console.log(`turn ${i}: ${label}`);
    if (turn.toolResult) {
      console.log(`  tool success=${turn.toolResult.success}`);
    }
  }

  console.log('\n--- Final response ---');
  console.log(JSON.stringify(result.finalResponse, null, 2));
  console.log(`\nAudit decisions: ${result.audit.map((a) => a.decision).join(', ') || '(none)'}`);

  const smokePath = path.join(workspace, 'smoke.txt');
  const content = await fs.readFile(smokePath, 'utf8').catch(() => null);
  const ok = content !== null && content.includes('GLM harness alive');

  console.log(`\nsmoke.txt present and correct: ${ok}`);
  if (!ok || result.finalResponse.type !== 'finish') {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

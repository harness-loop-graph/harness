import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelResponse } from '../src/index.js';
import {
  AgentLoop,
  FsContextManager,
  GraphEngine,
  Harness,
  LocalExecutionManager,
  PolicyGuardrails,
  RegistryToolManager,
  RecordingVerificationManager,
  registerBuiltinTools,
} from '../src/index.js';
import type { GraphNode, GraphRouter, LoopFactory, ModelAdapter } from '../src/index.js';
import type { ModelRequest } from '../src/index.js';

/** Replays a fixed list of responses; errors when exhausted. */
class StaticModelAdapter implements ModelAdapter {
  private call = 0;
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(_request: ModelRequest): Promise<ModelResponse> {
    return this.responses[this.call++] ?? { type: 'error', code: 'script_exhausted', message: 'no more responses' };
  }
}

describe('C3 multi-agent graph', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-c3-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  /** Standard wiring: real components + the given model, per node visit. */
  function makeLoopFactory(): { factory: LoopFactory; attempts: Record<string, ModelResponse[][]> } {
    const attempts: Record<string, ModelResponse[][]> = {};

    const factory: LoopFactory = (node: GraphNode) => {
      const execution = new LocalExecutionManager({ workspaceRoot: workspace, timeoutMs: 10_000 });
      const guardrails = new PolicyGuardrails({
        workspaceRoot: workspace,
        allowedTools: ['write_file', 'read_file', 'run_command'],
        allowedCommandPrefixes: ['npm', 'node', 'npx', 'git', 'ls', 'cat', 'echo', 'mkdir', 'test'],
        maxFileBytes: 1024 * 1024,
      });
      const tools = new RegistryToolManager(guardrails);
      const availTools = registerBuiltinTools(tools, { execution, workspaceRoot: workspace });
      const verification = new RecordingVerificationManager();

      const queue = attempts[node.id] ?? [];
      const script = queue.shift() ?? [{ type: 'finish' as const, content: 'nothing scripted' }];
      const model = new StaticModelAdapter(script);

      const harness = new Harness(
        { context: new FsContextManager(), model, tools, execution, verification, guardrails },
        { workspaceRoot: workspace, availTools, instructions: 'Stay inside the workspace.' },
      );
      return new AgentLoop({ harness, execution, verification, workspaceRoot: workspace });
    };

    return { factory, attempts };
  }

  it('runs a linear graph: architect -> builder -> FINISH', async () => {
    const { factory, attempts } = makeLoopFactory();
    attempts.architect = [
      [
        { type: 'tool_call', tool: 'write_file', args: { path: 'spec.txt', content: 'plan: build app.txt' } },
        { type: 'finish', content: 'spec ready' },
      ],
    ];
    attempts.builder = [
      [
        { type: 'tool_call', tool: 'write_file', args: { path: 'app.txt', content: 'app ready' } },
        { type: 'finish', content: 'app built' },
      ],
    ];

    const engine = new GraphEngine(factory, {
      task: 'Build the artifact from a spec',
      initialNode: 'architect',
      nodes: [
        {
          id: 'architect',
          role: 'architect',
          task: 'Create spec.txt containing a plan line',
          verification: { command: 'grep -q "plan" spec.txt' },
          maxTurns: 2,
        },
        {
          id: 'builder',
          role: 'backend',
          task: 'Create app.txt containing "app ready"',
          verification: { command: 'grep -q "app ready" app.txt' },
          maxTurns: 2,
        },
      ],
      edges: [{ from: 'architect', to: 'builder', condition: 'on_success' }],
      maxSteps: 6,
    });

    const result = await engine.run();

    expect(result.status).toBe('SUCCESS');
    expect(result.steps).toBe(2);
    expect(result.decision.action).toBe('FINISH');
    expect(result.state.nodeResults.map((n) => n.status)).toEqual(['SUCCESS', 'SUCCESS']);
    expect(result.state.shared.architect).toContain('spec ready');
    await expect(fs.readFile(path.join(workspace, 'app.txt'), 'utf8')).resolves.toContain('app ready');
  });

  it('reviewer pattern: a failing reviewer returns the flow to the responsible node', async () => {
    const { factory, attempts } = makeLoopFactory();
    // Visit 1: the builder passes its own (weaker) verification...
    attempts.builder = [
      [
        { type: 'tool_call', tool: 'write_file', args: { path: 'w.txt', content: 'placeholder' } },
        { type: 'finish', content: 'created w.txt' },
      ],
      // Visit 2: after the reviewer rejects it, produce the real content.
      [
        { type: 'tool_call', tool: 'write_file', args: { path: 'w.txt', content: 'final content' } },
        { type: 'finish', content: 'fixed w.txt' },
      ],
    ];
    // The reviewer only reports; its verification is the cross-layer check.
    attempts.reviewer = [
      [{ type: 'finish', content: 'review: not acceptable yet' }],
      [{ type: 'finish', content: 'review: acceptable' }],
    ];

    const engine = new GraphEngine(factory, {
      task: 'Produce w.txt with final content',
      initialNode: 'builder',
      nodes: [
        {
          id: 'builder',
          role: 'backend',
          task: 'Create w.txt with the final content',
          // Node-level verification: weaker than the reviewer's.
          verification: { command: 'test -f w.txt' },
          maxTurns: 2,
        },
        {
          id: 'reviewer',
          role: 'reviewer',
          task: 'Review the produced artifact',
          // Cross-layer verification catches what the node check missed.
          verification: { command: 'grep -q "final content" w.txt' },
          maxTurns: 1,
        },
      ],
      edges: [
        { from: 'builder', to: 'reviewer', condition: 'on_success' },
        // The reviewer returns the flow to the layer responsible for the failure.
        { from: 'reviewer', to: 'builder', condition: 'on_failure' },
      ],
      maxSteps: 8,
    });

    const result = await engine.run();

    expect(result.status).toBe('SUCCESS');
    expect(result.steps).toBe(4); // builder, reviewer, builder, reviewer
    expect(result.state.visits.builder).toBe(2);
    expect(result.state.visits.reviewer).toBe(2);
    // The graph trace shows the conditional branch back to the builder.
    expect(result.trace[1].decision.action).toBe('NEXT');
    if (result.trace[1].decision.action === 'NEXT') {
      expect(result.trace[1].decision.node).toBe('builder');
    }
    const content = await fs.readFile(path.join(workspace, 'w.txt'), 'utf8');
    expect(content).toBe('final content');
  });

  it('FAILs by maxSteps when nodes keep bouncing', async () => {
    const { factory, attempts } = makeLoopFactory();
    // The builder never produces acceptable content; the reviewer keeps rejecting.
    attempts.builder = [
      [{ type: 'tool_call', tool: 'write_file', args: { path: 'w.txt', content: 'placeholder' } }, { type: 'finish', content: 'done' }],
      [{ type: 'tool_call', tool: 'write_file', args: { path: 'w.txt', content: 'placeholder2' } }, { type: 'finish', content: 'done' }],
      [{ type: 'tool_call', tool: 'write_file', args: { path: 'w.txt', content: 'placeholder3' } }, { type: 'finish', content: 'done' }],
    ];
    attempts.reviewer = [[{ type: 'finish', content: 'nope' }]];

    const engine = new GraphEngine(factory, {
      task: 'Produce w.txt',
      initialNode: 'builder',
      nodes: [
        { id: 'builder', role: 'backend', task: 'Create w.txt', verification: { command: 'test -f w.txt' }, maxTurns: 1 },
        { id: 'reviewer', role: 'reviewer', task: 'Review', verification: { command: 'grep -q "final content" w.txt' }, maxTurns: 1 },
      ],
      edges: [
        { from: 'builder', to: 'reviewer', condition: 'on_success' },
        { from: 'reviewer', to: 'builder', condition: 'on_failure' },
      ],
      maxSteps: 4,
    });

    const result = await engine.run();

    expect(result.status).toBe('FAILED');
    expect(result.steps).toBe(4);
    expect(result.failure).toContain('maxSteps');
    // Reviewer visits bounced until the budget ran out.
    expect(result.state.visits.reviewer).toBe(2);
  });

  it('FAILs when a node fails and no on_failure edge exists', async () => {
    const { factory, attempts } = makeLoopFactory();
    attempts.solo = [[{ type: 'finish', content: 'done (nothing written)' }]];

    const engine = new GraphEngine(factory, {
      task: 'Create missing.txt',
      initialNode: 'solo',
      nodes: [{ id: 'solo', role: 'backend', task: 'Create missing.txt', verification: { command: 'test -f missing.txt' }, maxTurns: 1 }],
      edges: [],
      maxSteps: 3,
    });

    const result = await engine.run();

    expect(result.status).toBe('FAILED');
    expect(result.decision.action).toBe('FAIL');
    expect(result.failure).toContain('no on_failure edge');
  });

  it('routes through a custom router when provided', async () => {
    const { factory, attempts } = makeLoopFactory();
    attempts.source = [[{ type: 'finish', content: 'route to target' }]];
    attempts.target = [[{ type: 'finish', content: 'target reached' }]];

    const router: GraphRouter = (nodeId, _loopResult, state) => {
      if (nodeId === 'source' && state.shared.source === 'route to target') {
        return { action: 'NEXT', node: 'target', reason: 'custom router decided target' };
      }
      return { action: 'FINISH', reason: 'custom router finished' };
    };

    const engine = new GraphEngine(factory, {
      task: 'Test custom router',
      initialNode: 'source',
      nodes: [
        { id: 'source', role: 'test', task: 'Emit content', maxTurns: 1 },
        { id: 'target', role: 'test', task: 'Receive routing', maxTurns: 1 },
      ],
      edges: [],
      maxSteps: 4,
    }, router);

    const result = await engine.run();
    expect(result.status).toBe('SUCCESS');
    expect(result.steps).toBe(2);
    expect(result.trace[0].decision.action).toBe('NEXT');
    if (result.trace[0].decision.action === 'NEXT') {
      expect(result.trace[0].decision.node).toBe('target');
    }
    expect(result.state.shared.source).toBe('route to target');
  });

  it('falls back to static edge routing when no custom router is provided', async () => {
    const { factory, attempts } = makeLoopFactory();
    attempts.alpha = [[{ type: 'finish', content: 'alpha done' }]];
    attempts.beta = [[{ type: 'finish', content: 'beta done' }]];

    const engine = new GraphEngine(factory, {
      task: 'Test static fallback',
      initialNode: 'alpha',
      nodes: [
        { id: 'alpha', role: 'test', task: 'Step alpha', maxTurns: 1 },
        { id: 'beta', role: 'test', task: 'Step beta', maxTurns: 1 },
      ],
      edges: [{ from: 'alpha', to: 'beta', condition: 'on_success' }],
      maxSteps: 4,
    });

    const result = await engine.run();
    expect(result.status).toBe('SUCCESS');
    expect(result.steps).toBe(2);
    expect(result.state.currentNode).toBe('beta');
    expect(result.trace[0].decision.action).toBe('NEXT');
    if (result.trace[0].decision.action === 'NEXT') {
      expect(result.trace[0].decision.node).toBe('beta');
    }
  });

  it('FAILs immediately on an unknown initial node', async () => {
    const { factory } = makeLoopFactory();
    const engine = new GraphEngine(factory, {
      task: 'Nothing',
      initialNode: 'ghost',
      nodes: [{ id: 'real', role: 'backend', task: 'x' }],
      edges: [],
    });

    const result = await engine.run();

    expect(result.status).toBe('FAILED');
    expect(result.steps).toBe(0);
    expect(result.failure).toContain("Unknown node 'ghost'");
  });
});

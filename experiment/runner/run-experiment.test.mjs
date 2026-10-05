// Unit tests for the runner's --harness-config wiring (T6). Uses the harness's own
// fixture MCP server + skill fixtures rather than talking to a real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpToolProvider, GlmModelAdapter, RoutingModelAdapter } from '../../harness/dist/index.js';
import {
  parseArgs,
  buildNodes,
  loadHarnessExtras,
  buildHarness,
  createModel,
  createWorkspace,
  summarizeRouting,
  attachUsageAndRouting,
  compactTraceC3,
  slugifyModelId,
  timestampForWorkspace,
  initWorkspaceRepo,
  findAcceptancePathInWorkspace,
  collectSecretValues,
  scanWorkspaceForSecrets,
  checkGhAuthenticated,
  publishWorkspace,
} from './run-experiment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLM_TESTS_DIR = path.resolve(__dirname, '..', '..', 'harness', 'tests');
const FIXTURE_MCP_SERVER = path.join(GLM_TESTS_DIR, 'fixtures', 'mcp-fixture-server.mjs');
const FIXTURE_SKILLS_DIR = path.join(GLM_TESTS_DIR, 'fixtures', 'skills');

async function writeHarnessConfigFile(dir, { skillsDirs } = {}) {
  const file = path.join(dir, 'harness-config.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      mcpServers: {
        fixture: { command: 'node', args: [FIXTURE_MCP_SERVER] },
      },
      skillsDirs: skillsDirs ?? [FIXTURE_SKILLS_DIR],
    }),
  );
  return file;
}

test('loadHarnessExtras() reports MCP tools + skill metadata for run-report.json', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-config-'));
  let extras;
  try {
    const configPath = await writeHarnessConfigFile(workspace);
    extras = await loadHarnessExtras(configPath);

    assert.deepEqual(extras.metadata.mcpServers, ['fixture']);
    assert.deepEqual(
      [...extras.metadata.toolNames].sort(),
      ['load_skill', 'mcp__fixture__echo', 'mcp__fixture__fail'].sort(),
    );
    assert.deepEqual(extras.metadata.skillNames, ['writing-tests']);
    assert.equal(extras.metadata.path, configPath);
    assert.equal(typeof extras.metadata.sha256, 'string');
  } finally {
    await extras?.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('buildHarness() registers MCP tools + load_skill and extends the guardrail allowlist', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-harness-'));
  let extras;
  try {
    const configPath = await writeHarnessConfigFile(workspace);
    extras = await loadHarnessExtras(configPath);

    const { tools, guardrails } = buildHarness(workspace, {}, 5, path.join(workspace, 'audit.jsonl'), extras);

    const names = tools.getSpecs().map((s) => s.name).sort();
    assert.deepEqual(names, [
      'load_skill',
      'mcp__fixture__echo',
      'mcp__fixture__fail',
      'read_file',
      'run_command',
      'write_file',
    ]);

    for (const tool of ['mcp__fixture__echo', 'mcp__fixture__fail', 'load_skill']) {
      const decision = await guardrails.evaluate({ kind: 'tool', tool, args: {} });
      assert.equal(decision.decision, 'allowed', `${tool} should be allowed by the extended guardrail policy`);
    }
  } finally {
    await extras?.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('buildHarness() without a --harness-config builds the same tool set as before', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-no-config-'));
  try {
    const { tools, guardrails } = buildHarness(workspace, {}, 5, path.join(workspace, 'audit.jsonl'), null);

    const names = tools.getSpecs().map((s) => s.name).sort();
    assert.deepEqual(names, ['read_file', 'run_command', 'write_file']);

    const decision = await guardrails.evaluate({ kind: 'tool', tool: 'mcp__fixture__echo', args: {} });
    assert.equal(decision.decision, 'denied');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('loadHarnessExtras() closes the MCP provider when the skills load fails', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-skills-fail-'));
  const closeCalls = [];
  const originalClose = McpToolProvider.prototype.close;
  McpToolProvider.prototype.close = function patchedClose(...args) {
    closeCalls.push(this);
    return originalClose.apply(this, args);
  };
  try {
    const configPath = await writeHarnessConfigFile(workspace, {
      skillsDirs: [path.join(workspace, 'no-such-skills-dir')],
    });

    await assert.rejects(() => loadHarnessExtras(configPath), /Cannot read skills directory/);
    assert.equal(closeCalls.length, 1, 'the MCP provider must be closed when SkillCatalog.load() fails');
  } finally {
    McpToolProvider.prototype.close = originalClose;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('createModel() returns the plain GlmModelAdapter unchanged without a router (identical for every config)', async () => {
  for (const harnessExtras of [null, {}, { router: undefined }]) {
    const model = await createModel({ apiKey: 'k', modelId: 'm', sessionId: 's', harnessExtras });
    assert.ok(model instanceof GlmModelAdapter, 'expected a plain GlmModelAdapter, not a router wrapper');
  }
});

test('createModel() wraps the default adapter in a RoutingModelAdapter with the configured routes when a router is set', async () => {
  const created = [];
  const makeAdapter = (cfg) => {
    created.push(cfg);
    return { async complete() { return { type: 'finish', content: 'stub' }; } };
  };
  const previousLongKey = process.env.LONG_KEY;
  const previousModelApiKey = process.env.MODEL_API_KEY;
  process.env.LONG_KEY = 'long-key';
  // The 'retry' route has no apiKeyEnv, so it must fall back to
  // MODEL_API_KEY. Use a distinct value from the `apiKey` passed to
  // createModel() below (a different, unrelated 'run-default-key') so the
  // assertion can actually tell the fallback came from MODEL_API_KEY and
  // not from the createModel() call's own apiKey argument.
  process.env.MODEL_API_KEY = 'env-fallback-key';
  try {
    const model = await createModel({
      apiKey: 'run-default-key',
      modelId: 'default-model',
      sessionId: 'sess-1',
      harnessExtras: {
        router: {
          routes: {
            longContext: { model: 'long-model', apiKeyEnv: 'LONG_KEY' },
            retry: { model: 'retry-model' },
          },
        },
      },
      makeAdapter,
    });

    assert.ok(model instanceof RoutingModelAdapter);
    assert.equal(typeof model.getUsage, 'function');
    assert.equal(typeof model.getRouting, 'function');
    assert.deepEqual(created, [
      { apiKey: 'long-key', model: 'long-model', baseUrl: undefined, sessionId: 'sess-1' },
      { apiKey: 'env-fallback-key', model: 'retry-model', baseUrl: undefined, sessionId: 'sess-1' },
    ]);
  } finally {
    if (previousLongKey === undefined) delete process.env.LONG_KEY;
    else process.env.LONG_KEY = previousLongKey;
    if (previousModelApiKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previousModelApiKey;
  }
});

test('createModel() propagates a clear error naming the route and env var when apiKeyEnv is unset', async () => {
  delete process.env.MISSING_KEY;
  await assert.rejects(
    () =>
      createModel({
        apiKey: 'default-key',
        modelId: 'default-model',
        sessionId: 'sess-1',
        harnessExtras: { router: { routes: { longContext: { model: 'long-model', apiKeyEnv: 'MISSING_KEY' } } } },
        makeAdapter: () => ({ async complete() { return { type: 'finish', content: 'stub' }; } }),
      }),
    /route 'longContext' needs env var 'MISSING_KEY'/,
  );
});

test('attachUsageAndRouting() sets report.routing from a router model (shared by c1/c2/c3)', async () => {
  const created = [];
  const makeAdapter = (cfg) => {
    created.push(cfg);
    return { async complete() { return { type: 'finish', content: 'stub' }; } };
  };
  const previousModelApiKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = 'default-key';
  try {
    const model = await createModel({
      apiKey: 'default-key',
      modelId: 'default-model',
      sessionId: 'sess-1',
      harnessExtras: { router: { routes: { retry: { model: 'retry-model' } } } },
      makeAdapter,
    });
    await model.complete({ task: 't', context: { projectRoot: '/tmp', files: [] }, availTools: [], feedback: 'retry this' });

    // c1, c2 and c3 each call attachUsageAndRouting() with their run's
    // model right after computing report.status; this is that one call
    // site, exercised directly instead of running a full harness/loop/graph.
    const report = { status: 'SUCCESS' };
    attachUsageAndRouting(report, model);

    assert.equal(typeof report.usage, 'object');
    assert.deepEqual(report.routing, { byRoute: report.routing.byRoute, decisions: { 'retry:retry': 1 } });
    assert.ok('retry' in report.routing.byRoute);
  } finally {
    if (previousModelApiKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previousModelApiKey;
  }
});

test('attachUsageAndRouting() leaves report.routing unset for a plain (non-router) model', async () => {
  const model = await createModel({ apiKey: 'k', modelId: 'm', sessionId: 's', harnessExtras: null });
  // A plain GlmModelAdapter never made a real call, so getUsage() just
  // needs to exist and be callable; the point here is the absent `routing`.
  const report = { status: 'SUCCESS' };
  attachUsageAndRouting(report, model);

  assert.equal(typeof report.usage, 'object');
  assert.equal('routing' in report, false);
});

test('loadHarnessExtras() adds routeNames metadata (["default", ...routes]) only when a router is configured', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-routenames-'));
  let extrasWithRouter;
  let extrasWithoutRouter;
  try {
    const withRouterConfig = path.join(workspace, 'with-router.json');
    await fs.writeFile(
      withRouterConfig,
      JSON.stringify({
        mcpServers: { fixture: { command: 'node', args: [FIXTURE_MCP_SERVER] } },
        router: { routes: { longContext: { model: 'big-model' }, retry: { model: 'retry-model' } } },
      }),
    );
    extrasWithRouter = await loadHarnessExtras(withRouterConfig);
    assert.deepEqual(extrasWithRouter.metadata.routeNames, ['default', 'longContext', 'retry']);

    const withoutRouterConfig = await writeHarnessConfigFile(workspace, { skillsDirs: [] });
    extrasWithoutRouter = await loadHarnessExtras(withoutRouterConfig);
    assert.equal('routeNames' in extrasWithoutRouter.metadata, false);
  } finally {
    await extrasWithRouter?.close();
    await extrasWithoutRouter?.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('summarizeRouting() collapses the decision log into counts per route/reason, keeping byRoute as-is', () => {
  const summary = summarizeRouting({
    byRoute: { default: { calls: 2, promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0 } },
    decisions: [
      { route: 'default', reason: 'default' },
      { route: 'default', reason: 'default' },
      { route: 'longContext', reason: 'long_context' },
    ],
  });

  assert.deepEqual(summary, {
    byRoute: { default: { calls: 2, promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0 } },
    decisions: { 'default:default': 2, 'longContext:long_context': 1 },
  });
});

test('runs main() when invoked through a symlinked path', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-entry-'));
  try {
    const link = path.join(dir, 'run experiment.mjs');
    await fs.symlink(path.join(__dirname, 'run-experiment.mjs'), link);
    const res = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Usage: node run-experiment\.mjs/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('c3 --dry-run --task-file passes the override into the GraphEngine node plan (not SPEC)', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-taskfile-'));
  try {
    const taskFile = path.join(dir, 'task.txt');
    const taskText = 'Create notes/summary.txt documenting the API';
    await fs.writeFile(taskFile, taskText);

    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c3', '--dry-run', '--task-file', taskFile],
      {
        encoding: 'utf8',
        // --dry-run never calls the model, but loadCredentials() runs before
        // the dry-run branch and requires these to be set.
        env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' },
      },
    );

    assert.equal(res.status, 0, res.stderr);
    const plan = JSON.parse(res.stdout);
    assert.ok(Array.isArray(plan.nodes) && plan.nodes.length > 0);
    for (const node of plan.nodes) {
      assert.match(node.task, /Create notes\/summary\.txt documenting the API/);
      assert.doesNotMatch(node.task, /SPEC/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--task-file rejects an empty/whitespace-only file with a usage error and non-zero exit, before any model call', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-taskfile-empty-'));
  try {
    const taskFile = path.join(dir, 'empty.txt');
    await fs.writeFile(taskFile, '   \n\t\n');

    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c3', '--dry-run', '--task-file', taskFile],
      {
        encoding: 'utf8',
        env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' },
      },
    );

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Usage: --task-file/);
    assert.equal(res.stdout, '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('compactTraceC3() copies loopFailure into a failed trace entry and omits it from a successful one', () => {
  const graphResult = {
    trace: [
      {
        step: 1,
        nodeId: 'builder',
        loopStatus: 'FAILED',
        decision: { action: 'FAIL', reason: 'x' },
        loopFailure: 'max_turns (1) reached without success',
      },
      {
        step: 2,
        nodeId: 'reviewer',
        loopStatus: 'SUCCESS',
        decision: { action: 'FINISH', reason: 'done' },
      },
    ],
  };

  const compact = compactTraceC3(graphResult);

  assert.equal(compact[0].loopFailure, 'max_turns (1) reached without success');
  assert.equal('loopFailure' in compact[1], false);
});

// --- T3: runs dir outside the repo, per-run git repo, opt-in publish ---

test('parseArgs() default --runs-dir resolves outside the monorepo (sibling pi-runs)', () => {
  const monorepoRoot = path.resolve(__dirname, '..', '..');
  const parsed = parseArgs(['node', 'run-experiment.mjs', '--config', 'c1']);
  assert.equal(parsed.runsDir, path.join(path.dirname(monorepoRoot), 'pi-runs'));
  assert.ok(!parsed.runsDir.startsWith(monorepoRoot + path.sep));
  assert.equal(parsed.publish, false);
  assert.equal(parsed.publishOrg, 'harness-loop-graph');
});

test('parseArgs() --publish and --publish-org', () => {
  const parsed = parseArgs(['node', 'run-experiment.mjs', '--config', 'c1', '--publish', '--publish-org', 'some-org']);
  assert.equal(parsed.publish, true);
  assert.equal(parsed.publishOrg, 'some-org');
});

test('slugifyModelId() lowercases and collapses non [a-z0-9] runs into single trimmed hyphens', () => {
  assert.equal(slugifyModelId('GLM-5.2'), 'glm-5-2');
  assert.equal(slugifyModelId('  Some/Model_ID!! '), 'some-model-id');
  assert.equal(slugifyModelId('already-lower'), 'already-lower');
});

test('timestampForWorkspace() formats YYYYMMDDTHHMMSS in UTC', () => {
  const d = new Date(Date.UTC(2026, 0, 5, 3, 4, 5));
  assert.equal(timestampForWorkspace(d), '20260105T030405');
});

test('createWorkspace() names the dir <slug>-<config>-<timestamp>, and --dry-run creates nothing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runsdir-'));
  try {
    const runsDir = path.join(dir, 'runs');
    const ws = await createWorkspace(runsDir, 'c2', 'GLM-5.2', '/nonexistent/SPEC.md', { dryRun: true });
    assert.equal(path.dirname(ws), runsDir);
    assert.match(path.basename(ws), /^glm-5-2-c2-\d{8}T\d{6}$/);
    await assert.rejects(fs.access(runsDir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('c1 --dry-run plan workspace is outside the monorepo and nothing is created on disk', async () => {
  const { spawnSync } = await import('node:child_process');
  const monorepoRoot = path.resolve(__dirname, '..', '..');
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run'],
    { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
  );
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.ok(!plan.workspace.startsWith(monorepoRoot + path.sep), `workspace ${plan.workspace} must be outside ${monorepoRoot}`);
  await assert.rejects(fs.access(path.dirname(plan.workspace)), 'the planned runs dir must not have been created');
});

test('initWorkspaceRepo() creates a git repo with one commit, a .gitignore, and a fixed local identity', async () => {
  const { execFileSync } = await import('node:child_process');
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-repo-'));
  try {
    await fs.writeFile(path.join(ws, 'run-report.json'), '{}');
    await fs.writeFile(path.join(ws, 'audit.jsonl'), '{}\n');
    await fs.mkdir(path.join(ws, 'node_modules'));
    await fs.writeFile(path.join(ws, 'node_modules', 'x.txt'), 'should be ignored');

    await initWorkspaceRepo(ws, 'run: glm-5.2 c1 (SUCCESS)');

    const branch = execFileSync('git', ['-C', ws, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
    assert.equal(branch, 'main');

    const log = execFileSync('git', ['-C', ws, 'log', '--format=%s|%an|%ae'], { encoding: 'utf8' }).trim();
    assert.equal(log, 'run: glm-5.2 c1 (SUCCESS)|pi-runner|pi-runner@users.noreply.github.com');

    const tracked = execFileSync('git', ['-C', ws, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(tracked.includes('run-report.json'));
    assert.ok(tracked.includes('audit.jsonl'));
    assert.ok(tracked.includes('.gitignore'));
    assert.ok(!tracked.some((f) => f.startsWith('node_modules/')));

    const gitignore = await fs.readFile(path.join(ws, '.gitignore'), 'utf-8');
    for (const line of ['node_modules/', 'dist/', 'build/', 'coverage/', '.env*']) {
      assert.ok(gitignore.includes(line), `expected .gitignore to include '${line}'`);
    }
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('scanWorkspaceForSecrets() detects a planted API key value and reports its relative path, never the value', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-secret-'));
  try {
    await fs.mkdir(path.join(ws, 'src'));
    await fs.writeFile(path.join(ws, 'src', 'config.js'), "export const KEY = 'sk-super-secret-123';\n");
    const secrets = collectSecretValues({ apiKey: 'sk-super-secret-123', harnessExtras: null });
    const hit = await scanWorkspaceForSecrets(ws, secrets);
    assert.deepEqual(hit, { file: 'src/config.js', label: 'MODEL_API_KEY' });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('scanWorkspaceForSecrets() finds nothing when the key is absent from the workspace', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-secret-clean-'));
  try {
    await fs.writeFile(path.join(ws, 'README.md'), 'nothing secret here');
    const secrets = collectSecretValues({ apiKey: 'sk-super-secret-123', harnessExtras: null });
    assert.equal(await scanWorkspaceForSecrets(ws, secrets), null);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("collectSecretValues() also includes each router route's apiKeyEnv value when configured", () => {
  const previous = process.env.TEST_ROUTE_KEY;
  process.env.TEST_ROUTE_KEY = 'route-secret-xyz';
  try {
    const secrets = collectSecretValues({
      apiKey: 'default-secret',
      harnessExtras: { router: { routes: { longContext: { model: 'm', apiKeyEnv: 'TEST_ROUTE_KEY' }, retry: { model: 'm2' } } } },
    });
    assert.deepEqual(
      secrets.sort((a, b) => a.label.localeCompare(b.label)),
      [
        { label: 'MODEL_API_KEY', value: 'default-secret' },
        { label: 'TEST_ROUTE_KEY', value: 'route-secret-xyz' },
      ],
    );
  } finally {
    if (previous === undefined) delete process.env.TEST_ROUTE_KEY;
    else process.env.TEST_ROUTE_KEY = previous;
  }
});

test('findAcceptancePathInWorkspace() flags any path containing an acceptance/ segment', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-acceptance-'));
  try {
    assert.equal(await findAcceptancePathInWorkspace(ws), null);
    await fs.mkdir(path.join(ws, 'experiment', 'acceptance'), { recursive: true });
    await fs.writeFile(path.join(ws, 'experiment', 'acceptance', 'run-all.mjs'), '// hidden battery');
    const hit = await findAcceptancePathInWorkspace(ws);
    assert.ok(hit === 'experiment/acceptance' || hit.startsWith('experiment/acceptance/'), hit);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('checkGhAuthenticated() reflects whether the injected run resolves or rejects', async () => {
  assert.equal(await checkGhAuthenticated(async () => ({ stdout: '', stderr: '' })), true);
  assert.equal(
    await checkGhAuthenticated(async () => { throw new Error('not logged in'); }),
    false,
  );
});

test('publishWorkspace() builds the gh repo create command and records repository in run-report.json', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-'));
  try {
    await fs.writeFile(path.join(ws, 'run-report.json'), '{}');
    const wsName = path.basename(ws);
    const expectedUrl = `https://github.com/harness-loop-graph/run-${wsName}`;
    const calls = [];
    const run = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'gh') return { stdout: `${expectedUrl}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const report = { status: 'SUCCESS' };

    await publishWorkspace({ ws, report, modelId: 'glm-5.2', config: 'c1', org: 'harness-loop-graph', secrets: [], run });

    assert.equal(report.publishError, undefined);
    assert.deepEqual(report.repository, { name: `harness-loop-graph/run-${wsName}`, url: expectedUrl });

    const ghCall = calls.find((c) => c.cmd === 'gh');
    assert.deepEqual(ghCall.args, [
      'repo', 'create', `harness-loop-graph/run-${wsName}`,
      '--public', '--source', ws, '--push',
      '--description', 'glm-5.2 c1 run generated by the PI-I harness',
    ]);
    assert.ok(calls.some((c) => c.cmd === 'git' && c.args.includes('push')), 'the updated report must be pushed');

    const persisted = JSON.parse(await fs.readFile(path.join(ws, 'run-report.json'), 'utf-8'));
    assert.deepEqual(persisted.repository, report.repository);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('publishWorkspace() refuses to publish and never calls gh/git when a secret is found', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-secret-'));
  try {
    await fs.mkdir(path.join(ws, 'src'));
    await fs.writeFile(path.join(ws, 'src', 'leak.js'), "const key = 'leaked-key-abc';\n");
    const calls = [];
    const run = async (cmd) => { calls.push(cmd); return { stdout: '', stderr: '' }; };
    const report = {};

    await publishWorkspace({
      ws, report, modelId: 'glm-5.2', config: 'c1', org: 'harness-loop-graph',
      secrets: [{ label: 'MODEL_API_KEY', value: 'leaked-key-abc' }],
      run,
    });

    assert.equal(report.publishError, 'secret detected in src/leak.js');
    assert.equal(report.repository, undefined);
    assert.equal(calls.length, 0, 'gh/git must never be invoked once a secret is found');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('publishWorkspace() refuses to publish when the workspace contains an acceptance/ path', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-acceptance-'));
  try {
    await fs.mkdir(path.join(ws, 'acceptance'), { recursive: true });
    await fs.writeFile(path.join(ws, 'acceptance', 'run-all.mjs'), '// hidden battery');
    const calls = [];
    const run = async (cmd) => { calls.push(cmd); return { stdout: '', stderr: '' }; };
    const report = {};

    await publishWorkspace({ ws, report, modelId: 'm', config: 'c1', org: 'harness-loop-graph', secrets: [], run });

    assert.match(report.publishError, /acceptance/);
    assert.equal(calls.length, 0, 'gh/git must never be invoked once the acceptance guard trips');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('c3 nodes keep topology and verifications but use the --task-file task', () => {
  const parsed = { maxTurns: 1, toolRounds: 5 };
  const spec = buildNodes(parsed);
  const overridden = buildNodes(parsed, 'Create notes/summary.txt\n');
  assert.deepEqual(overridden.map((n) => n.id), spec.map((n) => n.id));
  assert.deepEqual(overridden.map((n) => n.verification), spec.map((n) => n.verification));
  for (const n of overridden) {
    assert.match(n.task, /Create notes\/summary\.txt$/);
    assert.doesNotMatch(n.task, /SPEC/);
  }
  assert.match(overridden.find((n) => n.id === 'reviewer').task, /review-verdict\.json/);
  assert.deepEqual(buildNodes(parsed, null), spec);
});

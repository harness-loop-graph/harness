// Unit tests for the runner's --harness-config wiring (T6). Uses the harness's own
// fixture MCP server + skill fixtures rather than talking to a real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpToolProvider, OpenAICompatibleModelAdapter, RoutingModelAdapter, BudgetedModelAdapter } from '../../harness/dist/index.js';
import {
  HARNESS_INSTRUCTIONS,
  SONAR_EXCLUSIONS,
  parseBatteryReport,
  parseArgs,
  buildNodes,
  loadHarnessExtras,
  buildHarness,
  createModel,
  readGitMetadata,
  createWorkspace,
  summarizeRouting,
  attachUsageAndRouting,
  applyBudgetToReport,
  compactTraceC2,
  compactTraceC3,
  slugifyModelId,
  timestampForWorkspace,
  initWorkspaceRepo,
  listTrackedFiles,
  findAcceptancePathInWorkspace,
  collectSecretValues,
  loadPublishOnlySecrets,
  scanWorkspaceForSecrets,
  checkGhAuthenticated,
  publishWorkspace,
  teardownDockerCompose,
  runBatteries,
  workspaceMayHaveDockerStack,
  clearStaleReviewVerdict,
  buildRouter,
  loadCredentials,
  routeApiKeyEnvNames,
  spawnCommand,
  STATIC_ANALYSIS_WORKFLOW,
  SEMGREP_CONFIGS,
  buildSonarProjectProperties,
  createSonarProject,
  loadSonarToken,
  loadPublishableWorkspace,
  publishExistingWorkspace,
} from './run-experiment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_TESTS_DIR = path.resolve(__dirname, '..', '..', 'harness', 'tests');
const FIXTURE_MCP_SERVER = path.join(HARNESS_TESTS_DIR, 'fixtures', 'mcp-fixture-server.mjs');
const FIXTURE_SKILLS_DIR = path.join(HARNESS_TESTS_DIR, 'fixtures', 'skills');

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
      'search_replace',
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
    assert.deepEqual(names, ['read_file', 'run_command', 'search_replace', 'write_file']);

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

test('createModel() returns the plain OpenAICompatibleModelAdapter unchanged without a router (identical for every config)', async () => {
  const previousBaseUrl = process.env.MODEL_BASE_URL;
  process.env.MODEL_BASE_URL = 'https://test.example/v1';
  try {
    for (const harnessExtras of [null, {}, { router: undefined }]) {
      const model = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras });
      assert.ok(model instanceof OpenAICompatibleModelAdapter, 'expected a plain OpenAICompatibleModelAdapter, not a router wrapper');
    }
  } finally {
    if (previousBaseUrl === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = previousBaseUrl;
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
  const previousBaseUrl = process.env.MODEL_BASE_URL;
  process.env.LONG_KEY = 'long-key';
  // The 'retry' route has no apiKeyEnv, so it must fall back to
  // MODEL_API_KEY. Use a distinct value from the `apiKey` passed to
  // createModel() below (a different, unrelated 'run-default-key') so the
  // assertion can actually tell the fallback came from MODEL_API_KEY and
  // not from the createModel() call's own apiKey argument.
  process.env.MODEL_API_KEY = 'env-fallback-key';
  // The default adapter construction inside createModel() now requires a
  // base URL (no provider default) even though this test never calls it.
  process.env.MODEL_BASE_URL = 'https://test.example/v1';
  try {
    const model = await createModel({
      apiKey: 'run-default-key',
      modelId: 'default-model',
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
      { apiKey: 'long-key', model: 'long-model', baseUrl: 'https://test.example/v1' },
      { apiKey: 'env-fallback-key', model: 'retry-model', baseUrl: 'https://test.example/v1' },
    ]);
  } finally {
    if (previousLongKey === undefined) delete process.env.LONG_KEY;
    else process.env.LONG_KEY = previousLongKey;
    if (previousModelApiKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previousModelApiKey;
    if (previousBaseUrl === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = previousBaseUrl;
  }
});

test('createModel() propagates a clear error naming the route and env var when apiKeyEnv is unset', async () => {
  delete process.env.MISSING_KEY;
  const previousBaseUrl = process.env.MODEL_BASE_URL;
  process.env.MODEL_BASE_URL = 'https://test.example/v1';
  try {
    await assert.rejects(
      () =>
        createModel({
          apiKey: 'default-key',
          modelId: 'default-model',
          harnessExtras: { router: { routes: { longContext: { model: 'long-model', apiKeyEnv: 'MISSING_KEY' } } } },
          makeAdapter: () => ({ async complete() { return { type: 'finish', content: 'stub' }; } }),
        }),
      /route 'longContext' needs env var 'MISSING_KEY'/,
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = previousBaseUrl;
  }
});

test('attachUsageAndRouting() sets report.routing from a router model (shared by c1/c2/c3)', async () => {
  const created = [];
  const makeAdapter = (cfg) => {
    created.push(cfg);
    return { async complete() { return { type: 'finish', content: 'stub' }; } };
  };
  const previousModelApiKey = process.env.MODEL_API_KEY;
  const previousBaseUrl = process.env.MODEL_BASE_URL;
  process.env.MODEL_API_KEY = 'default-key';
  process.env.MODEL_BASE_URL = 'https://test.example/v1';
  try {
    const model = await createModel({
      apiKey: 'default-key',
      modelId: 'default-model',
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
    if (previousBaseUrl === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = previousBaseUrl;
  }
});

test('attachUsageAndRouting() leaves report.routing unset for a plain (non-router) model', async () => {
  const previousBaseUrl = process.env.MODEL_BASE_URL;
  process.env.MODEL_BASE_URL = 'https://test.example/v1';
  try {
    const model = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras: null });
    // A plain OpenAICompatibleModelAdapter never made a real call, so
    // getUsage() just needs to exist and be callable; the point here is the
    // absent `routing`.
    const report = { status: 'SUCCESS' };
    attachUsageAndRouting(report, model);

    assert.equal(typeof report.usage, 'object');
    assert.equal('routing' in report, false);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = previousBaseUrl;
  }
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

test('compactTraceC2() keeps responseCode/responseMessage for errored turns and omits them otherwise', () => {
  const loopResult = {
    trace: [
      {
        turn: 1,
        phases: ['generating', 'observing', 'verifying', 'deciding'],
        decision: { action: 'RETRY', reason: 'x' },
        response: { type: 'error', code: 'max_tool_rounds', message: 'ran out' },
        responseCode: 'max_tool_rounds',
        responseMessage: 'ran out',
        verification: { passed: false },
      },
      {
        turn: 2,
        phases: ['generating', 'observing', 'deciding'],
        decision: { action: 'FINISH', reason: 'done' },
        response: { type: 'finish', content: 'ok' },
      },
    ],
  };

  const compact = compactTraceC2(loopResult);

  assert.equal(compact[0].responseType, 'error');
  assert.equal(compact[0].responseCode, 'max_tool_rounds');
  assert.equal(compact[0].responseMessage, 'ran out');
  assert.equal('responseCode' in compact[1], false);
  assert.equal('responseMessage' in compact[1], false);
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

test('parseArgs() sampling flags default to unset (null)', () => {
  const parsed = parseArgs(['node', 'run-experiment.mjs', '--config', 'c1']);
  assert.deepEqual(parsed.sampling, { temperature: null, topP: null, seed: null, maxTokens: null });
});

test('parseArgs() parses valid --temperature/--top-p/--seed/--max-tokens', () => {
  const parsed = parseArgs([
    'node', 'run-experiment.mjs', '--config', 'c2',
    '--temperature', '0', '--top-p', '1', '--seed', '-7', '--max-tokens', '4096',
  ]);
  assert.deepEqual(parsed.sampling, { temperature: 0, topP: 1, seed: -7, maxTokens: 4096 });
  const edge = parseArgs(['node', 'run-experiment.mjs', '--config', 'c1', '--temperature', '2', '--top-p', '0.05']);
  assert.deepEqual(edge.sampling, { temperature: 2, topP: 0.05, seed: null, maxTokens: null });
});

test('invalid sampling flag values exit with a usage error', async () => {
  const { spawnSync } = await import('node:child_process');
  const cases = [
    [['--temperature', '2.5'], /--temperature/],
    [['--temperature', '-0.1'], /--temperature/],
    [['--temperature', 'abc'], /--temperature/],
    [['--temperature'], /--temperature/],
    [['--top-p', '0'], /--top-p/],
    [['--top-p', '1.5'], /--top-p/],
    [['--seed', '1.5'], /--seed/],
    [['--seed', 'x'], /--seed/],
    [['--max-tokens', '0'], /--max-tokens/],
    [['--max-tokens', '2.5'], /--max-tokens/],
  ];
  for (const [flags, pattern] of cases) {
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', ...flags],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.equal(res.status, 1, `${flags.join(' ')} should exit 1`);
    assert.match(res.stderr, /Usage/);
    assert.match(res.stderr, pattern);
  }
});

test('--dry-run plan records sampling and reproducibility metadata (git sha + dirty flag)', async () => {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', '--temperature', '0.3', '--seed', '7'],
    { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
  );
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.deepEqual(plan.sampling, { temperature: 0.3, topP: null, seed: 7, maxTokens: null });
  assert.ok('harnessGitSha' in plan);
  assert.ok(plan.harnessGitSha === null || /^[0-9a-f]{40}$/.test(plan.harnessGitSha));
  assert.ok('harnessGitDirty' in plan);
  assert.ok(plan.harnessGitDirty === null || typeof plan.harnessGitDirty === 'boolean');
});

test('readGitMetadata() returns nulls instead of throwing when git is unavailable', async () => {
  const meta = await readGitMetadata({ cwd: '/nonexistent-dir-for-git-metadata' });
  assert.deepEqual(meta, { harnessGitSha: null, harnessGitDirty: null });
});

test('parseArgs() --provider defaults to DeepInfra with fallbacks disabled', () => {
  const parsed = parseArgs(['node', 'run-experiment.mjs', '--config', 'c1']);
  assert.deepEqual(parsed.provider, { order: ['DeepInfra'], allowFallbacks: false });
});

test('parseArgs() --provider accepts a comma-separated order, "none", and --allow-provider-fallbacks in any position', () => {
  const base = ['node', 'run-experiment.mjs', '--config', 'c2'];
  assert.deepEqual(
    parseArgs([...base, '--provider', 'DeepInfra, Fireworks']).provider,
    { order: ['DeepInfra', 'Fireworks'], allowFallbacks: false },
  );
  assert.equal(parseArgs([...base, '--provider', 'none']).provider, null);
  assert.deepEqual(
    parseArgs([...base, '--provider', 'Fireworks', '--allow-provider-fallbacks']).provider,
    { order: ['Fireworks'], allowFallbacks: true },
  );
  assert.deepEqual(
    parseArgs([...base, '--allow-provider-fallbacks', '--provider', 'Fireworks']).provider,
    { order: ['Fireworks'], allowFallbacks: true },
  );
  assert.deepEqual(
    parseArgs([...base, '--allow-provider-fallbacks']).provider,
    { order: ['DeepInfra'], allowFallbacks: true },
  );
});

test('invalid --provider values exit with a usage error', async () => {
  const { spawnSync } = await import('node:child_process');
  const cases = [
    [['--provider'], /--provider/],
    [['--provider', ''], /--provider/],
    [['--provider', '   '], /--provider/],
    [['--provider', ','], /--provider/],
    [['--provider', 'DeepInfra,,Fireworks'], /--provider/],
    [['--provider', 'none,DeepInfra'], /--provider/],
    [['--provider', 'none', '--allow-provider-fallbacks'], /--allow-provider-fallbacks/],
  ];
  for (const [flags, pattern] of cases) {
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', ...flags],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.equal(res.status, 1, `${flags.join(' ')} should exit 1`);
    assert.match(res.stderr, /Usage/);
    assert.match(res.stderr, pattern);
  }
});

test('--dry-run plan records the configured provider routing', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (...flags) => {
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', ...flags],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  assert.deepEqual(run().provider, { order: ['DeepInfra'], allowFallbacks: false });
  assert.equal(run('--provider', 'none').provider, null);
  assert.deepEqual(run('--provider', 'A,B', '--allow-provider-fallbacks').provider, { order: ['A', 'B'], allowFallbacks: true });
});

test('createModel() pins the same provider on the default adapter and every route adapter, and merges providers used', async () => {
  const bodies = [];
  const stubFetch = (providerName) => async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ provider: providerName, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const created = [];
  const makeAdapter = (cfg) => {
    created.push(cfg);
    return new OpenAICompatibleModelAdapter({ ...cfg, fetchImpl: stubFetch('Fireworks') });
  };
  const previous = {
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    MODEL_BASE_URL: process.env.MODEL_BASE_URL,
    fetch: globalThis.fetch,
  };
  process.env.MODEL_API_KEY = 'env-key';
  process.env.MODEL_BASE_URL = 'https://test.example/v1';
  globalThis.fetch = stubFetch('DeepInfra');
  const provider = { order: ['DeepInfra'], allowFallbacks: false };
  const request = (feedback) => ({
    task: 't',
    context: { projectRoot: '/tmp/ws', files: [], language: 'typescript' },
    availTools: [],
    ...(feedback && { feedback }),
  });
  try {
    const harnessExtras = { router: { routes: { retry: { model: 'retry-model' } } } };
    const model = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras, makeAdapter, provider });
    assert.deepEqual(created[0].provider, provider);

    await model.complete(request());
    await model.complete(request());
    await model.complete(request('fix it'));
    assert.equal(bodies.length, 3);
    for (const body of bodies) {
      assert.deepEqual(body.provider, { order: ['DeepInfra'], allow_fallbacks: false });
    }

    // Counts from the default adapter and the route adapter land in one report.usage.
    const report = {};
    attachUsageAndRouting(report, model);
    assert.deepEqual(report.usage.providersUsed, { DeepInfra: 2, Fireworks: 1 });

    // Budget wrapper forwards the effective routing; plain adapters expose it too.
    const capped = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras: null, provider, maxCostUsd: 1 });
    assert.deepEqual(capped.getProviderConfig(), provider);

    // Without a provider (--provider none), nothing is sent and route configs get no extra key.
    bodies.length = 0;
    created.length = 0;
    const unpinned = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras, makeAdapter, provider: null });
    await unpinned.complete(request());
    await unpinned.complete(request('fix it'));
    assert.ok(bodies.every((body) => !('provider' in body)));
    assert.ok(created.every((cfg) => !('provider' in cfg)));
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (k === 'fetch') globalThis.fetch = v;
      else if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('createModel() applies the same sampling to the default adapter and every route adapter', async () => {
  const created = [];
  const makeAdapter = (cfg) => {
    created.push(cfg);
    return { async complete() { return { type: 'finish', content: 'stub' }; } };
  };
  const previous = { MODEL_API_KEY: process.env.MODEL_API_KEY, MODEL_BASE_URL: process.env.MODEL_BASE_URL };
  process.env.MODEL_API_KEY = 'env-key';
  process.env.MODEL_BASE_URL = 'https://test.example/v1';
  const sampling = { temperature: 0.4, topP: 0.8, seed: 11, maxTokens: 2048 };
  try {
    const harnessExtras = { router: { routes: { retry: { model: 'retry-model' } } } };
    const model = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras, makeAdapter, sampling });
    assert.deepEqual(created, [
      { apiKey: 'env-key', model: 'retry-model', baseUrl: 'https://test.example/v1', ...sampling },
    ]);
    assert.ok(model instanceof RoutingModelAdapter);

    // Plain (no router) adapter exposes the effective sampling too.
    const plain = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras: null, sampling });
    assert.deepEqual(plain.getSamplingConfig(), sampling);

    // Unset sampling leaves route adapter configs untouched (no extra keys).
    created.length = 0;
    await createModel({ apiKey: 'k', modelId: 'm', harnessExtras, makeAdapter });
    assert.deepEqual(created, [{ apiKey: 'env-key', model: 'retry-model', baseUrl: 'https://test.example/v1' }]);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('slugifyModelId() lowercases and collapses non [a-z0-9] runs into single trimmed hyphens', () => {
  assert.equal(slugifyModelId('Test-Model-5.2'), 'test-model-5-2');
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
    const ws = await createWorkspace(runsDir, 'c2', 'Test-Model-5.2', '/nonexistent/SPEC.md', { dryRun: true });
    assert.equal(path.dirname(ws), runsDir);
    assert.match(path.basename(ws), /^test-model-5-2-c2-\d{8}T\d{6}$/);
    await assert.rejects(fs.access(runsDir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createWorkspace() copies the AGENTS.md next to the spec, and only the spec when there is none', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runsdir-agents-'));
  try {
    const withAgents = path.join(dir, 'with');
    await fs.mkdir(withAgents);
    await fs.writeFile(path.join(withAgents, 'SPEC.md'), 'spec');
    await fs.writeFile(path.join(withAgents, 'AGENTS.md'), 'rules');
    const ws1 = await createWorkspace(path.join(dir, 'runs1'), 'c1', 'm', path.join(withAgents, 'SPEC.md'));
    assert.equal(await fs.readFile(path.join(ws1, 'AGENTS.md'), 'utf8'), 'rules');
    assert.equal(await fs.readFile(path.join(ws1, 'SPEC.md'), 'utf8'), 'spec');

    const without = path.join(dir, 'without');
    await fs.mkdir(without);
    await fs.writeFile(path.join(without, 'SPEC.md'), 'spec');
    const ws2 = await createWorkspace(path.join(dir, 'runs2'), 'c1', 'm', path.join(without, 'SPEC.md'));
    assert.deepEqual(await fs.readdir(ws2), ['SPEC.md']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the AGENTS.md copied as run input is excluded from static analysis like SPEC.md', () => {
  assert.match(SONAR_EXCLUSIONS, /(^|,)AGENTS\.md(,|$)/);
});

test('c1 --dry-run creates nothing on disk (env-independent: uses its own --runs-dir, never the real default)', async () => {
  const { spawnSync } = await import('node:child_process');
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runsdir-dryrun-'));
  try {
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', '--runs-dir', runsDir],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.equal(res.status, 0, res.stderr);
    const plan = JSON.parse(res.stdout);
    assert.equal(path.dirname(plan.workspace), runsDir);
    // Asserting the planned workspace path itself was not created (rather
    // than asserting some ambient dir like the global default --runs-dir
    // doesn't exist) keeps this test honest regardless of what else this
    // machine has on disk from prior real runs.
    await assert.rejects(fs.access(plan.workspace), 'the planned workspace dir must not have been created by --dry-run');
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test('initWorkspaceRepo() creates a git repo with one commit, a .gitignore, and a fixed local identity', async () => {
  const { execFileSync } = await import('node:child_process');
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-repo-'));
  try {
    await fs.writeFile(path.join(ws, 'run-report.json'), '{}');
    await fs.writeFile(path.join(ws, 'audit.jsonl'), '{}\n');
    await fs.mkdir(path.join(ws, 'node_modules'));
    await fs.writeFile(path.join(ws, 'node_modules', 'x.txt'), 'should be ignored');

    await initWorkspaceRepo(ws, 'run: test-model-5.2 c1 (SUCCESS)');

    const branch = execFileSync('git', ['-C', ws, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
    assert.equal(branch, 'main');

    const log = execFileSync('git', ['-C', ws, 'log', '--format=%s|%an|%ae'], { encoding: 'utf8' }).trim();
    assert.equal(log, 'run: test-model-5.2 c1 (SUCCESS)|pi-runner|pi-runner@users.noreply.github.com');

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

test('scanWorkspaceForSecrets() detects a planted API key value in a tracked file and reports its relative path, never the value', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-secret-'));
  try {
    await fs.mkdir(path.join(ws, 'src'));
    await fs.writeFile(path.join(ws, 'src', 'config.js'), "export const KEY = 'sk-super-secret-123';\n");
    await initWorkspaceRepo(ws, 'test: seed');

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
    await initWorkspaceRepo(ws, 'test: seed');

    const secrets = collectSecretValues({ apiKey: 'sk-super-secret-123', harnessExtras: null });
    assert.equal(await scanWorkspaceForSecrets(ws, secrets), null);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('scanWorkspaceForSecrets() ignores a gitignored .env file even when it contains the secret value', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-secret-env-'));
  try {
    await fs.writeFile(path.join(ws, '.env'), 'MODEL_API_KEY=sk-super-secret-123\n');
    // initWorkspaceRepo()'s own .gitignore excludes .env*, so this file is
    // never tracked; the guard must only ever see `git ls-files`.
    await initWorkspaceRepo(ws, 'test: seed');
    assert.ok(!(await listTrackedFiles(ws)).includes('.env'), '.env must not be tracked');

    const secrets = collectSecretValues({ apiKey: 'sk-super-secret-123', harnessExtras: null });
    assert.equal(await scanWorkspaceForSecrets(ws, secrets), null);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('scanWorkspaceForSecrets() matches secret bytes even in a binary (non-UTF8-decodable) tracked file', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-secret-binary-'));
  try {
    const secretValue = 'sk-super-secret-123';
    const binary = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x01]), Buffer.from(secretValue, 'utf-8'), Buffer.from([0x00, 0xff])]);
    await fs.writeFile(path.join(ws, 'blob.bin'), binary);
    await initWorkspaceRepo(ws, 'test: seed');

    const secrets = collectSecretValues({ apiKey: secretValue, harnessExtras: null });
    const hit = await scanWorkspaceForSecrets(ws, secrets);
    assert.deepEqual(hit, { file: 'blob.bin', label: 'MODEL_API_KEY' });
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

test('collectSecretValues() includes non-empty --harness-config mcpServers env values of at least 8 chars, dropping shorter/empty ones', () => {
  const secrets = collectSecretValues({
    apiKey: 'default-secret',
    harnessExtras: {
      mcpServers: {
        fixture: {
          command: 'node',
          args: [],
          env: { LONG_TOKEN: 'a-long-enough-secret', SHORT: 'short1', EMPTY: '' },
        },
      },
    },
  });
  assert.deepEqual(
    secrets.sort((a, b) => a.label.localeCompare(b.label)),
    [
      { label: 'mcpServers.fixture.env.LONG_TOKEN', value: 'a-long-enough-secret' },
      { label: 'MODEL_API_KEY', value: 'default-secret' },
    ],
  );
});

test('findAcceptancePathInWorkspace() returns null when there is no bench directory to compare against', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-acceptance-nobench-'));
  try {
    await fs.writeFile(path.join(ws, 'README.md'), 'nothing here');
    await initWorkspaceRepo(ws, 'test: seed');
    assert.equal(await findAcceptancePathInWorkspace(ws, path.join(ws, 'no-such-bench-dir')), null);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("findAcceptancePathInWorkspace() does not flag a generated app's own acceptance/ folder (different content than the bench)", async () => {
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-acceptance-own-'));
  try {
    await fs.writeFile(path.join(benchDir, 'battery.mjs'), '// hidden battery assertion logic\n');

    await fs.mkdir(path.join(ws, 'acceptance'), { recursive: true });
    await fs.writeFile(path.join(ws, 'acceptance', 'run-all.mjs'), "// the generated app's own acceptance tests\n");
    await initWorkspaceRepo(ws, 'test: seed');

    assert.equal(await findAcceptancePathInWorkspace(ws, benchDir), null);
  } finally {
    await fs.rm(benchDir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("findAcceptancePathInWorkspace() ignores the bench's own run outputs (report.json, test-results/, playwright-report/)", async () => {
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-acceptance-outputs-'));
  try {
    // run-all.mjs writes its report into the bench dir; the runner writes the
    // same bytes to <ws>/batteries-report.json, which must not count as a bench copy.
    const report = '{"batteries":[]}\n';
    await fs.writeFile(path.join(benchDir, 'battery.mjs'), '// hidden battery assertion logic\n');
    await fs.writeFile(path.join(benchDir, 'report.json'), report);
    await fs.mkdir(path.join(benchDir, 'test-results', 'case'), { recursive: true });
    await fs.writeFile(path.join(benchDir, 'test-results', 'case', 'error-context.md'), 'page snapshot\n');
    await fs.mkdir(path.join(benchDir, 'playwright-report'), { recursive: true });
    await fs.writeFile(path.join(benchDir, 'playwright-report', 'index.html'), '<html></html>\n');

    await fs.writeFile(path.join(ws, 'batteries-report.json'), report);
    await fs.writeFile(path.join(ws, 'notes.md'), 'page snapshot\n');
    await fs.writeFile(path.join(ws, 'index.html'), '<html></html>\n');
    await initWorkspaceRepo(ws, 'test: seed');

    assert.equal(await findAcceptancePathInWorkspace(ws, benchDir), null);
  } finally {
    await fs.rm(benchDir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('findAcceptancePathInWorkspace() flags a byte-identical copy of a bench file, regardless of its path in the workspace', async () => {
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-acceptance-copy-'));
  try {
    const benchContent = '// hidden battery assertion logic\nexport const THRESHOLD = 42;\n';
    await fs.mkdir(path.join(benchDir, 'battery1-e2e'), { recursive: true });
    await fs.writeFile(path.join(benchDir, 'battery1-e2e', 'check.mjs'), benchContent);

    // Copied somewhere that doesn't even mention "acceptance" in its path,
    // to prove this is a content check, not the old path-segment regex.
    await fs.mkdir(path.join(ws, 'src', 'lib'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'lib', 'check.mjs'), benchContent);
    await initWorkspaceRepo(ws, 'test: seed');

    assert.equal(await findAcceptancePathInWorkspace(ws, benchDir), 'src/lib/check.mjs');
  } finally {
    await fs.rm(benchDir, { recursive: true, force: true });
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

// Sonar settings + a recording fetch that accepts project creation, so publish tests stay offline.
function makeFetch(responses = [{ status: 200, body: '{}' }]) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
  };
  fetchFn.calls = calls;
  return fetchFn;
}
const SONAR_OK = () => ({ sonarOrg: 'harness-loop-graph', sonarToken: 'sonar-secret-token', fetchFn: makeFetch() });

// Records every call; git runs for real (temp repos), gh and push are stubbed.
function makeRecordingRun(url = 'https://github.com/harness-loop-graph/run-x') {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'gh') return { stdout: `${url}\n`, stderr: '' };
    if (cmd === 'git' && args.includes('push')) return { stdout: '', stderr: '' };
    return spawnCommand(cmd, args, opts);
  };
  run.calls = calls;
  return run;
}

async function gitOut(ws, ...args) {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8' });
}

async function seedWorkspace(prefix, files = {}) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(ws, 'run-report.json'), '{"model":"m","config":"c1"}');
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
    await fs.writeFile(path.join(ws, rel), content);
  }
  await initWorkspaceRepo(ws, 'test: seed');
  return ws;
}

test('publishWorkspace() records the repository URL even when gh prints git push output after it', async () => {
  const ws = await seedWorkspace('runner-publish-url-');
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const repoName = `harness-loop-graph/run-${path.basename(ws)}`;
    // Real `gh repo create --push` output: the URL, then git's tracking message.
    const run = async (cmd) => ({
      stdout: cmd === 'gh' ? `https://github.com/${repoName}\nbranch 'main' set up to track 'origin/main'.\n` : '',
      stderr: '',
    });
    const report = { status: 'SUCCESS' };

    await publishWorkspace({ ws, report, modelId: 'm', config: 'c1', org: 'harness-loop-graph', secrets: [], run, benchDir, ...SONAR_OK() });

    assert.equal(report.publishError, undefined);
    assert.deepEqual(report.repository, { name: repoName, url: `https://github.com/${repoName}` });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('publishWorkspace() builds the gh repo create command and records repository in run-report.json', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-'));
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    await fs.writeFile(path.join(ws, 'run-report.json'), '{}');
    // publishWorkspace() only ever runs after initWorkspaceRepo() in main();
    // the guards read `git ls-files` for real, so the fixture needs a real
    // commit even though gh/git publish calls below are stubbed.
    await initWorkspaceRepo(ws, 'test: seed');
    const wsName = path.basename(ws);
    const expectedUrl = `https://github.com/harness-loop-graph/run-${wsName}`;
    const calls = [];
    const run = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'gh') return { stdout: `${expectedUrl}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const report = { status: 'SUCCESS' };

    await publishWorkspace({ ws, report, modelId: 'test-model-5.2', config: 'c1', org: 'harness-loop-graph', secrets: [], run, benchDir, ...SONAR_OK() });

    assert.equal(report.publishError, undefined);
    assert.deepEqual(report.repository, { name: `harness-loop-graph/run-${wsName}`, url: expectedUrl });

    const ghCall = calls.find((c) => c.cmd === 'gh');
    assert.deepEqual(ghCall.args, [
      'repo', 'create', `harness-loop-graph/run-${wsName}`,
      '--public', '--source', ws, '--push',
      '--description', 'test-model-5.2 c1 run generated by the PI-I harness',
    ]);
    assert.ok(calls.some((c) => c.cmd === 'git' && c.args.includes('push')), 'the updated report must be pushed');

    const persisted = JSON.parse(await fs.readFile(path.join(ws, 'run-report.json'), 'utf-8'));
    assert.deepEqual(persisted.repository, report.repository);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('publishWorkspace() refuses to publish and never calls gh/git when a secret is found in a tracked file', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-secret-'));
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    await fs.mkdir(path.join(ws, 'src'));
    await fs.writeFile(path.join(ws, 'src', 'leak.js'), "const key = 'leaked-key-abc';\n");
    await initWorkspaceRepo(ws, 'test: seed');
    const calls = [];
    const run = async (cmd) => { calls.push(cmd); return { stdout: '', stderr: '' }; };
    const report = {};

    await publishWorkspace({
      ws, report, modelId: 'test-model-5.2', config: 'c1', org: 'harness-loop-graph',
      secrets: [{ label: 'MODEL_API_KEY', value: 'leaked-key-abc' }],
      run, benchDir,
    });

    assert.equal(report.publishError, 'secret detected in src/leak.js');
    assert.equal(report.repository, undefined);
    assert.equal(calls.length, 0, 'gh/git must never be invoked once a secret is found');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('publishWorkspace() never flags a secret planted only in a gitignored .env file', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-env-'));
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    await fs.writeFile(path.join(ws, '.env'), 'MODEL_API_KEY=leaked-key-abc\n');
    await initWorkspaceRepo(ws, 'test: seed');
    const calls = [];
    const run = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { stdout: cmd === 'gh' ? 'https://github.com/harness-loop-graph/run-x\n' : '', stderr: '' };
    };
    const report = {};

    await publishWorkspace({
      ws, report, modelId: 'test-model-5.2', config: 'c1', org: 'harness-loop-graph',
      secrets: [{ label: 'MODEL_API_KEY', value: 'leaked-key-abc' }],
      run, benchDir, ...SONAR_OK(),
    });

    assert.equal(report.publishError, undefined);
    assert.ok(calls.some((c) => c.cmd === 'gh'), 'gh must be called once the (gitignored) secret is correctly ignored');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('publishWorkspace() refuses to publish when the workspace contains a byte-identical copy of a bench file', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-acceptance-'));
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-'));
  try {
    const benchContent = '// hidden battery\n';
    await fs.writeFile(path.join(benchDir, 'run-all.mjs'), benchContent);
    await fs.mkdir(path.join(ws, 'acceptance'), { recursive: true });
    await fs.writeFile(path.join(ws, 'acceptance', 'run-all.mjs'), benchContent);
    await initWorkspaceRepo(ws, 'test: seed');
    const calls = [];
    const run = async (cmd) => { calls.push(cmd); return { stdout: '', stderr: '' }; };
    const report = {};

    await publishWorkspace({ ws, report, modelId: 'm', config: 'c1', org: 'harness-loop-graph', secrets: [], run, benchDir });

    assert.match(report.publishError, /acceptance/);
    assert.equal(calls.length, 0, 'gh/git must never be invoked once the acceptance guard trips');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test("publishWorkspace() does not refuse for a generated app's own acceptance/ folder with different content", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-ownacceptance-'));
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-'));
  try {
    await fs.writeFile(path.join(benchDir, 'run-all.mjs'), '// hidden battery\n');
    await fs.mkdir(path.join(ws, 'acceptance'), { recursive: true });
    await fs.writeFile(path.join(ws, 'acceptance', 'run-all.mjs'), "// the generated app's own tests\n");
    await initWorkspaceRepo(ws, 'test: seed');
    const calls = [];
    const run = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: cmd === 'gh' ? 'https://github.com/harness-loop-graph/run-x\n' : '', stderr: '' };
    };
    const report = {};

    await publishWorkspace({ ws, report, modelId: 'm', config: 'c1', org: 'harness-loop-graph', secrets: [], run, benchDir, ...SONAR_OK() });

    assert.equal(report.publishError, undefined);
    assert.ok(calls.some((c) => c.cmd === 'gh'), 'gh must be called: a same-named but different-content acceptance/ folder is not the bench');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
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

// --- T3b: review fixes ---

test('a thrown exception during the run phase (e.g. createModel() with a missing router apiKeyEnv) still writes run-report.json, creates the workspace git repo, and exits non-zero', async () => {
  const { spawnSync } = await import('node:child_process');
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runsdir-exc-'));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-exc-config-'));
  try {
    const configPath = path.join(configDir, 'harness-config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ router: { routes: { longContext: { model: 'm', apiKeyEnv: 'RUNNER_TEST_UNSET_ENV_VAR' } } } }),
    );
    const childEnv = {
      ...process.env,
      MODEL_API_KEY: 'dummy-key',
      MODEL_ID: 'dummy-model',
      MODEL_BASE_URL: 'https://test.example/v1',
    };
    delete childEnv.RUNNER_TEST_UNSET_ENV_VAR;

    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--runs-dir', runsDir, '--harness-config', configPath],
      { encoding: 'utf8', env: childEnv },
    );

    assert.notEqual(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split('\n');
    const reportPath = lines.pop();
    const report = JSON.parse(await fs.readFile(reportPath, 'utf-8'));
    assert.equal(report.status, 'FAILED');
    assert.match(report.failure, /route 'longContext' needs env var 'RUNNER_TEST_UNSET_ENV_VAR'/);
    assert.equal(report.repoError, undefined, 'the workspace must still become a git repo despite the thrown exception');
    await fs.access(path.join(path.dirname(reportPath), '.git'));
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test('teardownDockerCompose() runs docker compose down -v in the workspace and returns null on success', async () => {
  const calls = [];
  const run = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: '', stderr: '' }; };
  const err = await teardownDockerCompose('/some/workspace', run);
  assert.equal(err, null);
  assert.deepEqual(calls, [{ cmd: 'docker', args: ['compose', 'down', '-v'], opts: { cwd: '/some/workspace', timeoutMs: 120_000 } }]);
});

test('teardownDockerCompose() never throws: returns a message naming the failure instead', async () => {
  const run = async () => { throw new Error('boom'); };
  const err = await teardownDockerCompose('/ws', run);
  assert.match(err, /docker compose down failed: boom/);
});

// runBatteries() fixtures: no real docker/node/network. `run` records every spawn, `fetchFn` counts
// health polls and `sleep` is instant.
async function batteriesFixture({ composeUp = 'ok', runAll = 'ok', healthy = true } = {}) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-batteries-'));
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'docker' && args[1] === 'up' && composeUp === 'fail') throw new Error('compose up exploded');
    if (cmd === 'node') {
      if (runAll === 'fail') throw new Error('node run-all.mjs timed out');
      if (runAll === 'exit1') {
        // run-all.mjs exits 1 whenever a battery fails, after printing its report.
        const err = new Error('node run-all.mjs exited with code 1');
        err.stdout = JSON.stringify({ passed: false, batteries: [{ battery: 'battery4-coherence', passed: true, checks: [] }] }, null, 2);
        throw err;
      }
      return { stdout: JSON.stringify({ passed: false, batteries: [] }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  let polls = 0;
  const fetchFn = async () => { polls++; return { ok: healthy }; };
  const sleep = async () => {};
  return { ws, calls, run, fetchFn, sleep, polls: () => polls, deps: { run, fetchFn, sleep, acceptanceDir: '/fake/acceptance' } };
}

test('runBatteries() still runs run-all and writes batteries-report.json when compose up fails, without polling health', async () => {
  const fx = await batteriesFixture({ composeUp: 'fail' });
  try {
    const out = await runBatteries(fx.ws, false, [], fx.deps);
    assert.equal(fx.polls(), 0);
    const runAll = fx.calls.find((c) => c.cmd === 'node');
    assert.deepEqual(runAll.args, ['run-all.mjs']);
    assert.equal(runAll.opts.cwd, '/fake/acceptance');
    const written = JSON.parse(await fs.readFile(path.join(fx.ws, 'batteries-report.json'), 'utf-8'));
    assert.deepEqual(written, out.batteryReport);
    assert.equal(out.stack.up, false);
    assert.equal(out.stack.healthy, false);
    assert.match(out.stack.error, /compose up exploded/);
    assert.equal(out.batteryError, null);
    // Our stack never started: whatever listens on the fixed ports is foreign
    // and must not be scored for this run.
    for (const key of ['BACKEND_URL', 'FRONTEND_URL', 'DB_URL']) {
      assert.doesNotMatch(runAll.opts.env[key], /localhost:(3000|8080|5432)/, key);
    }
  } finally {
    await fs.rm(fx.ws, { recursive: true, force: true });
  }
});

test('runBatteries() still runs run-all when health never passes (stack.up true, healthy false)', async () => {
  const fx = await batteriesFixture({ healthy: false });
  try {
    const out = await runBatteries(fx.ws, false, [], fx.deps);
    assert.equal(fx.polls(), 120);
    assert.ok(fx.calls.some((c) => c.cmd === 'node'));
    await fs.access(path.join(fx.ws, 'batteries-report.json'));
    assert.equal(out.stack.up, true);
    assert.equal(out.stack.healthy, false);
    assert.match(out.stack.error, /120s/);
    assert.equal(out.batteryError, null);
  } finally {
    await fs.rm(fx.ws, { recursive: true, force: true });
  }
});

test('runBatteries() happy path: stack up and healthy, report written, teardown still runs unless keep', async () => {
  const fx = await batteriesFixture();
  try {
    const out = await runBatteries(fx.ws, false, [], fx.deps);
    assert.deepEqual(out.stack, { up: true, healthy: true });
    assert.equal(out.batteryError, null);
    await fs.access(path.join(fx.ws, 'batteries-report.json'));
    assert.deepEqual(fx.calls.at(-1).args, ['compose', 'down', '-v']);
  } finally {
    await fs.rm(fx.ws, { recursive: true, force: true });
  }
  const kept = await batteriesFixture();
  try {
    await runBatteries(kept.ws, true, [], kept.deps);
    assert.ok(!kept.calls.some((c) => c.args[1] === 'down'));
  } finally {
    await fs.rm(kept.ws, { recursive: true, force: true });
  }
});

test('runBatteries() records batteryError when run-all itself fails, and still tears down', async () => {
  const fx = await batteriesFixture({ runAll: 'fail' });
  try {
    const out = await runBatteries(fx.ws, false, [], fx.deps);
    assert.match(out.batteryError, /run-all\.mjs timed out/);
    assert.equal(out.batteryReport, null);
    assert.deepEqual(out.stack, { up: true, healthy: true });
    assert.deepEqual(fx.calls.at(-1).args, ['compose', 'down', '-v']);
  } finally {
    await fs.rm(fx.ws, { recursive: true, force: true });
  }
});

test('workspaceMayHaveDockerStack() is true when --verify-cmd invokes docker compose, false for an unrelated command', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-compose-cmd-'));
  try {
    assert.equal(
      await workspaceMayHaveDockerStack(ws, 'docker compose up -d --build && curl -sf http://localhost:3000/health'),
      true,
    );
    assert.equal(await workspaceMayHaveDockerStack(ws, 'npm test'), false);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("workspaceMayHaveDockerStack() is true when the workspace has its own compose file, regardless of --verify-cmd", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-compose-file-'));
  try {
    await fs.writeFile(path.join(ws, 'docker-compose.yml'), 'services: {}\n');
    assert.equal(await workspaceMayHaveDockerStack(ws, 'npm test'), true);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('clearStaleReviewVerdict() deletes an existing review-verdict.json and is a no-op when none exists', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-verdict-'));
  try {
    await fs.writeFile(path.join(ws, 'review-verdict.json'), JSON.stringify({ acceptable: true }));
    clearStaleReviewVerdict(ws);
    await assert.rejects(fs.access(path.join(ws, 'review-verdict.json')));
    assert.doesNotThrow(() => clearStaleReviewVerdict(ws));
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("buildRouter() cannot be satisfied by a stale verdict once clearStaleReviewVerdict() has run for this visit", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-verdict-router-'));
  try {
    // A stale verdict from an earlier reviewer visit claiming acceptance...
    await fs.writeFile(path.join(ws, 'review-verdict.json'), JSON.stringify({ acceptable: true }));
    clearStaleReviewVerdict(ws); // ...is cleared before this visit, exactly as the c3 factory does for every reviewer node

    const router = buildRouter(ws);
    const decision = router('reviewer', { status: 'SUCCESS' }, { visits: { reviewer: 0 } });

    assert.equal(decision.action, 'NEXT');
    assert.equal(decision.node, 'reviewer');
    assert.match(decision.reason, /verdict unreadable/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('--max-turns/--max-steps/--tool-rounds reject non-positive-integer values with a usage error and non-zero exit', async () => {
  const { spawnSync } = await import('node:child_process');
  const cases = [
    ['--max-turns', '0'],
    ['--max-turns', '-1'],
    ['--max-turns', 'abc'],
    ['--max-steps', '1.5'],
    ['--tool-rounds', '0'],
  ];
  for (const [flag, value] of cases) {
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', flag, value],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.notEqual(res.status, 0, `${flag} ${value} should be rejected`);
    assert.match(res.stderr, new RegExp(`Usage: \\${flag}`), `${flag} ${value}: ${res.stderr}`);
    assert.equal(res.stdout, '');
  }
});

test('--max-turns/--tool-rounds accept positive integers and feed the dry-run plan', async () => {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', '--max-turns', '3', '--tool-rounds', '7'],
    { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
  );
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.wiring.maxTurns, 3);
  assert.equal(plan.wiring.toolRoundsPerTurn, 7);
});

test('parseArgs() --model-timeout defaults to 600 seconds and parses a valid value', () => {
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c1']).modelTimeoutSeconds, 600);
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c1', '--model-timeout', '900']).modelTimeoutSeconds, 900);
});

test('--model-timeout rejects missing, zero, negative, fractional and non-numeric values with a usage error', async () => {
  const { spawnSync } = await import('node:child_process');
  const cases = [[], ['0'], ['-5'], ['1.5'], ['abc']];
  for (const value of cases) {
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', '--model-timeout', ...value],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.notEqual(res.status, 0, `--model-timeout ${value} should be rejected`);
    assert.match(res.stderr, /Usage: --model-timeout/, `--model-timeout ${value}: ${res.stderr}`);
    assert.equal(res.stdout, '');
  }
});

test('--dry-run plan records modelTimeoutMs (default 600000, overridable with --model-timeout)', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (extra) => spawnSync(
    process.execPath,
    [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', ...extra],
    { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
  );
  const def = run([]);
  assert.equal(def.status, 0, def.stderr);
  assert.equal(JSON.parse(def.stdout).modelTimeoutMs, 600_000);
  const custom = run(['--model-timeout', '45']);
  assert.equal(custom.status, 0, custom.stderr);
  assert.equal(JSON.parse(custom.stdout).modelTimeoutMs, 45_000);
});

test('createModel() passes timeoutMs to the default adapter and every route adapter', async () => {
  const created = [];
  const makeAdapter = (cfg) => {
    created.push(cfg);
    return { async complete() { return { type: 'finish', content: 'stub' }; } };
  };
  const previous = { MODEL_API_KEY: process.env.MODEL_API_KEY, MODEL_BASE_URL: process.env.MODEL_BASE_URL };
  process.env.MODEL_API_KEY = 'env-key';
  process.env.MODEL_BASE_URL = 'https://test.example/v1';
  try {
    const harnessExtras = { router: { routes: { retry: { model: 'retry-model' } } } };
    await createModel({ apiKey: 'k', modelId: 'm', harnessExtras, makeAdapter, timeoutMs: 600_000 });
    assert.deepEqual(created, [
      { apiKey: 'env-key', model: 'retry-model', baseUrl: 'https://test.example/v1', timeoutMs: 600_000 },
    ]);

    // Default adapter (plain, no router) receives it too.
    const plain = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras: null, timeoutMs: 600_000 });
    assert.equal(plain.timeoutMs, 600_000);

    // Without a timeout the adapter keeps its own library default.
    const unset = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras: null });
    assert.equal(unset.timeoutMs, 120_000);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('an invalid --task-file (missing or empty) never creates a workspace under --runs-dir (validated before createWorkspace)', async () => {
  const { spawnSync } = await import('node:child_process');
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runsdir-taskfile-'));
  try {
    const missingTaskFile = path.join(runsDir, 'does-not-exist.txt');
    const resMissing = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--runs-dir', runsDir, '--task-file', missingTaskFile],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.notEqual(resMissing.status, 0);
    assert.match(resMissing.stderr, /Usage: --task-file/);

    const emptyTaskFile = path.join(runsDir, 'empty.txt');
    await fs.writeFile(emptyTaskFile, '   \n');
    const resEmpty = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--runs-dir', runsDir, '--task-file', emptyTaskFile],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.notEqual(resEmpty.status, 0);
    assert.match(resEmpty.stderr, /Usage: --task-file/);

    const entries = await fs.readdir(runsDir);
    assert.deepEqual(entries.sort(), ['empty.txt'], 'no workspace directory must have been created under --runs-dir');
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test('loadCredentials exports MODEL_* from the .env file without overriding the environment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-env-'));
  const saved = Object.fromEntries(['MODEL_API_KEY', 'MODEL_ID', 'MODEL_BASE_URL'].map((k) => [k, process.env[k]]));
  try {
    const envFile = path.join(dir, '.env');
    await fs.writeFile(envFile, 'MODEL_API_KEY=file-key\nMODEL_ID=file-model\nMODEL_BASE_URL=https://file.example/v1\n');
    delete process.env.MODEL_API_KEY;
    delete process.env.MODEL_BASE_URL;
    process.env.MODEL_ID = 'env-model';
    const creds = await loadCredentials(envFile);
    assert.deepEqual(creds, { apiKey: 'file-key', modelId: 'env-model' });
    assert.equal(process.env.MODEL_BASE_URL, 'https://file.example/v1');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseArgs() --max-cost defaults to unset (null) and parses a positive number', () => {
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c1']).maxCostUsd, null);
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c1', '--max-cost', '2.5']).maxCostUsd, 2.5);
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c3', '--max-cost', '0.01']).maxCostUsd, 0.01);
});

test('--max-cost rejects missing, zero, negative and non-numeric values with a usage error', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const flags of [['--max-cost'], ['--max-cost', '0'], ['--max-cost', '-1'], ['--max-cost', 'abc'], ['--max-cost', 'Infinity']]) {
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run', ...flags],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.equal(res.status, 1, `${flags.join(' ')} should exit 1`);
    assert.match(res.stderr, /Usage: --max-cost/);
    assert.equal(res.stdout, '');
  }
});

test('--dry-run plan includes the budget (null cap when --max-cost is unset)', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (extra) => {
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c2', '--dry-run', ...extra],
      { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
    );
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  assert.deepEqual(run([]).budget, { maxCostUsd: null, exhausted: false, costReported: null });
  assert.deepEqual(run(['--max-cost', '3']).budget, { maxCostUsd: 3, exhausted: false, costReported: null });
});

test('createModel() wraps the model in a BudgetedModelAdapter only when maxCostUsd is set (plain and routed)', async () => {
  const previousBaseUrl = process.env.MODEL_BASE_URL;
  process.env.MODEL_BASE_URL = 'https://test.example/v1';
  try {
    const plain = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras: null, maxCostUsd: 1.5 });
    assert.ok(plain instanceof BudgetedModelAdapter);
    assert.equal(plain.maxCostUsd, 1.5);
    assert.equal(typeof plain.getUsage, 'function');
    assert.equal(plain.getRouting, undefined, 'a plain model must not gain a routing field');

    const harnessExtras = { router: { routes: { retry: { model: 'm-retry', apiKeyEnv: 'BUDGET_TEST_ROUTE_KEY' } } } };
    process.env.BUDGET_TEST_ROUTE_KEY = 'route-key';
    const routed = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras, maxCostUsd: 1.5, makeAdapter: () => new OpenAICompatibleModelAdapter({ apiKey: 'k', model: 'x' }) });
    assert.ok(routed instanceof BudgetedModelAdapter);
    assert.equal(typeof routed.getRouting, 'function', 'router reporting must survive the budget wrapper');

    const uncapped = await createModel({ apiKey: 'k', modelId: 'm', harnessExtras: null });
    assert.ok(uncapped instanceof OpenAICompatibleModelAdapter);
  } finally {
    delete process.env.BUDGET_TEST_ROUTE_KEY;
    if (previousBaseUrl === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = previousBaseUrl;
  }
});

test('the wrapped model blocks further calls once cost reaches the cap, and applyBudgetToReport() surfaces it as the failure', async () => {
  let innerCalls = 0;
  let cost = 0;
  const inner = {
    async complete() {
      innerCalls += 1;
      cost += 0.4;
      return { type: 'finish', content: 'ok' };
    },
    getUsage: () => ({ calls: innerCalls, cost, promptTokens: 0, completionTokens: 0, totalTokens: 0, retries: 0, modelsUsed: [] }),
  };
  const model = new BudgetedModelAdapter(inner, { maxCostUsd: 0.5 });
  const req = { task: 't', context: { projectRoot: '/tmp', files: [], language: 'typescript' }, availTools: [] };
  await model.complete(req);
  await model.complete(req);
  const blocked = await model.complete(req);
  assert.equal(blocked.type, 'error');
  assert.equal(blocked.code, 'budget_exceeded');
  assert.equal(innerCalls, 2);

  const report = { status: 'FAILED', failure: 'error: Model returned error (budget_exceeded) and no turns are left' };
  applyBudgetToReport(report, model, 0.5);
  assert.deepEqual(report.budget, { maxCostUsd: 0.5, exhausted: true, costReported: true });
  assert.match(report.failure, /^budget_exceeded: /);
  assert.match(report.failure, /0\.8000/);
  assert.equal(report.status, 'FAILED');
});

test('applyBudgetToReport() leaves a successful run untouched and reports a null cap when unset', () => {
  const report = { status: 'SUCCESS' };
  applyBudgetToReport(report, { getUsage: () => ({ calls: 1, cost: 0.2 }) }, null);
  assert.deepEqual(report.budget, { maxCostUsd: null, exhausted: false, costReported: true });
  assert.equal(report.failure, undefined);
  assert.equal(report.status, 'SUCCESS');

  const nullModel = {};
  applyBudgetToReport(nullModel, null, 1);
  assert.deepEqual(nullModel.budget, { maxCostUsd: 1, exhausted: false, costReported: null });
});

test('applyBudgetToReport() flags costReported=false when calls happened at zero cost', () => {
  const report = { status: 'SUCCESS' };
  applyBudgetToReport(report, new BudgetedModelAdapter({ complete: async () => ({ type: 'finish', content: '' }), getUsage: () => ({ calls: 3, cost: 0 }) }, { maxCostUsd: 1 }), 1);
  assert.equal(report.budget.costReported, false);
  assert.equal(report.budget.exhausted, false);
  assert.equal(report.failure, undefined, 'an unknown cost warns but never fails the run');
});

test('routeApiKeyEnvNames() lists every router route apiKeyEnv, and is empty without a router', () => {
  assert.deepEqual(routeApiKeyEnvNames(null), []);
  assert.deepEqual(routeApiKeyEnvNames({}), []);
  assert.deepEqual(
    routeApiKeyEnvNames({ router: { routes: { a: { apiKeyEnv: 'ROUTE_A_VAR' }, b: {}, c: { apiKeyEnv: 'ROUTE_C_VAR' } } } }).sort(),
    ['ROUTE_A_VAR', 'ROUTE_C_VAR'],
  );
});

test('buildHarness() execution hides MODEL_API_KEY and router apiKeyEnv values from model-issued commands', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-scrub-'));
  const saved = { MODEL_API_KEY: process.env.MODEL_API_KEY, ROUTE_PLAIN_VAR: process.env.ROUTE_PLAIN_VAR };
  process.env.MODEL_API_KEY = 'sk-leak';
  process.env.ROUTE_PLAIN_VAR = 'route-leak';
  try {
    const extras = {
      router: { routes: { cheap: { apiKeyEnv: 'ROUTE_PLAIN_VAR' } } },
      mcpProvider: { registerInto: () => [] },
      allowedToolNames: [],
    };
    const { execution } = buildHarness(workspace, {}, 5, path.join(workspace, 'audit.jsonl'), extras);
    const res = await execution.run({ command: `node -e "console.log(JSON.stringify(process.env))"`, cwd: '.' });
    const env = JSON.parse(res.stdout);
    assert.equal(env.MODEL_API_KEY, undefined);
    assert.equal(env.ROUTE_PLAIN_VAR, undefined);
    assert.ok(env.PATH);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('spawnCommand({ scrubEnv: true }) strips inherited secrets but keeps explicit env (e.g. SEED_PASSWORD)', async () => {
  const saved = { MODEL_API_KEY: process.env.MODEL_API_KEY, ROUTE_PLAIN_VAR: process.env.ROUTE_PLAIN_VAR };
  process.env.MODEL_API_KEY = 'sk-leak';
  process.env.ROUTE_PLAIN_VAR = 'route-leak';
  try {
    const script = 'console.log(JSON.stringify(process.env))';
    const scrubbed = await spawnCommand('node', ['-e', script], {
      scrubEnv: true,
      scrubNames: ['ROUTE_PLAIN_VAR'],
      env: { SEED_PASSWORD: 'seed', BACKEND_URL: 'http://localhost:3000' },
    });
    const env = JSON.parse(scrubbed.stdout);
    assert.equal(env.MODEL_API_KEY, undefined);
    assert.equal(env.ROUTE_PLAIN_VAR, undefined);
    assert.equal(env.SEED_PASSWORD, 'seed');
    assert.equal(env.BACKEND_URL, 'http://localhost:3000');
    assert.ok(env.PATH);

    // Default (git/gh) spawns keep the inherited env untouched.
    const plain = await spawnCommand('node', ['-e', script], {});
    assert.equal(JSON.parse(plain.stdout).MODEL_API_KEY, 'sk-leak');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('harness instructions pin the repository root to the workspace root', () => {
  assert.match(HARNESS_INSTRUCTIONS, /workspace root is the repository root/i);
  assert.match(HARNESS_INSTRUCTIONS, /docker-compose\.yml/);
  assert.match(HARNESS_INSTRUCTIONS, /Stay inside the workspace/);
});

test('default tool-round budget lets c1 finish the SPEC and keeps c2/c3 per-turn budget', () => {
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c1']).toolRounds, 200);
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c2']).toolRounds, 30);
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c3']).toolRounds, 30);
});

test('parseBatteryReport reads the pretty-printed run-all.mjs report', () => {
  const report = { timestamp: 't', batteries: [{ battery: 'battery4-coherence', passed: true }], passed: false };
  assert.deepEqual(parseBatteryReport(JSON.stringify(report, null, 2)), report);
  assert.deepEqual(parseBatteryReport(`log line\n${JSON.stringify(report)}\n`), report);
  const broken = parseBatteryReport('not json');
  assert.equal(broken.parseError, true);
  assert.equal(broken.raw, 'not json');
});

// --- task identity in run-report.json / --dry-run plan ---

const sha256Hex = async (text) => (await import('node:crypto')).createHash('sha256').update(text).digest('hex');
const agentsSha256OrNull = async () => {
  try {
    return await sha256Hex(await fs.readFile(path.join(__dirname, '..', 'AGENTS.md')));
  } catch {
    return null;
  }
};

test('--dry-run plan records task identity: spec by default (sha256 of the default task text), repo-relative SPEC path', async () => {
  const { spawnSync } = await import('node:child_process');
  const { DEFAULT_TASK } = await import('./run-experiment.mjs');
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--dry-run'],
    { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
  );
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(typeof DEFAULT_TASK, 'string');
  assert.deepEqual(plan.task, {
    source: 'spec',
    path: 'experiment/SPEC.md',
    sha256: await sha256Hex(DEFAULT_TASK),
    specSha256: await sha256Hex(await fs.readFile(path.join(__dirname, '..', 'SPEC.md'))),
    agentsSha256: await agentsSha256OrNull(),
  });
});

test('--dry-run plan records task identity for --task-file: source task-file, sha256 of the exact file text, repo-relative path when inside the repo', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-taskid-'));
  try {
    const taskFile = path.join(dir, 'task.txt');
    const text = 'Create notes/summary.txt documenting the API\n';
    await fs.writeFile(taskFile, text);
    const run = (file) => {
      const res = spawnSync(
        process.execPath,
        [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c3', '--dry-run', '--task-file', file],
        { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model' } },
      );
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    };

    // Outside the repo (tmpdir): the absolute path is kept.
    assert.deepEqual(run(taskFile).task, {
      source: 'task-file',
      path: taskFile,
      sha256: await sha256Hex(text),
      specSha256: await sha256Hex(await fs.readFile(path.join(__dirname, '..', 'SPEC.md'))),
      agentsSha256: await agentsSha256OrNull(),
    });

    // Inside the repo: recorded relative to the repo root.
    assert.equal(run(path.join(__dirname, 'validation-task.txt')).task.path, 'experiment/runner/validation-task.txt');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a FAILED run (thrown exception) still records task identity in run-report.json', async () => {
  const { spawnSync } = await import('node:child_process');
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runsdir-taskid-'));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-taskid-config-'));
  try {
    const configPath = path.join(configDir, 'harness-config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ router: { routes: { longContext: { model: 'm', apiKeyEnv: 'RUNNER_TEST_UNSET_ENV_VAR' } } } }),
    );
    const childEnv = { ...process.env, MODEL_API_KEY: 'dummy-key', MODEL_ID: 'dummy-model', MODEL_BASE_URL: 'https://test.example/v1' };
    delete childEnv.RUNNER_TEST_UNSET_ENV_VAR;
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-experiment.mjs'), '--config', 'c1', '--runs-dir', runsDir, '--harness-config', configPath],
      { encoding: 'utf8', env: childEnv },
    );
    assert.notEqual(res.status, 0, res.stderr);
    const reportPath = res.stdout.trim().split('\n').pop();
    const report = JSON.parse(await fs.readFile(reportPath, 'utf-8'));
    assert.equal(report.status, 'FAILED');
    assert.equal(report.task.source, 'spec');
    assert.match(report.task.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test('default c2 verify command waits for the backend health check instead of probing once', () => {
  const { verifyCmd } = parseArgs(['node', 'run-experiment.mjs', '--config', 'c2']);
  assert.match(verifyCmd, /^docker compose up -d --build && /);
  assert.match(verifyCmd, /curl -sf --retry 60 --retry-delay 2 --retry-all-errors http:\/\/localhost:3000\/health$/);
});

// ---- static analysis on publish -------------------------------------------------------------

const publishArgs = (ws, report, extra = {}) => ({
  ws, report, modelId: 'm', config: 'c1', org: 'harness-loop-graph', secrets: [], ...extra,
});

test('publishWorkspace() removes tracked model-authored workflows in a dedicated commit and records the paths', async () => {
  const ws = await seedWorkspace('runner-sa-rm-', {
    '.github/workflows/ci.yml': 'name: model ci\n',
    '.github/workflows/deploy.yaml': 'name: model deploy\n',
    'src/app.js': 'x\n',
  });
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const run = makeRecordingRun();
    const report = {};
    await publishWorkspace(publishArgs(ws, report, { run, benchDir, ...SONAR_OK() }));

    assert.equal(report.publishError, undefined);
    assert.deepEqual([...report.staticAnalysis.removedWorkflows].sort(), ['.github/workflows/ci.yml', '.github/workflows/deploy.yaml']);
    const tracked = (await gitOut(ws, 'ls-files')).split('\n');
    assert.ok(!tracked.includes('.github/workflows/ci.yml'));
    assert.ok(!tracked.includes('.github/workflows/deploy.yaml'));
    assert.ok(tracked.includes('.github/workflows/static-analysis.yml'));
    assert.ok(tracked.includes('sonar-project.properties'));
    const subjects = (await gitOut(ws, 'log', '--format=%s')).trim().split('\n');
    assert.deepEqual(subjects.slice(1, 3).reverse(), ['harness: remove model-authored workflows', 'harness: add static analysis workflow']);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('publishWorkspace() makes no removal commit when the model wrote no workflows', async () => {
  const ws = await seedWorkspace('runner-sa-norm-', { 'src/app.js': 'x\n' });
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const report = {};
    await publishWorkspace(publishArgs(ws, report, { run: makeRecordingRun(), benchDir, ...SONAR_OK() }));
    assert.equal(report.publishError, undefined);
    assert.deepEqual(report.staticAnalysis.removedWorkflows, []);
    const log = await gitOut(ws, 'log', '--format=%s');
    assert.doesNotMatch(log, /remove model-authored workflows/);
    assert.match(log, /harness: add static analysis workflow/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('publishWorkspace() injects the runner-owned workflow and sonar-project.properties and records report.staticAnalysis', async () => {
  const ws = await seedWorkspace('runner-sa-inject-', {
    'sonar-project.properties': 'sonar.exclusions=**/*\n', // model tampering attempt
  });
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const report = {};
    await publishWorkspace(publishArgs(ws, report, { run: makeRecordingRun(), benchDir, ...SONAR_OK() }));
    assert.equal(report.publishError, undefined);

    const wf = await fs.readFile(path.join(ws, '.github/workflows/static-analysis.yml'), 'utf-8');
    assert.equal(wf, STATIC_ANALYSIS_WORKFLOW);
    assert.match(wf, /permissions:\n {2}contents: read\n {2}security-events: write\n {2}actions: read/);
    assert.match(wf, /semgrep scan --config p\/default --config p\/typescript --sarif --output semgrep\.sarif \|\| true/);
    assert.match(wf, /image: semgrep\/semgrep/);
    assert.match(wf, /github\/codeql-action\/upload-sarif@v3/);
    assert.match(wf, /category: semgrep/);
    assert.match(wf, /fetch-depth: 0/);
    assert.match(wf, /SonarSource\/sonarqube-scan-action@v5/);
    assert.match(wf, /SONAR_TOKEN: \$\{\{ secrets\.SONAR_TOKEN \}\}/);
    assert.match(wf, /SONAR_HOST_URL: https:\/\/sonarcloud\.io/);
    assert.match(wf, /workflow_dispatch/);

    const wsName = path.basename(ws);
    const props = await fs.readFile(path.join(ws, 'sonar-project.properties'), 'utf-8');
    assert.equal(props, buildSonarProjectProperties({ sonarOrg: 'harness-loop-graph', workspaceName: wsName }));
    assert.match(props, /^sonar\.organization=harness-loop-graph$/m);
    assert.match(props, new RegExp(`^sonar\\.projectKey=harness-loop-graph_run-${wsName}$`, 'm'));
    assert.match(props, new RegExp(`^sonar\\.projectName=run-${wsName}$`, 'm'));
    assert.match(props, /^sonar\.sources=\.$/m);
    assert.match(
      props,
      /^sonar\.exclusions=\*\*\/node_modules\/\*\*,\*\*\/dist\/\*\*,\*\*\/build\/\*\*,\*\*\/coverage\/\*\*,run-report\.json,batteries-report\.json,audit\*\.jsonl,SPEC\.md,AGENTS\.md,\.github\/\*\*$/m,
    );

    const { createHash } = await import('node:crypto');
    assert.deepEqual(report.staticAnalysis, {
      sonarOrganization: 'harness-loop-graph',
      sonarProjectKey: `harness-loop-graph_run-${wsName}`,
      semgrepConfig: ['p/default', 'p/typescript'],
      workflowSha256: createHash('sha256').update(STATIC_ANALYSIS_WORKFLOW).digest('hex'),
      removedWorkflows: [],
    });
    assert.deepEqual(SEMGREP_CONFIGS, ['p/default', 'p/typescript']);
    assert.equal(await gitOut(ws, 'status', '--porcelain', '--', '.github', 'sonar-project.properties'), '');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('publishWorkspace() creates the SonarCloud project (form params + Bearer token) before gh repo create', async () => {
  const ws = await seedWorkspace('runner-sa-sonar-');
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const order = [];
    const fetchFn = makeFetch();
    const base = makeRecordingRun();
    const run = async (cmd, args, opts) => { if (cmd === 'gh') order.push('gh'); return base(cmd, args, opts); };
    const tracked = async (url, init) => { order.push('sonar'); return fetchFn(url, init); };
    tracked.calls = fetchFn.calls;
    await publishWorkspace(publishArgs(ws, {}, { run, benchDir, sonarOrg: 'my-org', sonarToken: 'tok-123', fetchFn: tracked }));

    assert.deepEqual(order, ['sonar', 'sonar', 'gh']);
    assert.equal(fetchFn.calls.length, 2);
    const { url, init } = fetchFn.calls[0];
    assert.equal(url, 'https://sonarcloud.io/api/projects/create');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer tok-123');
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get('organization'), 'my-org');
    assert.equal(form.get('project'), `my-org_run-${path.basename(ws)}`);
    assert.equal(form.get('name'), `run-${path.basename(ws)}`);
    assert.equal(form.get('visibility'), 'public');

    // SonarCloud names a new project's main branch `master`; we push `main`, which would be
    // analyzed as a non-main branch whose measures a free org cannot read.
    const rename = fetchFn.calls[1];
    assert.equal(rename.url, 'https://sonarcloud.io/api/project_branches/rename');
    assert.equal(rename.init.method, 'POST');
    assert.equal(rename.init.headers.Authorization, 'Bearer tok-123');
    const renameForm = new URLSearchParams(String(rename.init.body));
    assert.equal(renameForm.get('project'), `my-org_run-${path.basename(ws)}`);
    assert.equal(renameForm.get('name'), 'main');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('createSonarProject() tolerates HTTP 400 "key already exists" but rejects any other failure', async () => {
  const args = { sonarOrg: 'o', projectKey: 'o_run-x', projectName: 'run-x', sonarToken: 't' };
  await createSonarProject({ ...args, fetchFn: makeFetch([{ status: 400, body: '{"errors":[{"msg":"Could not create Project, key already exists: o_run-x"}]}' }, { status: 204, body: '' }]) });
  await assert.rejects(
    createSonarProject({ ...args, fetchFn: makeFetch([{ status: 400, body: '{"errors":[{"msg":"Organization not found"}]}' }]) }),
    /400/,
  );
  await assert.rejects(createSonarProject({ ...args, fetchFn: makeFetch([{ status: 401, body: 'Unauthorized' }]) }), /401/);
  await assert.rejects(createSonarProject({ ...args, fetchFn: async () => { throw new Error('network down'); } }), /network down/);
  // Created (or already existing) but the main-branch rename failed: refuse, measures would be unreadable.
  await assert.rejects(
    createSonarProject({ ...args, fetchFn: makeFetch([{ status: 200, body: '{}' }, { status: 403, body: 'Insufficient privileges' }]) }),
    /main branch.*403/,
  );
});

test('publishWorkspace() sets publishError and never calls gh when SonarCloud project creation fails', async () => {
  const ws = await seedWorkspace('runner-sa-sonarfail-');
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const run = makeRecordingRun();
    const report = {};
    await publishWorkspace(publishArgs(ws, report, {
      run, benchDir, sonarOrg: 'o', sonarToken: 't', fetchFn: makeFetch([{ status: 403, body: 'forbidden' }]),
    }));
    assert.match(report.publishError, /SonarCloud/);
    assert.match(report.publishError, /403/);
    assert.equal(report.repository, undefined);
    assert.equal(report.staticAnalysis, undefined);
    assert.ok(!run.calls.some((c) => c.cmd === 'gh'), 'gh must not run');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('publishWorkspace() fails closed with a clear publishError when SONAR_TOKEN is missing (no fetch, no gh)', async () => {
  const ws = await seedWorkspace('runner-sa-notoken-');
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const run = makeRecordingRun();
    const fetchFn = makeFetch();
    const report = {};
    await publishWorkspace(publishArgs(ws, report, { run, benchDir, sonarOrg: 'o', sonarToken: undefined, fetchFn }));
    assert.match(report.publishError, /SONAR_TOKEN/);
    assert.equal(fetchFn.calls.length, 0);
    assert.ok(!run.calls.some((c) => c.cmd === 'gh'), 'gh must not run');
    assert.equal(report.repository, undefined);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('collectSecretValues() includes SONAR_TOKEN and the publish scan catches it planted in a workspace file', async () => {
  const saved = process.env.SONAR_TOKEN;
  process.env.SONAR_TOKEN = 'sonar-planted-token-value';
  const ws = await seedWorkspace('runner-sa-leak-', { 'src/config.js': "const t = 'sonar-planted-token-value';\n" });
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const secrets = collectSecretValues({ apiKey: 'k', harnessExtras: null });
    assert.ok(secrets.some((s) => s.label === 'SONAR_TOKEN' && s.value === 'sonar-planted-token-value'));
    const run = makeRecordingRun();
    const report = {};
    await publishWorkspace(publishArgs(ws, report, { run, benchDir, secrets, ...SONAR_OK() }));
    assert.equal(report.publishError, 'secret detected in src/config.js');
    assert.equal(run.calls.length, 0);
  } finally {
    if (saved === undefined) delete process.env.SONAR_TOKEN;
    else process.env.SONAR_TOKEN = saved;
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('scrubEnv drops SONAR_TOKEN from model-issued commands', async () => {
  const saved = process.env.SONAR_TOKEN;
  process.env.SONAR_TOKEN = 'sonar-leak';
  try {
    const out = await spawnCommand('node', ['-e', 'console.log(JSON.stringify(process.env))'], { scrubEnv: true });
    assert.equal(JSON.parse(out.stdout).SONAR_TOKEN, undefined);
  } finally {
    if (saved === undefined) delete process.env.SONAR_TOKEN;
    else process.env.SONAR_TOKEN = saved;
  }
});

test('loadSonarToken() prefers the environment, falls back to .env, and never exits when unset', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-sonar-env-'));
  const saved = process.env.SONAR_TOKEN;
  try {
    const envFile = path.join(dir, '.env');
    await fs.writeFile(envFile, 'MODEL_API_KEY=x\nSONAR_TOKEN=file-token\n');
    delete process.env.SONAR_TOKEN;
    assert.equal(await loadSonarToken(envFile), 'file-token');
    assert.equal(process.env.SONAR_TOKEN, 'file-token');
    process.env.SONAR_TOKEN = 'env-token';
    assert.equal(await loadSonarToken(envFile), 'env-token');
    delete process.env.SONAR_TOKEN;
    assert.equal(await loadSonarToken(path.join(dir, 'missing.env')), undefined);
  } finally {
    if (saved === undefined) delete process.env.SONAR_TOKEN;
    else process.env.SONAR_TOKEN = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loadPublishOnlySecrets() scans for MODEL_API_KEY and route keys that live only in .env', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-only-secrets-'));
  const names = ['MODEL_API_KEY', 'MODEL_ID', 'MODEL_BASE_URL', 'SONAR_TOKEN', 'PUBONLY_ROUTE_KEY'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const envFile = path.join(dir, '.env');
    await fs.writeFile(envFile, 'MODEL_API_KEY=sk-from-dotenv-123\nPUBONLY_ROUTE_KEY=route-from-dotenv-456\n');
    const configFile = path.join(dir, 'harness-config.json');
    await fs.writeFile(configFile, JSON.stringify({
      router: { routes: { longContext: { model: 'long-model', apiKeyEnv: 'PUBONLY_ROUTE_KEY' } } },
      mcpServers: { db: { command: 'node', env: { DB_PASSWORD: 'mcp-secret-789' } } },
    }));

    const withoutConfig = await loadPublishOnlySecrets({ envPath: envFile });
    assert.deepEqual(withoutConfig, [{ label: 'MODEL_API_KEY', value: 'sk-from-dotenv-123' }]);

    const withConfig = await loadPublishOnlySecrets({ envPath: envFile, harnessConfigPath: configFile });
    assert.deepEqual(
      withConfig.map((s) => s.value).sort(),
      ['mcp-secret-789', 'route-from-dotenv-456', 'sk-from-dotenv-123'],
    );
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseArgs() --sonar-org defaults to harness-loop-graph and can be overridden', () => {
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c1']).sonarOrg, 'harness-loop-graph');
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c1', '--sonar-org', 'other']).sonarOrg, 'other');
});

test('parseArgs() --publish-only takes a workspace dir and does not need --config', () => {
  const parsed = parseArgs(['node', 'run-experiment.mjs', '--publish-only', 'some/ws', '--sonar-org', 'o']);
  assert.equal(parsed.publishOnly, path.resolve('some/ws'));
  assert.equal(parsed.sonarOrg, 'o');
  assert.equal(parseArgs(['node', 'run-experiment.mjs', '--config', 'c1']).publishOnly, null);
});

test('loadPublishableWorkspace() refuses a report that already has a repository, and a dir that is not a git repo', async () => {
  const published = await seedWorkspace('runner-po-done-');
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-po-nogit-'));
  const noReport = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-po-noreport-'));
  try {
    await fs.writeFile(path.join(published, 'run-report.json'), JSON.stringify({ repository: { name: 'o/r', url: 'https://github.com/o/r' } }));
    await assert.rejects(loadPublishableWorkspace(published), /already published/);

    await fs.writeFile(path.join(plain, 'run-report.json'), '{}');
    await assert.rejects(loadPublishableWorkspace(plain), /not a git repository/);

    await assert.rejects(loadPublishableWorkspace(noReport), /run-report\.json/);

    const ok = await seedWorkspace('runner-po-ok-');
    try {
      const report = await loadPublishableWorkspace(ok);
      assert.equal(report.model, 'm');
    } finally {
      await fs.rm(ok, { recursive: true, force: true });
    }
  } finally {
    for (const d of [published, plain, noReport]) await fs.rm(d, { recursive: true, force: true });
  }
});

test('publishExistingWorkspace() publishes without generating and rewrites run-report.json', async () => {
  const ws = await seedWorkspace('runner-po-run-', { '.github/workflows/ci.yml': 'name: x\n' });
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const report = await publishExistingWorkspace({
      wsDir: ws, org: 'harness-loop-graph', run: makeRecordingRun(), benchDir, secrets: [], ...SONAR_OK(),
    });
    assert.equal(report.publishError, undefined);
    const persisted = JSON.parse(await fs.readFile(path.join(ws, 'run-report.json'), 'utf-8'));
    assert.equal(persisted.repository.name, `harness-loop-graph/run-${path.basename(ws)}`);
    assert.deepEqual(persisted.staticAnalysis.removedWorkflows, ['.github/workflows/ci.yml']);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('publishExistingWorkspace() persists publishError (and no repository) when publishing fails', async () => {
  const ws = await seedWorkspace('runner-po-fail-');
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  try {
    const run = makeRecordingRun();
    const report = await publishExistingWorkspace({
      wsDir: ws, org: 'harness-loop-graph', run, benchDir, secrets: [], sonarOrg: 'o', sonarToken: undefined, fetchFn: makeFetch(),
    });
    assert.match(report.publishError, /SONAR_TOKEN/);
    const persisted = JSON.parse(await fs.readFile(path.join(ws, 'run-report.json'), 'utf-8'));
    assert.match(persisted.publishError, /SONAR_TOKEN/);
    assert.equal(persisted.repository, undefined);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
  }
});

test('--publish-only never demands MODEL_API_KEY/MODEL_ID and exits non-zero on an already-published report', async () => {
  const { spawnSync } = await import('node:child_process');
  const ws = await seedWorkspace('runner-po-cli-');
  try {
    await fs.writeFile(path.join(ws, 'run-report.json'), JSON.stringify({ repository: { name: 'o/r', url: 'u' } }));
    const env = { ...process.env };
    for (const k of ['MODEL_API_KEY', 'MODEL_ID', 'MODEL_BASE_URL', 'SONAR_TOKEN']) delete env[k];
    const res = spawnSync(process.execPath, [path.join(__dirname, 'run-experiment.mjs'), '--publish-only', ws], { encoding: 'utf8', env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Usage: --publish-only/);
    assert.match(res.stderr, /already published/);
    assert.doesNotMatch(res.stderr, /MODEL_API_KEY/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('publishWorkspace() neutralizes model-planted git hooks and config before any publish git command', async () => {
  const ws = await seedWorkspace('runner-publish-hooks-');
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  const marker = path.join(ws, '..', `${path.basename(ws)}-hook-ran`);
  try {
    const hook = path.join(ws, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await fs.chmod(hook, 0o755);
    const evilHooks = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-evil-hooks-'));
    await fs.writeFile(path.join(evilHooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`);
    await fs.chmod(path.join(evilHooks, 'pre-commit'), 0o755);
    await gitOut(ws, 'config', 'core.hooksPath', evilHooks);
    await gitOut(ws, 'config', 'url.https://evil.example/.insteadOf', 'https://github.com/');
    await fs.writeFile(path.join(ws, '.github-placeholder'), 'x');

    const report = {};
    const run = makeRecordingRun();
    await publishWorkspace({ ws, report, modelId: 'm', config: 'c1', org: 'harness-loop-graph', secrets: [], run, benchDir, ...SONAR_OK() });

    assert.equal(report.publishError, undefined, report.publishError);
    await assert.rejects(fs.access(marker), 'a model-planted hook ran during publish');
    const config = await fs.readFile(path.join(ws, '.git', 'config'), 'utf8');
    assert.doesNotMatch(config, /hooksPath|insteadOf|evil/);
    assert.deepEqual(await fs.readdir(path.join(ws, '.git', 'hooks')), []);
    for (const call of run.calls.filter((c) => c.cmd === 'git' || c.cmd === 'gh')) {
      assert.equal(call.opts?.env?.GIT_CONFIG_KEY_0, 'core.hooksPath', `${call.cmd} ${call.args.join(' ')}`);
      assert.equal(call.opts?.env?.GIT_CONFIG_VALUE_0, '/dev/null');
    }
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(benchDir, { recursive: true, force: true });
    await fs.rm(marker, { force: true });
  }
});

test('publishWorkspace() never writes or deletes outside the workspace through model-planted symlinks', async () => {
  const benchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-bench-empty-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-outside-'));
  const victim = path.join(outside, 'victim.txt');
  const cleanup = [benchDir, outside];
  try {
    await fs.writeFile(victim, 'original');

    // A symlinked sonar-project.properties is replaced, not followed.
    const wsFile = await seedWorkspace('runner-publish-symfile-');
    cleanup.push(wsFile);
    await fs.symlink(victim, path.join(wsFile, 'sonar-project.properties'));
    const r1 = {};
    await publishWorkspace({ ws: wsFile, report: r1, modelId: 'm', config: 'c1', org: 'harness-loop-graph', secrets: [], run: makeRecordingRun(), benchDir, ...SONAR_OK() });
    assert.equal(await fs.readFile(victim, 'utf8'), 'original');
    assert.equal(r1.publishError, undefined, r1.publishError);
    assert.equal((await fs.lstat(path.join(wsFile, 'sonar-project.properties'))).isSymbolicLink(), false);

    // A symlinked .github directory aborts publishing before gh runs.
    const wsDir = await seedWorkspace('runner-publish-symdir-');
    cleanup.push(wsDir);
    await fs.symlink(outside, path.join(wsDir, '.github'));
    const run2 = makeRecordingRun();
    const r2 = {};
    await publishWorkspace({ ws: wsDir, report: r2, modelId: 'm', config: 'c1', org: 'harness-loop-graph', secrets: [], run: run2, benchDir, ...SONAR_OK() });
    assert.match(r2.publishError ?? '', /symlink|outside the workspace/i);
    assert.equal(run2.calls.some((c) => c.cmd === 'gh'), false);
    assert.deepEqual((await fs.readdir(outside)).sort(), ['victim.txt']);

    // A .git that is not a real directory aborts instead of being "sanitized".
    const wsGit = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-publish-symgit-'));
    cleanup.push(wsGit);
    await fs.writeFile(path.join(wsGit, 'run-report.json'), '{}');
    await fs.symlink(outside, path.join(wsGit, '.git'));
    const r3 = {};
    await publishWorkspace({ ws: wsGit, report: r3, modelId: 'm', config: 'c1', org: 'harness-loop-graph', secrets: [], run: makeRecordingRun(), benchDir, ...SONAR_OK() });
    assert.match(r3.publishError ?? '', /\.git/);
    assert.deepEqual((await fs.readdir(outside)).sort(), ['victim.txt']);
    assert.equal(await fs.readFile(victim, 'utf8'), 'original');
  } finally {
    for (const dir of cleanup) await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runBatteries() treats run-all exiting 1 with a valid report as failed batteries, not a phase error', async () => {
  const fx = await batteriesFixture({ runAll: 'exit1' });
  try {
    const out = await runBatteries(fx.ws, false, [], fx.deps);
    assert.equal(out.batteryError, null);
    assert.equal(out.batteryReport.passed, false);
    assert.equal(out.batteryReport.batteries[0].battery, 'battery4-coherence');
    await fs.access(path.join(fx.ws, 'batteries-report.json'));
  } finally {
    await fs.rm(fx.ws, { recursive: true, force: true });
  }
});

test('default loop turn budget is 40 for c2 and 8 per node for c3; --max-turns overrides both', () => {
  const parse = (...a) => parseArgs(['node', 'run-experiment.mjs', ...a]);
  assert.equal(parse('--config', 'c2').maxTurns, 40);
  assert.equal(parse('--config', 'c3').maxTurns, 8);
  assert.equal(parse('--config', 'c2', '--max-turns', '5').maxTurns, 5);
  assert.equal(parse('--config', 'c3', '--max-turns', '5').maxTurns, 5);
});

#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  Harness,
  AgentLoop,
  GraphEngine,
  GlmModelAdapter,
  FsContextManager,
  LocalExecutionManager,
  PolicyGuardrails,
  RegistryToolManager,
  registerBuiltinTools,
  RecordingVerificationManager,
  DEFAULT_ALLOWED_COMMAND_PREFIXES,
  DEFAULT_ALLOWED_TOOLS,
  parseHarnessConfig,
  McpToolProvider,
  SkillCatalog,
  registerSkillTool,
  createRoutedModel,
} from '../../harness/dist/index.js';

const DEFAULT_TASK =
  'Read SPEC.md in the workspace root and implement the complete system it describes, ' +
  'following every requirement (RF-01..RF-27), the endpoint catalog, the screens and the delivery contract. ' +
  'Work only inside the workspace.';

const CHAIN = ['architect', 'data', 'backend', 'frontend', 'reviewer'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    config: null,
    // Sibling of the monorepo root (one level above `experiment/runner`'s
    // grandparent), so generated apps never land inside this repository.
    runsDir: path.resolve(__dirname, '..', '..', '..', 'pi-runs'),
    spec: path.resolve(__dirname, '..', 'SPEC.md'),
    taskFile: null,
    maxTurns: 8,
    maxSteps: 12,
    toolRounds: null,
    verifyCmd: 'docker compose up -d --build && curl -sf http://localhost:3000/health',
    withBatteries: false,
    keep: false,
    dryRun: false,
    harnessConfig: null,
    publish: false,
    publishOrg: 'harness-loop-graph',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config') parsed.config = args[++i];
    else if (a === '--runs-dir') parsed.runsDir = path.resolve(args[++i]);
    else if (a === '--spec') parsed.spec = path.resolve(args[++i]);
    else if (a === '--task-file') parsed.taskFile = path.resolve(args[++i]);
    else if (a === '--max-turns') parsed.maxTurns = parseInt(args[++i], 10);
    else if (a === '--max-steps') parsed.maxSteps = parseInt(args[++i], 10);
    else if (a === '--tool-rounds') parsed.toolRounds = parseInt(args[++i], 10);
    else if (a === '--verify-cmd') parsed.verifyCmd = args[++i];
    else if (a === '--with-batteries') parsed.withBatteries = true;
    else if (a === '--keep') parsed.keep = true;
    else if (a === '--dry-run') parsed.dryRun = true;
    else if (a === '--publish') parsed.publish = true;
    else if (a === '--publish-org') parsed.publishOrg = args[++i];
    else if (a === '--harness-config') {
      const value = args[++i];
      if (value === undefined) {
        console.error('Usage: --harness-config <path> requires a value');
        process.exit(1);
      }
      parsed.harnessConfig = path.resolve(value);
    }
  }
  if (!parsed.config || !['c1', 'c2', 'c3'].includes(parsed.config)) {
    console.error('Usage: node run-experiment.mjs --config c1|c2|c3 [options]');
    process.exit(1);
  }
  if (parsed.toolRounds == null) {
    parsed.toolRounds = parsed.config === 'c1' ? 80 : 30;
  }
  return parsed;
}

async function loadCredentials() {
  let apiKey = process.env.MODEL_API_KEY;
  let modelId = process.env.MODEL_ID;
  if (!apiKey || !modelId) {
    try {
      const envPath = path.resolve(__dirname, '..', '..', '.env');
      const text = await fs.readFile(envPath, 'utf-8');
      for (const line of text.split('\n')) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key === 'MODEL_API_KEY' && !apiKey) apiKey = value;
        if (key === 'MODEL_ID' && !modelId) modelId = value;
      }
    } catch { /* ignore */ }
  }
  if (!apiKey || !modelId) {
    console.error('Missing MODEL_API_KEY and/or MODEL_ID. Set in environment or in .env at the repository root.');
    process.exit(1);
  }
  return { apiKey, modelId };
}

// Lowercases a model id and collapses anything that is not [a-z0-9] into a
// single '-', trimmed at both ends, so it is safe to use in a directory name.
function slugifyModelId(modelId) {
  return modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// YYYYMMDDTHHMMSS in UTC, matching the workspace dir naming contract exactly
// (ISO-minus-separators would keep the ':'/'.' positions misaligned).
function timestampForWorkspace(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

async function createWorkspace(runsDir, config, modelId, specPath, { dryRun = false } = {}) {
  const ts = timestampForWorkspace();
  const ws = path.join(runsDir, `${slugifyModelId(modelId)}-${config}-${ts}`);
  if (dryRun) return ws;
  await fs.mkdir(ws, { recursive: true });
  await fs.copyFile(specPath, path.join(ws, 'SPEC.md'));
  return ws;
}

// Patterns always ignored in a per-run workspace repo: dependency/build
// output that should never be committed, and any .env* file (credentials).
const RUN_GITIGNORE_LINES = ['node_modules/', 'dist/', 'build/', 'coverage/', '.env*'];

// Writes the workspace .gitignore, only adding lines the agent's own
// .gitignore (if any) doesn't already have, so a generated project's own
// ignores are preserved.
async function ensureRunGitignore(ws) {
  const gitignorePath = path.join(ws, '.gitignore');
  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf-8');
  } catch { /* no .gitignore yet */ }
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
  const missing = RUN_GITIGNORE_LINES.filter((l) => !existingLines.has(l));
  if (missing.length === 0) return;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.appendFile(gitignorePath, `${prefix}${missing.join('\n')}\n`);
}

// Turns a finished run workspace into its own git repo with one commit, using
// a fixed local identity so the operator's own git identity is never
// required. Real `git`: callers decide what to do if this throws (the run
// itself must never be lost because of a git failure).
async function initWorkspaceRepo(ws, message) {
  await spawnCommand('git', ['init', '-b', 'main'], { cwd: ws });
  await ensureRunGitignore(ws);
  await spawnCommand('git', ['add', '-A'], { cwd: ws });
  await spawnCommand(
    'git',
    ['-c', 'user.name=pi-runner', '-c', 'user.email=pi-runner@users.noreply.github.com', 'commit', '-m', message],
    { cwd: ws },
  );
}

// Lists every path under `ws` (files and directories, '/'-joined, relative to
// `ws`), skipping `.git`. Used by both the secret guard and the acceptance-
// bench assertion below.
async function walkWorkspaceEntries(ws) {
  const entries = [];
  const stack = [ws];
  while (stack.length > 0) {
    const dir = stack.pop();
    const dirEntries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(ws, full).split(path.sep).join('/');
      entries.push({ rel, full, isDirectory: entry.isDirectory() });
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return entries;
}

// The runner never copies experiment/acceptance/ into a generated workspace;
// this is a defensive assertion that refuses to publish if it ever did.
async function findAcceptancePathInWorkspace(ws) {
  const entries = await walkWorkspaceEntries(ws);
  const hit = entries.find((e) => /(^|\/)acceptance(\/|$)/.test(e.rel));
  return hit ? hit.rel : null;
}

// Secret values to refuse publishing on: the model API key actually used for
// this run, plus (when a router is configured) the value of every route's
// own apiKeyEnv. Values that are unset are dropped, never compared as ''.
function collectSecretValues({ apiKey, harnessExtras }) {
  const secrets = [{ label: 'MODEL_API_KEY', value: apiKey }];
  const router = harnessExtras?.router;
  if (router?.routes) {
    for (const route of Object.values(router.routes)) {
      if (route.apiKeyEnv) secrets.push({ label: route.apiKeyEnv, value: process.env[route.apiKeyEnv] });
    }
  }
  return secrets.filter((s) => s.value);
}

// Scans every committed file for any of `secrets`' values. Returns the first
// hit as { file, label } (never the matched value itself) or null.
async function scanWorkspaceForSecrets(ws, secrets) {
  if (secrets.length === 0) return null;
  const entries = await walkWorkspaceEntries(ws);
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    let content;
    try {
      content = await fs.readFile(entry.full, 'utf-8');
    } catch {
      continue; // unreadable/binary: nothing a plain string check can find anyway
    }
    for (const { label, value } of secrets) {
      if (content.includes(value)) return { file: entry.rel, label };
    }
  }
  return null;
}

async function checkGhAuthenticated(run = spawnCommand) {
  try {
    await run('gh', ['auth', 'status'], {});
    return true;
  } catch {
    return false;
  }
}

// Publishes a finished, already-committed workspace as a public repo under
// `org`, guarded by the acceptance-bench assertion and the secret scan.
// `run` is injectable so tests can stub `gh`/`git` without network or a real
// GitHub call. Mutates `report` in place (`repository` or `publishError`);
// never throws — callers decide exit status from `report.publishError`.
async function publishWorkspace({ ws, report, modelId, config, org, secrets, run = spawnCommand }) {
  const acceptancePath = await findAcceptancePathInWorkspace(ws);
  if (acceptancePath) {
    report.publishError = `workspace contains acceptance path: ${acceptancePath}`;
    return;
  }

  const secretHit = await scanWorkspaceForSecrets(ws, secrets);
  if (secretHit) {
    report.publishError = `secret detected in ${secretHit.file}`;
    return;
  }

  const repoName = `${org}/run-${path.basename(ws)}`;
  const description = `${modelId} ${config} run generated by the PI-I harness`;
  try {
    const result = await run(
      'gh',
      ['repo', 'create', repoName, '--public', '--source', ws, '--push', '--description', description],
      {},
    );
    const url = (result?.stdout ?? '').trim().split('\n').filter(Boolean).pop() || `https://github.com/${repoName}`;
    report.repository = { name: repoName, url };

    // Commit the updated report (now carrying `repository`) and push again,
    // rather than writing the URL before the first commit, so the first
    // commit/push never depends on a repo name `gh repo create` hasn't
    // confirmed yet.
    await fs.writeFile(path.join(ws, 'run-report.json'), JSON.stringify(report, null, 2));
    await run('git', ['add', 'run-report.json'], { cwd: ws });
    await run(
      'git',
      ['-c', 'user.name=pi-runner', '-c', 'user.email=pi-runner@users.noreply.github.com', 'commit', '-m', 'run: record repository metadata'],
      { cwd: ws },
    );
    await run('git', ['push'], { cwd: ws });
  } catch (err) {
    report.publishError = err instanceof Error ? err.message : String(err);
  }
}

function spawnCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timeout;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}. stderr: ${stderr.slice(0, 500)}`));
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    if (opts.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${cmd} ${args.join(' ')} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
  });
}

async function runBatteries(ws, keep) {
  let batteryReport = null;
  let batteryError = null;
  try {
    await spawnCommand('docker', ['compose', 'up', '-d', '--build'], { cwd: ws, timeoutMs: 600_000 });
    let healthy = false;
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch('http://localhost:3000/health');
        if (res.ok) { healthy = true; break; }
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) throw new Error('Health check did not pass within 120s');

    const acceptanceDir = path.resolve(__dirname, '..', 'acceptance');
    const result = await spawnCommand('node', ['run-all.mjs'], {
      cwd: acceptanceDir,
      env: {
        BACKEND_URL: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:8080',
        DB_URL: 'postgres://medapp:medapp@localhost:5432/medapp',
        WORKSPACE: ws,
      },
      timeoutMs: 600_000,
    });
    try {
      const lines = result.stdout.trim().split('\n');
      batteryReport = JSON.parse(lines.pop() || '{}');
    } catch {
      batteryReport = { parseError: true, raw: result.stdout.slice(0, 5000) };
    }
    await fs.writeFile(path.join(ws, 'batteries-report.json'), JSON.stringify(batteryReport, null, 2));
  } catch (err) {
    batteryError = err.message;
  } finally {
    if (!keep) {
      try {
        await spawnCommand('docker', ['compose', 'down', '-v'], { cwd: ws, timeoutMs: 120_000 });
      } catch (downErr) {
        if (!batteryError) batteryError = `docker compose down failed: ${downErr.message}`;
      }
    }
  }
  return { batteryReport, batteryError };
}

/**
 * Loads a --harness-config once per run: connects MCP (one connection,
 * shared across every harness the run builds) and loads the skill catalog.
 * Returns null when no config was requested, so callers stay unchanged.
 * Reads the config file once and reuses that same buffer for both hashing
 * and parsing (`parseHarnessConfig`), instead of reading it twice.
 */
async function loadHarnessExtras(configPath) {
  if (!configPath) return null;
  const raw = await fs.readFile(configPath, 'utf-8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const config = parseHarnessConfig(raw, path.dirname(configPath), configPath);

  const mcpProvider = new McpToolProvider({ mcpServers: config.mcpServers });
  const mcpSpecs = await mcpProvider.connect();

  let skillCatalog;
  try {
    if (config.skillsDirs.length > 0) {
      const catalog = await SkillCatalog.load(config.skillsDirs);
      if (catalog.list().length > 0) skillCatalog = catalog;
    }
  } catch (err) {
    // connect() already succeeded: close it before propagating, or the MCP
    // server process(es) leak for the rest of the run.
    await mcpProvider.close();
    throw err;
  }

  const allowedToolNames = mcpSpecs.map((s) => s.name);
  if (skillCatalog) allowedToolNames.push('load_skill');

  return {
    mcpProvider,
    skillCatalog,
    allowedToolNames,
    router: config.router,
    metadata: {
      path: configPath,
      sha256,
      mcpServers: Object.keys(config.mcpServers),
      toolNames: allowedToolNames,
      skillNames: skillCatalog ? skillCatalog.list().map((s) => s.name) : [],
      ...(config.router ? { routeNames: ['default', ...Object.keys(config.router.routes)] } : {}),
    },
    close: () => mcpProvider.close(),
  };
}

/**
 * Builds the model adapter for a run: identical code path for c1/c2/c3.
 * When the harness config has a `router` section, wraps a plain
 * GlmModelAdapter (the 'default' route) with a RoutingModelAdapter using
 * the same sessionId as the run; without one, returns the plain adapter
 * unchanged, so output without --harness-config (or without a router
 * section) is unaffected.
 */
async function createModel({ apiKey, modelId, sessionId, harnessExtras, makeAdapter }) {
  const defaultAdapter = new GlmModelAdapter({ apiKey, model: modelId, sessionId });
  if (!harnessExtras?.router) return defaultAdapter;
  return createRoutedModel(harnessExtras.router, defaultAdapter, { sessionId, makeAdapter });
}

/**
 * Reduces a RoutingModelAdapter's getRouting() into run-report.json's
 * `routing` field: per-route usage as-is, but the decision log collapsed
 * into counts per route/reason instead of the full per-call list, which
 * can grow unbounded over a long C2/C3 run.
 */
function summarizeRouting(routing) {
  const decisionCounts = {};
  for (const { route, reason } of routing.decisions) {
    const key = `${route}:${reason}`;
    decisionCounts[key] = (decisionCounts[key] ?? 0) + 1;
  }
  return { byRoute: routing.byRoute, decisions: decisionCounts };
}

/**
 * Sets `report.usage` from the model, and `report.routing` when (and only
 * when) `model` is a router (i.e. exposes `getRouting()`). The single call
 * site c1/c2/c3 all share, so a router config produces the same
 * `run-report.json` shape regardless of which of the three ran, and a
 * plain (non-router) model never gets a `routing` field.
 */
function attachUsageAndRouting(report, model) {
  report.usage = model.getUsage();
  if (typeof model.getRouting === 'function') {
    report.routing = summarizeRouting(model.getRouting());
  }
}

function buildHarness(ws, model, toolRounds, auditFile, harnessExtras) {
  const execution = new LocalExecutionManager({ workspaceRoot: ws, timeoutMs: 600_000 });
  const guardrails = new PolicyGuardrails(
    {
      workspaceRoot: ws,
      allowedTools: [...DEFAULT_ALLOWED_TOOLS, ...(harnessExtras?.allowedToolNames ?? [])],
      allowedCommandPrefixes: DEFAULT_ALLOWED_COMMAND_PREFIXES,
      maxFileBytes: 10 * 1024 * 1024,
    },
    auditFile,
  );
  const tools = new RegistryToolManager(guardrails);
  const availTools = registerBuiltinTools(tools, { execution, workspaceRoot: ws });
  if (harnessExtras) {
    availTools.push(...harnessExtras.mcpProvider.registerInto(tools));
    if (harnessExtras.skillCatalog) {
      availTools.push(registerSkillTool(tools, harnessExtras.skillCatalog));
    }
  }
  const verification = new RecordingVerificationManager();
  const harness = new Harness(
    { context: new FsContextManager(harnessExtras?.skillCatalog), model, tools, execution, verification, guardrails },
    {
      workspaceRoot: ws,
      availTools,
      instructions:
        "You are an agent inside a controlled harness. Use the provided tools to complete your task. " +
        "Stay inside the workspace. Finish with a final answer once your task is complete.",
      maxToolRounds: toolRounds,
    },
  );
  // `tools`/`guardrails`/`availTools` are exposed alongside `harness` so
  // tests can inspect the wiring (registered tool names, allowlist) without
  // driving a full model run.
  return { harness, execution, verification, tools, guardrails, availTools };
}

function buildRouter(ws) {
  return (nodeId, loopResult, state) => {
    const idx = CHAIN.indexOf(nodeId);

    if (nodeId !== 'reviewer') {
      if (loopResult.status === 'SUCCESS') {
        if (idx >= 0 && idx < CHAIN.length - 1) {
          return { action: 'NEXT', node: CHAIN[idx + 1], reason: `${nodeId} succeeded -> NEXT ${CHAIN[idx + 1]}` };
        }
        return { action: 'FINISH', reason: `${nodeId} succeeded at end of chain` };
      }
      const visits = state.visits[nodeId] ?? 0;
      if (visits < 2) {
        return { action: 'NEXT', node: nodeId, reason: `${nodeId} FAILED; retrying (${visits} visits)` };
      }
      return { action: 'FAIL', reason: `${nodeId} FAILED after max retries` };
    }

    if (loopResult.status === 'FAILED') {
      const visits = state.visits['reviewer'] ?? 0;
      if (visits < 2) {
        return { action: 'NEXT', node: 'reviewer', reason: 'reviewer loop FAILED; retrying' };
      }
      return { action: 'FAIL', reason: 'reviewer FAILED after max retries' };
    }

    try {
      const verdictPath = path.join(ws, 'review-verdict.json');
      const verdictText = readFileSync(verdictPath, 'utf-8');
      const verdict = JSON.parse(verdictText);
      if (verdict.acceptable === true) {
        return { action: 'FINISH', reason: 'reviewer accepted the system' };
      }
      const responsible = verdict.responsible;
      if (['data', 'backend', 'frontend'].includes(responsible)) {
        return { action: 'NEXT', node: responsible, reason: `reviewer rejected; responsible=${responsible}` };
      }
      const visits = state.visits['reviewer'] ?? 0;
      if (visits < 2) {
        return { action: 'NEXT', node: 'reviewer', reason: 'reviewer returned unacceptable/none; retrying' };
      }
      return { action: 'FAIL', reason: 'reviewer returned unacceptable after max retries' };
    } catch (err) {
      const visits = state.visits['reviewer'] ?? 0;
      if (visits < 2) {
        return { action: 'NEXT', node: 'reviewer', reason: `reviewer verdict unreadable (${err.message}); retrying` };
      }
      return { action: 'FAIL', reason: 'reviewer verdict unreadable after max retries' };
    }
  };
}

// With --task-file the topology, roles and verifications stay the same; only the SPEC work is swapped for the given task.
function overrideNodeTasks(task) {
  const t = task.trim();
  return {
    architect: `Write docs/architecture.md with a short plan for the task below.\n\nTask:\n${t}`,
    data: `Do the data-layer part of the task below, if it has one; otherwise finish.\n\nTask:\n${t}`,
    backend: `Do the backend part of the task below, if it has one; otherwise finish.\n\nTask:\n${t}`,
    frontend: `Do the frontend part of the task below, if it has one; otherwise finish.\n\nTask:\n${t}`,
    reviewer:
      'Review the workspace against the task below and write review-verdict.json with EXACTLY ' +
      '{ "acceptable": boolean, "responsible": "data"|"backend"|"frontend"|"none", "notes": string } ' +
      `— acceptable=true only if the task is done.\n\nTask:\n${t}`,
  };
}

function buildNodes(parsed, taskOverride = null) {
  const nodes = buildSpecNodes(parsed);
  if (taskOverride == null) return nodes;
  const tasks = overrideNodeTasks(taskOverride);
  return nodes.map((n) => ({ ...n, task: tasks[n.id] }));
}

function buildSpecNodes(parsed) {
  return [
    {
      id: 'architect',
      role: 'architect',
      task: 'Write docs/architecture.md: entity model, endpoint-to-screen contract mapping, repo layout. Consult SPEC.md.',
      verification: { command: 'test -f docs/architecture.md' },
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'data',
      role: 'data',
      task: 'Implement the data layer per SPEC: migrations + deterministic seed. Consult SPEC.md.',
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'backend',
      role: 'backend',
      task: 'Implement the NestJS backend per SPEC (endpoint catalog EP-01..EP-20). Consult SPEC.md.',
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'frontend',
      role: 'frontend',
      task: 'Implement the React SPA per SPEC (SCR-01..SCR-08, testability contract). Consult SPEC.md.',
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'reviewer',
      role: 'reviewer',
      task:
        'Review the whole system against SPEC.md and write review-verdict.json with EXACTLY ' +
        '{ "acceptable": boolean, "responsible": "data"|"backend"|"frontend"|"none", "notes": string } ' +
        '— acceptable=true only if the delivery contract holds. Consult SPEC.md.',
      verification: { command: 'test -f review-verdict.json' },
      maxTurns: 2,
      toolRoundsPerTurn: parsed.toolRounds,
    },
  ];
}

function compactTraceC1(result) {
  return result.turns.map((t, i) => ({
    round: i + 1,
    type: t.response.type,
    tool: t.response.type === 'tool_call' ? t.response.tool : undefined,
    verification: t.verification ? { passed: t.verification.passed } : undefined,
  }));
}

function compactTraceC2(loopResult) {
  return loopResult.trace.map((t) => ({
    turn: t.turn,
    phases: t.phases,
    decision: t.decision.action,
    responseType: t.response.type,
    verificationPassed: t.verification?.passed,
  }));
}

function compactTraceC3(graphResult) {
  return graphResult.trace.map((s) => ({
    step: s.step,
    nodeId: s.nodeId,
    loopStatus: s.loopStatus,
    decision: s.decision.action,
    nextNode: s.decision.node,
    ...(s.loopFailure !== undefined ? { loopFailure: s.loopFailure } : {}),
  }));
}

function truncate(s, n) {
  if (!s || s.length <= n) return s;
  return s.slice(0, n) + ' …';
}

async function main() {
  const parsed = parseArgs(process.argv);

  if (parsed.publish && !(await checkGhAuthenticated())) {
    console.error('Usage: --publish requires an authenticated gh CLI. Run `gh auth login` first.');
    process.exit(1);
  }

  const { apiKey, modelId } = await loadCredentials();
  const sessionId = randomUUID();
  const ws = await createWorkspace(parsed.runsDir, parsed.config, modelId, parsed.spec, { dryRun: parsed.dryRun });

  let task = DEFAULT_TASK;
  if (parsed.taskFile) {
    const raw = await fs.readFile(parsed.taskFile, 'utf-8');
    if (raw.trim().length === 0) {
      console.error(`Usage: --task-file <path> must point to a file that is not empty or whitespace-only (got: ${parsed.taskFile})`);
      process.exit(1);
    }
    task = raw;
  }

  if (parsed.dryRun) {
    const plan = {
      workspace: ws,
      config: parsed.config,
      wiring: {
        model: modelId,
        sessionId,
        maxTurns: parsed.maxTurns,
        maxSteps: parsed.maxSteps,
        toolRoundsPerTurn: parsed.toolRounds,
      },
      batteryPhase: parsed.withBatteries,
      harnessConfig: parsed.harnessConfig ?? undefined,
    };
    if (parsed.config === 'c3') {
      plan.nodes = buildNodes(parsed, parsed.taskFile ? task : null).map((n) => ({
        id: n.id,
        role: n.role,
        task: n.task,
        verification: n.verification,
        maxTurns: n.maxTurns,
        toolRoundsPerTurn: n.toolRoundsPerTurn,
      }));
      plan.budgets = { maxSteps: parsed.maxSteps, maxTurns: parsed.maxTurns, toolRoundsPerTurn: parsed.toolRounds };
    } else {
      plan.budgets = { maxToolRounds: parsed.toolRounds, maxTurns: parsed.maxTurns };
    }
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  let report = {
    config: parsed.config,
    model: modelId,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    status: 'FAILED',
    usage: null,
    turns: 0,
  };

  let harnessExtras = null;
  let configFailure = null;
  try {
    harnessExtras = await loadHarnessExtras(parsed.harnessConfig);
    if (harnessExtras) report.harnessConfig = harnessExtras.metadata;
  } catch (err) {
    // A bad --harness-config (unreadable/invalid file, a server that fails
    // to connect, a skills-dir failure) is recorded like any other failure
    // instead of crashing before run-report.json is written.
    configFailure = err instanceof Error ? err.message : String(err);
    report.status = 'FAILED';
    report.failure = `harness-config: ${configFailure}`;
  }

  if (!configFailure) try {
    if (parsed.config === 'c1') {
      const model = await createModel({ apiKey, modelId, sessionId, harnessExtras });
      const { harness } = buildHarness(ws, model, parsed.toolRounds, path.join(ws, 'audit.jsonl'), harnessExtras);
      const result = await harness.run(task, { maxToolRounds: parsed.toolRounds });
      report.status = result.finalResponse.type === 'finish' ? 'SUCCESS' : 'FAILED';
      attachUsageAndRouting(report, model);
      report.turns = result.turns.length;
      report.trace = compactTraceC1(result);
      if (result.finalResponse.type === 'finish') {
        report.finalResponse = truncate(result.finalResponse.content, 2000);
      } else if (result.finalResponse.type === 'error') {
        report.failure = `${result.finalResponse.code}: ${result.finalResponse.message}`;
      }
    } else if (parsed.config === 'c2') {
      const model = await createModel({ apiKey, modelId, sessionId, harnessExtras });
      const { harness, execution, verification } = buildHarness(ws, model, parsed.toolRounds, path.join(ws, 'audit.jsonl'), harnessExtras);
      const loop = new AgentLoop({ harness, execution, verification, workspaceRoot: ws });
      const loopResult = await loop.run({
        task,
        maxTurns: parsed.maxTurns,
        verification: { command: parsed.verifyCmd },
        toolRoundsPerTurn: parsed.toolRounds,
      });
      report.status = loopResult.status;
      attachUsageAndRouting(report, model);
      report.turns = loopResult.turns;
      report.decision = loopResult.decision;
      report.failure = loopResult.failure;
      report.trace = compactTraceC2(loopResult);
      if (loopResult.finalResponse?.type === 'finish') {
        report.finalResponse = truncate(loopResult.finalResponse.content, 2000);
      }
    } else if (parsed.config === 'c3') {
      const model = await createModel({ apiKey, modelId, sessionId, harnessExtras });
      const factory = (node) => {
        const { harness, execution, verification } = buildHarness(ws, model, node.toolRoundsPerTurn ?? parsed.toolRounds, path.join(ws, `audit-${node.id}.jsonl`), harnessExtras);
        return new AgentLoop({ harness, execution, verification, workspaceRoot: ws });
      };
      const nodes = buildNodes(parsed, parsed.taskFile ? task : null);
      const engine = new GraphEngine(factory, {
        // The engine's graph-level task must not contradict a --task-file
        // override even though GraphEngine itself only consults node.task.
        task: parsed.taskFile ? task : 'Implement the complete system described in SPEC.md',
        initialNode: 'architect',
        nodes,
        edges: [],
        maxSteps: parsed.maxSteps,
      }, buildRouter(ws));
      const graphResult = await engine.run();
      report.status = graphResult.status;
      attachUsageAndRouting(report, model);
      report.steps = graphResult.steps;
      report.totalLoopTurns = graphResult.totalLoopTurns;
      report.decision = graphResult.decision;
      report.failure = graphResult.failure;
      report.trace = compactTraceC3(graphResult);
    }

    if (parsed.withBatteries) {
      const batteryInfo = await runBatteries(ws, parsed.keep);
      report.batteryPhase = {
        ran: true,
        passed: !batteryInfo.batteryError && (batteryInfo.batteryReport?.passed ?? false),
        error: batteryInfo.batteryError || undefined,
      };
    }
  } finally {
    if (harnessExtras) {
      try {
        await harnessExtras.close();
      } catch (closeErr) {
        // Never let a close() failure mask the original run/battery error
        // (or overwrite a normal `report.failure`): log it and record it
        // under its own field instead of rethrowing from a finally block.
        const msg = `Failed to close harness extras: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`;
        console.error(msg);
        report.closeError = msg;
      }
    }
  }

  const finishedAt = new Date().toISOString();
  report.finishedAt = finishedAt;
  report.durationMs = Date.now() - t0;

  const reportPath = path.join(ws, 'run-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  // Turn the workspace into a git repo regardless of run outcome: a run that
  // FAILED is still worth keeping. A git failure here is recorded, never
  // thrown — it must not lose the run.
  try {
    await initWorkspaceRepo(ws, `run: ${modelId} ${parsed.config} (${report.status})`);
  } catch (err) {
    report.repoError = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to create workspace git repo: ${report.repoError}`);
  }

  if (parsed.publish) {
    if (report.repoError) {
      report.publishError = 'workspace repo was not created; see repoError';
    } else {
      const secrets = collectSecretValues({ apiKey, harnessExtras });
      await publishWorkspace({ ws, report, modelId, config: parsed.config, org: parsed.publishOrg, secrets });
    }
    if (report.publishError) console.error(`Publish failed: ${report.publishError}`);
  }

  // Re-persist: initWorkspaceRepo()/publishWorkspace() may have added
  // repoError/publishError/repository after the write above.
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.error(`Run complete`);
  console.error(`  Config:     ${report.config}`);
  console.error(`  Model:      ${report.model}`);
  console.error(`  Workspace:  ${ws}`);
  console.error(`  Status:     ${report.status}`);
  console.error(`  Duration:   ${report.durationMs}ms`);
  if (report.turns != null) console.error(`  Turns:      ${report.turns}`);
  if (report.steps != null) console.error(`  Steps:      ${report.steps}`);
  if (report.totalLoopTurns != null) console.error(`  Loop turns: ${report.totalLoopTurns}`);
  if (report.usage) console.error(`  Usage:      ${report.usage.totalTokens} tokens (${report.usage.calls} calls)`);
  if (parsed.withBatteries) {
    const bp = report.batteryPhase;
    console.error(`  Batteries:  ${bp.passed ? 'passed' : bp.error ? `failed (${bp.error})` : 'failed'}`);
  }
  console.log(reportPath);

  if (configFailure || report.publishError) process.exitCode = 1;
}

// Node realpath-resolves the main module; argv[1] is not, and import.meta.url is percent-encoded.
const isEntryPoint = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export {
  parseArgs,
  loadCredentials,
  loadHarnessExtras,
  buildHarness,
  buildNodes,
  buildRouter,
  createWorkspace,
  createModel,
  summarizeRouting,
  attachUsageAndRouting,
  compactTraceC3,
  slugifyModelId,
  timestampForWorkspace,
  initWorkspaceRepo,
  ensureRunGitignore,
  findAcceptancePathInWorkspace,
  collectSecretValues,
  scanWorkspaceForSecrets,
  checkGhAuthenticated,
  publishWorkspace,
  main,
};

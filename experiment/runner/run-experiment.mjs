#!/usr/bin/env node
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  Harness,
  AgentLoop,
  GraphEngine,
  OpenAICompatibleModelAdapter,
  BudgetedModelAdapter,
  FsContextManager,
  LocalExecutionManager,
  scrubEnv,
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

// Identifies the task text the model received so SPEC runs stay
// distinguishable from cheap `--task-file` validation runs. `path` is
// repo-relative when the file lives inside this repository.
function describeTask({ source, filePath, text, specPath }) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const rel = path.relative(repoRoot, filePath);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return {
    source,
    path: inside ? rel.split(path.sep).join('/') : filePath,
    sha256: createHash('sha256').update(text).digest('hex'),
    // SPEC.md is copied into every workspace, so its bytes are part of the
    // input even when the task sentence is unchanged.
    specSha256: createHash('sha256').update(readFileSync(specPath)).digest('hex'),
    // The working rules copied next to SPEC.md (see createWorkspace()); null when there are none.
    agentsSha256: agentsFileSha256(specPath),
  };
}

// AGENTS.md next to the spec holds the fixed working rules every run receives.
function agentsFilePath(specPath) {
  return path.join(path.dirname(specPath), 'AGENTS.md');
}

function agentsFileSha256(specPath) {
  try {
    return createHash('sha256').update(readFileSync(agentsFilePath(specPath))).digest('hex');
  } catch {
    return null;
  }
}

const CHAIN = ['architect', 'data', 'backend', 'frontend', 'reviewer'];

// Parses a numeric flag's value as a positive integer, or exits with a usage
// error (consistent with the other flag-shaped usage errors below) — a
// missing, non-numeric, fractional, zero or negative value is never silently
// accepted as a turn/step/tool-round budget.
function parsePositiveIntFlag(flag, raw) {
  if (raw === undefined) {
    console.error(`Usage: ${flag} <n> requires a value`);
    process.exit(1);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Usage: ${flag} <n> must be a positive integer (got: ${raw})`);
    process.exit(1);
  }
  return n;
}

// Parses --provider <name[,name...]> into an OpenRouter provider order, or
// null for `none` (no provider field sent). Exits with a usage error on a
// missing, empty or malformed list.
function parseProviderFlag(raw) {
  const fail = (reason) => {
    console.error(`Usage: --provider <name[,name...]|none> ${reason} (got: ${raw ?? ''})`);
    process.exit(1);
  };
  if (raw === undefined) fail('requires a value');
  const names = raw.split(',').map((name) => name.trim());
  if (names.length === 1 && names[0].toLowerCase() === 'none') return null;
  if (names.some((name) => name === '')) fail('must be a comma-separated list of non-empty provider names, or none');
  if (names.some((name) => name.toLowerCase() === 'none')) fail('cannot mix none with provider names');
  return names;
}

// Parses a numeric sampling flag, or exits with a usage error. `describe`
// names the accepted range in the message; `valid` is the range predicate.
function parseNumberFlag(flag, raw, { describe, valid }) {
  if (raw === undefined) {
    console.error(`Usage: ${flag} <n> requires a value`);
    process.exit(1);
  }
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || !valid(n)) {
    console.error(`Usage: ${flag} <n> must be ${describe} (got: ${raw})`);
    process.exit(1);
  }
  return n;
}

// Same cost cap for every config; override with --max-cost <usd>.
const DEFAULT_MAX_COST_USD = 6;

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    config: null,
    // Sibling of the monorepo root (one level above `experiment/runner`'s
    // grandparent), so generated apps never land inside this repository.
    runsDir: path.resolve(__dirname, '..', '..', '..', 'pi-runs'),
    spec: path.resolve(__dirname, '..', 'SPEC.md'),
    taskFile: null,
    maxTurns: null,
    maxSteps: 12,
    toolRounds: null,
    // `up -d` returns once containers start, not once the backend serves, so
    // the probe retries for up to ~120s, like the battery phase health wait.
    verifyCmd: 'docker compose up -d --build && curl -sf --retry 60 --retry-delay 2 --retry-all-errors http://localhost:3000/health',
    withBatteries: false,
    keep: false,
    dryRun: false,
    harnessConfig: null,
    // Money is the equalized resource across c1/c2/c3: every config gets the same cost cap.
    maxCostUsd: DEFAULT_MAX_COST_USD,
    publish: false,
    publishOrg: 'harness-loop-graph',
    sonarOrg: 'harness-loop-graph',
    // Workspace dir of an already generated run to publish without generating anything.
    publishOnly: null,
    // Workspace dir of an already published run whose runner-owned static analysis files get refreshed.
    updateAnalysis: null,
    // null = unset: the provider default applies and the field is omitted from requests.
    sampling: { temperature: null, topP: null, seed: null, maxTokens: null },
    // OpenRouter provider routing, pinned for every model call so c1/c2/c3 hit
    // the same upstream. null (--provider none) sends no provider field.
    provider: { order: ['DeepInfra'], allowFallbacks: false },
    // Per-request model timeout (whole response body, incl. slow non-streamed
    // generations). The adapter's own 120s default is too short for long contexts.
    modelTimeoutSeconds: 600,
    // Retries per model call for 429/5xx/network errors. The adapter's backoff doubles from 1s up to
    // 30s (or honors Retry-After), so 8 retries ride out a ~2-3 minute upstream overload.
    modelRetries: 8,
  };
  let providerOrder = parsed.provider.order;
  let allowProviderFallbacks = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config') parsed.config = args[++i];
    else if (a === '--runs-dir') parsed.runsDir = path.resolve(args[++i]);
    else if (a === '--spec') parsed.spec = path.resolve(args[++i]);
    else if (a === '--task-file') parsed.taskFile = path.resolve(args[++i]);
    else if (a === '--max-turns') parsed.maxTurns = parsePositiveIntFlag('--max-turns', args[++i]);
    else if (a === '--max-steps') parsed.maxSteps = parsePositiveIntFlag('--max-steps', args[++i]);
    else if (a === '--tool-rounds') parsed.toolRounds = parsePositiveIntFlag('--tool-rounds', args[++i]);
    else if (a === '--temperature') {
      parsed.sampling.temperature = parseNumberFlag('--temperature', args[++i], {
        describe: 'a number between 0 and 2',
        valid: (n) => n >= 0 && n <= 2,
      });
    } else if (a === '--top-p') {
      parsed.sampling.topP = parseNumberFlag('--top-p', args[++i], {
        describe: 'a number greater than 0 and at most 1',
        valid: (n) => n > 0 && n <= 1,
      });
    } else if (a === '--seed') {
      parsed.sampling.seed = parseNumberFlag('--seed', args[++i], {
        describe: 'an integer',
        valid: Number.isInteger,
      });
    } else if (a === '--max-tokens') parsed.sampling.maxTokens = parsePositiveIntFlag('--max-tokens', args[++i]);
    else if (a === '--provider') providerOrder = parseProviderFlag(args[++i]);
    else if (a === '--allow-provider-fallbacks') allowProviderFallbacks = true;
    else if (a === '--model-timeout') parsed.modelTimeoutSeconds = parsePositiveIntFlag('--model-timeout', args[++i]);
    else if (a === '--model-retries') parsed.modelRetries = parsePositiveIntFlag('--model-retries', args[++i]);
    else if (a === '--max-cost') {
      parsed.maxCostUsd = parseNumberFlag('--max-cost', args[++i], {
        describe: 'a positive number of USD',
        valid: (n) => n > 0,
      });
    } else if (a === '--verify-cmd') parsed.verifyCmd = args[++i];
    else if (a === '--with-batteries') parsed.withBatteries = true;
    else if (a === '--keep') parsed.keep = true;
    else if (a === '--dry-run') parsed.dryRun = true;
    else if (a === '--publish') parsed.publish = true;
    else if (a === '--publish-org') parsed.publishOrg = args[++i];
    else if (a === '--sonar-org') parsed.sonarOrg = args[++i];
    else if (a === '--publish-only') {
      const value = args[++i];
      if (value === undefined) {
        console.error('Usage: --publish-only <workspace-dir> requires a value');
        process.exit(1);
      }
      parsed.publishOnly = path.resolve(value);
    } else if (a === '--update-analysis') {
      const value = args[++i];
      if (value === undefined) {
        console.error('Usage: --update-analysis <workspace-dir> requires a value');
        process.exit(1);
      }
      parsed.updateAnalysis = path.resolve(value);
    }
    else if (a === '--harness-config') {
      const value = args[++i];
      if (value === undefined) {
        console.error('Usage: --harness-config <path> requires a value');
        process.exit(1);
      }
      parsed.harnessConfig = path.resolve(value);
    }
  }
  if (providerOrder === null && allowProviderFallbacks) {
    console.error('Usage: --allow-provider-fallbacks has no effect with --provider none');
    process.exit(1);
  }
  parsed.provider = providerOrder === null ? null : { order: providerOrder, allowFallbacks: allowProviderFallbacks };
  if (parsed.publishOnly && parsed.updateAnalysis) {
    console.error('Usage: --publish-only and --update-analysis are mutually exclusive');
    process.exit(1);
  }
  if (!parsed.publishOnly && !parsed.updateAnalysis && (!parsed.config || !['c1', 'c2', 'c3'].includes(parsed.config))) {
    console.error('Usage: node run-experiment.mjs --config c1|c2|c3 [options]');
    process.exit(1);
  }
  // c2's single loop gets more turns than each of c3's five node loops.
  if (parsed.maxTurns == null) {
    parsed.maxTurns = parsed.config === 'c2' ? 40 : 8;
  }
  if (parsed.toolRounds == null) {
    parsed.toolRounds = parsed.config === 'c1' ? 2000 : parsed.config === 'c2' ? 80 : 30;
  }
  return parsed;
}

// Identical for c1/c2/c3. The repository-root sentence exists because the
// SPEC runs `docker compose up` and Playwright "from the repo root" without
// saying where that is, and a real run nested the project under project/.
const HARNESS_INSTRUCTIONS =
  'You are an agent inside a controlled harness. Use the provided tools to complete your task. ' +
  'Stay inside the workspace. The workspace root is the repository root: place docker-compose.yml ' +
  'and the project files there, not in a nested folder. ' +
  'Finish with a final answer once your task is complete.';

const ENV_FILE_KEYS = ['MODEL_API_KEY', 'MODEL_ID', 'MODEL_BASE_URL'];
const DEFAULT_ENV_FILE = path.resolve(__dirname, '..', '..', '.env');

// Exports `keys` found in the .env file to process.env, never overriding values already set.
async function exportFromEnvFile(keys, envPath) {
  try {
    const text = await fs.readFile(envPath, 'utf-8');
    for (const line of text.split('\n')) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (keys.includes(key) && !process.env[key] && value) process.env[key] = value;
    }
  } catch { /* ignore */ }
}

// Values from the root .env are exported to process.env (never overriding it) so the adapter and
// every router route resolve MODEL_* the same way.
async function loadCredentials(envPath = DEFAULT_ENV_FILE) {
  if (ENV_FILE_KEYS.some((key) => !process.env[key])) await exportFromEnvFile(ENV_FILE_KEYS, envPath);
  const apiKey = process.env.MODEL_API_KEY;
  const modelId = process.env.MODEL_ID;
  if (!apiKey || !modelId) {
    console.error('Missing MODEL_API_KEY and/or MODEL_ID. Set in environment or in .env at the repository root.');
    process.exit(1);
  }
  return { apiKey, modelId };
}

// SONAR_TOKEN is only needed to publish, so unlike loadCredentials() an unset value is not an
// error here: publishWorkspace() fails closed with a publishError instead.
async function loadSonarToken(envPath = DEFAULT_ENV_FILE) {
  if (!process.env.SONAR_TOKEN) await exportFromEnvFile(['SONAR_TOKEN'], envPath);
  return process.env.SONAR_TOKEN || undefined;
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
  try {
    await fs.copyFile(agentsFilePath(specPath), path.join(ws, 'AGENTS.md'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return ws;
}

// Patterns always ignored in a per-run workspace repo: dependency/build
// output that should never be committed, and any .env* file (credentials).
const RUN_GITIGNORE_LINES = ['node_modules/', 'dist/', 'build/', 'coverage/', '.env*', 'reasoning.jsonl'];

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

// The workspace (including any .git the model created or touched) is
// model-writable. Every git/gh call the runner makes on it disables hooks via
// environment config, and the repo's hooks and config are reset to a minimal
// runner-owned state so planted hooks, fsmonitor commands or url rewrites
// (e.g. a push redirected with insteadOf) never run with runner secrets.
const GIT_HOOKS_OFF_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' };
const MINIMAL_GIT_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n';

// Writes a runner-owned file inside the workspace without following
// model-planted symlinks: each parent directory is checked (and created)
// one component at a time and must be a real directory, and an existing
// entry (possibly a symlink) is removed before the file is created
// exclusively.
async function writeOwnedFile(ws, rel, content) {
  let dir = ws;
  for (const part of path.dirname(rel).split(path.sep).filter((p) => p && p !== '.')) {
    dir = path.join(dir, part);
    let stat = null;
    try {
      stat = await fs.lstat(dir);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (!stat) await fs.mkdir(dir);
    else if (!stat.isDirectory()) throw new Error(`refusing to write ${rel}: ${path.relative(ws, dir)} is a symlink or not a directory inside the workspace`);
  }
  const target = path.join(ws, rel);
  await fs.rm(target, { force: true });
  await fs.writeFile(target, content, { flag: 'wx' });
}

async function sanitizeWorkspaceGit(ws) {
  const gitDir = path.join(ws, '.git');
  const stat = await fs.lstat(gitDir);
  if (!stat.isDirectory()) throw new Error('refusing to use the workspace .git: it is not a real directory (symlink or gitdir file)');
  // fs.rm removes a symlinked hooks dir as a link, never its target.
  await fs.rm(path.join(gitDir, 'hooks'), { recursive: true, force: true });
  await fs.mkdir(path.join(gitDir, 'hooks'));
  await writeOwnedFile(ws, path.join('.git', 'config'), MINIMAL_GIT_CONFIG);
}

// Turns a finished run workspace into its own git repo with one commit, using
// a fixed local identity so the operator's own git identity is never
// required. Real `git`: callers decide what to do if this throws (the run
// itself must never be lost because of a git failure).
async function initWorkspaceRepo(ws, message) {
  // A model-run `git init` may have left hooks/config behind; reset them first.
  await spawnCommand('git', ['init', '-b', 'main'], { cwd: ws, env: GIT_HOOKS_OFF_ENV });
  await sanitizeWorkspaceGit(ws);
  await ensureRunGitignore(ws);
  await spawnCommand('git', ['add', '-A'], { cwd: ws, env: GIT_HOOKS_OFF_ENV });
  await spawnCommand(
    'git',
    ['-c', 'user.name=pi-runner', '-c', 'user.email=pi-runner@users.noreply.github.com', 'commit', '--no-verify', '-m', message],
    { cwd: ws, env: GIT_HOOKS_OFF_ENV },
  );
}

// Lists every regular file under `dir` (relative path, '/'-joined), skipping
// any directory whose name is in `ignoreDirNames`. A missing `dir` yields an
// empty list rather than throwing. Shared by the bench-hash walk below
// (which also skips `node_modules`, since the bench's own dependencies are
// never meaningfully "the bench" being protected).
async function walkFiles(dir, ignoreDirNames) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let dirEntries;
    try {
      dirEntries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue; // `dir` (or a dir under it) does not exist / is not readable
    }
    for (const entry of dirEntries) {
      if (entry.isDirectory() && ignoreDirNames.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push({ rel: path.relative(dir, full).split(path.sep).join('/'), full });
    }
  }
  return files;
}

// Files actually committed into the per-run workspace repo (never the
// gitignored node_modules/dist/build/coverage/.env* that `initWorkspaceRepo()`
// writes into `.gitignore`). Both publish guards below must see exactly what
// gets pushed, not the whole working tree — `ws` is already a git repo with
// at least one commit by the time either guard runs (publishWorkspace() only
// runs after initWorkspaceRepo()).
async function listTrackedFiles(ws) {
  const { stdout } = await spawnCommand('git', ['-C', ws, 'ls-files', '-z'], {});
  return stdout.split('\0').filter(Boolean);
}

// Hashes (sha256 over raw bytes) every file under `benchDir` (the hidden
// acceptance bench), skipping `.git`/`node_modules`. Returns a
// Map<sha256Hex, relPath[]>; a missing `benchDir` (e.g. a checkout without
// the gitignored bench) hashes to an empty map rather than throwing.
// Run outputs written into the bench dir by run-all.mjs / Playwright. They are
// results, not the hidden bench: the runner copies report.json verbatim to
// <ws>/batteries-report.json, so hashing it would refuse every battery run.
const BENCH_OUTPUT_DIRS = ['test-results', 'playwright-report'];
const BENCH_OUTPUT_FILES = new Set(['report.json']);

async function hashBenchFiles(benchDir) {
  const hashes = new Map();
  const files = await walkFiles(benchDir, new Set(['.git', 'node_modules', ...BENCH_OUTPUT_DIRS]));
  for (const { rel, full } of files) {
    if (BENCH_OUTPUT_FILES.has(rel)) continue;
    const content = await fs.readFile(full);
    const digest = createHash('sha256').update(content).digest('hex');
    const existing = hashes.get(digest);
    if (existing) existing.push(rel);
    else hashes.set(digest, [rel]);
  }
  return hashes;
}

// The runner never copies experiment/acceptance/ (the hidden bench) into a
// generated workspace; this is a defensive assertion before publish. It
// compares every *tracked* workspace file's content (byte-for-byte, via
// sha256) against the bench's own file hashes, so a generated app's own
// folder that happens to be named `acceptance/` (legitimate product code,
// with different content) is never flagged — only an actual byte-identical
// copy of a bench file is. `benchDir` is overridable for tests.
async function findAcceptancePathInWorkspace(ws, benchDir = path.resolve(__dirname, '..', 'acceptance')) {
  const benchHashes = await hashBenchFiles(benchDir);
  if (benchHashes.size === 0) return null;
  const tracked = await listTrackedFiles(ws);
  for (const rel of tracked) {
    let content;
    try {
      content = await fs.readFile(path.join(ws, rel));
    } catch {
      continue;
    }
    const digest = createHash('sha256').update(content).digest('hex');
    if (benchHashes.has(digest)) return rel;
  }
  return null;
}

// Secret values to refuse publishing on: the model API key actually used for
// this run, the value of every router route's own apiKeyEnv (when a router is
// configured), and every non-empty env value configured for a
// --harness-config MCP server — except values under 8 chars, which are
// dropped to avoid false positives on short, non-secret-looking strings (the
// threshold is also documented in runner/README.md). Values that end up
// unset/empty are dropped, never compared as ''.
const MIN_MCP_ENV_SECRET_LENGTH = 8;

function collectSecretValues({ apiKey, harnessExtras }) {
  const secrets = [
    { label: 'MODEL_API_KEY', value: apiKey },
    { label: 'SONAR_TOKEN', value: process.env.SONAR_TOKEN },
  ];
  const router = harnessExtras?.router;
  if (router?.routes) {
    for (const route of Object.values(router.routes)) {
      if (route.apiKeyEnv) secrets.push({ label: route.apiKeyEnv, value: process.env[route.apiKeyEnv] });
    }
  }
  const mcpServers = harnessExtras?.mcpServers;
  if (mcpServers) {
    for (const [serverName, server] of Object.entries(mcpServers)) {
      if (!server.env) continue;
      for (const [envKey, value] of Object.entries(server.env)) {
        if (typeof value === 'string' && value.length >= MIN_MCP_ENV_SECRET_LENGTH) {
          secrets.push({ label: `mcpServers.${serverName}.env.${envKey}`, value });
        }
      }
    }
  }
  return secrets.filter((s) => s.value);
}

// Scans every *tracked* workspace file (see listTrackedFiles() above) for any
// of `secrets`' values, matched as raw bytes (never decoded as text) so a
// binary file is handled honestly instead of silently skipped as
// "unreadable". Returns the first hit as { file, label } (never the matched
// value itself) or null.
async function scanWorkspaceForSecrets(ws, secrets) {
  if (secrets.length === 0) return null;
  const needles = secrets.map(({ label, value }) => ({ label, buf: Buffer.from(value, 'utf-8') }));
  const tracked = await listTrackedFiles(ws);
  for (const rel of tracked) {
    let content;
    try {
      content = await fs.readFile(path.join(ws, rel));
    } catch {
      continue; // listed by git but unreadable on disk: nothing to scan
    }
    for (const { label, buf } of needles) {
      if (content.includes(buf)) return { file: rel, label };
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

// Runner-owned static analysis, injected into every published run. The model can write anything
// into its workspace (a real run wrote .github/workflows/*.yml), so its workflows are stripped and
// replaced by this exact text; tests and docs reference this constant.
const SEMGREP_CONFIGS = ['p/default', 'p/typescript'];

// Projects whose tests run in the secret-less `coverage` job (paths mirror experiment/AGENTS.md).
const COVERAGE_PROJECTS = ['backend', 'frontend'];

// Install + Vitest coverage for one project dir. Generated code runs here and only here: no
// secrets, read-only contents. Skips (exit 0) without a package.json, a test script or vitest;
// `sed` prefixes relative lcov `SF:` paths with the dir because Sonar resolves them from the repo root.
function coverageStep(dir) {
  return `      - name: Coverage (${dir})
        continue-on-error: true
        timeout-minutes: 20
        env:
          CI: true
        run: |
          if [ ! -f ${dir}/package.json ]; then echo "no ${dir}/package.json, skipping"; exit 0; fi
          cd ${dir}
          if ! node -e "process.exit(require('./package.json').scripts?.test ? 0 : 1)"; then echo "no test script, skipping"; exit 0; fi
          npm ci || npm install
          if [ ! -f node_modules/vitest/package.json ]; then echo "vitest not installed, skipping coverage"; exit 0; fi
          major=$(node -p "require('./node_modules/vitest/package.json').version.split('.')[0]")
          npm i --no-save @vitest/coverage-v8@$major
          npx vitest run --coverage --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=coverage
          if [ -f coverage/lcov.info ]; then sed -i '/^SF:[/]/!s#^SF:#SF:${dir}/#' coverage/lcov.info; fi
`;
}

// Informative quality thresholds (the course's reference workflow); they never block the job.
const QUALITY_THRESHOLDS = { MIN_COVERAGE: 65, MAX_DEBT_MIN: 960, MAX_COMPLEXITY: 50, MAX_VULNERABILITIES: 0 };
const SONAR_MAIN_ONLY_IF = "if: github.event_name == 'push' && github.ref == 'refs/heads/main'";

const STATIC_ANALYSIS_WORKFLOW = `name: static-analysis

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  security-events: write
  actions: read

jobs:
  semgrep:
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep
    steps:
      - uses: actions/checkout@v4
      - name: Semgrep scan
        run: semgrep scan ${SEMGREP_CONFIGS.map((c) => `--config ${c}`).join(' ')} --sarif --output semgrep.sarif || true
      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: semgrep.sarif
          category: semgrep

  coverage:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
${COVERAGE_PROJECTS.map(coverageStep).join('')}      - name: Stage coverage reports
        if: always()
        run: |
          for f in ${COVERAGE_PROJECTS.map((d) => `${d}/coverage/lcov.info`).join(' ')}; do
            if [ -f "$f" ] && [ ! -L "$f" ]; then mkdir -p "coverage-artifacts/$(dirname "$f")" && cp "$f" "coverage-artifacts/$f"; fi
          done
      - name: Upload coverage reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-reports
          path: coverage-artifacts
          if-no-files-found: ignore

  sonarcloud:
    needs: coverage
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Download coverage reports
        continue-on-error: true
        uses: actions/download-artifact@v4
        with:
          name: coverage-reports
          path: .
      - name: SonarCloud scan
        uses: SonarSource/sonarqube-scan-action@v5
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
          SONAR_HOST_URL: https://sonarcloud.io
      - name: Wait for SonarCloud analysis
        ${SONAR_MAIN_ONLY_IF}
        continue-on-error: true
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
        run: |
          report=.scannerwork/report-task.txt
          if [ ! -f "$report" ]; then echo "no report-task.txt, not waiting"; exit 0; fi
          # ceTaskUrl is the /api/ce/task?id=... URL of this analysis' compute task
          url=$(sed -n 's/^ceTaskUrl=//p' "$report")
          case "$url" in https://sonarcloud.io/*) ;; *) echo "unexpected ceTaskUrl, not waiting"; exit 0 ;; esac
          for i in $(seq 1 30); do
            status=$(curl -s -u "$SONAR_TOKEN:" "$url" | jq -r '.task.status // empty')
            echo "attempt $i: $status"
            case "$status" in SUCCESS|FAILED|CANCELED) break ;; esac
            sleep 5
          done
          exit 0
      - name: Quality criteria (informative)
        ${SONAR_MAIN_ONLY_IF}
        continue-on-error: true
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
${Object.entries(QUALITY_THRESHOLDS).map(([k, v]) => `          ${k}: ${v}\n`).join('')}        run: |
          PROJECT_KEY=$(sed -n 's/^sonar.projectKey=//p' sonar-project.properties)
          api() { curl -s -u "$SONAR_TOKEN:" "$1"; }
          measures=$(api "https://sonarcloud.io/api/measures/component?component=$PROJECT_KEY&branch=main&metricKeys=coverage,sqale_index,complexity")
          metric() { echo "$measures" | jq -r --arg m "$1" '.component.measures[]? | select(.metric == $m) | .value'; }
          coverage=$(metric coverage)
          debt=$(metric sqale_index)
          complexity=$(metric complexity)
          vulns=$(api "https://sonarcloud.io/api/issues/search?componentKeys=$PROJECT_KEY&branch=main&types=VULNERABILITY&severities=CRITICAL,BLOCKER&resolved=false&ps=1" | jq -r '.total // empty')
          failed=0
          row() {
            ok=$(awk -v v="$2" -v t="$4" -v op="$5" 'BEGIN { if (v == "") print 0; else if (op == "ge") print (v + 0 >= t + 0); else if (op == "le") print (v + 0 <= t + 0); else if (op == "lt") print (v + 0 < t + 0); else print (v + 0 == t + 0) }')
            if [ "$ok" = "1" ]; then state="✅"; else state="❌"; failed=1; fi
            value="$2$6"
            if [ -z "$2" ]; then value="N/A"; fi
            echo "| $1 | $value | $3 | $state |"
          }
          {
            echo "### Resultado de calidad"
            echo "| Criterio | Valor | Meta | Estado |"
            echo "|---|---|---|---|"
            row "Cobertura" "$coverage" "≥ $MIN_COVERAGE%" "$MIN_COVERAGE" ge "%"
            row "Deuda técnica" "$debt" "≤ $MAX_DEBT_MIN min" "$MAX_DEBT_MIN" le " min"
            row "Complejidad ciclomática" "$complexity" "< $MAX_COMPLEXITY" "$MAX_COMPLEXITY" lt ""
            row "Vulnerabilidades críticas" "$vulns" "$MAX_VULNERABILITIES" "$MAX_VULNERABILITIES" eq ""
          } >> "$GITHUB_STEP_SUMMARY"
          if [ "$failed" = "1" ]; then echo "::warning title=Quality gates::Algunos criterios no se cumplen. Revisa la tabla en Summary."; fi
          exit 0
`;

// The batteries pace their logins (~61 s apart) to respect the SPEC's auth rate limit (RF-14),
// so ~12 logins alone take ~12 minutes.
const BATTERY_TIMEOUT_MS = 30 * 60_000;

// Test files are declared as tests (SONAR_TEST_INCLUSIONS) and kept out of the sources.
const SONAR_TEST_INCLUSIONS = '**/*.spec.ts,**/*.test.ts,**/*.spec.tsx,**/*.test.tsx,e2e/**';
const SONAR_EXCLUSIONS = `**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,run-report.json,batteries-report.json,audit*.jsonl,SPEC.md,AGENTS.md,.github/**,${SONAR_TEST_INCLUSIONS}`;
const SONAR_LCOV_REPORT_PATHS = COVERAGE_PROJECTS.map((d) => `${d}/coverage/lcov.info`).join(',');
const SONARCLOUD_CREATE_URL = 'https://sonarcloud.io/api/projects/create';
const SONARCLOUD_RENAME_BRANCH_URL = 'https://sonarcloud.io/api/project_branches/rename';
const WORKFLOWS_DIR = '.github/workflows';
const STATIC_ANALYSIS_WORKFLOW_PATH = `${WORKFLOWS_DIR}/static-analysis.yml`;
const SONAR_PROPERTIES_PATH = 'sonar-project.properties';

function sonarProjectKey(sonarOrg, workspaceName) {
  return `${sonarOrg}_run-${workspaceName}`;
}

function buildSonarProjectProperties({ sonarOrg, workspaceName }) {
  return [
    `sonar.organization=${sonarOrg}`,
    `sonar.projectKey=${sonarProjectKey(sonarOrg, workspaceName)}`,
    `sonar.projectName=run-${workspaceName}`,
    'sonar.sources=.',
    `sonar.exclusions=${SONAR_EXCLUSIONS}`,
    'sonar.tests=.',
    `sonar.test.inclusions=${SONAR_TEST_INCLUSIONS}`,
    `sonar.javascript.lcov.reportPaths=${SONAR_LCOV_REPORT_PATHS}`,
    '',
  ].join('\n');
}

// Creates the (public) SonarCloud project so the first workflow run has somewhere to report.
// HTTP 400 "key already exists" is success (republishing the same workspace); anything else throws.
// Then renames the project's main branch to `main` (SonarCloud defaults it to `master`): the pushed
// `main` would otherwise be analyzed as a non-main branch, whose measures a free org cannot read.
// Renaming to the current name is a no-op 204, so republishing stays idempotent.
async function createSonarProject({ sonarOrg, projectKey, projectName, sonarToken, fetchFn = globalThis.fetch }) {
  const headers = { Authorization: `Bearer ${sonarToken}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const res = await fetchFn(SONARCLOUD_CREATE_URL, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ organization: sonarOrg, project: projectKey, name: projectName, visibility: 'public' }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    if (!(res.status === 400 && /already exist/i.test(body))) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const rename = await fetchFn(SONARCLOUD_RENAME_BRANCH_URL, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ project: projectKey, name: 'main' }).toString(),
  });
  if (!rename.ok) throw new Error(`renaming the SonarCloud main branch failed: HTTP ${rename.status}: ${(await rename.text()).slice(0, 300)}`);
}

const GIT_COMMIT_IDENTITY = ['-c', 'user.name=pi-runner', '-c', 'user.email=pi-runner@users.noreply.github.com'];

// `--no-verify`: the workspace is model-writable, so its git hooks must never run in the runner.
async function commitAll(run, ws, message) {
  await run('git', [...GIT_COMMIT_IDENTITY, 'commit', '--no-verify', '-m', message], { cwd: ws });
}

// Publishes a finished, already-committed workspace as a public repo under
// `org`, guarded by the acceptance-bench assertion and the secret scan, and
// with runner-owned static analysis (Semgrep + SonarCloud) injected first.
// `run` is injectable so tests can stub `gh`/`git` without network or a real
// GitHub call; `benchDir` and `fetchFn` are injectable so tests don't depend
// on this checkout's real (gitignored) experiment/acceptance/ contents or
// the network. Mutates `report` in place (`repository`/`staticAnalysis` or
// `publishError`); never throws — callers decide exit status from
// `report.publishError`.
async function publishWorkspace({
  ws, report, modelId, config, org, secrets, sonarOrg, sonarToken, run = spawnCommand, benchDir, fetchFn = globalThis.fetch,
}) {
  try {
    await sanitizeWorkspaceGit(ws);
  } catch (err) {
    report.publishError = err instanceof Error ? err.message : String(err);
    return;
  }
  const gitRun = (cmd, args, opts = {}) => run(cmd, args, { ...opts, env: { ...opts.env, ...GIT_HOOKS_OFF_ENV } });
  const acceptancePath = await findAcceptancePathInWorkspace(ws, benchDir);
  if (acceptancePath) {
    report.publishError = `workspace contains a copy of the hidden acceptance bench: ${acceptancePath}`;
    return;
  }

  const secretHit = await scanWorkspaceForSecrets(ws, secrets);
  if (secretHit) {
    report.publishError = `secret detected in ${secretHit.file}`;
    return;
  }

  // Fail closed before touching the workspace: an unanalyzed public run is useless.
  if (!sonarToken) {
    report.publishError = 'SONAR_TOKEN is not set (environment or .env at the repository root); refusing to publish a run without static analysis';
    return;
  }

  const workspaceName = path.basename(ws);
  const repoName = `${org}/run-${workspaceName}`;
  const description = `${modelId} ${config} run generated by the PI-I harness`;
  const projectKey = sonarProjectKey(sonarOrg, workspaceName);
  try {
    const removedWorkflows = (await listTrackedFiles(ws)).filter((f) => f.startsWith(`${WORKFLOWS_DIR}/`));
    if (removedWorkflows.length > 0) {
      await gitRun('git', ['rm', '-q', '-f', '--', ...removedWorkflows], { cwd: ws });
      await commitAll(gitRun, ws, 'harness: remove model-authored workflows');
    }

    await writeOwnedFile(ws, STATIC_ANALYSIS_WORKFLOW_PATH, STATIC_ANALYSIS_WORKFLOW);
    await writeOwnedFile(ws, SONAR_PROPERTIES_PATH, buildSonarProjectProperties({ sonarOrg, workspaceName }));
    // -f: a model-written .gitignore must not be able to keep the injected files out of the push.
    await gitRun('git', ['add', '-f', '--', STATIC_ANALYSIS_WORKFLOW_PATH, SONAR_PROPERTIES_PATH], { cwd: ws });
    const pending = await gitRun('git', ['status', '--porcelain', '--', STATIC_ANALYSIS_WORKFLOW_PATH, SONAR_PROPERTIES_PATH], { cwd: ws });
    if ((pending?.stdout ?? '').trim()) await commitAll(gitRun, ws, 'harness: add static analysis workflow');

    // The injected files are published too, so they get the same secret scan.
    const injectedHit = await scanWorkspaceForSecrets(ws, secrets);
    if (injectedHit) {
      report.publishError = `secret detected in ${injectedHit.file}`;
      return;
    }

    try {
      await createSonarProject({ sonarOrg, projectKey, projectName: `run-${workspaceName}`, sonarToken, fetchFn });
    } catch (err) {
      report.publishError = `SonarCloud project creation failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    report.staticAnalysis = {
      sonarOrganization: sonarOrg,
      sonarProjectKey: projectKey,
      semgrepConfig: [...SEMGREP_CONFIGS],
      workflowSha256: createHash('sha256').update(STATIC_ANALYSIS_WORKFLOW).digest('hex'),
      removedWorkflows,
    };

    const result = await gitRun(
      'gh',
      ['repo', 'create', repoName, '--public', '--source', ws, '--push', '--description', description],
      {},
    );
    // `--push` makes gh relay git's output after the URL, so take the last URL line, not the last line.
    const url = (result?.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('https://')).pop()
      || `https://github.com/${repoName}`;
    report.repository = { name: repoName, url };

    // Commit the updated report (now carrying `repository`) and push again,
    // rather than writing the URL before the first commit, so the first
    // commit/push never depends on a repo name `gh repo create` hasn't
    // confirmed yet.
    await fs.writeFile(path.join(ws, 'run-report.json'), JSON.stringify(report, null, 2));
    await gitRun('git', ['add', 'run-report.json'], { cwd: ws });
    await gitRun(
      'git',
      ['-c', 'user.name=pi-runner', '-c', 'user.email=pi-runner@users.noreply.github.com', 'commit', '--no-verify', '-m', 'run: record repository metadata'],
      { cwd: ws },
    );
    await gitRun('git', ['push'], { cwd: ws });
  } catch (err) {
    report.publishError = err instanceof Error ? err.message : String(err);
  }
}

// Loads the run-report.json of an already generated workspace for --publish-only. Throws a
// usage-style error when it cannot (or must not) be published: no report, not a git repo, or a
// repository is already recorded (no double publish).
async function loadPublishableWorkspace(wsDir) {
  let report;
  try {
    report = JSON.parse(await fs.readFile(path.join(wsDir, 'run-report.json'), 'utf-8'));
  } catch (err) {
    throw new Error(`cannot read run-report.json in ${wsDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await spawnCommand('git', ['-C', wsDir, 'rev-parse', '--git-dir'], {});
  } catch {
    throw new Error(`${wsDir} is not a git repository`);
  }
  if (report.repository) {
    throw new Error(`${wsDir} is already published (${report.repository.url ?? report.repository.name}); refusing to publish twice`);
  }
  return report;
}

// --publish-only: runs the same publish flow on an existing workspace and rewrites its
// run-report.json (repository/staticAnalysis, or publishError). Returns the final report.
async function publishExistingWorkspace({ wsDir, org, sonarOrg, sonarToken, secrets, run, benchDir, fetchFn }) {
  const report = await loadPublishableWorkspace(wsDir);
  delete report.publishError;
  await publishWorkspace({
    ws: wsDir, report, modelId: report.model, config: report.config, org, secrets, sonarOrg, sonarToken, run, benchDir, fetchFn,
  });
  await fs.writeFile(path.join(wsDir, 'run-report.json'), JSON.stringify(report, null, 2));
  return report;
}

const UPDATE_ANALYSIS_COMMIT_MESSAGE = 'runner: update static analysis (coverage + quality criteria)';
const GITHUB_REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Loads the run-report.json of an already published workspace for --update-analysis. Throws a
// usage-style error when it cannot be updated: no report, no recorded repository (nothing to push
// to), or not a git repository.
async function loadUpdatableWorkspace(wsDir) {
  let report;
  try {
    report = JSON.parse(await fs.readFile(path.join(wsDir, 'run-report.json'), 'utf-8'));
  } catch (err) {
    throw new Error(`cannot read run-report.json in ${wsDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!report.repository?.name) {
    throw new Error(`${wsDir} is not published (run-report.json has no repository); publish it first with --publish-only`);
  }
  try {
    await spawnCommand('git', ['-C', wsDir, 'rev-parse', '--git-dir'], {});
  } catch {
    throw new Error(`${wsDir} is not a git repository`);
  }
  return report;
}

// --update-analysis: rewrites ONLY the two runner-owned static analysis files of an already
// published run (generated code is never touched), commits them and pushes to the recorded
// remote's main, with the same protections as publishWorkspace(): git hooks/config neutralized,
// no symlink following, and the secret scan before anything is committed or pushed. Never
// throws once the report is loaded: failures land in `report.updateError` (persisted).
async function updateStaticAnalysis({ wsDir, sonarOrg, sonarToken, secrets, run = spawnCommand, now = new Date() }) {
  const report = await loadUpdatableWorkspace(wsDir);
  delete report.updateError;
  const gitRun = (cmd, args, opts = {}) => run(cmd, args, { ...opts, env: { ...opts.env, ...GIT_HOOKS_OFF_ENV } });
  try {
    if (!sonarToken) {
      throw new Error('SONAR_TOKEN is not set (environment or .env at the repository root); refusing to update a run without static analysis');
    }
    if (!GITHUB_REPO_NAME.test(report.repository.name)) throw new Error(`unexpected repository name in run-report.json: ${report.repository.name}`);
    await sanitizeWorkspaceGit(wsDir);
    const secretHit = await scanWorkspaceForSecrets(wsDir, secrets);
    if (secretHit) throw new Error(`secret detected in ${secretHit.file}`);

    // Same project the run was published with: the recorded organization beats --sonar-org.
    const projectOrg = report.staticAnalysis?.sonarOrganization ?? sonarOrg;
    const owned = [STATIC_ANALYSIS_WORKFLOW_PATH, SONAR_PROPERTIES_PATH];
    await writeOwnedFile(wsDir, STATIC_ANALYSIS_WORKFLOW_PATH, STATIC_ANALYSIS_WORKFLOW);
    await writeOwnedFile(wsDir, SONAR_PROPERTIES_PATH, buildSonarProjectProperties({ sonarOrg: projectOrg, workspaceName: path.basename(wsDir) }));
    await gitRun('git', ['add', '-f', '--', ...owned], { cwd: wsDir });
    const pending = await gitRun('git', ['status', '--porcelain', '--', ...owned], { cwd: wsDir });
    if ((pending?.stdout ?? '').trim()) {
      const injectedHit = await scanWorkspaceForSecrets(wsDir, secrets);
      if (injectedHit) throw new Error(`secret detected in ${injectedHit.file}`);
      // `git commit` would also take other staged paths; the pathspec commits exactly the two files.
      await gitRun('git', [...GIT_COMMIT_IDENTITY, 'commit', '--no-verify', '-m', UPDATE_ANALYSIS_COMMIT_MESSAGE, '--', ...owned], { cwd: wsDir });
      // sanitizeWorkspaceGit() reset .git/config (planted remotes are gone), so point origin at the recorded repository again.
      await gitRun('git', ['remote', 'add', 'origin', `https://github.com/${report.repository.name}.git`], { cwd: wsDir });
      await gitRun('git', ['push', 'origin', 'HEAD:main'], { cwd: wsDir });
    }
    report.staticAnalysis = {
      ...report.staticAnalysis,
      workflowSha256: createHash('sha256').update(STATIC_ANALYSIS_WORKFLOW).digest('hex'),
      ...((pending?.stdout ?? '').trim() ? { updatedAt: now.toISOString() } : {}),
    };
  } catch (err) {
    report.updateError = err instanceof Error ? err.message : String(err);
  }
  await fs.writeFile(path.join(wsDir, 'run-report.json'), JSON.stringify(report, null, 2));
  return report;
}

// Env var names of every router route's own API key (routes may point at keys other than
// MODEL_API_KEY). Generated code and model-issued commands must never inherit them.
function routeApiKeyEnvNames(harnessExtras) {
  const routes = harnessExtras?.router?.routes;
  if (!routes) return [];
  return Object.values(routes).map((route) => route.apiKeyEnv).filter(Boolean);
}

// `opts.scrubEnv` strips secrets (see scrubEnv() in the harness, plus `opts.scrubNames`) from the
// inherited environment before the explicit `opts.env` is applied, so caller-passed variables
// (e.g. SEED_PASSWORD for the batteries) still reach the child. Use it for every spawn that runs
// generated code; git/gh spawns keep the full environment (gh may authenticate through it).
function spawnCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const inherited = opts.scrubEnv ? scrubEnv(process.env, opts.scrubNames) : process.env;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...inherited, ...opts.env },
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
      else {
        const err = new Error(`${cmd} ${args.join(' ')} exited ${code}. stderr: ${stderr.slice(0, 500)}`);
        err.stdout = stdout;
        reject(err);
      }
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

// Tears down a workspace's docker compose stack (`docker compose down -v`).
// Used both at the end of the battery phase below and at the end of a c2 run
// (see main()), since c2's default --verify-cmd starts the same kind of stack
// via `docker compose up -d --build`. `run` is injectable for tests. Never
// throws: returns an error message string on failure, or null, so callers can
// record it (e.g. report.teardownError) without masking the run's own result.
async function teardownDockerCompose(ws, run = spawnCommand) {
  try {
    await run('docker', ['compose', 'down', '-v'], { cwd: ws, timeoutMs: 120_000 });
    return null;
  } catch (err) {
    return `docker compose down failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Whether a run may have left a docker compose stack running that needs
// tearing down at the end: either the verify command itself invokes
// `docker compose` (c2's default --verify-cmd), or the workspace has its own
// compose file (SPEC.md requires one) regardless of what --verify-cmd says.
async function workspaceMayHaveDockerStack(ws, verifyCmd) {
  if (typeof verifyCmd === 'string' && /docker compose\b/.test(verifyCmd)) return true;
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    try {
      await fs.access(path.join(ws, name));
      return true;
    } catch { /* not present */ }
  }
  return false;
}

// run-all.mjs prints its report pretty-printed (multi-line), so the whole
// output is parsed first; the last line covers single-line output after logs.
function parseBatteryReport(stdout) {
  const trimmed = stdout.trim();
  for (const candidate of [trimmed, trimmed.split('\n').pop()]) {
    try {
      return JSON.parse(candidate);
    } catch { /* try the next candidate */ }
  }
  return { parseError: true, raw: stdout.slice(0, 5000) };
}

// Always runs run-all.mjs and writes batteries-report.json, even when the stack never came up:
// batteries 1-3 record their own connection failures and battery4 (coherence) is static. Without
// the report the aggregator would drop the run from the battery means, making a system that does
// not start look better than one that starts and fails checks. The stack outcome is returned
// separately as `stack` ({ up, healthy, error? }); `batteryError` is reserved for failures of
// run-all.mjs itself (or of the teardown). `run`, `fetchFn`, `sleep` and `acceptanceDir` are
// injectable for tests.
async function runBatteries(ws, keep, scrubNames = [], deps = {}) {
  const {
    run = spawnCommand,
    fetchFn = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    // The battery scripts live in experiment/acceptance/ (never copied into the workspace).
    acceptanceDir = path.resolve(__dirname, '..', 'acceptance'),
  } = deps;
  let batteryReport = null;
  let batteryError = null;
  const stack = { up: false, healthy: false };
  // SEED_PASSWORD matches the secret filter but is an operator-set seed value the app and batteries share.
  const seedEnv = process.env.SEED_PASSWORD ? { SEED_PASSWORD: process.env.SEED_PASSWORD } : {};
  try {
    try {
      await run('docker', ['compose', 'up', '-d', '--build'], { cwd: ws, timeoutMs: 600_000, scrubEnv: true, scrubNames, env: seedEnv });
      stack.up = true;
    } catch (err) {
      stack.error = err instanceof Error ? err.message : String(err);
    }

    // No point waiting for health when compose up already failed.
    if (stack.up) {
      for (let i = 0; i < 120; i++) {
        try {
          const res = await fetchFn('http://localhost:3000/health');
          if (res.ok) { stack.healthy = true; break; }
        } catch { /* ignore */ }
        await sleep(1000);
      }
      if (!stack.healthy) stack.error = 'Health check did not pass within 120s';
    }

    // Run against the workspace from the bench's own directory; WORKSPACE tells the
    // batteries which generated app to exercise. When this run's stack never
    // started, anything on the fixed ports belongs to another run, so the
    // runtime batteries target a closed port and fail instead of scoring it.
    const host = stack.up ? 'localhost' : '127.0.0.1';
    const [backendPort, frontendPort, dbPort] = stack.up ? [3000, 8080, 5432] : [9, 9, 9];
    try {
      const result = await run('node', ['run-all.mjs'], {
        cwd: acceptanceDir,
        scrubEnv: true,
        scrubNames,
        env: {
          ...seedEnv,
          BACKEND_URL: `http://${host}:${backendPort}`,
          FRONTEND_URL: `http://${host}:${frontendPort}`,
          DB_URL: `postgres://medapp:medapp@${host}:${dbPort}/medapp`,
          WORKSPACE: ws,
        },
        timeoutMs: BATTERY_TIMEOUT_MS,
      });
      batteryReport = parseBatteryReport(result.stdout);
    } catch (err) {
      // run-all.mjs exits 1 whenever a battery fails, after printing its
      // report: that is a battery result, not a phase error.
      if (typeof err?.stdout === 'string' && err.stdout.trim()) batteryReport = parseBatteryReport(err.stdout);
      if (!batteryReport || batteryReport.parseError) batteryError = err instanceof Error ? err.message : String(err);
    }
    if (batteryReport) {
      await fs.writeFile(path.join(ws, 'batteries-report.json'), JSON.stringify(batteryReport, null, 2));
    }
  } catch (err) {
    batteryError = err instanceof Error ? err.message : String(err);
  } finally {
    if (!keep) {
      const downErr = await teardownDockerCompose(ws, run);
      if (downErr && !batteryError) batteryError = downErr;
    }
  }
  return { batteryReport, batteryError, stack };
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
    mcpServers: config.mcpServers,
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
 * OpenAICompatibleModelAdapter (the 'default' route) with a
 * RoutingModelAdapter; without one, returns the plain adapter unchanged, so
 * output without --harness-config (or without a router section) is
 * unaffected. With `maxCostUsd`, the result is wrapped in a
 * BudgetedModelAdapter (cost ceiling; getUsage()/getRouting() still forwarded).
 */
async function createModel({ apiKey, modelId, harnessExtras, makeAdapter, sampling, provider, timeoutMs, maxRetries, reasoningLogFile, maxCostUsd = null }) {
  const model = await createBaseModel({ apiKey, modelId, harnessExtras, makeAdapter, sampling, provider, timeoutMs, maxRetries, reasoningLogFile });
  // Same wrapper for c1/c2/c3 and for plain or routed models; without a cap
  // the model is returned unchanged.
  return maxCostUsd == null ? model : new BudgetedModelAdapter(model, { maxCostUsd });
}

async function createBaseModel({ apiKey, modelId, harnessExtras, makeAdapter, sampling, provider, timeoutMs, maxRetries, reasoningLogFile }) {
  // Unset timeoutMs/maxRetries/reasoningLogFile are left out so the adapter keeps its own defaults.
  // reasoningLogFile is one shared file: every adapter appends to it, so routed runs log together.
  const timeoutCfg = {
    ...(timeoutMs != null ? { timeoutMs } : {}),
    ...(maxRetries != null ? { maxRetries } : {}),
    ...(reasoningLogFile != null ? { reasoningLogFile } : {}),
  };
  const defaultAdapter = new OpenAICompatibleModelAdapter({ apiKey, model: modelId, ...samplingToAdapterConfig(sampling), ...providerToAdapterConfig(provider), ...timeoutCfg });
  if (!harnessExtras?.router) return defaultAdapter;
  // Route adapters get the same sampling and provider routing as the default one: equal conditions across c1/c2/c3 is the point.
  const build = makeAdapter ?? ((cfg) => new OpenAICompatibleModelAdapter(cfg));
  return createRoutedModel(harnessExtras.router, defaultAdapter, {
    // Same for the timeout, except a route's own explicit timeoutMs wins.
    makeAdapter: (cfg) => build({ ...timeoutCfg, ...cfg, ...samplingToAdapterConfig(sampling), ...providerToAdapterConfig(provider) }),
  });
}

// Adapter config for the set sampling fields only; unset (null/undefined)
// fields are left out so the adapter omits them from the request body.
function samplingToAdapterConfig(sampling) {
  const cfg = {};
  if (sampling?.temperature != null) cfg.temperature = sampling.temperature;
  if (sampling?.topP != null) cfg.topP = sampling.topP;
  if (sampling?.seed != null) cfg.seed = sampling.seed;
  if (sampling?.maxTokens != null) cfg.maxTokens = sampling.maxTokens;
  return cfg;
}

// Adapter config for the provider routing; unset (null/undefined) leaves the
// key out so the adapter omits `provider` from the request body.
function providerToAdapterConfig(provider) {
  return provider ? { provider: { order: [...provider.order], allowFallbacks: provider.allowFallbacks } } : {};
}

// Commit and dirty flag of the harness checkout, for run reproducibility.
// Never throws: a missing git or a non-repo directory yields nulls.
async function readGitMetadata({ cwd = path.resolve(__dirname, '..', '..') } = {}) {
  let harnessGitSha = null;
  let harnessGitDirty = null;
  try {
    const { stdout } = await spawnCommand('git', ['rev-parse', 'HEAD'], { cwd });
    harnessGitSha = stdout.trim() || null;
  } catch { /* git missing or not a repository */ }
  try {
    const { stdout } = await spawnCommand('git', ['status', '--porcelain'], { cwd });
    harnessGitDirty = stdout.trim().length > 0;
  } catch { /* git missing or not a repository */ }
  return { harnessGitSha, harnessGitDirty };
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

/**
 * Sets `report.budget` ({ maxCostUsd, exhausted, costReported }) from the
 * run's model, and — when the cap actually refused a call — makes that the
 * run's failure: status FAILED and `failure` prefixed with `budget_exceeded`
 * (the downstream loop/graph failure text is kept in parentheses). `model` may
 * be null (run failed before one existed) or an uncapped plain model.
 */
function applyBudgetToReport(report, model, maxCostUsd) {
  const capped = model instanceof BudgetedModelAdapter;
  let costReported = null;
  if (model && typeof model.getUsage === 'function') {
    const { calls, cost } = model.getUsage();
    costReported = cost > 0 ? true : calls > 0 ? false : null;
  }
  report.budget = { maxCostUsd: maxCostUsd ?? null, exhausted: capped ? model.isExhausted() : false, costReported };
  if (capped && model.blockedCalls > 0) {
    const spent = model.getUsage().cost;
    const reason = `budget_exceeded: spent $${spent.toFixed(4)} of $${model.maxCostUsd.toFixed(4)} limit; ${model.blockedCalls} model call(s) refused`;
    report.status = 'FAILED';
    report.failure = report.failure ? `${reason} (${report.failure})` : reason;
  }
}

// Why a run ended, in one value. Order matters: a thrown exception wins, then a
// refused model call (the budget cap), then the shape of the final outcome.
const STOP_REASONS = [
  'finished',
  'budget_exceeded',
  'max_tool_rounds',
  'max_turns',
  'max_steps',
  'context_overflow',
  'repeated_tool_call',
  'empty_content',
  'provider_refused',
  'model_error',
  'runner_error',
];

/** Category of a model error code (a ModelResponse `error`), shared by c1/c2/c3. */
function stopReasonForModelError(code) {
  switch (code) {
    case 'budget_exceeded':
    case 'max_tool_rounds':
    case 'context_overflow':
    case 'repeated_tool_call':
    case 'empty_content':
      return code;
    case 'http_401':
    case 'http_402':
      return 'provider_refused';
    default:
      return 'model_error';
  }
}

/**
 * Pure derivation of `report.stopReason` from what the runner already has.
 * `runnerError`: truthy when the runner itself threw (or the harness config
 * failed). `budgetRefused`: the cost cap refused at least one model call.
 * Exactly one outcome applies: `finalResponse` (c1), `loopResult` (c2) or
 * `graphResult` (c3). A loop that used every turn is `max_turns`; a failure
 * caused by a model error that ended the loop early uses that error's
 * category; otherwise c3 ran out of steps/retries (`max_steps`).
 */
function deriveStopReason({ runnerError = null, budgetRefused = false, finalResponse = null, loopResult = null, graphResult = null } = {}) {
  if (runnerError) return 'runner_error';
  if (budgetRefused) return 'budget_exceeded';
  const fromResponse = (r) => (r?.type === 'error' ? stopReasonForModelError(r.code) : null);
  // Using every turn is the cause, even when the last turn also ended on an error (e.g. max_tool_rounds).
  const ranOutOfTurns = (loop) => /^max_turns \(/.test(loop?.failure ?? '');
  if (finalResponse) {
    if (finalResponse.type === 'finish') return 'finished';
    return fromResponse(finalResponse) ?? 'model_error';
  }
  if (loopResult) {
    if (loopResult.status === 'SUCCESS') return 'finished';
    if (ranOutOfTurns(loopResult)) return 'max_turns';
    return fromResponse(loopResult.finalResponse) ?? 'max_turns';
  }
  if (graphResult) {
    if (graphResult.status === 'SUCCESS') return 'finished';
    if (/^maxSteps \(/.test(graphResult.failure ?? graphResult.decision?.reason ?? '')) return 'max_steps';
    const last = graphResult.state?.nodeResults?.at(-1);
    if (last?.status === 'FAILED') return ranOutOfTurns(last) ? 'max_turns' : fromResponse(last.finalResponse) ?? 'max_turns';
    return 'max_steps';
  }
  return 'runner_error';
}

function buildHarness(ws, model, toolRounds, auditFile, harnessExtras) {
  const execution = new LocalExecutionManager({
    workspaceRoot: ws,
    timeoutMs: 600_000,
    envDenylist: routeApiKeyEnvNames(harnessExtras),
  });
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
      instructions: HARNESS_INSTRUCTIONS,
      maxToolRounds: toolRounds,
    },
  );
  // `tools`/`guardrails`/`availTools` are exposed alongside `harness` so
  // tests can inspect the wiring (registered tool names, allowlist) without
  // driving a full model run.
  return { harness, execution, verification, tools, guardrails, availTools };
}

// Deletes any review-verdict.json left from an earlier reviewer visit, so
// neither this visit's `test -f review-verdict.json` verification nor
// buildRouter() below can be satisfied by stale data when the reviewer loop
// fails to write a fresh one this time. `force: true` makes a first visit
// (no stale file yet) a no-op instead of throwing.
function clearStaleReviewVerdict(ws) {
  rmSync(path.join(ws, 'review-verdict.json'), { force: true });
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

// A build node is done when its verification passes: the loop then ends the
// node on that evidence (finishOnVerificationPass) instead of waiting for the
// model to declare it, so a model that keeps polishing cannot burn all its turns.
function doneInstructions(scope, command) {
  return (
    ` Work only in ${scope}. Your part is done when \`${command}\` passes; the harness then ends your work automatically.` +
    ' Do not review or polish other parts of the system: the reviewer node checks the whole system.'
  );
}

function buildSpecNodes(parsed) {
  const dataCommand =
    'test -d backend/src/database/migrations && ls backend/src/database/migrations | grep -q . && cd backend && npm run build';
  const backendCommand = 'cd backend && npm run build && npm test';
  const frontendCommand = 'cd frontend && npm run build';
  return [
    {
      id: 'architect',
      role: 'architect',
      task:
        'Write docs/architecture.md: entity model, endpoint-to-screen contract mapping, repo layout. Consult SPEC.md.' +
        doneInstructions('docs/', 'test -f docs/architecture.md'),
      verification: { command: 'test -f docs/architecture.md' },
      finishOnVerificationPass: true,
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'data',
      role: 'data',
      task:
        'Implement the data layer per SPEC: migrations + deterministic seed. Consult SPEC.md.' +
        doneInstructions('backend/src/database/ (migrations and seed) and the wiring that runs them on start', dataCommand),
      verification: { command: dataCommand },
      finishOnVerificationPass: true,
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'backend',
      role: 'backend',
      task:
        'Implement the NestJS backend per SPEC (endpoint catalog EP-01..EP-20). Consult SPEC.md.' +
        doneInstructions('backend/ (plus root files the backend needs)', backendCommand),
      verification: { command: backendCommand },
      finishOnVerificationPass: true,
      maxTurns: parsed.maxTurns,
      toolRoundsPerTurn: parsed.toolRounds,
    },
    {
      id: 'frontend',
      role: 'frontend',
      task:
        'Implement the React SPA per SPEC (SCR-01..SCR-08, testability contract). Consult SPEC.md.' +
        doneInstructions('frontend/', frontendCommand),
      verification: { command: frontendCommand },
      finishOnVerificationPass: true,
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

// Long text kept per C2 turn in run-report.json, so a failed run shows what the model was told.
const MAX_TRACE_TEXT_CHARS = 2000;

function clipHead(text) {
  return text.length <= MAX_TRACE_TEXT_CHARS ? text : text.slice(0, MAX_TRACE_TEXT_CHARS) + '…';
}

// Verification output ends with the error, so keep its tail.
function clipTail(text) {
  return text.length <= MAX_TRACE_TEXT_CHARS ? text : '…' + text.slice(-MAX_TRACE_TEXT_CHARS);
}

function compactTraceC2(loopResult) {
  return loopResult.trace.map((t) => ({
    turn: t.turn,
    phases: t.phases,
    decision: t.decision.action,
    responseType: t.response.type,
    ...(t.responseCode !== undefined ? { responseCode: t.responseCode } : {}),
    ...(t.responseMessage !== undefined ? { responseMessage: t.responseMessage } : {}),
    verificationPassed: t.verification?.passed,
    ...(typeof t.verification?.details === 'string' ? { verificationDetails: clipTail(t.verification.details) } : {}),
    ...(typeof t.feedback === 'string' ? { feedbackReceived: clipHead(t.feedback) } : {}),
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

// --publish-only scans for the same secrets as a --publish run: MODEL_* and route keys may live
// only in the root .env, and --harness-config (parsed, never connected) adds route keys and MCP
// server env values. Nothing is required: an unset key just has no value to look for.
async function loadPublishOnlySecrets({ envPath = DEFAULT_ENV_FILE, harnessConfigPath = null } = {}) {
  let harnessExtras = null;
  if (harnessConfigPath) {
    const raw = await fs.readFile(harnessConfigPath, 'utf-8');
    const config = parseHarnessConfig(raw, path.dirname(harnessConfigPath), harnessConfigPath);
    harnessExtras = { router: config.router, mcpServers: config.mcpServers };
  }
  await exportFromEnvFile([...ENV_FILE_KEYS, ...routeApiKeyEnvNames(harnessExtras)], envPath);
  return collectSecretValues({ apiKey: process.env.MODEL_API_KEY, harnessExtras });
}

async function mainPublishOnly(parsed) {
  try {
    await loadPublishableWorkspace(parsed.publishOnly);
  } catch (err) {
    console.error(`Usage: --publish-only ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!(await checkGhAuthenticated())) {
    console.error('Usage: --publish-only requires an authenticated gh CLI. Run `gh auth login` first.');
    process.exit(1);
  }
  const sonarToken = await loadSonarToken();
  const secrets = await loadPublishOnlySecrets({ harnessConfigPath: parsed.harnessConfig });
  const report = await publishExistingWorkspace({
    wsDir: parsed.publishOnly, org: parsed.publishOrg, sonarOrg: parsed.sonarOrg, sonarToken, secrets,
  });
  if (report.publishError) console.error(`Publish failed: ${report.publishError}`);
  else console.error(`Published ${report.repository.url}`);
  console.log(path.join(parsed.publishOnly, 'run-report.json'));
  if (report.publishError) process.exitCode = 1;
}

async function mainUpdateAnalysis(parsed) {
  try {
    await loadUpdatableWorkspace(parsed.updateAnalysis);
  } catch (err) {
    console.error(`Usage: --update-analysis ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!(await checkGhAuthenticated())) {
    console.error('Usage: --update-analysis requires an authenticated gh CLI. Run `gh auth login` first.');
    process.exit(1);
  }
  const sonarToken = await loadSonarToken();
  const secrets = await loadPublishOnlySecrets({ harnessConfigPath: parsed.harnessConfig });
  const report = await updateStaticAnalysis({ wsDir: parsed.updateAnalysis, sonarOrg: parsed.sonarOrg, sonarToken, secrets });
  if (report.updateError) console.error(`Update failed: ${report.updateError}`);
  else console.error(`Updated static analysis of ${report.repository.url ?? report.repository.name}`);
  console.log(path.join(parsed.updateAnalysis, 'run-report.json'));
  if (report.updateError) process.exitCode = 1;
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.publishOnly) return mainPublishOnly(parsed);
  if (parsed.updateAnalysis) return mainUpdateAnalysis(parsed);

  if (parsed.publish && !(await checkGhAuthenticated())) {
    console.error('Usage: --publish requires an authenticated gh CLI. Run `gh auth login` first.');
    process.exit(1);
  }
  // Optional for non-publish runs; publishWorkspace() fails closed when it is missing.
  const sonarToken = parsed.publish ? await loadSonarToken() : undefined;

  // Validated before createWorkspace() below so a bad --task-file never
  // leaves an orphan workspace directory on disk.
  let task = DEFAULT_TASK;
  if (parsed.taskFile) {
    let raw;
    try {
      raw = await fs.readFile(parsed.taskFile, 'utf-8');
    } catch (err) {
      console.error(`Usage: --task-file <path> must point to a readable file (${parsed.taskFile}): ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (raw.trim().length === 0) {
      console.error(`Usage: --task-file <path> must point to a file that is not empty or whitespace-only (got: ${parsed.taskFile})`);
      process.exit(1);
    }
    task = raw;
  }

  const taskIdentity = describeTask({
    source: parsed.taskFile ? 'task-file' : 'spec',
    filePath: parsed.taskFile ?? parsed.spec,
    text: task,
    specPath: parsed.spec,
  });

  const { apiKey, modelId } = await loadCredentials();
  const ws = await createWorkspace(parsed.runsDir, parsed.config, modelId, parsed.spec, { dryRun: parsed.dryRun });

  const gitMetadata = await readGitMetadata();
  const modelTimeoutMs = parsed.modelTimeoutSeconds * 1000;

  if (parsed.dryRun) {
    const plan = {
      workspace: ws,
      config: parsed.config,
      wiring: {
        model: modelId,
        maxTurns: parsed.maxTurns,
        maxSteps: parsed.maxSteps,
        toolRoundsPerTurn: parsed.toolRounds,
      },
      sampling: parsed.sampling,
      provider: parsed.provider,
      modelTimeoutMs,
      modelRetries: parsed.modelRetries,
      task: taskIdentity,
      budget: { maxCostUsd: parsed.maxCostUsd, exhausted: false, costReported: null },
      ...gitMetadata,
      batteryPhase: parsed.withBatteries,
      harnessConfig: parsed.harnessConfig ?? undefined,
    };
    if (parsed.config === 'c3') {
      plan.nodes = buildNodes(parsed, parsed.taskFile ? task : null).map((n) => ({
        id: n.id,
        role: n.role,
        task: n.task,
        verification: n.verification,
        finishOnVerificationPass: n.finishOnVerificationPass,
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
    sampling: parsed.sampling,
    provider: parsed.provider,
    modelTimeoutMs,
    modelRetries: parsed.modelRetries,
    task: taskIdentity,
    ...gitMetadata,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    status: 'FAILED',
    usage: null,
    budget: { maxCostUsd: parsed.maxCostUsd, exhausted: false, costReported: null },
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

  let runException = null;
  let runModel = null;
  // The one outcome object deriveStopReason() reads (set by the config's branch).
  let stopOutcome = {};
  if (!configFailure) try {
    if (parsed.config === 'c1') {
      const model = await createModel({ apiKey, modelId, harnessExtras, sampling: parsed.sampling, provider: parsed.provider, timeoutMs: modelTimeoutMs, maxRetries: parsed.modelRetries, reasoningLogFile: path.join(ws, 'reasoning.jsonl'), maxCostUsd: parsed.maxCostUsd });
      runModel = model;
      const { harness } = buildHarness(ws, model, parsed.toolRounds, path.join(ws, 'audit.jsonl'), harnessExtras);
      const result = await harness.run(task, { maxToolRounds: parsed.toolRounds });
      stopOutcome = { finalResponse: result.finalResponse };
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
      const model = await createModel({ apiKey, modelId, harnessExtras, sampling: parsed.sampling, provider: parsed.provider, timeoutMs: modelTimeoutMs, maxRetries: parsed.modelRetries, reasoningLogFile: path.join(ws, 'reasoning.jsonl'), maxCostUsd: parsed.maxCostUsd });
      runModel = model;
      const { harness, execution, verification } = buildHarness(ws, model, parsed.toolRounds, path.join(ws, 'audit.jsonl'), harnessExtras);
      const loop = new AgentLoop({ harness, execution, verification, workspaceRoot: ws });
      const loopResult = await loop.run({
        task,
        maxTurns: parsed.maxTurns,
        verification: { command: parsed.verifyCmd },
        toolRoundsPerTurn: parsed.toolRounds,
      });
      stopOutcome = { loopResult };
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
      const model = await createModel({ apiKey, modelId, harnessExtras, sampling: parsed.sampling, provider: parsed.provider, timeoutMs: modelTimeoutMs, maxRetries: parsed.modelRetries, reasoningLogFile: path.join(ws, 'reasoning.jsonl'), maxCostUsd: parsed.maxCostUsd });
      runModel = model;
      const factory = (node) => {
        if (node.id === 'reviewer') clearStaleReviewVerdict(ws);
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
      stopOutcome = { graphResult };
      report.status = graphResult.status;
      attachUsageAndRouting(report, model);
      report.steps = graphResult.steps;
      report.totalLoopTurns = graphResult.totalLoopTurns;
      report.decision = graphResult.decision;
      report.failure = graphResult.failure;
      report.trace = compactTraceC3(graphResult);
    }

    if (parsed.withBatteries) {
      const batteryInfo = await runBatteries(ws, parsed.keep, routeApiKeyEnvNames(harnessExtras));
      report.batteryPhase = {
        ran: true,
        stack: batteryInfo.stack,
        passed: !batteryInfo.batteryError && batteryInfo.stack.healthy && (batteryInfo.batteryReport?.passed ?? false),
        error: batteryInfo.batteryError || undefined,
      };
    }
  } catch (err) {
    // A throw anywhere above (createModel() rejecting on a router route with
    // an unset apiKeyEnv, or any harness/loop/graph exception) must never
    // skip run-report.json / initWorkspaceRepo() / --publish below: record it
    // like any other failure instead of letting it escape main().
    runException = err instanceof Error ? err.message : String(err);
    report.status = 'FAILED';
    report.failure = runException;
  } finally {
    // Tear down a c2 run's own docker compose stack (its default
    // --verify-cmd starts one) regardless of success/failure/exception, so
    // the next run doesn't hit port conflicts on the fixed ports. Skipped
    // when --with-batteries --keep was requested: the battery phase already
    // left the stack up on purpose and this must not undo that.
    if (parsed.config === 'c2' && !(parsed.withBatteries && parsed.keep)) {
      if (await workspaceMayHaveDockerStack(ws, parsed.verifyCmd)) {
        const teardownErr = await teardownDockerCompose(ws);
        if (teardownErr) report.teardownError = teardownErr;
      }
    }
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

  // Also reached after a thrown exception or config failure (runModel may be
  // null), so budget is present in every report.
  applyBudgetToReport(report, runModel, parsed.maxCostUsd);
  report.stopReason = deriveStopReason({
    runnerError: configFailure || runException,
    budgetRefused: runModel instanceof BudgetedModelAdapter && runModel.blockedCalls > 0,
    ...stopOutcome,
  });
  if (report.budget.maxCostUsd != null && report.budget.costReported === false) {
    report.budget.warning = 'The provider reported no cost (usage.cost), so --max-cost cannot be enforced';
    console.error(`Warning: ${report.budget.warning}.`);
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
      await publishWorkspace({
        ws, report, modelId, config: parsed.config, org: parsed.publishOrg, secrets, sonarOrg: parsed.sonarOrg, sonarToken,
      });
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
  console.error(`  Stopped:    ${report.stopReason}`);
  console.error(`  Duration:   ${report.durationMs}ms`);
  if (report.turns != null) console.error(`  Turns:      ${report.turns}`);
  if (report.steps != null) console.error(`  Steps:      ${report.steps}`);
  if (report.totalLoopTurns != null) console.error(`  Loop turns: ${report.totalLoopTurns}`);
  if (report.usage) console.error(`  Usage:      ${report.usage.totalTokens} tokens (${report.usage.calls} calls)`);
  if (report.budget.maxCostUsd != null) {
    console.error(`  Budget:     $${report.budget.maxCostUsd} cap${report.budget.exhausted ? ' (EXHAUSTED)' : ''}`);
  }
  if (parsed.withBatteries) {
    const bp = report.batteryPhase;
    const bpReason = bp.error ?? (bp.stack?.error ? `stack: ${bp.stack.error}` : null);
    console.error(`  Batteries:  ${bp.passed ? 'passed' : bpReason ? `failed (${bpReason})` : 'failed'}`);
  }
  console.log(reportPath);

  if (configFailure || runException || report.publishError) process.exitCode = 1;
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
  DEFAULT_TASK,
  describeTask,
  HARNESS_INSTRUCTIONS,
  parseBatteryReport,
  parseArgs,
  loadCredentials,
  loadSonarToken,
  loadHarnessExtras,
  buildHarness,
  buildNodes,
  buildRouter,
  createWorkspace,
  createModel,
  readGitMetadata,
  summarizeRouting,
  attachUsageAndRouting,
  applyBudgetToReport,
  deriveStopReason,
  STOP_REASONS,
  DEFAULT_MAX_COST_USD,
  compactTraceC2,
  BATTERY_TIMEOUT_MS,
  MAX_TRACE_TEXT_CHARS,
  compactTraceC3,
  slugifyModelId,
  timestampForWorkspace,
  initWorkspaceRepo,
  ensureRunGitignore,
  listTrackedFiles,
  findAcceptancePathInWorkspace,
  collectSecretValues,
  loadPublishOnlySecrets,
  scanWorkspaceForSecrets,
  checkGhAuthenticated,
  publishWorkspace,
  publishExistingWorkspace,
  loadPublishableWorkspace,
  loadUpdatableWorkspace,
  updateStaticAnalysis,
  createSonarProject,
  buildSonarProjectProperties,
  STATIC_ANALYSIS_WORKFLOW,
  SONAR_EXCLUSIONS,
  SEMGREP_CONFIGS,
  teardownDockerCompose,
  runBatteries,
  routeApiKeyEnvNames,
  spawnCommand,
  workspaceMayHaveDockerStack,
  clearStaleReviewVerdict,
  main,
};

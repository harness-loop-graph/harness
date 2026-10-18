#!/usr/bin/env node
// Collects the static-analysis results (SonarCloud measures + Semgrep code-scanning
// alerts) of published runs into <workspace>/static-analysis.json. Results arrive
// asynchronously after publishing, so `pending` is a normal state; re-run later.
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_RUNS_DIR } from './aggregate-runs.mjs';

const SONAR_MEASURES_URL = 'https://sonarcloud.io/api/measures/component';
const SONAR_METRICS = [
  'ncloc', 'bugs', 'vulnerabilities', 'code_smells', 'security_hotspots', 'duplicated_lines_density',
  'cognitive_complexity', 'sqale_index', 'reliability_rating', 'security_rating', 'sqale_rating',
];
const SEMGREP_PENDING_PATTERN = /no analysis found|\b404\b|not found/i;

const errMessage = (err) => (err instanceof Error ? err.message : String(err));

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { runsDir: DEFAULT_RUNS_DIR, force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') parsed.force = true;
    else if (args[i] === '--runs-dir') {
      const value = args[++i];
      if (value === undefined) throw new Error('Usage: --runs-dir <value> requires a value');
      parsed.runsDir = path.resolve(value);
    } else throw new Error(`Usage: unknown argument ${args[i]} (expected --runs-dir, --force)`);
  }
  return parsed;
}

function spawnCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${cmd} ${args.join(' ')} exited ${code}. stderr: ${stderr.slice(0, 500)}`);
        err.stdout = stdout;
        reject(err);
      }
    });
  });
}

async function collectSonar({ projectKey, fetchFn, env }) {
  const result = { status: 'pending', projectKey, measures: {} };
  try {
    const url = `${SONAR_MEASURES_URL}?component=${encodeURIComponent(projectKey)}&metricKeys=${SONAR_METRICS.join(',')}`;
    const headers = { Accept: 'application/json' };
    if (env.SONAR_TOKEN) headers.Authorization = `Bearer ${env.SONAR_TOKEN}`;
    const res = await fetchFn(url, { headers });
    if (res.status === 404) return result;
    if (!res.ok) return { ...result, status: 'error', error: `SonarCloud HTTP ${res.status}` };
    const body = await res.json();
    const measures = Array.isArray(body?.component?.measures) ? body.component.measures : [];
    for (const m of measures) {
      const value = Number(m?.value);
      if (typeof m?.metric === 'string' && m.value !== undefined && m.value !== '' && Number.isFinite(value)) result.measures[m.metric] = value;
    }
    if (Object.keys(result.measures).length > 0) result.status = 'complete';
    return result;
  } catch (err) {
    return { ...result, status: 'error', error: errMessage(err) };
  }
}

// `gh api --paginate` prints each page's JSON array back to back (`[..][..]`), which is
// not one valid JSON document, so split top-level values by bracket depth.
function parseConcatenatedJsonArrays(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const whole = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    // fall through to the page-splitting scan
  }
  const items = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        const value = JSON.parse(trimmed.slice(start, i + 1));
        if (Array.isArray(value)) items.push(...value);
        else items.push(value);
      }
    }
  }
  return items;
}

const bump = (counts, key) => {
  if (typeof key === 'string' && key) counts[key] = (counts[key] ?? 0) + 1;
};

const isSemgrep = (item) => String(item?.tool?.name ?? '').toLowerCase().startsWith('semgrep');

async function collectSemgrep({ repoName, run }) {
  try {
    // No uploaded Semgrep analysis yet means no result, not zero findings.
    const { stdout: analysesOut } = await run('gh', ['api', '--paginate', `repos/${repoName}/code-scanning/analyses?per_page=100`], {});
    if (!parseConcatenatedJsonArrays(analysesOut).some(isSemgrep)) return { status: 'pending' };

    const { stdout } = await run('gh', ['api', '--paginate', `repos/${repoName}/code-scanning/alerts?state=open&per_page=100`], {});
    const alerts = parseConcatenatedJsonArrays(stdout).filter(isSemgrep);
    const bySeverity = {};
    const bySecuritySeverity = {};
    for (const a of alerts) {
      bump(bySeverity, a.rule?.severity);
      bump(bySecuritySeverity, a.rule?.security_severity_level);
    }
    return { status: 'complete', openAlerts: alerts.length, bySeverity, bySecuritySeverity };
  } catch (err) {
    const message = errMessage(err);
    return { status: SEMGREP_PENDING_PATTERN.test(message) ? 'pending' : 'error', ...(SEMGREP_PENDING_PATTERN.test(message) ? {} : { error: message }) };
  }
}

function overallStatus(sonar, semgrep) {
  if (sonar.status === 'error' || semgrep.status === 'error') return 'error';
  return sonar.status === 'complete' && semgrep.status === 'complete' ? 'complete' : 'pending';
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return null;
  }
}

// Collects one published run. Never throws: failures land in the returned/written status.
async function collectRun({ workspace, dir, report, force = false, fetchFn, run, env, now }) {
  const outFile = path.join(dir, 'static-analysis.json');
  if (!force && (await readJsonOrNull(outFile))?.status === 'complete') return { workspace, status: 'complete', skipped: true };
  const [sonar, semgrep] = await Promise.all([
    collectSonar({ projectKey: report.staticAnalysis.sonarProjectKey, fetchFn, env }),
    collectSemgrep({ repoName: report.repository.name, run }),
  ]);
  const status = overallStatus(sonar, semgrep);
  const out = { collectedAt: now().toISOString(), status, sonar, semgrep };
  try {
    await fs.writeFile(outFile, JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    return { workspace, status: 'error', sonar: sonar.status, semgrep: semgrep.status, error: `cannot write static-analysis.json: ${errMessage(err)}` };
  }
  return { workspace, status, sonar: sonar.status, semgrep: semgrep.status };
}

async function collectAll({ runsDir, force = false, fetchFn = globalThis.fetch, run = spawnCommand, env = process.env, now = () => new Date() }) {
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const results = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    const report = await readJsonOrNull(path.join(dir, 'run-report.json'));
    if (!report?.repository?.name || !report.staticAnalysis?.sonarProjectKey) continue;
    results.push(await collectRun({ workspace: entry.name, dir, report, force, fetchFn, run, env, now }));
  }
  return results;
}

const describe = (r) => (r.skipped
  ? `${r.workspace}: complete (skipped, already collected)`
  : `${r.workspace}: ${r.status} (sonar=${r.sonar}, semgrep=${r.semgrep})${r.error ? ` ${r.error}` : ''}`);

// Returns the process exit code: 1 only when every published run errored.
async function main(argv = process.argv, { fetchFn, run, env, now, log = console.log, logError = console.error } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    logError(errMessage(err));
    return 1;
  }
  let results;
  try {
    results = await collectAll({ runsDir: parsed.runsDir, force: parsed.force, fetchFn, run, env, now });
  } catch (err) {
    logError(`Cannot read runs dir ${parsed.runsDir}: ${errMessage(err)}`);
    return 1;
  }
  for (const r of results) log(describe(r));
  return results.length > 0 && results.every((r) => r.status === 'error') ? 1 : 0;
}

const isEntryPoint = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isEntryPoint) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(1);
  });
}

export { SONAR_METRICS, parseArgs, parseConcatenatedJsonArrays, collectSonar, collectSemgrep, collectRun, collectAll, main };

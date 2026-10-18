#!/usr/bin/env node
// Aggregates the run workspaces produced by run-experiment.mjs into CSV/Markdown
// tables. Only clean SPEC runs are included; everything else is listed as
// excluded with an explicit reason.
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Must stay equal to run-experiment.mjs's default `--runs-dir` (a test checks it).
const DEFAULT_RUNS_DIR = path.resolve(__dirname, '..', '..', '..', 'pi-runs');
const BATTERY_NAMES = ['battery1-e2e', 'battery2-schema', 'battery3-abuse', 'battery4-coherence'];
const STAT_METRICS = ['cost', 'totalTokens', 'durationMs'];
// Row key, CSV name, Markdown label and reader per metric. Sonar measures come from
// sonar.measures, Semgrep from semgrep.openAlerts; both only count when the file is `complete`.
const STATIC_METRICS = [
  { key: 'sonarNcloc', csv: 'sonar_ncloc', label: 'sonar ncloc', read: (a) => a.sonar?.measures?.ncloc },
  { key: 'sonarBugs', csv: 'sonar_bugs', label: 'sonar bugs', read: (a) => a.sonar?.measures?.bugs },
  { key: 'sonarVulnerabilities', csv: 'sonar_vulnerabilities', label: 'sonar vulns', read: (a) => a.sonar?.measures?.vulnerabilities },
  { key: 'sonarCodeSmells', csv: 'sonar_code_smells', label: 'sonar smells', read: (a) => a.sonar?.measures?.code_smells },
  { key: 'sonarDuplicatedLinesDensity', csv: 'sonar_duplicated_lines_density', label: 'sonar dup %', read: (a) => a.sonar?.measures?.duplicated_lines_density },
  { key: 'sonarCognitiveComplexity', csv: 'sonar_cognitive_complexity', label: 'sonar cognitive', read: (a) => a.sonar?.measures?.cognitive_complexity },
  { key: 'sonarSqaleIndex', csv: 'sonar_sqale_index', label: 'sonar debt min', read: (a) => a.sonar?.measures?.sqale_index },
  { key: 'semgrepOpenAlerts', csv: 'semgrep_open_alerts', label: 'semgrep alerts', read: (a) => a.semgrep?.openAlerts },
];

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { runsDir: DEFAULT_RUNS_DIR, harnessSha: null, model: null, out: null };
  const flags = { '--runs-dir': 'runsDir', '--harness-sha': 'harnessSha', '--model': 'model', '--out': 'out' };
  for (let i = 0; i < args.length; i++) {
    const key = flags[args[i]];
    if (!key) throw new Error(`Usage: unknown argument ${args[i]} (expected --runs-dir, --harness-sha, --model, --out)`);
    const value = args[++i];
    if (value === undefined) throw new Error(`Usage: ${args[i - 1]} <value> requires a value`);
    parsed[key] = key === 'runsDir' || key === 'out' ? path.resolve(value) : value;
  }
  return parsed;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

// Loads every immediate subdirectory holding a run-report.json. Directories
// without one are skipped silently; unreadable/malformed reports come back in
// `excluded` instead of throwing.
async function loadRuns(runsDir) {
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const runs = [];
  const excluded = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    const reportPath = path.join(dir, 'run-report.json');
    try {
      await fs.access(reportPath);
    } catch {
      continue;
    }
    let report;
    try {
      report = await readJson(reportPath);
      if (report === null || typeof report !== 'object' || Array.isArray(report)) throw new Error('not a JSON object');
    } catch (err) {
      excluded.push({ workspace: entry.name, reason: `malformed run-report.json (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    let batteries = null;
    try {
      batteries = await readJson(path.join(dir, 'batteries-report.json'));
    } catch {
      batteries = null; // missing or malformed: battery cells stay empty
    }
    let staticAnalysis = null;
    try {
      staticAnalysis = await readJson(path.join(dir, 'static-analysis.json'));
    } catch {
      staticAnalysis = null; // missing or malformed: static-analysis cells stay empty
    }
    runs.push({ workspace: entry.name, report, batteries, staticAnalysis });
  }
  return { runs, excluded };
}

// Returns the exclusion reason for a run, or null when it is included.
function exclusionReason(report, { harnessSha = null, model = null } = {}) {
  if (!report.task || typeof report.task !== 'object') return 'no task identity (legacy run)';
  if (report.task.source === 'task-file') return 'task-file run';
  if (report.task.source !== 'spec') return `unknown task source (${JSON.stringify(report.task.source)})`;
  if (typeof report.task.specSha256 !== 'string') return 'no SPEC hash (legacy run)';
  if (report.harnessGitDirty === true) return 'dirty harness tree';
  if (report.harnessGitDirty !== false) return 'harness tree state unknown (harnessGitDirty not recorded)';
  if (harnessSha && !(typeof report.harnessGitSha === 'string' && report.harnessGitSha.toLowerCase().startsWith(harnessSha.toLowerCase()))) {
    return 'harness sha mismatch';
  }
  if (model && report.model !== model) return 'model mismatch';
  return null;
}

function batteryCells(batteriesReport) {
  const cells = Object.fromEntries(BATTERY_NAMES.map((name) => [name, { passed: null, total: null }]));
  if (!batteriesReport || batteriesReport.parseError || !Array.isArray(batteriesReport.batteries)) return { cells, overall: null };
  for (const b of batteriesReport.batteries) {
    if (!BATTERY_NAMES.includes(b?.battery) || !Array.isArray(b.checks)) continue;
    cells[b.battery] = { passed: b.checks.filter((c) => c.passed === true).length, total: b.checks.length };
  }
  return { cells, overall: typeof batteriesReport.passed === 'boolean' ? batteriesReport.passed : null };
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function buildRow({ workspace, report, batteries, staticAnalysis = null }) {
  const { cells, overall } = batteryCells(batteries);
  const staticDone = staticAnalysis && typeof staticAnalysis === 'object' && staticAnalysis.status === 'complete' ? staticAnalysis : null;
  return {
    workspace,
    config: report.config ?? null,
    model: report.model ?? null,
    harnessGitSha: typeof report.harnessGitSha === 'string' ? report.harnessGitSha.slice(0, 7) : null,
    specSha256: typeof report.task?.specSha256 === 'string' ? report.task.specSha256.slice(0, 12) : null,
    status: report.status ?? null,
    durationMs: numOrNull(report.durationMs),
    calls: numOrNull(report.usage?.calls),
    retries: numOrNull(report.usage?.retries),
    totalTokens: numOrNull(report.usage?.totalTokens),
    cost: numOrNull(report.usage?.cost),
    budgetExhausted: typeof report.budget?.exhausted === 'boolean' ? report.budget.exhausted : null,
    batteries: cells,
    batteriesPassed: overall,
    publishUrl: report.repository?.url ?? null,
    ...Object.fromEntries(STATIC_METRICS.map((m) => [m.key, staticDone ? numOrNull(m.read(staticDone)) : null])),
  };
}

function meanAndStdDev(values) {
  const xs = values.filter((v) => v !== null && v !== undefined);
  if (xs.length === 0) return { n: 0, mean: null, stdDev: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length < 2) return { n: xs.length, mean, stdDev: null };
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { n: xs.length, mean, stdDev: Math.sqrt(variance) };
}

function summarizeByConfig(rows) {
  const configs = [...new Set(rows.map((r) => r.config))].sort();
  return configs.map((config) => {
    const group = rows.filter((r) => r.config === config);
    const batteries = {};
    for (const name of BATTERY_NAMES) {
      const ratios = group
        .map((r) => r.batteries[name])
        .filter((c) => c.total !== null && c.total > 0)
        .map((c) => c.passed / c.total);
      // n can be below the config's n when some runs have no battery data.
      batteries[name] = { meanPassRatio: ratios.length ? meanAndStdDev(ratios).mean : null, n: ratios.length };
    }
    const summary = {
      config,
      n: group.length,
      generationSuccess: group.filter((r) => r.status === 'SUCCESS').length,
      batteriesPassed: group.filter((r) => r.batteriesPassed === true).length,
      batteries,
    };
    for (const metric of [...STAT_METRICS, ...STATIC_METRICS.map((m) => m.key)]) summary[metric] = meanAndStdDev(group.map((r) => r[metric]));
    return summary;
  });
}

async function aggregate({ runsDir, harnessSha = null, model = null }) {
  const { runs, excluded } = await loadRuns(runsDir);
  const rows = [];
  for (const run of runs) {
    const reason = exclusionReason(run.report, { harnessSha, model });
    if (reason) excluded.push({ workspace: run.workspace, reason });
    else rows.push(buildRow(run));
  }
  excluded.sort((a, b) => (a.workspace < b.workspace ? -1 : a.workspace > b.workspace ? 1 : 0));
  return { rows, excluded, summary: summarizeByConfig(rows) };
}

// RFC 4180: quote fields containing a comma, double quote or line break.
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, records) {
  return [header, ...records].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function runsToCsv(rows) {
  const header = [
    'workspace', 'config', 'model', 'harnessGitSha', 'status', 'durationMs', 'calls', 'retries', 'totalTokens', 'cost', 'budgetExhausted',
    ...BATTERY_NAMES.flatMap((b) => [`${b}_passed`, `${b}_total`]),
    'batteriesPassed', 'publishUrl',
    ...STATIC_METRICS.map((m) => m.csv),
  ];
  return toCsv(header, rows.map((r) => [
    r.workspace, r.config, r.model, r.harnessGitSha, r.status, r.durationMs, r.calls, r.retries, r.totalTokens, r.cost, r.budgetExhausted,
    ...BATTERY_NAMES.flatMap((b) => [r.batteries[b].passed, r.batteries[b].total]),
    r.batteriesPassed, r.publishUrl,
    ...STATIC_METRICS.map((m) => r[m.key]),
  ]));
}

function summaryToCsv(summary) {
  const header = [
    'config', 'n', 'generationSuccess', 'batteriesPassed',
    ...BATTERY_NAMES.flatMap((b) => [`${b}_meanPassRatio`, `${b}_n`]),
    ...STAT_METRICS.flatMap((m) => [`${m}_mean`, `${m}_stddev`]),
    ...STATIC_METRICS.flatMap((m) => [`${m.csv}_mean`, `${m.csv}_stddev`, `${m.csv}_n`]),
  ];
  return toCsv(header, summary.map((s) => [
    s.config, s.n, s.generationSuccess, s.batteriesPassed,
    ...BATTERY_NAMES.flatMap((b) => [s.batteries[b].meanPassRatio, s.batteries[b].n]),
    ...STAT_METRICS.flatMap((m) => [s[m].mean, s[m].stdDev]),
    ...STATIC_METRICS.flatMap((m) => [s[m.key].mean, s[m.key].stdDev, s[m.key].n]),
  ]));
}

const fmt = (v, digits = 4) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(Number(v.toFixed(digits))) : String(v));
const mdCell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const mdTable = (header, records) => [
  `| ${header.join(' | ')} |`,
  `|${header.map(() => '---').join('|')}|`,
  ...records.map((r) => `| ${r.map((c) => mdCell(c)).join(' | ')} |`),
].join('\n');

// Included runs are only comparable when they share one SPEC and one harness
// version; mixing them is reported rather than silently averaged.
function comparabilityWarnings(rows) {
  const warnings = [];
  const specs = new Set(rows.map((r) => r.specSha256));
  const shas = new Set(rows.map((r) => r.harnessGitSha));
  if (specs.size > 1) warnings.push(`Included runs use ${specs.size} different SPEC versions: ${[...specs].join(', ')}`);
  if (shas.size > 1) warnings.push(`Included runs use ${shas.size} different harness versions: ${[...shas].join(', ')}`);
  return warnings;
}

function renderMarkdown({ rows, excluded, summary }) {
  const warnings = comparabilityWarnings(rows);
  const summaryTable = mdTable(
    ['config', 'n', 'generation ok', 'batteries ok', ...BATTERY_NAMES.map((b) => `${b} mean ratio`),
      'cost mean', 'cost sd', 'tokens mean', 'tokens sd', 'duration ms mean', 'duration ms sd',
      ...STATIC_METRICS.map((m) => `${m.label} mean`)],
    summary.map((s) => [
      s.config, s.n, s.generationSuccess, s.batteriesPassed,
      ...BATTERY_NAMES.map((b) => (s.batteries[b].n ? `${fmt(s.batteries[b].meanPassRatio)} (n=${s.batteries[b].n})` : '')),
      fmt(s.cost.mean), fmt(s.cost.stdDev), fmt(s.totalTokens.mean, 1), fmt(s.totalTokens.stdDev, 1),
      fmt(s.durationMs.mean, 0), fmt(s.durationMs.stdDev, 0),
      ...STATIC_METRICS.map((m) => (s[m.key].n ? `${fmt(s[m.key].mean)} (n=${s[m.key].n})` : '')),
    ]),
  );
  const runsTable = mdTable(
    ['workspace', 'config', 'model', 'sha', 'status', 'duration ms', 'calls', 'retries', 'tokens', 'cost', 'budget exhausted',
      ...BATTERY_NAMES, 'batteries ok', 'publish', ...STATIC_METRICS.map((m) => m.label)],
    rows.map((r) => [
      r.workspace, r.config, r.model, r.harnessGitSha, r.status, r.durationMs, r.calls, r.retries, r.totalTokens, fmt(r.cost), r.budgetExhausted,
      ...BATTERY_NAMES.map((b) => (r.batteries[b].total === null ? '' : `${r.batteries[b].passed}/${r.batteries[b].total}`)),
      r.batteriesPassed, r.publishUrl,
      ...STATIC_METRICS.map((m) => r[m.key]),
    ]),
  );
  const excludedTable = mdTable(['workspace', 'reason'], excluded.map((e) => [e.workspace, e.reason]));
  return [
    '# Experiment runs summary', '',
    `Included: ${rows.length} — Excluded: ${excluded.length}`, '',
    ...(warnings.length ? ['## Warnings', '', ...warnings.map((w) => `- ${w}`), ''] : []),
    '## Summary per config', '', summaryTable, '',
    '## Included runs', '', runsTable, '',
    '## Excluded runs', '', excludedTable, '',
  ].join('\n');
}

async function main(argv = process.argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const outDir = parsed.out ?? path.join(parsed.runsDir, '_aggregate');
  let result;
  try {
    result = await aggregate({ runsDir: parsed.runsDir, harnessSha: parsed.harnessSha, model: parsed.model });
  } catch (err) {
    console.error(`Cannot read runs dir ${parsed.runsDir}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const markdown = renderMarkdown(result);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'runs.csv'), runsToCsv(result.rows));
  await fs.writeFile(path.join(outDir, 'summary.csv'), summaryToCsv(result.summary));
  await fs.writeFile(path.join(outDir, 'summary.md'), markdown);
  console.log(markdown);
}

const isEntryPoint = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export {
  DEFAULT_RUNS_DIR,
  BATTERY_NAMES,
  STATIC_METRICS,
  parseArgs,
  loadRuns,
  exclusionReason,
  buildRow,
  meanAndStdDev,
  summarizeByConfig,
  aggregate,
  csvEscape,
  runsToCsv,
  summaryToCsv,
  comparabilityWarnings,
  renderMarkdown,
  main,
};

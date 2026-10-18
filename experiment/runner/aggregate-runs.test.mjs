// Tests for aggregate-runs.mjs: filtering/exclusion reasons, battery cells,
// per-config statistics, CSV quoting and the CLI. Fixtures live in temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as agg from './aggregate-runs.mjs';
import { parseArgs } from './run-experiment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHA_A = 'aaaaaaa1111111111111111111111111111111aa';
const SHA_B = 'bbbbbbb2222222222222222222222222222222bb';
const BATTERIES = ['battery1-e2e', 'battery2-schema', 'battery3-abuse', 'battery4-coherence'];

function reportFixture(overrides = {}) {
  return {
    config: 'c1',
    model: 'm/model-x',
    harnessGitSha: SHA_A,
    harnessGitDirty: false,
    status: 'SUCCESS',
    durationMs: 1000,
    usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, calls: 5, retries: 1, cost: 1 },
    budget: { maxCostUsd: 5, exhausted: false, costReported: true },
    task: { source: 'spec', path: 'experiment/SPEC.md', sha256: 'f'.repeat(64), specSha256: 'e'.repeat(64) },
    ...overrides,
  };
}

function batteryFixture(counts, passed = false) {
  // counts: { 'battery1-e2e': [passed, total], ... }
  return {
    timestamp: '2026-01-01T00:00:00Z',
    passed,
    batteries: Object.entries(counts).map(([battery, [p, t]]) => ({
      battery,
      passed: p === t,
      checks: Array.from({ length: t }, (_, i) => ({ name: `c${i}`, passed: i < p, details: '' })),
      summary: { total: t, passed: p, failed: t - p },
    })),
  };
}

async function withRunsDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-runs-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function addRun(runsDir, name, { report, batteries, rawReport, rawBatteries } = {}) {
  const dir = path.join(runsDir, name);
  await fs.mkdir(dir, { recursive: true });
  if (rawReport !== undefined) await fs.writeFile(path.join(dir, 'run-report.json'), rawReport);
  else if (report) await fs.writeFile(path.join(dir, 'run-report.json'), JSON.stringify(report));
  if (rawBatteries !== undefined) await fs.writeFile(path.join(dir, 'batteries-report.json'), rawBatteries);
  else if (batteries) await fs.writeFile(path.join(dir, 'batteries-report.json'), JSON.stringify(batteries));
}

const excludedReason = (result, name) => result.excluded.find((e) => e.workspace === name)?.reason;

test('default runs-dir matches the runner default', () => {
  assert.equal(agg.DEFAULT_RUNS_DIR, parseArgs(['node', 'run-experiment.mjs', '--config', 'c1']).runsDir);
});

test('includes a clean spec run with its battery cells and publish URL', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'run-1', {
      report: reportFixture({ repository: { name: 'r', url: 'https://github.com/o/r' } }),
      batteries: batteryFixture({ 'battery1-e2e': [3, 4], 'battery2-schema': [2, 2], 'battery3-abuse': [0, 5], 'battery4-coherence': [1, 1] }, false),
    });
    const result = await agg.aggregate({ runsDir });
    assert.equal(result.excluded.length, 0);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.equal(row.workspace, 'run-1');
    assert.equal(row.config, 'c1');
    assert.equal(row.model, 'm/model-x');
    assert.equal(row.harnessGitSha, 'aaaaaaa');
    assert.equal(row.calls, 5);
    assert.equal(row.retries, 1);
    assert.equal(row.totalTokens, 100);
    assert.equal(row.cost, 1);
    assert.equal(row.budgetExhausted, false);
    assert.deepEqual(row.batteries['battery1-e2e'], { passed: 3, total: 4 });
    assert.deepEqual(row.batteries['battery3-abuse'], { passed: 0, total: 5 });
    assert.equal(row.batteriesPassed, false);
    assert.equal(row.publishUrl, 'https://github.com/o/r');
  });
});

test('excludes task-file, legacy, dirty-tree and other-source runs with explicit reasons', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'taskfile', { report: reportFixture({ task: { source: 'task-file', path: 'x', sha256: 'a' } }) });
    const legacy = reportFixture();
    delete legacy.task;
    await addRun(runsDir, 'legacy', { report: legacy });
    await addRun(runsDir, 'dirty', { report: reportFixture({ harnessGitDirty: true }) });
    await addRun(runsDir, 'unknown-dirty', { report: reportFixture({ harnessGitDirty: null }) });
    await addRun(runsDir, 'good', { report: reportFixture() });
    await fs.mkdir(path.join(runsDir, 'not-a-run'));
    await fs.writeFile(path.join(runsDir, 'stray-file.txt'), 'x');

    const result = await agg.aggregate({ runsDir });
    assert.deepEqual(result.rows.map((r) => r.workspace), ['good']);
    assert.equal(excludedReason(result, 'taskfile'), 'task-file run');
    assert.equal(excludedReason(result, 'legacy'), 'no task identity (legacy run)');
    assert.equal(excludedReason(result, 'dirty'), 'dirty harness tree');
    assert.match(excludedReason(result, 'unknown-dirty'), /harness tree state unknown/);
    assert.equal(result.excluded.length, 4, 'directories without run-report.json and stray files are skipped silently');
  });
});

test('a malformed run-report.json is excluded with a reason, never a crash', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'broken', { rawReport: '{ not json' });
    await addRun(runsDir, 'good', { report: reportFixture() });
    const result = await agg.aggregate({ runsDir });
    assert.deepEqual(result.rows.map((r) => r.workspace), ['good']);
    assert.match(excludedReason(result, 'broken'), /^malformed run-report\.json/);
  });
});

test('parseError, malformed or missing batteries-report.json yield empty battery cells', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'parse-error', { report: reportFixture(), batteries: { parseError: true, raw: 'garbage' } });
    await addRun(runsDir, 'malformed', { report: reportFixture(), rawBatteries: '{{{' });
    await addRun(runsDir, 'missing', { report: reportFixture() });
    const result = await agg.aggregate({ runsDir });
    assert.equal(result.rows.length, 3);
    for (const row of result.rows) {
      assert.equal(row.batteriesPassed, null, row.workspace);
      for (const b of BATTERIES) assert.deepEqual(row.batteries[b], { passed: null, total: null }, `${row.workspace} ${b}`);
    }
    const csv = agg.runsToCsv(result.rows);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /battery1-e2e_passed,battery1-e2e_total/);
  });
});

test('per-config summary: n=1 has empty std dev, n=2 has known mean and sample std dev', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'c1-a', {
      report: reportFixture({ durationMs: 1000, usage: { totalTokens: 100, calls: 1, retries: 0, cost: 1 } }),
      batteries: batteryFixture({ 'battery1-e2e': [1, 2] }, true),
    });
    await addRun(runsDir, 'c1-b', {
      report: reportFixture({ durationMs: 3000, status: 'FAILED', usage: { totalTokens: 300, calls: 1, retries: 0, cost: 3 } }),
      batteries: batteryFixture({ 'battery1-e2e': [2, 2] }, false),
    });
    await addRun(runsDir, 'c2-a', { report: reportFixture({ config: 'c2' }) });

    const { summary } = await agg.aggregate({ runsDir });
    const c1 = summary.find((s) => s.config === 'c1');
    assert.equal(c1.n, 2);
    assert.equal(c1.generationSuccess, 1);
    assert.equal(c1.batteriesPassed, 1);
    assert.equal(c1.cost.mean, 2);
    assert.ok(Math.abs(c1.cost.stdDev - Math.SQRT2) < 1e-9);
    assert.equal(c1.totalTokens.mean, 200);
    assert.ok(Math.abs(c1.totalTokens.stdDev - 100 * Math.SQRT2) < 1e-9);
    assert.equal(c1.durationMs.mean, 2000);
    assert.ok(Math.abs(c1.durationMs.stdDev - 1000 * Math.SQRT2) < 1e-9);
    assert.equal(c1.batteries['battery1-e2e'].meanPassRatio, 0.75);
    assert.equal(c1.batteries['battery2-schema'].meanPassRatio, null);

    const c2 = summary.find((s) => s.config === 'c2');
    assert.equal(c2.n, 1);
    assert.equal(c2.cost.mean, 1);
    assert.equal(c2.cost.stdDev, null);

    const csv = agg.summaryToCsv(summary).trim().split('\r\n');
    assert.equal(csv.length, 3);
    const header = csv[0].split(',');
    const c2Row = csv[2].split(',');
    assert.equal(c2Row[header.indexOf('cost_stddev')], '');
    assert.notEqual(csv[1].split(',')[header.indexOf('cost_stddev')], '');
  });
});

test('CSV escaping follows RFC 4180 (commas, quotes, newlines) with CRLF rows', () => {
  assert.equal(agg.csvEscape('plain'), 'plain');
  assert.equal(agg.csvEscape('a,b'), '"a,b"');
  assert.equal(agg.csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(agg.csvEscape('l1\nl2'), '"l1\nl2"');
  assert.equal(agg.csvEscape(null), '');
  assert.equal(agg.csvEscape(undefined), '');
  assert.equal(agg.csvEscape(0), '0');
  assert.equal(agg.csvEscape(false), 'false');
});

test('a model id containing a comma/quote is quoted in runs.csv', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'weird', { report: reportFixture({ model: 'vendor/model,"v2"' }) });
    const { rows } = await agg.aggregate({ runsDir });
    const csv = agg.runsToCsv(rows);
    assert.ok(csv.includes('"vendor/model,""v2"""'), csv);
  });
});

test('--harness-sha filters by prefix and --model by exact id; mismatches are excluded with reasons', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'sha-a', { report: reportFixture({ harnessGitSha: SHA_A }) });
    await addRun(runsDir, 'sha-b', { report: reportFixture({ harnessGitSha: SHA_B }) });
    await addRun(runsDir, 'other-model', { report: reportFixture({ model: 'm/other' }) });

    const bySha = await agg.aggregate({ runsDir, harnessSha: 'aaaa' });
    assert.deepEqual(bySha.rows.map((r) => r.workspace), ['other-model', 'sha-a']);
    assert.equal(excludedReason(bySha, 'sha-b'), 'harness sha mismatch');

    const byModel = await agg.aggregate({ runsDir, model: 'm/model-x' });
    assert.deepEqual(byModel.rows.map((r) => r.workspace), ['sha-a', 'sha-b']);
    assert.equal(excludedReason(byModel, 'other-model'), 'model mismatch');
  });
});

test('summary.md lists the summary, included runs and excluded runs with reasons', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'good', { report: reportFixture() });
    await addRun(runsDir, 'dirty', { report: reportFixture({ harnessGitDirty: true }) });
    const result = await agg.aggregate({ runsDir });
    const md = agg.renderMarkdown(result);
    assert.match(md, /## Summary per config/);
    assert.match(md, /## Included runs/);
    assert.match(md, /## Excluded runs/);
    assert.match(md, /\| dirty \| dirty harness tree \|/);
    assert.match(md, /\| good \|/);
  });
});

test('CLI writes runs.csv, summary.csv, summary.md to --out (default <runs-dir>/_aggregate) and prints summary.md', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'good', { report: reportFixture() });
    const outDir = path.join(runsDir, 'custom-out');
    const script = path.join(__dirname, 'aggregate-runs.mjs');

    const res = spawnSync(process.execPath, [script, '--runs-dir', runsDir, '--out', outDir], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const md = await fs.readFile(path.join(outDir, 'summary.md'), 'utf8');
    assert.equal(res.stdout.trim(), md.trim());
    await fs.access(path.join(outDir, 'runs.csv'));
    await fs.access(path.join(outDir, 'summary.csv'));

    const res2 = spawnSync(process.execPath, [script, '--runs-dir', runsDir], { encoding: 'utf8' });
    assert.equal(res2.status, 0, res2.stderr);
    await fs.access(path.join(runsDir, '_aggregate', 'summary.md'));

    // The output dir sits inside runs-dir but has no run-report.json, so a re-run never ingests it.
    const res3 = spawnSync(process.execPath, [script, '--runs-dir', runsDir], { encoding: 'utf8' });
    assert.equal(res3.stdout, res2.stdout);
  });
});

test('CLI rejects unknown flags and flags without a value with a usage error', () => {
  const script = path.join(__dirname, 'aggregate-runs.mjs');
  const unknown = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Usage/);
  const missing = spawnSync(process.execPath, [script, '--model'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Usage/);
});

test('runs without a SPEC hash are excluded, and mixed SPEC or harness versions are flagged', async () => {
  assert.equal(
    agg.exclusionReason(reportFixture({ task: { source: 'spec', path: 'experiment/SPEC.md', sha256: 'f'.repeat(64) } })),
    'no SPEC hash (legacy run)',
  );
  const rows = [
    agg.buildRow({ workspace: 'a', report: reportFixture(), batteries: null }),
    agg.buildRow({ workspace: 'b', report: reportFixture({ harnessGitSha: SHA_B, task: { source: 'spec', path: 'experiment/SPEC.md', sha256: 'f'.repeat(64), specSha256: 'd'.repeat(64) } }), batteries: null }),
  ];
  const warnings = agg.comparabilityWarnings(rows);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /SPEC/);
  assert.match(warnings.join('\n'), /harness/);
  assert.deepEqual(agg.comparabilityWarnings(rows.slice(0, 1)), []);
  assert.match(agg.renderMarkdown({ rows, excluded: [], summary: agg.summarizeByConfig(rows) }), /SPEC/);
});

test('per-battery means report how many runs they cover, so missing battery data is visible', () => {
  const rows = [
    agg.buildRow({ workspace: 'a', report: reportFixture(), batteries: batteryFixture({ 'battery1-e2e': [4, 8] }) }),
    agg.buildRow({ workspace: 'b', report: reportFixture(), batteries: null }),
  ];
  const [summary] = agg.summarizeByConfig(rows);
  assert.equal(summary.n, 2);
  assert.deepEqual(summary.batteries['battery1-e2e'], { meanPassRatio: 0.5, n: 1 });
  assert.match(agg.renderMarkdown({ rows, excluded: [], summary: [summary] }), /0\.5\d* \(n=1\)/);
  assert.match(agg.summaryToCsv([summary]), /battery1-e2e_n/);
});

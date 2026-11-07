// Tests for collect-static-analysis.mjs. Sonar (fetch) and gh (run) are injected;
// no network or gh call happens here. Fixtures live in temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as collect from './collect-static-analysis.mjs';
import { DEFAULT_RUNS_DIR } from './aggregate-runs.mjs';

const NOW = new Date('2026-02-03T04:05:06.000Z');

async function withRunsDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-static-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function addRun(runsDir, name, report) {
  const dir = path.join(runsDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'run-report.json'), JSON.stringify(report));
  return dir;
}

const publishedReport = (name = 'ws1') => ({
  config: 'c1',
  repository: { name: `harness-loop-graph/run-${name}`, url: `https://github.com/harness-loop-graph/run-${name}` },
  staticAnalysis: { sonarOrganization: 'org', sonarProjectKey: `org_run-${name}`, semgrepConfig: ['p/default'], workflowSha256: 'a'.repeat(64), removedWorkflows: [] },
});

const SONAR_BODY = {
  component: {
    key: 'org_run-ws1',
    measures: [
      { metric: 'ncloc', value: '1200' },
      { metric: 'bugs', value: '3' },
      { metric: 'vulnerabilities', value: '1' },
      { metric: 'code_smells', value: '40' },
      { metric: 'security_hotspots', value: '2' },
      { metric: 'duplicated_lines_density', value: '4.5' },
      { metric: 'cognitive_complexity', value: '77' },
      { metric: 'sqale_index', value: '300' },
      { metric: 'reliability_rating', value: '1.0' },
      { metric: 'security_rating', value: '2.0' },
      { metric: 'sqale_rating', value: '1.0' },
      { metric: 'coverage', value: '81.3' },
      { metric: 'complexity', value: '412' },
    ],
  },
};

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function fakeFetch(response, calls = []) {
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof response === 'function' ? response(String(url)) : response;
  };
  fn.calls = calls;
  return fn;
}

const alert = (tool, severity, securitySeverity) => ({
  state: 'open',
  tool: { name: tool },
  rule: { severity, security_severity_level: securitySeverity ?? null },
});

const ALERTS = [
  alert('Semgrep', 'error', 'high'),
  alert('Semgrep OSS', 'warning', 'medium'),
  alert('semgrep', 'warning', null),
  alert('Semgrep', 'note', 'low'),
  alert('CodeQL', 'error', 'critical'), // must be ignored
];

const SEMGREP_ANALYSES = [{ tool: { name: 'Semgrep OSS' } }];

// Alerts are counted only once a Semgrep analysis exists, so the fake answers
// the analyses listing separately (default: one Semgrep analysis uploaded).
function fakeRun(result, calls = [], { analyses = SEMGREP_ANALYSES } = {}) {
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (result instanceof Error) throw result;
    if (args.some((a) => a.includes('/code-scanning/analyses'))) return { stdout: JSON.stringify(analyses), stderr: '' };
    return { stdout: typeof result === 'string' ? result : JSON.stringify(result), stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

const readOut = async (dir, ws) => JSON.parse(await fs.readFile(path.join(dir, ws, 'static-analysis.json'), 'utf8'));
const collectAll = (runsDir, deps, opts = {}) => collect.collectAll({ runsDir, now: () => NOW, env: {}, ...opts, ...deps });

test('default runs dir is the aggregator default', () => {
  assert.equal(collect.parseArgs(['node', 'x']).runsDir, DEFAULT_RUNS_DIR);
  assert.equal(collect.parseArgs(['node', 'x', '--force']).force, true);
  assert.equal(collect.parseArgs(['node', 'x', '--runs-dir', '/tmp/r']).runsDir, '/tmp/r');
  assert.throws(() => collect.parseArgs(['node', 'x', '--bogus']), /Usage/);
});

test('complete case: Sonar measures + Semgrep alerts (non-semgrep ignored) are written', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'ws1', publishedReport('ws1'));
    const fetchFn = fakeFetch(jsonResponse(200, SONAR_BODY));
    const run = fakeRun(ALERTS);
    const results = await collectAll(runsDir, { fetchFn, run });

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'complete');

    const url = new URL(fetchFn.calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://sonarcloud.io/api/measures/component');
    assert.equal(url.searchParams.get('component'), 'org_run-ws1');
    assert.equal(url.searchParams.get('metricKeys'), 'ncloc,bugs,vulnerabilities,code_smells,security_hotspots,duplicated_lines_density,cognitive_complexity,sqale_index,reliability_rating,security_rating,sqale_rating,coverage,complexity');
    assert.equal(fetchFn.calls[0].init?.headers?.Authorization, undefined, 'no token => no auth header');

    const alertsCall = run.calls.find((c) => c.args.some((a) => a.includes('/code-scanning/alerts')));
    assert.equal(alertsCall.cmd, 'gh');
    assert.deepEqual(alertsCall.args.slice(0, 3), ['api', '--paginate', 'repos/harness-loop-graph/run-ws1/code-scanning/alerts?state=open&per_page=100']);

    const out = await readOut(runsDir, 'ws1');
    assert.deepEqual(out, {
      collectedAt: '2026-02-03T04:05:06.000Z',
      status: 'complete',
      sonar: {
        status: 'complete',
        projectKey: 'org_run-ws1',
        measures: {
          ncloc: 1200, bugs: 3, vulnerabilities: 1, code_smells: 40, security_hotspots: 2, duplicated_lines_density: 4.5,
          cognitive_complexity: 77, sqale_index: 300, reliability_rating: 1, security_rating: 2, sqale_rating: 1,
          coverage: 81.3, complexity: 412,
        },
      },
      semgrep: {
        status: 'complete',
        openAlerts: 4,
        bySeverity: { error: 1, warning: 2, note: 1 },
        bySecuritySeverity: { high: 1, medium: 1, low: 1 },
      },
    });
  });
});

test('SONAR_TOKEN is sent as a Bearer header only when set', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'ws1', publishedReport('ws1'));
    const fetchFn = fakeFetch(jsonResponse(200, SONAR_BODY));
    await collectAll(runsDir, { fetchFn, run: fakeRun([]) }, { env: { SONAR_TOKEN: 'tok' } });
    assert.equal(fetchFn.calls[0].init.headers.Authorization, 'Bearer tok');
  });
});

test('paginated gh output (concatenated JSON arrays) is parsed', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'ws1', publishedReport('ws1'));
    const pages = `${JSON.stringify([ALERTS[0]])}${JSON.stringify([ALERTS[1], ALERTS[4]])}\n`;
    await collectAll(runsDir, { fetchFn: fakeFetch(jsonResponse(200, SONAR_BODY)), run: fakeRun(pages) });
    assert.equal((await readOut(runsDir, 'ws1')).semgrep.openAlerts, 2);
  });
});

test('Sonar 404 or empty measures => sonar pending, overall pending', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'ws1', publishedReport('ws1'));
    await collectAll(runsDir, { fetchFn: fakeFetch(jsonResponse(404, { errors: [{ msg: 'not found' }] })), run: fakeRun(ALERTS) });
    let out = await readOut(runsDir, 'ws1');
    assert.equal(out.sonar.status, 'pending');
    assert.equal(out.semgrep.status, 'complete');
    assert.equal(out.status, 'pending');

    await collectAll(runsDir, { fetchFn: fakeFetch(jsonResponse(200, { component: { measures: [] } })), run: fakeRun(ALERTS) });
    out = await readOut(runsDir, 'ws1');
    assert.equal(out.sonar.status, 'pending');
    assert.equal(out.status, 'pending');
  });
});

test('gh "no analysis found" or 404 => semgrep pending', async () => {
  for (const message of ['gh: no analysis found (HTTP 404)', 'gh: Not Found (HTTP 404)']) {
    await withRunsDir(async (runsDir) => {
      await addRun(runsDir, 'ws1', publishedReport('ws1'));
      await collectAll(runsDir, { fetchFn: fakeFetch(jsonResponse(200, SONAR_BODY)), run: fakeRun(new Error(message)) });
      const out = await readOut(runsDir, 'ws1');
      assert.equal(out.semgrep.status, 'pending', message);
      assert.equal(out.sonar.status, 'complete');
      assert.equal(out.status, 'pending');
    });
  }
});

test('other gh errors => semgrep error with message; overall error', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'ws1', publishedReport('ws1'));
    const results = await collectAll(runsDir, { fetchFn: fakeFetch(jsonResponse(200, SONAR_BODY)), run: fakeRun(new Error('gh: rate limit exceeded (HTTP 403)')) });
    const out = await readOut(runsDir, 'ws1');
    assert.equal(out.semgrep.status, 'error');
    assert.match(out.semgrep.error, /rate limit/);
    assert.equal(out.status, 'error');
    assert.equal(results[0].status, 'error');
  });
});

test('a Sonar fetch failure is an error for that run, never a throw', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'ws1', publishedReport('ws1'));
    const fetchFn = async () => { throw new Error('socket hang up'); };
    await collectAll(runsDir, { fetchFn, run: fakeRun(ALERTS) });
    const out = await readOut(runsDir, 'ws1');
    assert.equal(out.sonar.status, 'error');
    assert.match(out.sonar.error, /socket hang up/);
    assert.equal(out.status, 'error');
  });
});

test('an existing complete file is skipped unless --force; pending files are recollected', async () => {
  await withRunsDir(async (runsDir) => {
    const dir = await addRun(runsDir, 'ws1', publishedReport('ws1'));
    const file = path.join(dir, 'static-analysis.json');
    await fs.writeFile(file, JSON.stringify({ status: 'complete', marker: 1 }));

    const fetchFn = fakeFetch(jsonResponse(200, SONAR_BODY));
    const run = fakeRun(ALERTS);
    let results = await collectAll(runsDir, { fetchFn, run });
    assert.equal(results[0].skipped, true);
    assert.equal(fetchFn.calls.length, 0);
    assert.equal(run.calls.length, 0);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).marker, 1);

    results = await collectAll(runsDir, { fetchFn, run }, { force: true });
    assert.equal(results[0].skipped, undefined);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'complete');
    assert.equal(fetchFn.calls.length, 1);

    await fs.writeFile(file, JSON.stringify({ status: 'pending' }));
    await collectAll(runsDir, { fetchFn, run });
    assert.equal(fetchFn.calls.length, 2);
  });
});

test('unpublished runs and non-run directories are ignored', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'no-repo', { config: 'c1', staticAnalysis: publishedReport().staticAnalysis });
    await addRun(runsDir, 'no-static', { config: 'c1', repository: publishedReport().repository });
    await fs.mkdir(path.join(runsDir, 'empty'));
    const fetchFn = fakeFetch(jsonResponse(200, SONAR_BODY));
    const run = fakeRun(ALERTS);
    const results = await collectAll(runsDir, { fetchFn, run });
    assert.deepEqual(results, []);
    assert.equal(fetchFn.calls.length, 0);
    await assert.rejects(fs.access(path.join(runsDir, 'no-repo', 'static-analysis.json')));
  });
});

test('main: one line per run, exit 0 unless every published run errored', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'ws1', publishedReport('ws1'));
    await addRun(runsDir, 'ws2', publishedReport('ws2'));
    const lines = [];
    const log = (l) => lines.push(l);
    const okDeps = { fetchFn: fakeFetch(jsonResponse(200, SONAR_BODY)), run: fakeRun(ALERTS), log, env: {} };
    assert.equal(await collect.main(['node', 'x', '--runs-dir', runsDir], okDeps), 0);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /ws1/);
    assert.match(lines[0], /complete/);

    const badDeps = { fetchFn: async () => { throw new Error('boom'); }, run: fakeRun(new Error('gh: boom')), log, env: {} };
    assert.equal(await collect.main(['node', 'x', '--runs-dir', runsDir, '--force'], badDeps), 1);

    const mixed = { fetchFn: fakeFetch(jsonResponse(404, {})), run: fakeRun(ALERTS), log, env: {} };
    assert.equal(await collect.main(['node', 'x', '--runs-dir', runsDir, '--force'], mixed), 0, 'pending is not an error');
  });
});

test('an empty alert list before any Semgrep analysis is uploaded is pending, never a perfect score', async () => {
  await withRunsDir(async (runsDir) => {
    await addRun(runsDir, 'ws1', publishedReport('ws1'));
    for (const analyses of [[], [{ tool: { name: 'CodeQL' } }]]) {
      const run = fakeRun([], [], { analyses });
      await collectAll(runsDir, { fetchFn: fakeFetch(jsonResponse(200, SONAR_BODY)), run }, { force: true });
      const out = await readOut(runsDir, 'ws1');
      assert.equal(out.semgrep.status, 'pending');
      assert.equal(out.semgrep.openAlerts, undefined);
      assert.equal(out.status, 'pending');
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalExecutionManager, scrubEnv } from '../src/components/execution-manager.js';

describe('scrubEnv', () => {
  it('removes secret-looking names case-insensitively and the explicit MODEL_* names', () => {
    const out = scrubEnv({
      PATH: '/bin',
      HOME: '/home/x',
      DOCKER_HOST: 'unix:///sock',
      MODEL_API_KEY: 'k',
      MODEL_BASE_URL: 'u',
      MODEL_ID: 'm',
      OPENAI_APIKEY: 'a',
      openai_api_key: 'b',
      GH_TOKEN: 't',
      DB_PASSWORD: 'p',
      PGPASSWD: 'p',
      MY_SECRET: 's',
      AWS_CREDENTIALS: 'c',
      SSH_PRIVATE_KEY: 'x',
    });
    expect(Object.keys(out).sort()).toEqual(['DOCKER_HOST', 'HOME', 'MODEL_ID', 'PATH']);
  });

  it('removes extra exact names and skips undefined values', () => {
    const out = scrubEnv({ PATH: '/bin', CUSTOM_ROUTE_VAR: 'v', GONE: undefined }, ['CUSTOM_ROUTE_VAR']);
    expect(out).toEqual({ PATH: '/bin' });
  });

  it('does not mutate its input', () => {
    const input = { PATH: '/bin', FOO_TOKEN: 't' };
    scrubEnv(input);
    expect(input).toEqual({ PATH: '/bin', FOO_TOKEN: 't' });
  });
});

describe('LocalExecutionManager environment scrubbing', () => {
  const dump = `node -e "console.log(JSON.stringify(process.env))"`;
  const saved: Record<string, string | undefined> = {};
  const names = ['MODEL_API_KEY', 'FOO_TOKEN', 'ROUTE_KEY_VAR'];

  beforeEach(() => {
    for (const n of names) saved[n] = process.env[n];
    process.env.MODEL_API_KEY = 'sk-leak';
    process.env.FOO_TOKEN = 'tok-leak';
    process.env.ROUTE_KEY_VAR = 'route-leak';
  });

  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('does not leak secrets from process.env to the child but keeps PATH', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir() });
    const res = await mgr.run({ command: dump, cwd: '.' });
    const env = JSON.parse(res.stdout);
    expect(env.MODEL_API_KEY).toBeUndefined();
    expect(env.FOO_TOKEN).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });

  it('still applies explicit req.env entries, even secret-looking ones', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir() });
    const res = await mgr.run({ command: dump, cwd: '.', env: { SEED_PASSWORD: 'seed', MODEL_API_KEY: 'explicit' } });
    const env = JSON.parse(res.stdout);
    expect(env.SEED_PASSWORD).toBe('seed');
    expect(env.MODEL_API_KEY).toBe('explicit');
  });

  it('removes names listed in envDenylist', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir(), envDenylist: ['ROUTE_KEY_VAR'] });
    const res = await mgr.run({ command: dump, cwd: '.' });
    expect(JSON.parse(res.stdout).ROUTE_KEY_VAR).toBeUndefined();
  });
});

describe('LocalExecutionManager output capture', () => {
  it('keeps the tail of output that exceeds the cap', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir(), timeoutMs: 20_000 });
    const script =
      "process.stdout.write('FIRST_LINE\\n' + 'x'.repeat(1024*1024) + '\\nLAST_LINE\\n');" +
      "process.stderr.write('y'.repeat(1024*1024) + '\\nERR_LAST\\n');";
    const res = await mgr.run({ command: `node -e "${script}"`, cwd: '.' });
    expect(res.stdout).toContain('FIRST_LINE');
    expect(res.stdout).toContain('LAST_LINE');
    expect(res.stdout).toMatch(/\[truncated \d+ chars\]/);
    expect(res.stdout.length).toBeLessThanOrEqual(512 * 1024);
    expect(res.stderr).toContain('ERR_LAST');
    expect(res.stderr.length).toBeLessThanOrEqual(512 * 1024);
  });

  it('leaves output under the cap untouched', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir() });
    const res = await mgr.run({ command: 'echo hello', cwd: '.' });
    expect(res.stdout.trim()).toBe('hello');
  });
});

describe('LocalExecutionManager shell', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-shell-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('expands bash brace expansion instead of creating a literal directory', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: dir });
    const res = await mgr.run({ command: 'mkdir -p d/{a,b}', cwd: '.' });
    expect(res.exitCode).toBe(0);
    expect((await fs.readdir(path.join(dir, 'd'))).sort()).toEqual(['a', 'b']);
  });

  it('supports bash-only syntax such as [[ ]]', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: dir });
    const res = await mgr.run({ command: '[[ 1 == 1 ]] && echo yes', cwd: '.' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('yes');
  });

  it('runs commands under bash', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: dir });
    const res = await mgr.run({ command: 'echo $BASH_VERSION', cwd: '.' });
    expect(res.stdout.trim()).not.toBe('');
  });
});

describe('LocalExecutionManager timeout', () => {
  it('returns on timeout even when a background child keeps the output pipes open', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir(), timeoutMs: 500 });
    const started = Date.now();
    // `sleep 30 &` inherits stdout/stderr: killing only the shell leaves the pipes open.
    const result = await mgr.run({ command: 'sleep 30 & sleep 30', cwd: os.tmpdir() });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('[timeout]');
  }, 10_000);

  it('kills the whole process group on timeout, not only the shell', async () => {
    const seconds = 3000 + (process.pid % 900);
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir(), timeoutMs: 500 });
    await mgr.run({ command: `sleep ${seconds} & sleep 30`, cwd: os.tmpdir() });
    await new Promise((r) => setTimeout(r, 300));
    const { execSync } = await import('node:child_process');
    const alive = execSync(`ps -eo args | grep -c "^sleep ${seconds}$" || true`).toString().trim();
    expect(alive).toBe('0');
  }, 10_000);
});

describe('LocalExecutionManager non-interactive environment', () => {
  it('sets CI=true so test runners do not start in watch mode', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir(), timeoutMs: 5_000 });
    expect((await mgr.run({ command: 'echo "$CI"', cwd: os.tmpdir() })).stdout.trim()).toBe('true');
  });

  it('lets req.env override CI', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir(), timeoutMs: 5_000 });
    expect((await mgr.run({ command: 'echo "$CI"', cwd: os.tmpdir(), env: { CI: '' } })).stdout.trim()).toBe('');
  });
});

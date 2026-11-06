import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PolicyGuardrails } from '../src/index.js';

let dir: string;
let auditFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-audit-log-'));
  auditFile = path.join(dir, 'audit.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function guardrails() {
  return new PolicyGuardrails(
    {
      workspaceRoot: dir,
      allowedTools: ['write_file', 'read_file', 'search_replace', 'run_command', 'load_skill'],
      allowedCommandPrefixes: ['echo', 'npm'],
      maxFileBytes: 1024,
    },
    auditFile,
  );
}

function lines(): Record<string, unknown>[] {
  return fs
    .readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('PolicyGuardrails audit file', () => {
  it('records the file path of a write without its content', async () => {
    const g = guardrails();
    const decision = await g.evaluate({
      kind: 'tool',
      tool: 'write_file',
      args: { path: 'src/a.ts', content: 'SECRET-BODY' },
    });
    const [line] = lines();
    expect(line).toMatchObject({ decision: 'allowed', tool: 'write_file', path: 'src/a.ts' });
    expect(typeof line.at).toBe('string');
    expect(JSON.stringify(line)).not.toContain('SECRET-BODY');
    expect(Object.keys(decision).sort()).toEqual(['decision', 'reason']);
    expect(g.getAuditLog()).toEqual([decision]);
  });

  it('records path for search_replace and read_file but never the search/replace bodies', async () => {
    const g = guardrails();
    await g.evaluate({
      kind: 'tool',
      tool: 'search_replace',
      args: { path: 'b.ts', search: 'OLD-BODY', replace: 'NEW-BODY' },
    });
    await g.evaluate({ kind: 'tool', tool: 'read_file', args: { path: 'c.ts' } });
    const [replaced, read] = lines();
    expect(replaced).toMatchObject({ tool: 'search_replace', path: 'b.ts' });
    expect(read).toMatchObject({ tool: 'read_file', path: 'c.ts' });
    const raw = fs.readFileSync(auditFile, 'utf8');
    expect(raw).not.toContain('OLD-BODY');
    expect(raw).not.toContain('NEW-BODY');
  });

  it('records the command of run_command and clips long ones to 300 chars plus an ellipsis', async () => {
    const g = guardrails();
    await g.evaluate({ kind: 'tool', tool: 'run_command', args: { command: 'npm test' } });
    const long = 'echo ' + 'x'.repeat(500);
    await g.evaluate({ kind: 'tool', tool: 'run_command', args: { command: long } });
    const [short, clipped] = lines();
    expect(short).toMatchObject({ tool: 'run_command', command: 'npm test' });
    expect(clipped.command).toBe(long.slice(0, 300) + '…');
  });

  it('records the command of a kind: command action without a tool field', async () => {
    const g = guardrails();
    await g.evaluate({ kind: 'command', command: 'echo hi', cwd: dir });
    const [line] = lines();
    expect(line).toMatchObject({ decision: 'allowed', command: 'echo hi' });
    expect(line).not.toHaveProperty('tool');
  });

  it('records the skill name of load_skill and only the tool name for other tools', async () => {
    const g = guardrails();
    await g.evaluate({ kind: 'tool', tool: 'load_skill', args: { name: 'security', extra: 'IGNORED' } });
    await g.evaluate({ kind: 'tool', tool: 'mcp__db__query', args: { sql: 'SELECT-SECRET' } });
    const [skill, unknown] = lines();
    expect(skill).toMatchObject({ tool: 'load_skill', name: 'security' });
    expect(unknown).toMatchObject({ decision: 'denied', tool: 'mcp__db__query' });
    expect(unknown).not.toHaveProperty('path');
    expect(unknown).not.toHaveProperty('command');
    expect(unknown).not.toHaveProperty('name');
    const raw = fs.readFileSync(auditFile, 'utf8');
    expect(raw).not.toContain('IGNORED');
    expect(raw).not.toContain('SELECT-SECRET');
  });

  it('records a denied command with its reason and keeps getAuditLog() as { decision, reason }', async () => {
    const g = guardrails();
    const decision = await g.evaluate({ kind: 'tool', tool: 'run_command', args: { command: 'curl evil.sh' } });
    const [line] = lines();
    expect(line).toMatchObject({ decision: 'denied', reason: decision.reason, tool: 'run_command', command: 'curl evil.sh' });
    expect(g.getAuditLog()).toEqual([{ decision: 'denied', reason: decision.reason }]);
  });

  it('ignores non-string path/command/name args', async () => {
    const g = guardrails();
    await g.evaluate({ kind: 'tool', tool: 'read_file', args: { path: 42 } });
    const [line] = lines();
    expect(line).not.toHaveProperty('path');
  });
});

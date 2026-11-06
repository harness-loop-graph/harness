import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsContextManager, MAX_CONTEXT_FILE_BYTES } from '../src/components/context-manager.js';

describe('FsContextManager context files', () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'context-manager-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'context-outside-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('reads AGENTS.md from the workspace root', async () => {
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Use pnpm.');
    const ctx = await new FsContextManager().prepare('task', workspace);
    expect(ctx.contextFiles).toEqual([{ path: 'AGENTS.md', content: 'Use pnpm.', truncated: false }]);
  });

  it('falls back to CLAUDE.md when AGENTS.md is absent', async () => {
    await fs.writeFile(path.join(workspace, 'CLAUDE.md'), 'Claude rules.');
    const ctx = await new FsContextManager().prepare('task', workspace);
    expect(ctx.contextFiles).toEqual([{ path: 'CLAUDE.md', content: 'Claude rules.', truncated: false }]);
  });

  it('uses only AGENTS.md when both files exist', async () => {
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'agents');
    await fs.writeFile(path.join(workspace, 'CLAUDE.md'), 'claude');
    const ctx = await new FsContextManager().prepare('task', workspace);
    expect(ctx.contextFiles).toEqual([{ path: 'AGENTS.md', content: 'agents', truncated: false }]);
  });

  it('omits contextFiles when no context file exists', async () => {
    const ctx = await new FsContextManager().prepare('task', workspace);
    expect('contextFiles' in ctx).toBe(false);
  });

  it('truncates content over the cap and flags it', async () => {
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'a'.repeat(MAX_CONTEXT_FILE_BYTES + 100));
    const ctx = await new FsContextManager().prepare('task', workspace);
    const [file] = ctx.contextFiles ?? [];
    expect(file.truncated).toBe(true);
    expect(Buffer.byteLength(file.content)).toBeLessThanOrEqual(MAX_CONTEXT_FILE_BYTES);
  });

  it('does not flag a file exactly at the cap as truncated', async () => {
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'a'.repeat(MAX_CONTEXT_FILE_BYTES));
    const ctx = await new FsContextManager().prepare('task', workspace);
    expect(ctx.contextFiles?.[0].truncated).toBe(false);
  });

  it('ignores a symlinked AGENTS.md and falls back to a regular CLAUDE.md', async () => {
    const secret = path.join(outside, 'secret.md');
    await fs.writeFile(secret, 'TOP SECRET');
    await fs.symlink(secret, path.join(workspace, 'AGENTS.md'));
    await fs.writeFile(path.join(workspace, 'CLAUDE.md'), 'claude');
    const ctx = await new FsContextManager().prepare('task', workspace);
    expect(ctx.contextFiles).toEqual([{ path: 'CLAUDE.md', content: 'claude', truncated: false }]);
  });

  it('omits contextFiles when the only candidate is a symlink', async () => {
    const secret = path.join(outside, 'secret.md');
    await fs.writeFile(secret, 'TOP SECRET');
    await fs.symlink(secret, path.join(workspace, 'AGENTS.md'));
    const ctx = await new FsContextManager().prepare('task', workspace);
    expect(ctx.contextFiles).toBeUndefined();
  });

  it('skips a directory named AGENTS.md without failing the cycle', async () => {
    await fs.mkdir(path.join(workspace, 'AGENTS.md'));
    const ctx = await new FsContextManager().prepare('task', workspace);
    expect(ctx.contextFiles).toBeUndefined();
  });
});

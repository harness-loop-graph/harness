import type { ExecutionRequest, ExecutionResult } from '../contracts/core.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { BoundedOutput } from './truncate.js';

/** Executes commands in an isolated workspace directory. */
export interface ExecutionManager {
  run(req: ExecutionRequest): Promise<ExecutionResult>;
}

const MAX_OUTPUT_BYTES = 512 * 1024;

const BASH_PATH = '/bin/bash';

/**
 * Models write bash (brace expansion, `[[ ]]`); /bin/sh is dash on Debian/Ubuntu
 * and silently misreads them. Falls back to the platform default shell when bash
 * is not installed.
 */
function resolveShell(): string | true {
  return existsSync(BASH_PATH) ? BASH_PATH : true;
}

const SECRET_NAME_PATTERN = /API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY/i;
const DEFAULT_SECRET_NAMES = ['MODEL_API_KEY', 'MODEL_BASE_URL'];

/**
 * Returns a copy of `env` without secrets: names matching the default secret pattern
 * (case-insensitive), the default explicit names, and any exact name in `extraNames`.
 * Undefined values are dropped.
 */
export function scrubEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  extraNames: readonly string[] = [],
): Record<string, string> {
  const denied = new Set([...DEFAULT_SECRET_NAMES, ...extraNames]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || denied.has(name) || SECRET_NAME_PATTERN.test(name)) continue;
    out[name] = value;
  }
  return out;
}

export interface LocalExecutionOptions {
  /** Absolute path the agent is confined to; commands never run outside it. */
  workspaceRoot: string;
  /** Hard kill after this many milliseconds. Default 30_000. */
  timeoutMs?: number;
  /** Extra exact env var names removed from the inherited environment (on top of the default secret filter). */
  envDenylist?: string[];
}

/** Spawns commands confined to the workspace, with output caps and a hard timeout. */
export class LocalExecutionManager implements ExecutionManager {
  private readonly timeoutMs: number;

  constructor(private readonly opts: LocalExecutionOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    const root = path.resolve(this.opts.workspaceRoot);
    const cwd = path.isAbsolute(req.cwd) ? path.resolve(req.cwd) : path.resolve(root, req.cwd);
    const rel = path.relative(root, cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { exitCode: 126, stdout: '', stderr: `Execution cwd '${req.cwd}' is outside the workspace` };
    }

    return new Promise<ExecutionResult>((resolve) => {
      const child = spawn(req.command, {
        shell: resolveShell(),
        cwd,
        // CI=true: nobody is at the terminal, so test runners must not start in watch mode.
        env: { ...scrubEnv(process.env, this.opts.envDenylist), CI: 'true', ...req.env },
        // Own process group, so a timeout can kill background and grandchild processes too.
        detached: process.platform !== 'win32',
      });

      const out = new BoundedOutput(MAX_OUTPUT_BYTES);
      const err = new BoundedOutput(MAX_OUTPUT_BYTES);
      let settled = false;
      const finish = (result: ExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => out.append(chunk));
      child.stderr.on('data', (chunk: string) => err.append(chunk));

      const timer = setTimeout(() => {
        killProcessGroup(child);
        // A surviving process can keep the pipes open, so do not wait for 'close'.
        child.stdout.destroy();
        child.stderr.destroy();
        finish({
          exitCode: 124,
          stdout: out.toString(),
          stderr: err.toString() + `\n[timeout] killed after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);

      child.on('error', (error) => {
        finish({ exitCode: 127, stdout: out.toString(), stderr: err.toString() + String(error) });
      });

      child.on('close', (code) => {
        finish({ exitCode: code ?? 1, stdout: out.toString(), stderr: err.toString() });
      });
    });
  }
}

/** Kills the child's whole process group (see `detached`), falling back to the child alone. */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The group is already gone, or was never created: kill the child itself.
    }
  }
  child.kill('SIGKILL');
}

/** Stub for unit tests. */
export class StubExecutionManager implements ExecutionManager {
  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    return {
      exitCode: 0,
      stdout: `Executed: ${req.command}`,
      stderr: '',
    };
  }
}

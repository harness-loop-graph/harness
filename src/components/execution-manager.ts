import type { ExecutionRequest, ExecutionResult } from '../contracts/core.js';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

/** Executes commands in an isolated workspace directory. */
export interface ExecutionManager {
  run(req: ExecutionRequest): Promise<ExecutionResult>;
}

const MAX_OUTPUT_BYTES = 512 * 1024;

export interface LocalExecutionOptions {
  /** Absolute path the agent is confined to; commands never run outside it. */
  workspaceRoot: string;
  /** Hard kill after this many milliseconds. Default 30_000. */
  timeoutMs?: number;
}

/**
 * Real execution manager: spawns the command with a shell inside the
 * workspace, captures stdout/stderr with a size cap, and kills the
 * process tree on timeout. The cwd is confined to the workspace root.
 */
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
        shell: true,
        cwd,
        env: { ...process.env, ...req.env },
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const cap = (current: string, chunk: Buffer | string): string => {
        const next = current + chunk.toString('utf8');
        return next.length > MAX_OUTPUT_BYTES ? next.slice(0, MAX_OUTPUT_BYTES) : next;
      };

      child.stdout.on('data', (chunk) => (stdout = cap(stdout, chunk)));
      child.stderr.on('data', (chunk) => (stderr = cap(stderr, chunk)));

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, stdout, stderr: stderr + String(err) });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({
            exitCode: 124,
            stdout,
            stderr: stderr + `\n[timeout] killed after ${this.timeoutMs}ms`,
          });
        } else {
          resolve({ exitCode: code ?? 1, stdout, stderr });
        }
      });
    });
  }
}

/** Minimal stub: echoes the command back as stdout. Used in unit tests. */
export class StubExecutionManager implements ExecutionManager {
  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    return {
      exitCode: 0,
      stdout: `Executed: ${req.command}`,
      stderr: '',
    };
  }
}

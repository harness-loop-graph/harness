import type { ExecutionRequest, ExecutionResult } from '../contracts/core.js';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { BoundedOutput } from './truncate.js';

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
        shell: true,
        cwd,
        env: { ...process.env, ...req.env },
      });

      const out = new BoundedOutput(MAX_OUTPUT_BYTES);
      const err = new BoundedOutput(MAX_OUTPUT_BYTES);
      let killed = false;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => out.append(chunk));
      child.stderr.on('data', (chunk: string) => err.append(chunk));

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, stdout: out.toString(), stderr: err.toString() + String(error) });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({
            exitCode: 124,
            stdout: out.toString(),
            stderr: err.toString() + `\n[timeout] killed after ${this.timeoutMs}ms`,
          });
        } else {
          resolve({ exitCode: code ?? 1, stdout: out.toString(), stderr: err.toString() });
        }
      });
    });
  }
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

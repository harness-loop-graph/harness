import type { ExecutionRequest, ExecutionResult } from '../contracts/core.js';

/** Executes commands in an isolated workspace directory. */
export interface ExecutionManager {
  run(req: ExecutionRequest): Promise<ExecutionResult>;
}

/** Minimal stub: echoes the command back as stdout. */
export class StubExecutionManager implements ExecutionManager {
  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    return {
      exitCode: 0,
      stdout: `Executed: ${req.command}`,
      stderr: '',
    };
  }
}

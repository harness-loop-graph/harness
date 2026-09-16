import type { Context } from '../contracts/core.js';

/** Selects and prepares relevant project context. */
export interface ContextManager {
  prepare(task: string, projectRoot: string): Promise<Context>;
}

/** Minimal stub: returns a Context with the given root and an empty file list. */
export class StubContextManager implements ContextManager {
  async prepare(task: string, projectRoot: string): Promise<Context> {
    return {
      projectRoot,
      files: [],
      language: 'typescript',
    };
  }
}

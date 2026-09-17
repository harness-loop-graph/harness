import type { Context } from '../contracts/core.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Selects and prepares relevant project context. */
export interface ContextManager {
  prepare(task: string, projectRoot: string): Promise<Context>;
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.cache']);
const MAX_FILES = 500;
const MAX_DEPTH = 6;

/**
 * Real context manager: deterministically scans the workspace and
 * returns its file listing plus a coarse language guess. The task is
 * kept in the context for downstream consumers.
 */
export class FsContextManager implements ContextManager {
  async prepare(task: string, projectRoot: string): Promise<Context> {
    const root = path.resolve(projectRoot);
    const files: string[] = [];
    await this.walk(root, root, files, 0);

    const language = this.guessLanguage(files);
    return { projectRoot: root, files, language, task };
  }

  private async walk(root: string, dir: string, files: string[], depth: number): Promise<void> {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, never fail the cycle
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const rel = path.relative(root, path.join(dir, entry.name));
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await this.walk(root, path.join(dir, entry.name), files, depth + 1);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }

  private guessLanguage(files: string[]): string | undefined {
    const exts = files.map((f) => path.extname(f));
    const count = (ext: string) => exts.filter((e) => e === ext).length;
    if (count('.ts') + count('.tsx') > 0) return 'typescript';
    if (count('.js') + count('.jsx') + count('.mjs') > 0) return 'javascript';
    if (count('.py') > 0) return 'python';
    if (count('.go') > 0) return 'go';
    return undefined;
  }
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

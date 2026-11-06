import type { Context } from '../contracts/core.js';
import type { SkillCatalog } from './skill-catalog.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Selects and prepares relevant project context. */
export interface ContextManager {
  prepare(task: string, projectRoot: string): Promise<Context>;
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.cache']);
const MAX_FILES = 500;
const MAX_DEPTH = 6;
/** Candidates in priority order: only the first one found is used. */
const CONTEXT_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'];
export const MAX_CONTEXT_FILE_BYTES = 32 * 1024;

/** Deterministic workspace scan: file listing plus a coarse language guess. */
export class FsContextManager implements ContextManager {
  constructor(private readonly skillCatalog?: SkillCatalog) {}

  async prepare(task: string, projectRoot: string): Promise<Context> {
    const root = path.resolve(projectRoot);
    const files: string[] = [];
    await this.walk(root, root, files, 0);

    const language = this.guessLanguage(files);
    const skills = this.skillCatalog?.list();
    const contextFile = await this.readContextFile(root);
    return {
      projectRoot: root,
      files,
      language,
      task,
      ...(skills && skills.length > 0 ? { skills } : {}),
      ...(contextFile ? { contextFiles: [contextFile] } : {}),
    };
  }

  /**
   * Workspace root only (never home or parents) so experiment runs stay reproducible.
   * Symlinks are ignored so a planted link cannot exfiltrate files outside the workspace.
   */
  private async readContextFile(
    root: string,
  ): Promise<{ path: string; content: string; truncated: boolean } | undefined> {
    for (const name of CONTEXT_FILE_NAMES) {
      const full = path.join(root, name);
      try {
        if (!(await fs.lstat(full)).isFile()) continue;
        const handle = await fs.open(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          // One byte past the cap tells us whether the file was cut.
          const buffer = Buffer.alloc(MAX_CONTEXT_FILE_BYTES + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const truncated = bytesRead > MAX_CONTEXT_FILE_BYTES;
          const content = buffer.subarray(0, Math.min(bytesRead, MAX_CONTEXT_FILE_BYTES)).toString('utf8');
          return { path: name, content, truncated };
        } finally {
          await handle.close();
        }
      } catch {
        continue; // missing or unreadable: skip, never fail the cycle
      }
    }
    return undefined;
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

/** Stub for unit tests. */
export class StubContextManager implements ContextManager {
  async prepare(task: string, projectRoot: string): Promise<Context> {
    return {
      projectRoot,
      files: [],
      language: 'typescript',
    };
  }
}

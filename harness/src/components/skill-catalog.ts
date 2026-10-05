import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolSpec } from '../contracts/core.js';
import { MAX_READ_BYTES, type RegistryToolManager } from './tool-manager.js';

export interface SkillMeta {
  name: string;
  description: string;
}

interface SkillEntry extends SkillMeta {
  dir: string;
  body: string;
  /** Relative (POSIX-style) paths of every companion file under `dir`, excluding `SKILL.md` itself. */
  files: string[];
}

const FRONTMATTER_DELIMITER = '---';

/**
 * Loads skills from one or more directories: each `<dir>/<skill>/SKILL.md`
 * with a `---` frontmatter block containing `name` and `description`.
 * Progressive disclosure: the catalog exposes name/description for context
 * rendering, and the full body on demand (see `load_skill`).
 */
export class SkillCatalog {
  private readonly entries = new Map<string, SkillEntry>();

  static async load(dirs: string[]): Promise<SkillCatalog> {
    const catalog = new SkillCatalog();
    for (const dir of dirs) {
      await catalog.loadDir(dir);
    }
    return catalog;
  }

  private async loadDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`Cannot read skills directory '${dir}': ${err instanceof Error ? err.message : String(err)}`);
    }
    // Sort subdirectory names so loading order (and therefore duplicate-name
    // error messages) is stable regardless of the OS's readdir order.
    const subdirNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(byCodePoint);

    for (const subdir of subdirNames) {
      const skillFile = path.join(dir, subdir, 'SKILL.md');
      let raw: string;
      try {
        raw = await fs.readFile(skillFile, 'utf8');
      } catch (err) {
        // Only a missing SKILL.md means "not a skill directory"; any other
        // read failure (permissions, a SKILL.md that is itself a directory,
        // etc.) is a real problem and must fail fast, naming the file.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw new Error(`Cannot read '${skillFile}': ${err instanceof Error ? err.message : String(err)}`);
      }
      const { name, description, body } = parseSkillMd(raw, skillFile);
      if (this.entries.has(name)) {
        throw new Error(`Duplicate skill name '${name}' (already loaded, now also in '${skillFile}')`);
      }
      const skillDir = path.dirname(skillFile);
      const files = await listCompanionFiles(skillDir);
      this.entries.set(name, { name, description, dir: skillDir, body, files });
    }
  }

  /** Sorted by name so `list()` and the "Available skills" prompt are stable across runs. */
  list(): SkillMeta[] {
    return [...this.entries.values()]
      .map(({ name, description }) => ({ name, description }))
      .sort((a, b) => byCodePoint(a.name, b.name));
  }

  get(name: string): SkillEntry | undefined {
    return this.entries.get(name);
  }
}

function parseSkillMd(raw: string, sourceFile: string): { name: string; description: string; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`Missing frontmatter in '${sourceFile}': file must start with '---'`);
  }
  const endIndex = lines.findIndex((line, i) => i > 0 && line.trim() === FRONTMATTER_DELIMITER);
  if (endIndex === -1) {
    throw new Error(`Unterminated frontmatter in '${sourceFile}': missing closing '---'`);
  }

  const fields: Record<string, string> = {};
  const header = lines.slice(1, endIndex);
  for (let i = 0; i < header.length; i++) {
    const line = header[i];
    if (line.trim() === '') continue;
    const sepIndex = line.indexOf(':');
    if (sepIndex === -1) continue;
    const key = line.slice(0, sepIndex).trim();
    let value = line.slice(sepIndex + 1).trim();
    // YAML block scalar (`>` folds lines, `|` keeps them); published skills commonly use it for descriptions.
    const block = /^([>|])[-+]?$/.exec(value);
    if (block) {
      const parts: string[] = [];
      while (i + 1 < header.length && (header[i + 1].trim() === '' || /^\s/.test(header[i + 1]))) {
        parts.push(header[++i].trim());
      }
      fields[key] = parts.filter((p) => p !== '').join(block[1] === '>' ? ' ' : '\n');
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const name = fields.name;
  const description = fields.description;
  if (!name || !description) {
    throw new Error(`Frontmatter in '${sourceFile}' must have both 'name' and 'description'`);
  }

  const body = lines.slice(endIndex + 1).join('\n').trimStart();
  return { name, description, body };
}

/**
 * Recursively lists every file under `dir` (POSIX-style relative paths, sorted),
 * excluding the top-level `SKILL.md`. Uses `fs.stat` (follows symlinks) so a
 * symlinked file or directory is listed like a regular one; a broken symlink
 * is silently skipped rather than failing catalog loading.
 */
async function listCompanionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string, relPrefix: string): Promise<void> {
    const names = (await fs.readdir(current)).sort(byCodePoint);
    for (const name of names) {
      if (relPrefix === '' && name === 'SKILL.md') continue;
      const abs = path.join(current, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue; // broken symlink or disappeared between readdir and stat
      }
      if (stat.isDirectory()) {
        await walk(abs, rel);
      } else if (stat.isFile()) {
        files.push(rel);
      }
    }
  }

  await walk(dir, '');
  return files;
}

/**
 * Resolves `file` (a path relative to `skill.dir`) and returns its text content.
 * Rejects absolute paths, `..` escapes, and symlinks that resolve outside the
 * skill directory (checked via `fs.realpath` on both the target and the skill
 * directory, so a symlink hop can't land outside the confined tree). Caps size
 * at `MAX_READ_BYTES`, same as `read_file`.
 */
async function readSkillFile(skill: SkillEntry, file: string): Promise<{ file: string; content: string }> {
  if (path.isAbsolute(file)) {
    throw new Error(`File path '${file}' must be relative to the skill directory, not absolute`);
  }
  const target = path.resolve(skill.dir, file);
  const relFromDir = path.relative(skill.dir, target);
  if (relFromDir === '' || relFromDir.startsWith('..') || path.isAbsolute(relFromDir)) {
    throw new Error(`File path '${file}' escapes the '${skill.name}' skill directory`);
  }

  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(
        `Unknown file '${file}' in skill '${skill.name}'. Available files: ${skill.files.join(', ') || '(none)'}`,
      );
    }
    throw err;
  }
  // Resolve the skill dir too: a symlinked companion file (or, in principle, a
  // symlinked skill dir) must still land inside the *real* skill directory.
  const realDir = await fs.realpath(skill.dir);
  const relFromRealDir = path.relative(realDir, realTarget);
  if (relFromRealDir === '' || relFromRealDir.startsWith('..') || path.isAbsolute(relFromRealDir)) {
    throw new Error(`File path '${file}' escapes the '${skill.name}' skill directory`);
  }

  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) {
    throw new Error(`'${file}' is not a regular file in skill '${skill.name}'`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File '${file}' is ${stat.size} bytes, exceeding the ${MAX_READ_BYTES}-byte limit`);
  }

  const content = await fs.readFile(realTarget, 'utf8');
  return { file, content };
}

/**
 * Registers `load_skill`. Without `file`: the SKILL.md body, the skill's
 * directory, and the list of companion files available inside it. With
 * `file`: the text content of that companion file (read-only, confined to
 * the skill directory — see `readSkillFile`).
 */
export function registerSkillTool(manager: RegistryToolManager, catalog: SkillCatalog): ToolSpec {
  const spec: ToolSpec = {
    name: 'load_skill',
    description:
      "Load the full instructions of an available skill by name. Without 'file', returns the skill's " +
      "body plus the list of companion files available inside its directory. With 'file' set to one of " +
      "those relative paths (e.g. 'reference/page-object-model.md'), returns that file's text content " +
      "instead. Absolute paths, '..' escapes, and symlinks resolving outside the skill directory are rejected.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, as listed in "Available skills"' },
        file: {
          type: 'string',
          description:
            "Optional: a companion file's path, relative to this skill's directory, as listed in the " +
            "'files' array returned when loading the skill without this argument.",
        },
      },
      required: ['name'],
    },
  };
  manager.register(spec, async (args) => {
    const name = typeof args.name === 'string' ? args.name : '';
    const skill = catalog.get(name);
    if (!skill) {
      const available = catalog.list().map((s) => s.name);
      throw new Error(`Unknown skill '${name}'. Available skills: ${available.join(', ') || '(none)'}`);
    }
    if (args.file !== undefined) {
      if (typeof args.file !== 'string' || args.file === '') {
        throw new Error("Missing or invalid 'file' argument");
      }
      const { file, content } = await readSkillFile(skill, args.file);
      return { name: skill.name, file, content };
    }
    return { name: skill.name, dir: skill.dir, body: skill.body, files: skill.files };
  });
  return spec;
}

// localeCompare depends on the host ICU/locale; the prompt must be identical on every machine.
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

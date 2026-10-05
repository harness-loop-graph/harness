import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolSpec } from '../contracts/core.js';
import type { RegistryToolManager } from './tool-manager.js';

export interface SkillMeta {
  name: string;
  description: string;
}

interface SkillEntry extends SkillMeta {
  dir: string;
  body: string;
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
      this.entries.set(name, { name, description, dir: path.dirname(skillFile), body });
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

/** Registers `load_skill`, returning a SKILL.md body + directory so the model can read referenced files. */
export function registerSkillTool(manager: RegistryToolManager, catalog: SkillCatalog): ToolSpec {
  const spec: ToolSpec = {
    name: 'load_skill',
    description: 'Load the full instructions of an available skill by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, as listed in "Available skills"' },
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
    return { name: skill.name, dir: skill.dir, body: skill.body };
  });
  return spec;
}

// localeCompare depends on the host ICU/locale; the prompt must be identical on every machine.
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

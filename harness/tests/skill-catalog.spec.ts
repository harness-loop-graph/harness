import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillCatalog, registerSkillTool } from '../src/components/skill-catalog.js';
import { RegistryToolManager, MAX_READ_BYTES } from '../src/components/tool-manager.js';
import { StubGuardrails } from '../src/components/guardrails.js';
import { FsContextManager } from '../src/components/context-manager.js';
import { OpenAICompatibleModelAdapter } from '../src/components/openai-compatible-adapter.js';
import type { ModelRequest } from '../src/contracts/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SKILLS_DIR = path.join(__dirname, 'fixtures', 'skills');

describe('SkillCatalog', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-catalog-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('loads name/description from valid SKILL.md frontmatter', async () => {
    const catalog = await SkillCatalog.load([FIXTURE_SKILLS_DIR]);
    expect(catalog.list()).toEqual([
      { name: 'writing-tests', description: 'Guidance for writing vitest specs in this repo' },
    ]);
  });

  it('exposes the body without frontmatter and the skill directory', async () => {
    const catalog = await SkillCatalog.load([FIXTURE_SKILLS_DIR]);
    const skill = catalog.get('writing-tests');
    expect(skill?.dir).toBe(path.join(FIXTURE_SKILLS_DIR, 'writing-tests'));
    expect(skill?.body).toContain('Use `describe`/`it` blocks');
    expect(skill?.body).not.toContain('---');
  });

  it('lists companion files recursively, excluding SKILL.md, as sorted relative paths', async () => {
    const catalog = await SkillCatalog.load([FIXTURE_SKILLS_DIR]);
    const skill = catalog.get('writing-tests');
    expect(skill?.files).toEqual(['helper.md', 'reference/page-object-model.md']);
  });

  it('does not hang or crash on a directory symlink cycle among companion files', async () => {
    const dir = path.join(workspace, 'cyclical-skill');
    const nested = path.join(dir, 'nested');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: cyclical\ndescription: has a cyclical companion dir\n---\nBody');
    await fs.writeFile(path.join(nested, 'note.md'), 'note');
    await fs.symlink(dir, path.join(nested, 'back-to-root'), 'dir'); // cycle: nested/back-to-root -> dir

    const catalog = await SkillCatalog.load([workspace]);
    expect(catalog.get('cyclical')?.files).toEqual(['nested/note.md']);
  });

  it('skips a companion directory it cannot read instead of failing the whole skill', async () => {
    const dir = path.join(workspace, 'locked-skill');
    const locked = path.join(dir, 'locked');
    await fs.mkdir(locked, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: locked\ndescription: has an unreadable companion dir\n---\nBody');
    await fs.writeFile(path.join(dir, 'ok.md'), 'ok');
    await fs.chmod(locked, 0o000);

    try {
      const catalog = await SkillCatalog.load([workspace]);
      expect(catalog.get('locked')?.files).toEqual(['ok.md']);
    } finally {
      await fs.chmod(locked, 0o755); // restore so afterEach can remove the workspace
    }
  });

  it('errors naming the file when frontmatter is missing', async () => {
    const dir = path.join(workspace, 'bad-skill');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    await fs.writeFile(file, '# No frontmatter here\n');

    await expect(SkillCatalog.load([workspace])).rejects.toThrow(file);
  });

  it('errors naming the file when a required field is missing', async () => {
    const dir = path.join(workspace, 'incomplete-skill');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    await fs.writeFile(file, '---\nname: incomplete\n---\nBody\n');

    await expect(SkillCatalog.load([workspace])).rejects.toThrow(file);
  });

  it('errors on duplicate skill names across directories', async () => {
    const dirA = path.join(workspace, 'a', 'dup');
    const dirB = path.join(workspace, 'b', 'dup');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    const content = '---\nname: dup\ndescription: dup skill\n---\nBody\n';
    await fs.writeFile(path.join(dirA, 'SKILL.md'), content);
    await fs.writeFile(path.join(dirB, 'SKILL.md'), content);

    await expect(SkillCatalog.load([path.join(workspace, 'a'), path.join(workspace, 'b')])).rejects.toThrow(/Duplicate skill name 'dup'/);
  });

  it('errors naming the config when the configured skills directory itself is missing', async () => {
    const missing = path.join(workspace, 'does-not-exist');
    await expect(SkillCatalog.load([missing])).rejects.toThrow(/Cannot read skills directory/);
  });

  it('propagates a non-ENOENT read error (e.g. SKILL.md is itself a directory) naming the file', async () => {
    const dir = path.join(workspace, 'weird-skill');
    // A directory named SKILL.md makes fs.readFile fail with EISDIR, not ENOENT:
    // this must fail fast rather than being silently skipped as "not a skill".
    await fs.mkdir(path.join(dir, 'SKILL.md'), { recursive: true });

    await expect(SkillCatalog.load([workspace])).rejects.toThrow(path.join(dir, 'SKILL.md'));
  });

  it('parses folded (>) and literal (|) block scalars in frontmatter', async () => {
    await fs.mkdir(path.join(workspace, 'folded'));
    await fs.writeFile(
      path.join(workspace, 'folded', 'SKILL.md'),
      '---\nname: folded\ndescription: >\n  First line,\n  second: with colon.\n\nversion: 1\n---\nBody',
    );
    await fs.mkdir(path.join(workspace, 'literal'));
    await fs.writeFile(
      path.join(workspace, 'literal', 'SKILL.md'),
      '---\nname: literal\ndescription: |-\n  Line one\n  Line two\n---\nBody',
    );
    const catalog = await SkillCatalog.load([workspace]);
    expect(catalog.list()).toEqual([
      { name: 'folded', description: 'First line, second: with colon.' },
      { name: 'literal', description: 'Line one\nLine two' },
    ]);
  });

  it('lists skills sorted by name regardless of on-disk order', async () => {
    for (const name of ['charlie', 'alpha', 'bravo']) {
      const dir = path.join(workspace, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`);
    }

    const catalog = await SkillCatalog.load([workspace]);
    expect(catalog.list().map((s) => s.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });
});

describe('Context rendering with skills', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-context-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('FsContextManager populates Context.skills from the catalog', async () => {
    const catalog = await SkillCatalog.load([FIXTURE_SKILLS_DIR]);
    const contextManager = new FsContextManager(catalog);
    const ctx = await contextManager.prepare('do something', workspace);
    expect(ctx.skills).toEqual([
      { name: 'writing-tests', description: 'Guidance for writing vitest specs in this repo' },
    ]);
  });

  it('Context.skills is omitted without a catalog', async () => {
    const contextManager = new FsContextManager();
    const ctx = await contextManager.prepare('do something', workspace);
    expect(ctx.skills).toBeUndefined();
  });

  it('the adapter renders an Available skills section only when skills exist', async () => {
    vi.stubEnv('MODEL_API_KEY', 'test-key');
    vi.stubEnv('MODEL_ID', 'test-model');
    vi.stubEnv('MODEL_BASE_URL', 'https://test.example/v1');
    let capturedBody: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const adapter = new OpenAICompatibleModelAdapter({ fetchImpl });

    const withSkills: ModelRequest = {
      task: 'do something',
      context: {
        projectRoot: workspace,
        files: [],
        skills: [{ name: 'writing-tests', description: 'Guidance for writing vitest specs' }],
      },
      availTools: [],
    };
    await adapter.complete(withSkills);
    const systemMessage = capturedBody.messages.find((m: any) => m.role === 'system');
    expect(systemMessage.content).toContain('Available skills:');
    expect(systemMessage.content).toContain('writing-tests: Guidance for writing vitest specs');
    expect(systemMessage.content).toContain('load_skill');

    const withoutSkills: ModelRequest = {
      task: 'do something',
      context: { projectRoot: workspace, files: [] },
      availTools: [],
    };
    await adapter.complete(withoutSkills);
    const noSkillsSystem = capturedBody.messages.find((m: any) => m.role === 'system');
    expect(noSkillsSystem).toBeUndefined();
  });
});

describe('load_skill tool', () => {
  it('returns the skill body and directory for a known skill', async () => {
    const catalog = await SkillCatalog.load([FIXTURE_SKILLS_DIR]);
    const guardrails = new StubGuardrails(['load_skill']);
    const manager = new RegistryToolManager(guardrails);
    registerSkillTool(manager, catalog);

    const result = await manager.execute({ type: 'tool_call', tool: 'load_skill', args: { name: 'writing-tests' } });

    expect(result.success).toBe(true);
    const payload = result.result as { name: string; dir: string; body: string; files: string[] };
    expect(payload.name).toBe('writing-tests');
    expect(payload.dir).toBe(path.join(FIXTURE_SKILLS_DIR, 'writing-tests'));
    expect(payload.body).toContain('Use `describe`/`it` blocks');
    expect(payload.files).toEqual(['helper.md', 'reference/page-object-model.md']);
  });

  it('fails with the list of available skills for an unknown name', async () => {
    const catalog = await SkillCatalog.load([FIXTURE_SKILLS_DIR]);
    const guardrails = new StubGuardrails(['load_skill']);
    const manager = new RegistryToolManager(guardrails);
    registerSkillTool(manager, catalog);

    const result = await manager.execute({ type: 'tool_call', tool: 'load_skill', args: { name: 'nope' } });

    expect(result.success).toBe(false);
    expect(String(result.result)).toContain('writing-tests');
  });
});

describe('load_skill tool: file argument', () => {
  let workspace: string;
  let skillsDir: string;
  let catalog: SkillCatalog;
  let manager: RegistryToolManager;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-file-'));
    skillsDir = path.join(workspace, 'skills');
    const demoDir = path.join(skillsDir, 'demo');
    await fs.mkdir(path.join(demoDir, 'reference'), { recursive: true });
    await fs.writeFile(
      path.join(demoDir, 'SKILL.md'),
      '---\nname: demo\ndescription: demo skill\n---\nBody\n',
    );
    await fs.writeFile(path.join(demoDir, 'reference', 'notes.md'), 'Reference notes.\n');

    // A file outside any skill directory, used to prove escape attempts are rejected.
    await fs.mkdir(path.join(workspace, 'outside'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'outside', 'secret.md'), 'should never be readable\n');
    await fs.symlink(
      path.join(workspace, 'outside', 'secret.md'),
      path.join(demoDir, 'reference', 'escape-link.md'),
    );

    catalog = await SkillCatalog.load([skillsDir]);
    manager = new RegistryToolManager(new StubGuardrails(['load_skill']));
    registerSkillTool(manager, catalog);
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('reads a companion file by its relative path', async () => {
    const result = await manager.execute({
      type: 'tool_call',
      tool: 'load_skill',
      args: { name: 'demo', file: 'reference/notes.md' },
    });

    expect(result.success).toBe(true);
    const payload = result.result as { name: string; file: string; content: string };
    expect(payload.name).toBe('demo');
    expect(payload.file).toBe('reference/notes.md');
    expect(payload.content).toBe('Reference notes.\n');
  });

  it('rejects a ".." escape attempt', async () => {
    const result = await manager.execute({
      type: 'tool_call',
      tool: 'load_skill',
      args: { name: 'demo', file: '../../outside/secret.md' },
    });

    expect(result.success).toBe(false);
    expect(String(result.result)).toContain('escapes');
  });

  it('rejects an absolute path', async () => {
    const result = await manager.execute({
      type: 'tool_call',
      tool: 'load_skill',
      args: { name: 'demo', file: path.join(workspace, 'outside', 'secret.md') },
    });

    expect(result.success).toBe(false);
    expect(String(result.result)).toContain('absolute');
  });

  it('rejects a symlink that resolves outside the skill directory', async () => {
    const result = await manager.execute({
      type: 'tool_call',
      tool: 'load_skill',
      args: { name: 'demo', file: 'reference/escape-link.md' },
    });

    expect(result.success).toBe(false);
    expect(String(result.result)).toContain('escapes');
  });

  it('rejects a file over the size cap with a clear error', async () => {
    const demoDir = path.join(skillsDir, 'demo');
    await fs.writeFile(path.join(demoDir, 'reference', 'big.md'), 'x'.repeat(MAX_READ_BYTES + 1));
    const biggerCatalog = await SkillCatalog.load([skillsDir]);
    const biggerManager = new RegistryToolManager(new StubGuardrails(['load_skill']));
    registerSkillTool(biggerManager, biggerCatalog);

    const result = await biggerManager.execute({
      type: 'tool_call',
      tool: 'load_skill',
      args: { name: 'demo', file: 'reference/big.md' },
    });

    expect(result.success).toBe(false);
    expect(String(result.result)).toContain('exceeding');
    expect(String(result.result)).toContain(String(MAX_READ_BYTES));
  });

  it('fails with the list of available files for an unknown file', async () => {
    const result = await manager.execute({
      type: 'tool_call',
      tool: 'load_skill',
      args: { name: 'demo', file: 'nope.md' },
    });

    expect(result.success).toBe(false);
    expect(String(result.result)).toContain('reference/notes.md');
  });
});

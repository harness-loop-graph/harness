import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolSpec } from './contracts/core.js';
import { McpToolProvider, type McpServerConfig } from './components/mcp-tool-provider.js';
import { SkillCatalog, registerSkillTool } from './components/skill-catalog.js';
import type { RegistryToolManager } from './components/tool-manager.js';

export interface HarnessConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
  skillsDirs?: string[];
}

/** A harness config file, parsed and with every relative path resolved against its own directory. */
export interface HarnessConfig {
  path: string;
  mcpServers: Record<string, McpServerConfig>;
  skillsDirs: string[];
}

/**
 * Parses and validates already-read harness config text. Split out from
 * `loadHarnessConfig` so a caller that needs the raw bytes for something
 * else (e.g. hashing) can read the file once and reuse the same buffer for
 * both, instead of reading it twice.
 */
export function parseHarnessConfig(text: string, configDir: string, resolvedPath: string): HarnessConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Harness config '${resolvedPath}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Harness config '${resolvedPath}' must be a JSON object`);
  }
  const file = parsed as HarnessConfigFile;

  const mcpServers: Record<string, McpServerConfig> = {};
  if (file.mcpServers !== undefined) {
    if (typeof file.mcpServers !== 'object' || file.mcpServers === null || Array.isArray(file.mcpServers)) {
      throw new Error(`Harness config '${resolvedPath}': 'mcpServers' must be an object`);
    }
    for (const [name, server] of Object.entries(file.mcpServers)) {
      if (typeof server !== 'object' || server === null || typeof server.command !== 'string' || server.command === '') {
        throw new Error(`Harness config '${resolvedPath}': mcpServers.${name} must have a non-empty 'command' string`);
      }
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((a) => typeof a !== 'string'))) {
        throw new Error(`Harness config '${resolvedPath}': mcpServers.${name}.args must be an array of strings`);
      }
      if (server.env !== undefined) {
        const validEnv =
          typeof server.env === 'object' &&
          server.env !== null &&
          !Array.isArray(server.env) &&
          Object.values(server.env).every((v) => typeof v === 'string');
        if (!validEnv) {
          throw new Error(`Harness config '${resolvedPath}': mcpServers.${name}.env must be an object of string values`);
        }
      }
      if (server.cwd !== undefined && typeof server.cwd !== 'string') {
        throw new Error(`Harness config '${resolvedPath}': mcpServers.${name}.cwd must be a string`);
      }
      mcpServers[name] = {
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd ? path.resolve(configDir, server.cwd) : undefined,
      };
    }
  }

  let skillsDirs: string[] = [];
  if (file.skillsDirs !== undefined) {
    if (!Array.isArray(file.skillsDirs) || file.skillsDirs.some((d) => typeof d !== 'string')) {
      throw new Error(`Harness config '${resolvedPath}': 'skillsDirs' must be an array of strings`);
    }
    skillsDirs = file.skillsDirs.map((d) => path.resolve(configDir, d));
  }

  return { path: resolvedPath, mcpServers, skillsDirs };
}

/**
 * Loads `{ mcpServers, skillsDirs }` from a JSON file. Relative paths
 * (skillsDirs, and each server's cwd) are resolved against the config
 * file's directory, so a config is portable regardless of the caller's cwd.
 */
export async function loadHarnessConfig(configPath: string): Promise<HarnessConfig> {
  const resolvedPath = path.resolve(configPath);
  const configDir = path.dirname(resolvedPath);

  let text: string;
  try {
    text = await fs.readFile(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read harness config '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`);
  }

  return parseHarnessConfig(text, configDir, resolvedPath);
}

export interface WiredHarnessConfig {
  specs: ToolSpec[];
  catalog?: SkillCatalog;
  allowedToolNames: string[];
  close(): Promise<void>;
}

/**
 * Convenience for a single harness: connects MCP, loads skills, and
 * registers everything (MCP tools + `load_skill`) into `manager`.
 *
 * A run that builds several harnesses sharing one MCP connection (C3 builds
 * one per graph node) should NOT call this per harness, since each call
 * opens its own connections. Instead, connect a `McpToolProvider` and load a
 * `SkillCatalog` once, then call `provider.registerInto(manager)` and
 * `registerSkillTool(manager, catalog)` for each harness's manager.
 */
export async function wireHarnessConfig(config: HarnessConfig, manager: RegistryToolManager): Promise<WiredHarnessConfig> {
  const provider = new McpToolProvider({ mcpServers: config.mcpServers });
  // connect() already closes everything it opened if it fails partway
  // through (see McpToolProvider); a failure here needs no extra cleanup.
  const mcpSpecs = await provider.connect();

  try {
    provider.registerInto(manager);

    let catalog: SkillCatalog | undefined;
    const specs = [...mcpSpecs];
    if (config.skillsDirs.length > 0) {
      catalog = await SkillCatalog.load(config.skillsDirs);
      if (catalog.list().length > 0) {
        specs.push(registerSkillTool(manager, catalog));
      }
    }

    return {
      specs,
      catalog,
      allowedToolNames: specs.map((s) => s.name),
      close: () => provider.close(),
    };
  } catch (err) {
    // registerInto() or SkillCatalog.load() failed after a successful
    // connect(): the provider is otherwise never returned, so close it here.
    await provider.close();
    throw err;
  }
}

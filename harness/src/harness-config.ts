import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolSpec } from './contracts/core.js';
import { McpToolProvider, type McpServerConfig } from './components/mcp-tool-provider.js';
import { SkillCatalog, registerSkillTool } from './components/skill-catalog.js';
import type { RegistryToolManager } from './components/tool-manager.js';
import { OpenAICompatibleModelAdapter, type OpenAICompatibleAdapterConfig } from './components/openai-compatible-adapter.js';
import { RoutingModelAdapter, type CustomRouter } from './components/routing-model-adapter.js';
import type { ModelAdapter } from './components/model-adapter.js';

/** One named route in a `router` config section: which model/endpoint it dials. */
export interface RouterRouteConfig {
  model: string;
  baseUrl?: string;
  /** Env var holding the API key. Omitted → falls back to the default model's env (MODEL_API_KEY). Never a literal key. */
  apiKeyEnv?: string;
}

export interface RouterConfigFile {
  longContextThreshold?: number;
  /** Route names other than 'default' (supplied by the caller): 'longContext', 'retry', or any name a customRouter can return. */
  routes: Record<string, RouterRouteConfig>;
  /** Path (relative to the config file) to a module whose default (or named `route`) export is a CustomRouter function. */
  customRouterPath?: string;
}

/** `RouterConfigFile` with `customRouterPath` resolved to an absolute path. */
export interface RouterConfig {
  longContextThreshold?: number;
  routes: Record<string, RouterRouteConfig>;
  customRouterPath?: string;
}

export interface HarnessConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
  skillsDirs?: string[];
  router?: RouterConfigFile;
}

/** A harness config file, parsed and with every relative path resolved against its own directory. */
export interface HarnessConfig {
  path: string;
  mcpServers: Record<string, McpServerConfig>;
  skillsDirs: string[];
  router?: RouterConfig;
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

  let router: RouterConfig | undefined;
  if (file.router !== undefined) {
    const r = file.router;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) {
      throw new Error(`Harness config '${resolvedPath}': 'router' must be an object`);
    }
    if (
      r.longContextThreshold !== undefined &&
      (typeof r.longContextThreshold !== 'number' || !Number.isFinite(r.longContextThreshold) || r.longContextThreshold <= 0)
    ) {
      throw new Error(`Harness config '${resolvedPath}': router.longContextThreshold must be a positive number`);
    }
    if (typeof r.routes !== 'object' || r.routes === null || Array.isArray(r.routes) || Object.keys(r.routes).length === 0) {
      throw new Error(`Harness config '${resolvedPath}': router.routes must be a non-empty object`);
    }
    // Object.create(null) so a route named '__proto__' assigns a plain own
    // property instead of reaching the Object.prototype accessor; rejected
    // explicitly below anyway, for a clear error instead of silent handling.
    const routes: Record<string, RouterRouteConfig> = Object.create(null);
    for (const [name, route] of Object.entries(r.routes)) {
      if (name === 'default') {
        throw new Error(
          `Harness config '${resolvedPath}': router.routes must not declare 'default' (the caller's existing model is always the default route)`,
        );
      }
      if (name === '__proto__') {
        throw new Error(`Harness config '${resolvedPath}': router.routes must not declare '__proto__'`);
      }
      if (typeof route !== 'object' || route === null || typeof route.model !== 'string' || route.model === '') {
        throw new Error(`Harness config '${resolvedPath}': router.routes.${name}.model must be a non-empty string`);
      }
      if (route.baseUrl !== undefined && typeof route.baseUrl !== 'string') {
        throw new Error(`Harness config '${resolvedPath}': router.routes.${name}.baseUrl must be a string`);
      }
      if (route.apiKeyEnv !== undefined && (typeof route.apiKeyEnv !== 'string' || route.apiKeyEnv === '')) {
        throw new Error(`Harness config '${resolvedPath}': router.routes.${name}.apiKeyEnv must be a non-empty string`);
      }
      routes[name] = { model: route.model, baseUrl: route.baseUrl, apiKeyEnv: route.apiKeyEnv };
    }
    if (r.customRouterPath !== undefined && (typeof r.customRouterPath !== 'string' || r.customRouterPath === '')) {
      throw new Error(`Harness config '${resolvedPath}': router.customRouterPath must be a non-empty string`);
    }
    router = {
      longContextThreshold: r.longContextThreshold,
      routes,
      customRouterPath: r.customRouterPath ? path.resolve(configDir, r.customRouterPath) : undefined,
    };
  }

  return { path: resolvedPath, mcpServers, skillsDirs, router };
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

export interface CreateRoutedModelOptions {
  /** Adapter constructor for named routes; defaults to `OpenAICompatibleModelAdapter`. Injectable for tests. */
  makeAdapter?: (config: OpenAICompatibleAdapterConfig) => ModelAdapter;
}

/**
 * Builds a `RoutingModelAdapter` from a harness config's `router` section:
 * `defaultAdapter` becomes the 'default' route (it is never declared in the
 * config file), and every configured route gets its own adapter instance.
 * Each route's API key comes from `apiKeyEnv` (never a literal key in the
 * config); a missing env var fails fast, naming the route and the variable.
 * `customRouterPath`, if set, is dynamically imported and its default (or
 * named `route`) export used as the `CustomRouter` function.
 */
export async function createRoutedModel(
  routerConfig: RouterConfig,
  defaultAdapter: ModelAdapter,
  options: CreateRoutedModelOptions = {},
): Promise<RoutingModelAdapter> {
  const makeAdapter =
    options.makeAdapter ?? ((config: OpenAICompatibleAdapterConfig) => new OpenAICompatibleModelAdapter(config));

  const routes: Record<string, ModelAdapter> = { default: defaultAdapter };
  for (const [name, route] of Object.entries(routerConfig.routes)) {
    const apiKey = route.apiKeyEnv ? process.env[route.apiKeyEnv] : process.env.MODEL_API_KEY;
    if (!apiKey) {
      const source = route.apiKeyEnv ? `env var '${route.apiKeyEnv}' (apiKeyEnv)` : `env var 'MODEL_API_KEY' (no apiKeyEnv set)`;
      throw new Error(`Harness config router: route '${name}' needs ${source}, which is not set`);
    }
    routes[name] = makeAdapter({
      apiKey,
      model: route.model,
      baseUrl: route.baseUrl ?? process.env.MODEL_BASE_URL,
    });
  }

  let customRouter: CustomRouter | undefined;
  if (routerConfig.customRouterPath) {
    const mod = (await import(pathToFileURL(routerConfig.customRouterPath).href)) as {
      default?: unknown;
      route?: unknown;
    };
    const candidate = mod.default ?? mod.route;
    if (typeof candidate !== 'function') {
      throw new Error(
        `Harness config router: customRouterPath '${routerConfig.customRouterPath}' must export a function as default or 'route'`,
      );
    }
    customRouter = candidate as CustomRouter;
  }

  return new RoutingModelAdapter({ routes, longContextThreshold: routerConfig.longContextThreshold, customRouter });
}

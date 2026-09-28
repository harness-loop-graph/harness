# MCP tools and skills

Two additions on top of the C1/C2/C3 harness: tools sourced from external
MCP servers, and agent skills (`SKILL.md`) loaded on demand. Both go through
the same guardrail + audit path as the built-in tools — there is no
parallel execution path for them.

## MCP tool provider — `McpToolProvider`

`src/components/mcp-tool-provider.ts`. Config shape matches the common
`{ mcpServers: { name: { command, args, env, cwd } } }` convention.

- `connect()` spawns each server over stdio (`StdioClientTransport`), calls
  `listTools()`, and builds one `ToolSpec` per remote tool, named
  `mcp__<server>__<tool>` (sanitized to `[a-zA-Z0-9_-]`, capped at 64
  chars). A connection failure throws immediately — a silently missing
  server would corrupt an experiment run, so there is no soft-fail path.
  If any server fails to connect, or two tools sanitize to the same name,
  every client already opened is closed before the error is rethrown — a
  partial `connect()` never leaks server processes.
- A tool-name collision — two MCP tools sanitizing to the same name, or an
  MCP tool colliding with a tool already registered in the target manager
  (a built-in, `load_skill`, or another MCP tool) — throws a clear error
  naming both origins instead of silently overriding the earlier
  registration.
- `registerInto(manager)` registers the discovered tools (spec + handler)
  into a `RegistryToolManager`, so every call is guardrail-checked and
  audited exactly like `write_file`/`read_file`/`run_command`. `connect()`
  and `registerInto()` are split on purpose: one MCP connection can be
  shared across several `RegistryToolManager` instances, which is what the
  experiment runner does for C3 (one harness, and one tool manager, per
  graph node — see `experiment/runner/run-experiment.mjs`).
- The registered handler calls `client.callTool(...)`; a result with
  `isError: true` is turned into a thrown error (`RegistryToolManager`
  turns that into a failed `ToolResult`), and a normal result's `text`
  content parts are joined and returned.
- `close()` closes every open client connection and drops the discovered
  registrations (their handlers would otherwise call closed clients).

Tests: `tests/mcp-tool-provider.spec.ts` exercises a tiny fixture MCP
server (`tests/fixtures/mcp-fixture-server.mjs`, built on the SDK's
low-level `Server` + `StdioServerTransport`) end to end, including the
`isError` path and sharing one connection across two tool managers.

## Skill catalog — `SkillCatalog`

`src/components/skill-catalog.ts`. Loads every `<dir>/<skill>/SKILL.md`
under one or more directories, given directories processed in the order
passed in and, within each directory, subdirectories sorted by name — so
`list()` and the rendered "Available skills" prompt are stable across
runs regardless of the OS's `readdir` order. `list()` itself is also
sorted by skill name. A skill file must start with a `---` frontmatter
block containing `name` and `description` (simple `key: value` lines,
quoted values allowed — no YAML dependency). Missing/invalid frontmatter
and duplicate skill names both throw, naming the offending file. A missing
configured skills directory throws; inside a directory, only a missing
`SKILL.md` (ENOENT) is treated as "not a skill" and skipped — any other
read failure (permissions, a `SKILL.md` that is itself a directory, etc.)
fails fast, naming the file.

Progressive disclosure: `catalog.list()` returns only `{ name,
description }` pairs, which `FsContextManager` (constructor now takes an
optional `SkillCatalog`) puts on `Context.skills`, and `GlmModelAdapter`
renders as an "Available skills" system-message section — only when at
least one skill is loaded — instructing the model to call `load_skill`
before doing work a skill covers. The full body (frontmatter stripped)
and the skill's directory (so the model can `read_file` files the skill
references) are only returned by the `load_skill` tool
(`registerSkillTool`), on demand. An unknown skill name is a failed
`ToolResult` listing the available skill names.

Tests: `tests/skill-catalog.spec.ts` covers frontmatter parsing (valid,
missing, incomplete, duplicate), `Context.skills` population (present vs.
absent), the adapter's conditional rendering, and `load_skill` (found vs.
unknown).

## Harness config loader — `src/harness-config.ts`

`loadHarnessConfig(path)` reads and validates a JSON file
`{ mcpServers?, skillsDirs? }`: `skillsDirs` entries and each server's
`cwd` are resolved relative to the config file's own directory (not the
caller's `cwd`), so a config is portable. Invalid shapes (missing
`command`, non-array `args`/non-string entries, non-string-record `env`,
non-string `cwd`, non-object `mcpServers`, non-array `skillsDirs`, bad
JSON, unreadable file) all throw with the config path (and, for a server
field, the server name) in the message. The JSON-parsing and validation
logic lives in `parseHarnessConfig(text, configDir, resolvedPath)`, a pure
function `loadHarnessConfig` calls after reading the file — a caller that
also needs the raw bytes (e.g. to hash them) can read the file once and
pass the same buffer to both, instead of reading it twice.

`wireHarnessConfig(config, manager)` is a convenience for the common
single-harness case: it connects a fresh `McpToolProvider`, loads a fresh
`SkillCatalog`, registers everything into `manager`, and returns
`{ specs, catalog, allowedToolNames, close }`. If anything fails after a
successful `connect()` (`registerInto()`'s collision check, or
`SkillCatalog.load()`), the provider is closed before the error is
rethrown. It deliberately does **not** try to share connections across
managers — a run that builds several harnesses (C3) connects a
`McpToolProvider` and loads a `SkillCatalog` once, then calls
`provider.registerInto(manager)` / `registerSkillTool(manager, catalog)`
per harness directly, reusing the same MCP connection and skill catalog
instance. `experiment/runner/run-experiment.mjs` does exactly this.

Tests: `tests/harness-config.spec.ts`, against `examples/harness-config.json`
(which points at the fixture MCP server and an example `greeter` skill
under `examples/skills/`).

## What C1/C2/C3 get identically

The runner wires the same MCP tools, `load_skill`, and guardrail allowlist
into every configuration's harness(es) — see `experiment/runner/README.md`. Without
`--harness-config`, none of this code path runs, so C1/C2/C3 behavior is
unchanged.

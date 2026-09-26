# Feature: MCP and Skills support in the harness

## Objective
The harness can consume tools from MCP servers and load agent skills (SKILL.md), and the experiment runner applies both identically to C1, C2 and C3.

## Problem / Why
Advisor feedback: the harness lacks MCP and skills support. Both must be usable during experiment runs, not only as a demo capability.

## Scope
- `glm/`: MCP client tool provider, skills catalog + `load_skill` tool, context/adapter rendering, exports, tests, docs.
- `app/runner/`: `--harness-config` option wiring MCP servers and skill dirs into `buildHarness` for every configuration.

## Constraints
- Identical MCP/skills setup across C1/C2/C3 (otherwise config differences confound the experiment).
- Every MCP tool call goes through `RegistryToolManager` → guardrails + audit log.
- Config format compatible with the common `{ "mcpServers": { name: { command, args, env } } }` shape.
- Skills use progressive disclosure: only name + description in context; body via `load_skill`.
- Minimal comments (non-obvious info only).

## TDD
Mode: off (source: no project/session TDD configuration). Runner: `npm test` (vitest) + `npm run build` (tsc) in `glm/`; `node --check` for the runner.

## Tasks
- [x] T1 — MCP tool provider (`@modelcontextprotocol/sdk` stdio client), tools namespaced `mcp__<server>__<tool>`, registered in `RegistryToolManager`; tests with a local fixture MCP server.
- [x] T2 — Skills: `SkillCatalog` (frontmatter `name`/`description`), `load_skill` tool, skill index in `Context` rendered by the GLM adapter; tests.
- [x] T3 — Public exports, harness-config loader, README/docs update.
- [x] T4 — Runner: `--harness-config <path>`, one shared MCP connection per run, guardrail allowlist extended, config recorded in run metrics, clean shutdown; README.

- [x] T5 — glm review fixes: skills sorted deterministically; unreadable/invalid skill dirs fail fast (only a missing SKILL.md is skipped); `connect()` tracks/closes clients on partial failure; `wireHarnessConfig` closes what it opened on failure; tool-name collision → error; validate `args`/`env`; guardrail-deny test for MCP + `load_skill`; test cleanup in finally/afterEach; restore env in tests.
- [x] T6 — runner review fixes: close MCP if skills load fails; config failures recorded in run-report; `--harness-config` without value → usage error; hash and parse the same buffer; `close()` errors logged without masking the original error; unit tests for the runner's harness-config wiring.

## Acceptance criteria
- A run with a harness config exposes MCP tools and skills to the model in C1, C2 and C3.
- Guardrails deny unlisted tools; MCP calls appear in the audit log.
- Without a harness config, behavior is unchanged.
- `npm test` and `npm run build` pass in `glm/`.

## Progress / Evidence

### T1 — MCP tool provider
- Commit: 5347a3f — `feat(mcp): add stdio MCP tool provider`
- `npm run build`: pass. `npm test`: 8 files / 54 tests pass (includes
  `tests/mcp-tool-provider.spec.ts` against the fixture server).
- `@modelcontextprotocol/sdk@1.30.1` added as a dependency.
- Deviation: `connect()` no longer takes a manager and registers directly;
  it now returns specs from stored `{spec, handler}` pairs, and a separate
  `registerInto(manager)` performs the registration. Reason: C3 builds one
  harness (and tool manager) per graph node but the run must share a single
  MCP connection across all of them — a `connect(manager)` API would force
  either one connection per harness or a manager built before the servers
  are known.

### T2 — Skills
- Commit: d1e15a0 — `feat(skills): add SKILL.md catalog and load_skill tool`
- `npm run build`: pass. `npm test`: 8 files / 54 tests pass (includes
  `tests/skill-catalog.spec.ts`: frontmatter parsing, duplicate names,
  `Context.skills` population, adapter rendering, `load_skill`).

### T3 — Exports, harness-config loader, docs
- Commit: f00195e — `feat(harness-config): add config loader, public exports and docs`
- `npm run build`: pass. `npm test`: pass (adds
  `tests/harness-config.spec.ts` against `examples/harness-config.json`).
- Exports added to `src/index.ts`: `mcp-tool-provider`, `skill-catalog`,
  `harness-config`.
- Docs: `docs/mcp-skills.md` (new), `docs/README.md` and
  `docs/architecture.md` updated to reference it, top-level `README.md`
  gets an "MCP tools and skills" section. Example config + skill added
  under `glm/examples/`.
- Deviation: `wireHarnessConfig(config, manager)` connects/loads fresh MCP
  + skill instances rather than accepting pre-connected ones — it is a
  convenience for the single-harness case only. A run sharing one MCP
  connection across several harnesses (the runner, T4) uses the lower-level
  `McpToolProvider`/`SkillCatalog` primitives directly instead of this
  helper, since calling it per harness would reconnect per harness.

### T4 — Runner wiring (repo: `app`, branch `feat/harness-config`)
- Commit: `app@29a00f4` — `feat(runner): wire MCP tools and skills into C1/C2/C3 via --harness-config`
- `node --check runner/run-experiment.mjs`: pass.
- No-model wiring check (throwaway script against
  `glm/examples/harness-config.json` + the fixture MCP server): registered
  tool names include `mcp__fixture__echo`, `mcp__fixture__fail`,
  `load_skill`; a guardrail-allowed `mcp__fixture__echo` call and a
  `load_skill('greeter')` call both succeed end to end.
- `--dry-run` verified byte-identical plan JSON without `--harness-config`,
  and an added `harnessConfig` field (path only, no connection opened)
  with it.
- `run-report.json` gains `harnessConfig: { path, sha256, mcpServers,
  toolNames, skillNames }` only when `--harness-config` is passed.
- Deviation: none from the design; `wireHarnessConfig` (T3's single-harness
  convenience) is intentionally not used here — the runner connects
  `McpToolProvider` and loads `SkillCatalog` directly once per run and
  reuses them (`registerInto` / `registerSkillTool`) per harness, per the
  T3 deviation note above.

### Native review (RDD on, both medium)
- app `feat/harness-config`: reliability lens, approved + acknowledged (lineage review-7c283696d9725e62). Advisory: MCP connection leak if skills load fails; no run-report on config failure; `--harness-config` without value → TypeError; config read twice for hash; close() error masks original; no runner tests. R3-003 (allowlist changed) refuted: `DEFAULT_ALLOWED_TOOLS` equals the previous three names.
- glm `feat/mcp-skills`: reliability lens, approved + acknowledged (lineage review-eeb80d880cb37fb9). Advisory: leaks on partial connect failure (`wireHarnessConfig`, untracked client on `connect()` reject); tool-name collisions after sanitize/truncate; skill order depends on `readdir` (non-deterministic prompt across runs); bare catch skips unreadable skills; args/env unvalidated; no guardrail-deny test; test cleanup/env pollution.

### T5 — glm review fixes
- Commit: d8c7242 — `fix(mcp-skills): address review findings on ordering, leaks and collisions`
- `npm run build`: pass. `npm test`: 8 files / 65 tests pass (was 54; +11
  new: guardrail-deny for MCP + `load_skill`, deterministic sort order,
  non-ENOENT skill read errors, missing skills dir, partial-connect
  cleanup, two collision cases, args/env/cwd validation, wireHarnessConfig
  cleanup-on-failure).
- `SkillCatalog`: subdirectories sorted by name before loading, `list()`
  sorted by name; a non-ENOENT `SKILL.md` read error now throws naming the
  file instead of being silently skipped.
- `McpToolProvider.connect()`: tracks a client as soon as `client.connect()`
  succeeds; any later failure (a subsequent server, a name collision)
  closes every client opened so far (and drops registrations) before
  rethrowing — `close()` now also clears `registrations` so no stale
  handler referencing a closed client survives.
- `McpToolProvider.registerInto()`: throws naming both origins on a
  tool-name collision against an already-registered tool (built-in,
  `load_skill`, or an earlier MCP registration) instead of overriding it.
- `wireHarnessConfig`: closes the provider if `registerInto()` or
  `SkillCatalog.load()` fails after a successful `connect()`.
- `harness-config.ts`: validates `mcpServers[].args` (string array),
  `.env` (string→string record) and `.cwd` (string), naming the config
  path and server. Extracted `parseHarnessConfig(text, configDir, path)`
  (pure) from `loadHarnessConfig` so a caller can parse an already-read
  buffer.
- `docs/mcp-skills.md` updated (ordering, fail-fast, collisions, close()).
- Deviation: none from the review findings as scoped.

### T6 — runner review fixes (repo: `app`, branch `feat/harness-config`)
- Commit: `app@1f2e8a4` — `fix(runner): address review findings on harness-config failures and cleanup`
- `node --check runner/run-experiment.mjs`: pass.
- `node --test runner/run-experiment.test.mjs`: 4/4 pass (new file; uses
  glm's fixture MCP server + skill fixtures, no model calls). Covers
  `run-report.json`'s `harnessConfig` metadata, the guardrail allowlist
  extended with MCP tools + `load_skill`, the MCP provider being closed
  when `SkillCatalog.load()` fails, and that a run without
  `--harness-config` registers exactly the pre-existing 3 built-in tools.
- Manual `--dry-run` checks: c1/c2/c3 without `--harness-config` produce
  byte-identical plan JSON (module differences aside) to before T6; with
  `--harness-config` the `harnessConfig` path field is added, unchanged;
  `--harness-config` with no value now prints a usage error (exit 1)
  instead of a raw `TypeError`.
- Manual end-to-end check: `--harness-config` pointing at a missing file
  (no model call reached) still writes `run-report.json` with
  `status: "FAILED"` and `failure: "harness-config: ..."`, and the process
  exits non-zero (`process.exitCode = 1`).
- `loadHarnessExtras` now reads the config file once and calls glm's new
  `parseHarnessConfig(raw, dir, path)` directly (no second `fs.readFile`
  via `loadHarnessConfig`); closes the MCP provider if `SkillCatalog.load()`
  throws after `connect()` succeeded.
- `main()` moved the harness-config load inside the run's try/catch; a
  `finally` `close()` failure is caught, logged, and recorded under a new
  `closeError` report field without replacing `report.failure`.
- Added an entrypoint guard (`main()` only auto-runs when the file is
  executed directly) and exported the wiring functions used by the new
  tests; `buildHarness` additionally returns `tools`/`guardrails`/
  `availTools` for inspection. No CLI behavior change.
- `app/runner/README.md` updated: config-failure behavior, `closeError`,
  and the `node --test` command.
- Deviation: none from the review findings as scoped.

## Next step
Feature complete (T1-T6). Live model smoke run with a real
`--harness-config` remains optional follow-up, not required by the
acceptance criteria.

### Previous next step
Feature complete (T1-T4). Live model smoke run with a real
`--harness-config` is optional follow-up, not required by the acceptance
criteria (which are satisfied by the automated tests + the no-model wiring
check).

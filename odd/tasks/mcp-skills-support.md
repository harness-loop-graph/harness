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
- [ ] T2 — Skills: `SkillCatalog` (frontmatter `name`/`description`), `load_skill` tool, skill index in `Context` rendered by the GLM adapter; tests.
- [ ] T3 — Public exports, harness-config loader, README/docs update.
- [ ] T4 — Runner: `--harness-config <path>`, one shared MCP connection per run, guardrail allowlist extended, config recorded in run metrics, clean shutdown; README.

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

## Next step
T2.

# Agent Harness — C1

Model-agnostic agent harness for experimental AI code-generation.
The same harness implementation is run against multiple model providers
as part of a broader experiment.

## Iteration

**C1** — The harness as a running system. One interaction cycle:

```
task ──► ContextManager ──► ModelRequest ──► ModelAdapter
                                                  │
                     ┌────────────────────────────┤
                     ▼                            ▼
                tool_call                     finish / error
                     │
           Guardrails (allowed / denied)
                     ▼
           ToolManager (validate + execute)
                     ▼
           ToolResult ──► back to the model ──► final response
```

**C2** — The corrective loop on top (`src/loop/`). Each turn runs a full
harness interaction, then the loop verifies the workspace with an
operator-owned command and decides:

```
starting → generating → observing → verifying → deciding → final
                                                ├─ FINISH (verification passed)
                                                ├─ RETRY  (feedback fed to next turn)
                                                └─ FAIL   (max_turns reached)
```

The decision policy is deterministic and lives in `AgentLoop`, not in
the model: verification evidence, not model claims, closes the loop.
Contracts: `LoopRequest` (task + maxTurns + verification), `LoopState`,
`LoopDecision` (FINISH/RETRY/FAIL), `LoopResult` (SUCCESS/FAILED + trace).

**C3** — The multi-agent graph on top (`src/graph/`). A state machine
over nodes where each node runs its own C2 loop; edges route on loop
outcomes with conditional branching:

```
architect --on_success--> data --on_success--> backend ...
reviewer --on_failure--> backend   (returns to the responsible layer)
successful node with no outgoing edge = terminal FINISH
maxSteps = graph-level infinite-loop prevention
```

Contracts: `GraphRequest` (task + nodes + edges + initialNode +
maxSteps), `GraphNode` (id/role/task/instructions/verification),
`GraphEdge` (from/to/on_success|on_failure|always), `GraphState`
(current node, visits, results, shared notes), `GraphDecision`
(NEXT/FINISH/FAIL), `GraphResult` (SUCCESS/FAILED + step trace +
metrics). Routing is deterministic: the reviewer pattern is an
`on_failure` edge, not a model choice.

## Components (6)

1. **Context Manager** (`FsContextManager`) — deterministic workspace scan
2. **Model Adapter** — interface + a concrete adapter for an OpenAI-compatible endpoint
3. **Tool Manager** (`RegistryToolManager`) — registry, guardrail check, execution
   of `write_file`, `read_file`, `run_command`
4. **Execution Manager** (`LocalExecutionManager`) — spawns commands confined to
   the workspace, captures stdout/stderr, hard timeout
5. **Verification Manager** (`RecordingVerificationManager`) — evaluates command
   results, stores history (in memory + JSONL)
6. **Guardrails** (`PolicyGuardrails`) — tool whitelist, command prefix whitelist,
   path confinement, size limits, append-only audit trail

## Harness

`src/harness.ts` composes the six components and runs exactly one
interaction cycle (`maxToolRounds` defaults to 1). Every run returns the
final model response, a per-turn trace, the guardrail audit log and the
verification history.

## MCP tools and skills (optional)

The harness can consume tools from MCP servers and load agent skills
(`SKILL.md`), on top of the built-in tools:

- `McpToolProvider` connects to stdio MCP servers, lists their tools, and
  registers them (namespaced `mcp__<server>__<tool>`) into a
  `RegistryToolManager`, so every call is guardrail-checked and audited.
- `SkillCatalog` loads `SKILL.md` files (frontmatter `name`/`description`);
  the context manager exposes name/description only, and the `load_skill`
  tool returns the full body on demand.
- `loadHarnessConfig(path)` / `wireHarnessConfig(config, manager)` wire a
  JSON config (`{ mcpServers, skillsDirs }`) into a harness.

See [`docs/mcp-skills.md`](./docs/mcp-skills.md) for the full detail and
`examples/harness-config.json` for a working example.

## Model router (optional)

`RoutingModelAdapter` routes each request to a named `ModelAdapter` by
rule (custom → long-context → retry → default), off unless a harness
config's `router` section opts in. The same rules apply identically to
C1/C2/C3 — no rule depends on graph node/role. See
[`docs/model-router.md`](./docs/model-router.md).

## Run tests

```bash
npm install
npm test
```

## Live smoke test (real model endpoint)

Create a git-ignored `.env` file (see below) and run:

```bash
MODEL_API_KEY=<your provider API key>
MODEL_ID=<your model id>
npm run smoke         # C1: single interaction cycle
npm run smoke:loop    # C2: corrective loop with hidden verification
npm run smoke:graph   # C3: architect -> builder multi-agent graph
```

The smoke run creates an isolated temp workspace, asks the model to write
`smoke.txt` through the tool pipeline, and exits non-zero if the cycle does
not finish successfully.

### Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `MODEL_API_KEY` | yes | — | API key of the provider you point at |
| `MODEL_ID` | yes | — | Model id, any OpenAI-compatible model |
| `MODEL_BASE_URL` | yes | — (no provider default) | Any OpenAI-compatible base URL, e.g. `https://openrouter.ai/api/v1` |

Variables are provider-generic on purpose: the adapter speaks the
OpenAI-compatible dialect, so pointing `MODEL_BASE_URL` at a different
provider works with no code changes (see the adapter tests). There is no
provider default for `MODEL_BASE_URL`: it must be set, or construction
fails fast with a clear error. The adapter also sends a custom `User-Agent`
identifying the harness, and merges any configured `headers` into every
request, for an endpoint that needs a custom header.

## Build

```bash
npm run build
```

# Agent Harness — C1

Model-agnostic agent harness for experimental AI code-generation.
This repository is the **GLM** arm of the experiment: the same harness
runs against Claude in the sibling `claude/` repository.

## Iteration

**C1** — The harness as a running system. One interaction cycle:

```
task ──► ContextManager ──► ModelRequest ──► ModelAdapter (GLM)
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
2. **Model Adapter** — interface + stub; the GLM adapter lands next
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

## Run tests

```bash
npm install
npm test
```

## Live smoke test (real GLM endpoint)

Create a git-ignored `glm/.env` file (see below) and run:

```bash
MODEL_API_KEY=<OpenCode Go key>
MODEL_ID=glm-5.2
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
| `MODEL_API_KEY` | yes | — | API key of the provider you point at (OpenCode Go: https://opencode.ai/auth) |
| `MODEL_ID` | yes | — | Model id, e.g. `glm-5.2`, or any OpenAI-compatible model |
| `MODEL_BASE_URL` | no | `https://opencode.ai/zen/go/v1` | Any OpenAI-compatible base URL works |

Variables are provider-generic on purpose: the adapter speaks the
OpenAI-compatible dialect, so pointing `MODEL_BASE_URL` at OpenAI,
Z.ai, OpenRouter, etc. works with no code changes (see the adapter tests).

### Provider: OpenCode Go

This experiment accesses GLM through **OpenCode Go**
(https://opencode.ai/docs/go/): an OpenAI-compatible proxy that serves
`glm-5.2` (and other GLM versions). The adapter implements Go's client
requirements automatically: a custom `User-Agent` identifying the harness
and a stable `x-opencode-session` header per conversation (see
`GlmModelAdapter` options). Direct Z.ai endpoints can be used instead by
overriding `GLM_BASE_URL`.

## Build

```bash
npm run build
```

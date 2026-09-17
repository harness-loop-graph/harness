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

No corrective loop (that is C2) and no multi-agent graph (that is C3).

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
npm run smoke
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

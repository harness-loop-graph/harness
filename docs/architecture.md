# Architecture — C1: the harness

C1 is the harness as a running system: one interaction cycle from a task to
a final model response, mediated by six components and one set of shared
contracts.

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

## The six components

| # | Role | Interface | Real implementation | File |
|---|------|-----------|----------------------|------|
| 1 | Context Manager | `ContextManager` | `FsContextManager` | `src/components/context-manager.ts` |
| 2 | Model Adapter | `ModelAdapter` | `GlmModelAdapter` | `src/components/model-adapter.ts`, `src/components/glm-adapter.ts` |
| 3 | Tool Manager | `ToolManager` | `RegistryToolManager` | `src/components/tool-manager.ts` |
| 4 | Execution Manager | `ExecutionManager` | `LocalExecutionManager` | `src/components/execution-manager.ts` |
| 5 | Verification Manager | `VerificationManager` | `RecordingVerificationManager` | `src/components/verification-manager.ts` |
| 6 | Guardrails | `Guardrails` | `PolicyGuardrails` | `src/components/guardrails.ts` |

Every component also ships a `Stub*` implementation (`StubContextManager`,
`StubModelAdapter`, `StubToolManager`, `StubExecutionManager`,
`StubVerificationManager`, `StubGuardrails`) used by unit tests that don't
need the real behavior.

### 1. Context Manager — `FsContextManager`

`prepare(task, projectRoot)` walks the workspace from `projectRoot`,
skipping `node_modules`, `.git`, `dist`, `.cache`, capped at 500 files and a
recursion depth of 6 (`MAX_FILES`, `MAX_DEPTH`). Unreadable directories are
skipped rather than failing the cycle. It returns a `Context` with the
resolved root, the relative file list, a coarse `language` guess derived
from file extensions (`typescript`, `javascript`, `python`, `go`, or
`undefined`), and the task string. This is a deterministic scan — no model
call is involved.

### 2. Model Adapter — interface + `GlmModelAdapter`

`ModelAdapter` is the abstraction (`complete(request): Promise<ModelResponse>`).
The concrete implementation used by this arm, `GlmModelAdapter`, talks to
GLM through OpenCode Go; see [`model-provider.md`](./model-provider.md) for
the full detail.

### 3. Tool Manager — `RegistryToolManager`

Holds a registry of `ToolSpec` + `ToolHandler` pairs (`register`). On
`execute(call)`:
1. Looks up the spec; an unknown tool name returns a failed `ToolResult`
   without calling guardrails.
2. Calls `guardrails.evaluate({ kind: 'tool', tool, args })`. A `denied`
   decision short-circuits into a failed `ToolResult` carrying the denial
   reason.
3. Runs the registered handler; handler exceptions are caught and turned
   into a failed `ToolResult` rather than propagating.

`registerBuiltinTools(manager, { execution, workspaceRoot })` registers the
three built-in tools and returns their `ToolSpec[]`:

- `write_file` — writes UTF-8 content to a path relative to the workspace
  root, creating parent directories.
- `read_file` — reads a UTF-8 file, truncated to 256 KiB (`MAX_READ_BYTES`).
- `run_command` — delegates to the `ExecutionManager` with `cwd` fixed to
  the workspace root.

### 4. Execution Manager — `LocalExecutionManager`

`run(req)` resolves `req.cwd` against `workspaceRoot` and rejects any
resolved path outside it (`exitCode: 126`) before spawning anything. It
spawns the command with `child_process.spawn(..., { shell: true })`,
captures stdout/stderr capped at 512 KiB (`MAX_OUTPUT_BYTES`), and enforces
a hard timeout (`timeoutMs`, default 30 000 ms) that `SIGKILL`s the child
and reports `exitCode: 124` with a `[timeout]` marker in stderr. A spawn
error itself maps to `exitCode: 127`.

### 5. Verification Manager — `RecordingVerificationManager`

`verify(result: ExecutionResult)` turns an execution outcome into a
`VerificationResult`: `passed` is `result.exitCode === 0`, `details` carries
the last 2000 characters (`MAX_DETAIL_CHARS`) of stdout (on success) or
stderr-or-stdout (on failure), and `metrics.exitCode` records the raw exit
code. Every verification is appended to an in-memory `history` array and,
when a `historyFile` path is supplied to the constructor, to a JSONL file.
`getHistory()` returns a copy of the accumulated history.

### 6. Guardrails — `PolicyGuardrails`

`evaluate(action: GuardrailAction)` decides and records a `GuardrailDecision`
(`{ decision: 'allowed' | 'denied', reason }`) for one of two action kinds:
`{ kind: 'tool', tool, args }` or `{ kind: 'command', command, cwd }`. The
policy (`GuardrailPolicy`) is: `workspaceRoot`, `allowedTools`,
`allowedCommandPrefixes`, `maxFileBytes`. See
[`decisions.md`](./decisions.md) for the design rationale (tool whitelist,
command prefix whitelist, path confinement, size limits, audit trail).
`getAuditLog()` returns every decision made so far, in order; when
constructed with an `auditFile` path, decisions are also appended to it as
JSONL with an `at` timestamp.

## The harness — `src/harness.ts`

`Harness` composes the six components (`HarnessComponents`) plus static
options (`HarnessOptions`: `workspaceRoot`, `availTools`, `instructions`,
`maxToolRounds` — defaulting to `1`, which is the C1 contract of a single
interaction with no corrective retry; C2 loops override this per run via
`HarnessRunOptions.maxToolRounds`).

`run(task, runOptions)`:

1. Calls `context.prepare(task, workspaceRoot)` once to build the `Context`.
2. Loops `round` from `0` to `maxToolRounds` inclusive, building a
   `ModelRequest` each iteration with the accumulated `history` (`ModelResponse | ToolResult` entries fed back to the model) and, only on
   `round === 0`, any `feedback` string passed in from a previous failed
   attempt (loop retry — the loop, not the harness, owns cross-turn
   feedback).
3. Calls `model.complete(request)`. If the response is not a `tool_call`,
   the loop breaks immediately (the model finished or errored).
4. Otherwise it executes the tool through `tools.execute(response)`,
   pushes both the tool call and its `ToolResult` onto `history`, and — if
   the tool result's payload looks like an `ExecutionResult`
   (`exitCode`/`stdout`/`stderr`, checked by `isExecutionResult`) — runs
   `verification.verify(...)` and attaches it to the turn.
5. If the round limit is reached without a non-tool-call response, the
   harness synthesizes an `error` response with code `max_tool_rounds`.

The return value (`HarnessRunResult`) is `{ finalResponse, turns, audit,
verifications }`: `turns` is the full per-round trace (`InteractionTurn[]`),
`audit` is `guardrails.getAuditLog()`, and `verifications` is
`verification.getHistory()` — i.e. every verification produced during the
run, not just the ones attached to individual turns.

## Contracts — `src/contracts/core.ts`

These are the types every component and the harness share:

- **`Context`** — `projectRoot`, `files: string[]`, optional `language`,
  `framework`, `task`.
- **`ModelRequest`** — `task`, `context`, `availTools: ToolSpec[]`, optional
  `instructions`, `feedback` (verification feedback from a previous failed
  attempt — loop retry only), `history` (prior `ModelResponse | ToolResult`
  entries of this interaction).
- **`ModelResponse`** — a union of `ToolCallResponse`
  (`{ type: 'tool_call', tool, args }`), `ErrorResponse`
  (`{ type: 'error', code, message }`), `FinishResponse`
  (`{ type: 'finish', content }`).
- **`ToolResult`** — `{ type: 'tool_result', tool, success, result }`.
- **`ExecutionRequest`** / **`ExecutionResult`** — `{ command, cwd, env? }`
  and `{ exitCode, stdout, stderr }`, the contract between the tool layer
  and `ExecutionManager`.
- **`VerificationResult`** — `{ passed, details, metrics? }`.
- **`GuardrailDecision`** — `{ decision: 'allowed' | 'denied', reason }`.
- **`ToolSpec`** — `{ name, description, inputSchema }`, the JSON-Schema-like
  shape sent to the model as a function/tool definition.

All of these are exported from `src/index.ts` alongside every concrete
component class, the `Harness`, and the C2/C3 contracts and engines.

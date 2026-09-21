# Implementation decisions

Decisions worth recording for the thesis writeup, with the code evidence
that backs each one.

## Provider access: OpenCode Go, not direct Z.ai/GLM API

`GlmModelAdapter` (`src/components/glm-adapter.ts`) defaults its base URL
to `DEFAULT_GLM_BASE_URL = 'https://opencode.ai/zen/go/v1'` — OpenCode Go —
rather than a Z.ai/GLM-native endpoint. The adapter's own doc comment names
this explicitly: *"Default endpoint: OpenCode Go
(https://opencode.ai/docs/go/), the provider this experiment accesses GLM
through."* Two consequences of that choice are visible directly in the
code:

- OpenCode Go **requires** a custom `User-Agent` header
  (`harness-glm/0.1.0` by default) and a stable per-conversation
  `x-opencode-session` header for routing and prompt caching — both are
  sent unconditionally when a `sessionId` is configured
  (`src/components/glm-adapter.ts:103-113`).
- Because OpenCode Go speaks the OpenAI chat-completions dialect, the
  adapter's request/response shape is generic OpenAI-compatible JSON
  (`messages`, `tools`, `choices[0].message.tool_calls`). `MODEL_BASE_URL`
  can be pointed at any other OpenAI-compatible endpoint with no code
  change — proven by `tests/glm-adapter.spec.ts`'s test that reuses
  `GlmModelAdapter` against `https://api.openai.com/v1`.

## Environment variable naming is provider-generic

The three variables the harness reads — `MODEL_API_KEY`, `MODEL_ID`,
`MODEL_BASE_URL` — are not named `GLM_API_KEY` / `ZAI_API_KEY` /
`OPENCODE_...`. This is intentional: the same env var names work for any
model-provider arm of the broader experiment (see `docs/README.md` for how
this repo relates to the sibling `claude/` arm), even though this specific
repo's `GlmModelAdapter` class and its default base URL are GLM/OpenCode-Go
specific. The class name and defaults are concrete because this experiment
run *is* GLM-specific; the configuration surface stays generic so the
pattern is directly reusable by another provider arm.

## Deterministic (non-model) decision policy in the loop and graph

Both C2 and C3 route on **evidence**, never on the model's own claim of
success:

- `AgentLoop.decide` (`src/loop/agent-loop.ts`) only returns `FINISH` when
  either no verification command was configured, or the verification
  command's exit code was `0` — a `finish` response alone is not enough.
  This is a plain synchronous TypeScript method with no model call inside
  it.
- `GraphEngine.route` (`src/graph/graph-engine.ts`) matches edges purely
  against `loopResult.status` (`'SUCCESS' | 'FAILED'`, itself derived from
  the loop's deterministic decision), or against a caller-supplied
  `GraphRouter` that inspects `GraphState` — never the model.
- The reviewer pattern (`tests/graph.spec.ts`, `smoke-graph.ts`) is
  expressed purely as an `on_failure` `GraphEdge` from a reviewer node back
  to the node responsible for the failure; there is no model-side "should I
  go back" decision anywhere in the routing path.

This matters for the thesis because it isolates what the model is trusted
to do (produce tool calls and a final answer) from what closes the loop
(operator-owned shell verification commands whose result is a plain exit
code).

## Guardrails design

`PolicyGuardrails` (`src/components/guardrails.ts`) implements defense
purely through static, pre-execution policy checks — no model or LLM-based
judgment is involved in the allow/deny decision:

- **Tool whitelist** — `GuardrailPolicy.allowedTools`; an unlisted tool
  name is denied before any handler runs (`RegistryToolManager.execute`
  calls `guardrails.evaluate` before invoking the handler).
- **Command prefix whitelist** — `GuardrailPolicy.allowedCommandPrefixes`;
  only the first whitespace-delimited token of a `run_command` string is
  checked (e.g. `npm`, `git`, `node`). `DEFAULT_ALLOWED_COMMAND_PREFIXES`
  in the same file lists the default set. A regex additionally always
  denies `rm -r`/`rm -f` variants (`/(^|\s)rm\s+-[rf]/`) even if `rm`
  itself is on the whitelist.
- **Path confinement** — `checkPath` resolves any path argument against
  the workspace root and denies anything that resolves outside it (`..`
  escapes, or an absolute path pointing elsewhere); this is applied to
  `write_file`/`read_file` paths and to `run_command`'s effective `cwd`
  (which the tool layer always pins to the workspace root — see
  `registerBuiltinTools` in `src/components/tool-manager.ts`).
  `LocalExecutionManager.run` independently re-checks the resolved `cwd`
  against the workspace root before spawning anything, so the confinement
  is enforced at two layers.
- **Size limits** — `GuardrailPolicy.maxFileBytes` bounds a single
  `write_file` call's UTF-8 byte length; independently, `read_file` and
  command stdout/stderr are byte-capped inside the tool/execution layer
  itself (`MAX_READ_BYTES` in `tool-manager.ts`, `MAX_OUTPUT_BYTES` in
  `execution-manager.ts`).
- **Append-only audit trail** — every `evaluate(...)` call pushes onto an
  in-memory `audit` array (`getAuditLog()` returns a copy) and, when a
  `PolicyGuardrails` instance is constructed with an `auditFile` path,
  appends the same decision as a JSONL line with an `at` ISO timestamp
  (`fs.appendFileSync`) — the file is never truncated or rewritten, only
  appended to.

`Harness.run` surfaces every guardrail decision made during a run through
`HarnessRunResult.audit`, so the audit trail is part of the experiment's
recorded evidence for every task, not just a debugging side-channel.

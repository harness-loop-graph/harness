# Model provider — GLM through OpenCode Go

This experiment run of the harness talks to **GLM (`glm-5.2`)** as the
underlying model, accessed through **OpenCode Go**
(https://opencode.ai/docs/go/), an OpenAI-compatible proxy. The concrete
adapter is `GlmModelAdapter` in `src/components/glm-adapter.ts`.

## Why a generic interface

`ModelAdapter` (`src/components/model-adapter.ts`) is a one-method
interface: `complete(request: ModelRequest): Promise<ModelResponse>`. Every
other harness component (`ContextManager`, `ToolManager`,
`ExecutionManager`, `VerificationManager`, `Guardrails`) is provider-blind;
`GlmModelAdapter` is the **only** component that knows how to speak to a
specific endpoint. In principle any OpenAI-compatible endpoint can be
plugged in by constructing the adapter with a different `baseUrl`/`model`
— no other harness code changes. This is demonstrated directly by
`tests/glm-adapter.spec.ts`'s `'works unchanged against any
OpenAI-compatible endpoint (e.g., OpenAI)'` test, which points the same
class at `https://api.openai.com/v1` and asserts the request shape is
identical. For this experiment run, though, the class name, the default
base URL, and the required headers are GLM/OpenCode-Go-specific by design
— see [`decisions.md`](./decisions.md) for why a generic class wasn't used
instead.

## Configuration — `GlmAdapterConfig`

| Field | Source | Fallback |
|---|---|---|
| `apiKey` | constructor arg | `process.env.MODEL_API_KEY` |
| `baseUrl` | constructor arg | `process.env.MODEL_BASE_URL` → `DEFAULT_GLM_BASE_URL` (`https://opencode.ai/zen/go/v1`) |
| `model` | constructor arg | `process.env.MODEL_ID` (e.g. `glm-5.2`) |
| `fetchImpl` | constructor arg | global `fetch` (injectable for tests) |
| `timeoutMs` | constructor arg | `120_000` |
| `sessionId` | constructor arg | none — omitted from headers if unset |
| `userAgent` | constructor arg | `'harness-glm/0.1.0'` |

The constructor throws immediately (`MODEL_API_KEY is not set...` /
`MODEL_ID is not set...`) if the key or model resolve to an empty string,
so a misconfigured run fails fast rather than making a doomed HTTP call.

### Environment variables

`MODEL_API_KEY`, `MODEL_ID`, `MODEL_BASE_URL` are the three variables the
harness reads. Their names are deliberately **provider-generic**, not
`GLM_API_KEY` / `ZAI_API_KEY` / etc. — see
[`decisions.md`](./decisions.md#env-var-naming).

## Request shape

`complete(request)` POSTs to `` `${baseUrl}/chat/completions` `` with:

```json
{
  "model": "<MODEL_ID>",
  "messages": [ ... ],
  "tools": [ ... ]   // omitted when availTools is empty
}
```

Headers:

```
Content-Type: application/json
Authorization: Bearer <MODEL_API_KEY>
User-Agent: harness-glm/0.1.0          (or configured userAgent)
x-opencode-session: <sessionId>        (only if sessionId is set)
```

The custom `User-Agent` and the `x-opencode-session` header are called out
explicitly in the adapter's own doc comment as **required by OpenCode Go**:
`sessionId` is a stable per-conversation identifier used for routing and
prompt caching on the proxy side. `smoke-graph.ts` reuses a single
`sessionId` (`randomUUID()` generated once) across every node's
`GlmModelAdapter` in a graph run specifically to keep provider-side prompt
caching effective across the whole multi-agent run.

Requests time out via `AbortSignal.timeout(timeoutMs)` (default 120 s).

## Message construction — `buildMessages`

- A `system` message is emitted only if there is something to put in it:
  `request.instructions` and/or a rendered list of `request.availTools`
  (`- name: description` lines under `Available tools:`).
- The task becomes a `user` message, appended with the first 200
  files of `request.context.files`, the workspace root, and the guessed
  language; if `request.feedback` is present (loop retry) it's appended
  under a `[feedback from previous failed attempt]` marker.
- `request.history` (prior `ModelResponse | ToolResult` entries) is replayed
  as OpenAI-style messages: a `tool_call` becomes an `assistant` message
  with `tool_calls` (synthetic id `` call_${tool} ``); a `tool_result`
  becomes a `role: 'tool'` message with the matching `tool_call_id`,
  content capped at 8000 characters; a `finish` becomes a plain `assistant`
  message; anything else (an `error`) becomes an `assistant` message
  summarizing the error code and text.

## Response mapping — `complete`

- Network failure (fetch throws) → `{ type: 'error', code: 'network_error', message }`.
- Non-2xx HTTP → `{ type: 'error', code: 'http_<status>', message }` (body
  truncated to 2000 characters).
- Non-JSON body → `{ type: 'error', code: 'invalid_json', ... }`.
- A JSON `error` field in the payload → `{ type: 'error', code, message }`.
- No `choices[0].message` → `{ type: 'error', code: 'empty_response', ... }`.
- `message.tool_calls[0]` present → parses `function.arguments` as JSON and
  returns `{ type: 'tool_call', tool, args }`; unparseable arguments become
  `{ type: 'error', code: 'invalid_tool_arguments', ... }`.
- `message.content` is a non-empty string → `{ type: 'finish', content }`.
- Neither → `{ type: 'error', code: 'empty_content', ... }`.

Token usage (`payload.usage.prompt_tokens` / `completion_tokens`) is
accumulated across every call on the instance and exposed via
`getUsage(): { promptTokens, completionTokens, totalTokens, calls }`.

## Where it's wired in

`GlmModelAdapter` is instantiated directly (no factory/registry
indirection) in the three live smoke entry points:

- `src/smoke.ts` — one `GlmModelAdapter({ sessionId: randomUUID() })` for a
  single C1 interaction.
- `src/smoke-loop.ts` — one adapter reused across every turn of a C2
  `AgentLoop`.
- `src/smoke-graph.ts` — one adapter constructed per node inside the
  `LoopFactory`, all sharing a single `sessionId` generated once per graph
  run.

## Behavior verified by `tests/glm-adapter.spec.ts`

Missing `MODEL_API_KEY` / `MODEL_ID` throw with a message naming the
missing variable; a `tool_calls` response maps to `tool_call` and the
request is sent to `https://opencode.ai/zen/go/v1/chat/completions` with
`Authorization: Bearer ...`, `x-opencode-session`, and `User-Agent:
harness-glm/0.1.0`; a plain content response maps to `finish`; pointing
`baseUrl` at `https://api.openai.com/v1` produces the identical request
shape against a different provider; HTTP 401 and network failures both map
to typed `error` responses; usage accumulates across calls and defaults to
zero when the payload omits it; and `history` round-trips correctly into
`assistant`/`tool` messages.

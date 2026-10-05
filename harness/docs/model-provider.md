# Model provider — OpenAI-compatible chat completions

This experiment run of the harness talks to a model through any
OpenAI-compatible chat-completions endpoint (configured by
`MODEL_BASE_URL`/`MODEL_API_KEY`/`MODEL_ID`). Historically the first runs
pointed this at **GLM** through **OpenCode Go**
(https://opencode.ai/docs/go/); OpenRouter and OpenCode Go are two examples
of endpoints that work, not a requirement. The concrete adapter is
`OpenAICompatibleModelAdapter` in `src/components/openai-compatible-adapter.ts`.

## Why a generic interface

`ModelAdapter` (`src/components/model-adapter.ts`) is a one-method
interface: `complete(request: ModelRequest): Promise<ModelResponse>`. Every
other harness component (`ContextManager`, `ToolManager`,
`ExecutionManager`, `VerificationManager`, `Guardrails`) is provider-blind;
`OpenAICompatibleModelAdapter` is the **only** component that knows how to
speak to a specific endpoint, and it carries no provider-specific class
name, default base URL, or hardcoded header — any OpenAI-compatible
endpoint is plugged in by constructing the adapter with a different
`baseUrl`/`model` (and, if the endpoint needs one, a custom header via
`headers`). This is demonstrated directly by
`tests/openai-compatible-adapter.spec.ts`'s `'works unchanged against any
OpenAI-compatible endpoint (e.g., OpenAI)'` test, which points the same
class at `https://api.openai.com/v1` and asserts the request shape is
identical. See [`decisions.md`](./decisions.md) for the history of why the
first experiment runs used GLM through OpenCode Go, and why the design
itself stays provider-agnostic.

## Configuration — `OpenAICompatibleAdapterConfig`

| Field | Source | Fallback |
|---|---|---|
| `apiKey` | constructor arg | `process.env.MODEL_API_KEY` |
| `baseUrl` | constructor arg | `process.env.MODEL_BASE_URL` — **no provider default**; construction throws if neither is set |
| `model` | constructor arg | `process.env.MODEL_ID` (e.g. `gpt-4o-mini`) |
| `fetchImpl` | constructor arg | global `fetch` (injectable for tests) |
| `timeoutMs` | constructor arg | `120_000` |
| `headers` | constructor arg | `{}` — merged into every request, for an endpoint that needs a custom header |
| `userAgent` | constructor arg | `'pi-harness/0.1.0'` |

The constructor throws immediately (`MODEL_API_KEY is not set...` /
`MODEL_ID is not set...` / `MODEL_BASE_URL is not set...`) if the key,
model, or base URL resolve to an empty string, so a misconfigured run fails
fast rather than making a doomed HTTP call.

### Environment variables

`MODEL_API_KEY`, `MODEL_ID`, `MODEL_BASE_URL` are the three variables the
harness reads. Their names are deliberately **provider-generic**, not
`GLM_API_KEY` / `ZAI_API_KEY` / etc. — see
[`decisions.md`](./decisions.md#env-var-naming). `MODEL_BASE_URL` is
**required** (there is no provider default); point it at any
OpenAI-compatible endpoint, e.g. `https://openrouter.ai/api/v1` or
`https://opencode.ai/zen/go/v1`.

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
User-Agent: pi-harness/0.1.0          (or configured userAgent)
...headers                            (any configured `headers` merged in)
```

`headers` lets a caller add whatever a specific endpoint needs (e.g. a
session/routing header some proxies require); the adapter itself has no
opinion about what, if anything, goes there.

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

`OpenAICompatibleModelAdapter` is instantiated directly (no factory/registry
indirection) in the three live smoke entry points:

- `src/smoke.ts` — one `OpenAICompatibleModelAdapter()` for a single C1
  interaction.
- `src/smoke-loop.ts` — one adapter reused across every turn of a C2
  `AgentLoop`.
- `src/smoke-graph.ts` — one adapter constructed per node inside the
  `LoopFactory`.

## Behavior verified by `tests/openai-compatible-adapter.spec.ts`

Missing `MODEL_API_KEY` / `MODEL_ID` / `MODEL_BASE_URL` throw with a message
naming the missing variable; a `tool_calls` response maps to `tool_call`;
configured `headers` are merged into the request alongside `Authorization`
and `User-Agent`; a plain content response maps to `finish`; pointing
`baseUrl` at `https://api.openai.com/v1` produces the identical request
shape against a different provider; HTTP 401 and network failures both map
to typed `error` responses; usage accumulates across calls and defaults to
zero when the payload omits it; and `history` round-trips correctly into
`assistant`/`tool` messages.

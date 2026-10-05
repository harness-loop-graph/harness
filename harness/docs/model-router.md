# Model router

Optional, off-by-default request routing on top of the `ModelAdapter`
interface: send each request to a different model/endpoint by rule,
inspired by [claude-code-router](https://github.com/musistudio/claude-code-router).
Unlike that project, this router carries no per-agent/role configuration —
see "Why no role-based routing" below.

## What it is

`RoutingModelAdapter` (`src/components/routing-model-adapter.ts`) wraps a
set of named `ModelAdapter`s behind one `ModelAdapter`. Callers (the
harness, the loop, the graph engine) never see the router — they call
`complete(request)` exactly as they would on any adapter.

```
ModelRequest ──► RoutingModelAdapter ──► decide route ──► routes[route].complete(request)
                                              │
                                  custom → longContext → retry → default
```

## Rules and precedence

Evaluated in this fixed order; the first matching rule wins:

1. **custom** — if a `customRouter(request, ctx)` is configured, it runs
   first. Returning a route name forces that route (reason `'custom'`);
   returning `null` falls through to the rules below. Returning an
   unknown route name throws.
2. **longContext** — if a `longContext` route is configured and the
   request's estimated token count exceeds `longContextThreshold`
   (default 60000).
3. **retry** — if a `retry` route is configured and `request.feedback` is
   a non-empty string (verification feedback from a previous failed
   attempt — see `ModelRequest.feedback` in `src/contracts/core.ts`).
4. **default** — otherwise. This is always the adapter the caller already
   had; it is never declared in a config file.

The token estimate (when no `estimateTokens` override is given) is a
rough heuristic, not a tokenizer: the serialized character length of
`task` + `context` + `instructions` + `history` + `feedback`, divided by
4.

## Usage

```ts
const router = new RoutingModelAdapter({
  routes: {
    default: new GlmModelAdapter({ apiKey, model: 'glm-5.2' }),
    longContext: new GlmModelAdapter({ apiKey, model: 'glm-5.2-long' }),
    retry: new GlmModelAdapter({ apiKey, model: 'glm-5.2' }),
  },
  longContextThreshold: 60_000,
});
```

`getUsage()` returns the same shape as `GlmModelAdapter.getUsage()`
(`promptTokens`, `completionTokens`, `totalTokens`, `calls`, `cost`,
`modelsUsed`), aggregated across every route — so a caller that only
reads `getUsage()` (e.g. the experiment runner's `report.usage`) needs no
changes when a router is introduced. `getRouting()` is the router-specific
surface: `{ byRoute: { <name>: { calls, promptTokens, completionTokens,
totalTokens, cost } }, decisions: { route, reason }[] }`.

## Harness config wiring

A harness config file (see `docs/mcp-skills.md`) can carry an
optional `router` section:

```json
{
  "router": {
    "longContextThreshold": 60000,
    "routes": {
      "longContext": { "model": "glm-5.2-long", "apiKeyEnv": "LONG_MODEL_API_KEY" },
      "retry": { "model": "glm-5.2" }
    },
    "customRouterPath": "./my-custom-router.mjs"
  }
}
```

- `default` is never declared here — it is always the caller's existing
  model adapter.
- Route names are `longContext`, `retry`, or any other name only ever
  returned by a custom router (built-in rules only ever pick
  `longContext`/`retry`/`default`).
- API keys are never literal in the config file: `apiKeyEnv` names an
  environment variable; a route without `apiKeyEnv` falls back to the
  default model's own env vars (`MODEL_API_KEY`, and `MODEL_BASE_URL` if
  `baseUrl` is also omitted). A missing env var fails fast, naming the
  route and the variable.
- `customRouterPath` is resolved relative to the config file and
  dynamically `import()`-ed; its default export (or a named `route`
  export) must be a function `(request, ctx) => routeName | null`.

`parseHarnessConfig`/`loadHarnessConfig` validate this section (see
`src/harness-config.ts`); `createRoutedModel(routerConfig, defaultAdapter,
{ sessionId, makeAdapter? })` builds the `RoutingModelAdapter` from it —
`makeAdapter` defaults to `GlmModelAdapter` and is injectable for tests.

## Why no role-based routing

`claude-code-router` (and similar tools) often route by which agent/role
is calling — e.g. a "planner" role gets a stronger model than a "coder"
role. This harness deliberately does not: `ModelRequest`/`Context` carry
no node/role identity, and no routing rule may depend on one. The reason
is the experiment this harness supports: C1/C2/C3 (one interaction, a
corrective loop, a multi-agent graph) are compared against each other
holding the model fixed. Role-based routing would let C3's graph
structure quietly buy itself a stronger model per node, confounding the
graph-vs-loop-vs-single-shot comparison with a model choice. The same
router rules therefore apply identically to C1, C2 and C3, and are off
unless a harness config opts in.

## Tests

- `tests/routing-model-adapter.spec.ts` — every rule, precedence,
  custom-router null fallback, unknown-route error, usage aggregation
  (including two route names sharing one adapter instance).
- `tests/harness-config.spec.ts` — `router` section validation and
  `createRoutedModel` (route construction, missing-env-var errors,
  `customRouterPath` loading).

# Feature: Model router (claude-code-router style)

## Objective
The harness can route each model request to a different provider/model by rule, inspired by claude-code-router, applied identically to C1, C2 and C3 and off by default.

## Problem / Why
Advisor suggested a claude-code-router-like capability. Decision (user, 2026-09-28): option 1 — the same routing rules for every configuration, disabled unless configured, so the C1/C2/C3 comparison stays valid. Role-based routing per C3 node is out of scope (it would confound the graph with the model).

## Scope
- `glm/`: `RoutingModelAdapter` implementing `ModelAdapter`; routes `default`, `longContext`, `retry`; optional custom router module; per-route usage; `router` section in harness config; docs.
- `experiment/runner/`: wrap the model with the router when the harness config has `router`, identically for c1/c2/c3; record routing usage in `run-report.json`.

## Rules
- `default`: the existing model (env `MODEL_*`), unchanged behavior.
- `longContext`: estimated request tokens > `longContextThreshold` (default 60000).
- `retry`: request carries verification feedback from a previous failed attempt (`ModelRequest.feedback`).
- Custom router: module exporting a function `(request, ctx) => routeName | null`; `null` falls back to built-in rules. Unknown route name → error.
- Precedence: custom → longContext → retry → default.

## Constraints
- No `router` in config → byte-for-byte same behavior and outputs.
- API keys never in the config file: routes reference an env var name (`apiKeyEnv`).
- Same rules for every configuration; no rule keyed on graph node/role.
- Minimal comments.

## TDD
Mode: off (source: no project/session TDD configuration). Checks: `npm test` + `npm run build` in `glm/`; `node --test experiment/runner/run-experiment.test.mjs`.

## Tasks
- [x] T1 — `RoutingModelAdapter` + rule evaluation + per-route usage; tests with stub adapters.
- [x] T2 — `router` section in harness config (validation, env-var keys, custom router loading), factory, exports, docs.
- [x] T3 — Runner wiring for c1/c2/c3, routing usage in `run-report.json`, README, tests.

- [x] T4 — Review fixes (user-authorized 2026-09-28): glm — env-independent `createRoutedModel` test (stub `MODEL_BASE_URL`) + positive fallback test; count failed delegate calls/usage per route; `Object.hasOwn` route lookup; reject `__proto__`-style route names and empty `apiKeyEnv`. experiment — tests for `report.routing` (present with router in c1/c2/c3, absent without) and `routeNames`; retry-key fallback test distinguishes env vs default key and restores env.

## Acceptance criteria
- With a router config, requests over the threshold go to `longContext`, retry requests go to `retry`, everything else to `default`, in all three configurations.
- `run-report.json` shows calls/tokens per route.
- Without `router`, runner tests and dry-run output unchanged.
- All checks pass.

## Progress / Evidence

### T1 (commit `ee9ef38`, glm)
- Added `src/components/routing-model-adapter.ts`: `RoutingModelAdapter implements ModelAdapter`,
  precedence custom → longContext → retry → default, unknown custom route throws, default token
  estimate is `serialized-request-chars / 4`. Usage is tracked as a per-call delta on each route
  adapter's own `getUsage()` (handles a shared adapter instance across two route names correctly).
  `getUsage()` stays byte-for-byte the same shape as `GlmModelAdapter.getUsage()`; `getRouting()`
  is the new surface for `byRoute` usage + the ordered decision log — chosen over overloading
  `getUsage()` so existing callers of the aggregate shape are unaffected.
- Tests: `tests/routing-model-adapter.spec.ts` (13 tests) — each rule, precedence, custom-null
  fallback, unknown-route error, calls-only fallback for adapters without `getUsage()`, usage
  aggregation, and the shared-instance split.
- `cd glm && npm test`: 9 files, 84 passed.
- `cd glm && npm run build`: clean (tsc).

### T2 (commit `62b5e89`, glm)
- `src/harness-config.ts`: `HarnessConfigFile`/`HarnessConfig` gain an optional `router`
  section, validated in `parseHarnessConfig` (positive `longContextThreshold`, non-empty
  `routes`, `default` forbidden as a declared route name, each route's `model` required,
  `baseUrl`/`apiKeyEnv` optional strings, `customRouterPath` resolved relative to the config
  file like `skillsDirs`).
- Added `createRoutedModel(routerConfig, defaultAdapter, { sessionId, makeAdapter? })`:
  builds one `GlmModelAdapter` per configured route (`makeAdapter` injectable for tests),
  resolves each route's API key from `apiKeyEnv` (falling back to `MODEL_API_KEY`) and
  throws naming the route + missing env var if absent, dynamically `import()`s
  `customRouterPath` and uses its default (or `route`) export as the `CustomRouter`.
  Exported from `src/index.ts` via the existing `export * from './harness-config.js'`.
- Docs: new `glm/docs/model-router.md` (rules/precedence, config shape, why no
  role-based routing), linked from `docs/README.md` and `docs/architecture.md`; a short
  section added to the top-level `README.md`.
- Tests added to `tests/harness-config.spec.ts` (10 new): router section validation
  (resolve + 4 error cases) and `createRoutedModel` (route construction incl. env-var
  resolution, missing-env-var errors for both `apiKeyEnv` and the `MODEL_API_KEY`
  fallback, `customRouterPath` loading, and a non-function export error).
- `cd glm && npm test`: 9 files, 94 passed. `cd glm && npm run build`: clean (tsc).

### T3 (commit `45aa5b7`, experiment)
- `experiment/runner/run-experiment.mjs`: added `createModel({ apiKey, modelId, sessionId,
  harnessExtras, makeAdapter })` — the single code path c1/c2/c3 now call to build the run's
  model adapter (same `sessionId`), returning a plain `GlmModelAdapter` unless
  `harnessExtras.router` is set, in which case it delegates to glm's `createRoutedModel()`.
  `loadHarnessExtras()` now carries `config.router` through and adds `routeNames` to
  `report.harnessConfig` metadata when present. Added `summarizeRouting(routing)`, reducing
  `RoutingModelAdapter.getRouting()` into `report.routing = { byRoute, decisions }` with the
  decision log collapsed to counts per `"<route>:<reason>"` key (kept out of the report as a
  full per-call list — unbounded over a long C2/C3 run; counts are enough to see which rule
  fired and how often). Exported `createModel`/`summarizeRouting` for tests.
- `experiment/harness-config.json` left untouched (no `router` section — off by default);
  `experiment/runner/README.md` documents an example `router` config, the `routing` report
  field, and the `routeNames` metadata addition.
- Tests added to `run-experiment.test.mjs` (5 new): `createModel()` returns a plain
  `GlmModelAdapter` unchanged for every no-router `harnessExtras` shape, wraps it in a
  `RoutingModelAdapter` with the configured routes using an injected `makeAdapter` stub (no
  network) when a router is set, and propagates a clear missing-env-var error; and
  `summarizeRouting()`'s count reduction.
- `cd glm && npm test`: 9 files, 94 passed. `cd glm && npm run build`: clean (tsc).
- `node --check experiment/runner/run-experiment.mjs`: OK.
- `node --test experiment/runner/run-experiment.test.mjs`: 9 passed.
- `node experiment/runner/run-experiment.mjs --config c1 --dry-run`, with and without
  `--harness-config experiment/harness-config.json`: compared byte-for-byte against the
  pre-change commit (`experiment` `a7006d8`), ignoring `sessionId` and the workspace
  timestamp — identical in both cases.

All three tasks done; all required checks pass. No deviations from the design beyond the
two explicit design choices already recorded under T1 (`getRouting()` instead of overloading
`getUsage()`) and T3 (routing decisions summarized as counts, not the full list).

### T4 (commits `782a8ba` glm, `b5c3774` experiment)
- `glm/src/components/routing-model-adapter.ts`: `complete()` now records the call/usage
  delta in a `finally` block around `adapter.complete()` instead of after it resolves, so a
  throwing delegate is still counted (and the error still propagates) — new test:
  "records the call and any usage delta when the delegate throws, then rethrows". The
  custom-router unknown-route check now uses `Object.hasOwn(this.routes, chosen)` instead of
  a truthy property lookup, so a custom router returning `'toString'`/`'constructor'` still
  throws the clear unknown-route error instead of resolving to `Object.prototype`'s own
  method — new test: "throws unknown-route even for inherited plain-object property names".
- `glm/src/harness-config.ts`: `router.routes.<name>.apiKeyEnv` now rejects the empty string
  (previously only rejected non-strings); a route named `__proto__` is rejected explicitly
  with a clear error, and `routes` is built via `Object.create(null)` as defense in depth (a
  `JSON.parse`'d `"__proto__"` key is a genuine own property — `JSON.parse` never invokes the
  accessor — so on a normal `{}` object, `routes[name] = ...` for that name would otherwise
  reassign `routes`'s own prototype). New tests: empty-`apiKeyEnv` rejection, `__proto__`
  route rejection (verifies `Object.prototype` stays untouched).
- `glm/tests/harness-config.spec.ts`: the `createRoutedModel` describe block now uses
  `vi.stubEnv`/`vi.unstubAllEnvs` instead of manually snapshotting/restoring
  `process.env`, and every test that expects a route's `baseUrl: undefined` explicitly
  stubs `MODEL_BASE_URL` to `undefined` first (previously it silently depended on the var
  being unset in the ambient shell — reproduced pre-fix: `MODEL_BASE_URL=https://example.test
  npx vitest run tests/harness-config.spec.ts` failed 1 test). New positive test: a route
  without its own `baseUrl` falls back to `MODEL_BASE_URL` when that env var is set.
- `cd glm && npm test`: 9 files, 99 passed. `cd glm && MODEL_BASE_URL=https://example.test
  npm test`: 9 files, 99 passed (same). `cd glm && npm run build`: clean (tsc).
- `experiment/runner/run-experiment.mjs`: extracted `attachUsageAndRouting(report, model)` —
  the single place c1/c2/c3 now set `report.usage`/`report.routing` — replacing the three
  duplicated `if (typeof model.getRouting === 'function') ...` copies at the c1/c2/c3 call
  sites; exported for tests. CLI behavior (including dry-run JSON output) is unchanged.
- `experiment/runner/run-experiment.test.mjs`: new tests — `attachUsageAndRouting()` sets
  `report.routing` from a router model (byRoute + decision counts) and leaves it unset for a
  plain model; `loadHarnessExtras()`'s `routeNames` metadata is `['default', ...routes]` when
  a router is configured and absent otherwise. Fixed the retry-key fallback test: it
  previously used the same literal (`'default-key'`) for both `MODEL_API_KEY` and the
  `apiKey` passed to `createModel()`, so it could not tell which one the built adapter's
  `apiKey` came from; now they're distinct values (`'env-fallback-key'` vs
  `'run-default-key'`), which actually proves the retry route's adapter used the
  `MODEL_API_KEY` env fallback, and both `LONG_KEY`/`MODEL_API_KEY` are restored to their
  prior values in `finally` instead of being deleted.
- `node --check experiment/runner/run-experiment.mjs`: OK. `node --test
  experiment/runner/run-experiment.test.mjs`: 12 passed (was 9 before T4's added tests).
- `node experiment/runner/run-experiment.mjs --config c1 --dry-run`, with and without
  `--harness-config experiment/harness-config.json`: compared byte-for-byte against the
  pre-T4 commit (`experiment` `45aa5b7`), ignoring `sessionId`/workspace path — identical in
  both cases.
- No behavior change for concurrent calls (out of scope per the review's own instruction;
  the graph still runs nodes sequentially).

All four tasks done; all required checks pass, including the two new invariants
(`MODEL_BASE_URL`-independent test run, and dry-run output unchanged).

## Next step
Feature complete, including review follow-ups. Optional follow-up (not requested): wire an
actual `longContext`/`retry` router config into a real experiment run to observe routing in a
live `run-report.json`.

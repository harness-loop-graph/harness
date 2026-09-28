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
- [ ] T2 — `router` section in harness config (validation, env-var keys, custom router loading), factory, exports, docs.
- [ ] T3 — Runner wiring for c1/c2/c3, routing usage in `run-report.json`, README, tests.

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

## Next step
T2 — `router` section in harness config + `createRoutedModel` factory + docs.

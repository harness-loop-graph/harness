# Harness — internal documentation

`harness/` is the code generator of a university thesis project
(PI-I): a model-agnostic agent harness built in three iterations — C1 (one
interaction cycle), C2 (a corrective loop on top of C1), and C3 (a
multi-agent graph on top of C2). It runs against any OpenAI-compatible
chat-completions endpoint, configured by `MODEL_BASE_URL`/`MODEL_API_KEY`/
`MODEL_ID` (the first experiment runs used GLM through OpenCode Go — see
[`decisions.md`](./decisions.md)). The `experiment/` directory at the repository root defines the fixed case study
(`SPEC.md`) the harness is asked to build, and orchestrates experiment runs
(`experiment/runner/run-experiment.mjs`) across the C1/C2/C3 configurations.

The public `harness/README.md` is deliberately
provider-agnostic (it describes the harness in terms of generic
"ModelAdapter" and "OpenAI-compatible endpoint" language). This `docs/`
folder is internal: it names the real classes, files, and provider details
so the thesis writeup can cite exact implementation evidence.

## Contents

- [`architecture.md`](./architecture.md) — C1: the six components, the
  interaction cycle, `Harness`, and the core contracts.
- [`loop.md`](./loop.md) — C2: the corrective loop (`AgentLoop`), its state
  machine, and the deterministic FINISH/RETRY/FAIL decision policy.
- [`graph.md`](./graph.md) — C3: the multi-agent graph (`GraphEngine`), node
  and edge model, and `maxSteps` loop prevention.
- [`model-provider.md`](./model-provider.md) — the real model adapter
  (`OpenAICompatibleModelAdapter`), the OpenAI-compatible chat-completions
  request/response shape, environment variables, and why the adapter stays
  provider-generic in shape.
- [`decisions.md`](./decisions.md) — implementation decisions worth
  recording for the thesis: provider choice, env var naming, deterministic
  decision policy, guardrails design.
- [`mcp-skills.md`](./mcp-skills.md) — MCP tool provider (`McpToolProvider`),
  skill catalog + `load_skill`, and the harness-config loader that wires
  both into C1/C2/C3 identically.
- [`model-router.md`](./model-router.md) — `RoutingModelAdapter`, the
  `router` harness-config section, and why routing rules never depend on
  graph node/role.

Every claim in these documents is grounded in the source under `src/` and
the behavior asserted by the tests under `tests/`.

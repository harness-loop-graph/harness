# Harness, Loop and Graph Engineering

A model-agnostic agent harness that generates complete software systems from a
fixed specification, and the experiment bench that measures how each
engineering layer affects the quality of the generated code.

The generator is built in three incremental configurations. Each one adds a
layer on top of the previous one, so their results can be compared directly:

| Config | Layers | What it adds |
|---|---|---|
| **C1** | Harness | One interaction cycle: context → model → guardrailed tools → verification → final answer |
| **C2** | Harness + loop | A corrective loop: after each turn a verification command decides `FINISH`, `RETRY` (with feedback) or `FAIL` |
| **C3** | Harness + loop + graph | A multi-agent graph: architect → data → backend → frontend → reviewer, with deterministic conditional routing |

## Features

- **Model-agnostic.** Works with any OpenAI-compatible chat-completions
  endpoint (OpenRouter, OpenCode Go, a self-hosted server…), configured only
  through environment variables.
- **Guardrails.** Every tool call is checked against an allowlist of tools and
  command prefixes, confined to the run workspace, and written to an audit log.
- **MCP tools.** Connects to MCP servers over stdio and exposes their tools to
  the model, behind the same guardrails.
- **Agent skills.** Loads `SKILL.md` skills with progressive disclosure: only
  names and descriptions enter the context; the body is loaded on demand.
- **Model router.** Optionally routes each request to a different model by
  rule (long context, retry after a failed attempt, or a custom router script).
- **Reproducible runs.** Each run records its configuration, model, token
  usage, cost, per-node failure reasons and a hash of the harness config.

## Repository layout

```
harness/      The generator (TypeScript): harness, loop, graph, adapters, tools
experiment/   The experiment bench: SPEC.md, runner, skills, harness config
```

Generated applications never live in this repository. Each run is written to
its own directory outside it and becomes an independent Git repository that
can be published to GitHub for static analysis.

## Requirements

- Node.js 20 or later
- Docker (C2 verification and the acceptance batteries start the generated stack)
- [GitHub CLI](https://cli.github.com/) authenticated, only to publish runs

## Quick start

```bash
(cd harness && npm install && npm run build && npm test)
node experiment/runner/run-experiment.mjs --config c1 --dry-run
```

Create a `.env` file at the repository root (it is gitignored):

```
MODEL_BASE_URL=https://openrouter.ai/api/v1
MODEL_API_KEY=<your key>
MODEL_ID=qwen/qwen3-235b-a22b-2507
```

Environment variables take precedence over the file.

## Running the experiment

```bash
# Build the full system from SPEC.md with each configuration
node experiment/runner/run-experiment.mjs --config c1 --harness-config experiment/harness-config.json
node experiment/runner/run-experiment.mjs --config c2 --harness-config experiment/harness-config.json
node experiment/runner/run-experiment.mjs --config c3 --harness-config experiment/harness-config.json

# Publish the generated app as its own public repository in the organization
node experiment/runner/run-experiment.mjs --config c1 --harness-config experiment/harness-config.json --publish

# Cheap validation run with a short task instead of the full specification
node experiment/runner/run-experiment.mjs --config c3 --task-file experiment/runner/validation-task.txt
```

Each run writes `run-report.json` (status, budgets, token usage, cost, trace)
inside the generated repository. The same harness config — MCP servers and
skills — is applied identically to C1, C2 and C3, so differences between
configurations come from the engineering layers, not from the setup.

See [`experiment/runner/README.md`](experiment/runner/README.md) for every flag,
the report format and the publishing safeguards, and
[`harness/README.md`](harness/README.md) for the harness architecture.

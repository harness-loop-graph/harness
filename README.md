# Harness, Loop and Graph Engineering — PI-I

University thesis project (PI-I) that measures how three engineering layers
affect the quality of AI-generated software.

| Directory | What it is |
|---|---|
| [`harness/`](harness/) | The code generator: a model-agnostic agent harness built in three incremental configurations — **C1** harness, **C2** + corrective loop, **C3** + multi-agent graph. Supports MCP tools, agent skills and a model router. |
| [`experiment/`](experiment/) | The experiment bench: the fixed specification the generator receives (`SPEC.md`), the runner that executes C1/C2/C3 in isolated workspaces and records metrics, and the skills/harness config shared by every configuration. The hidden acceptance batteries (`experiment/acceptance/`) are never committed. |
| `odd/` | Task documents for features built in this repository. |

Only the harness generates code. Each generated application is written
**outside this repository** and can be published as its own GitHub repository
for static analysis (see `experiment/runner/README.md`).

## Quick start

Run from the repository root (the `harness` build/test step uses a subshell
so the second command still runs from the root, not from `harness/`):

```bash
(cd harness && npm install && npm run build && npm test)
node experiment/runner/run-experiment.mjs --config c1 --dry-run
```

Model credentials (`MODEL_API_KEY`, `MODEL_ID`, optional `MODEL_BASE_URL`) are
read from the environment or from `.env` at the repository root (gitignored).

This repository merges the former `harness` and `experiment` repositories with
their full history.

# Experiment Runner

Plain-ESM CLI that orchestrates the model-agnostic harness over the fixed `SPEC.md` in isolated workspaces, against any OpenAI-compatible chat-completions endpoint.

## Usage

```bash
node runner/run-experiment.mjs --config c1|c2|c3 [options]
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--config c1\|c2\|c3` | **required** | Experiment configuration |
| `--runs-dir <path>` | `<monorepo>/../pi-runs` (sibling of this repo, never inside it) | Run workspace root |
| `--spec <path>` | `experiment/SPEC.md` | Fixed specification file |
| `--task-file <path>` | — | Override generation task (cheap validation runs). In c3 every node keeps its role and verification but works on this task instead of the SPEC, and the `GraphEngine`'s graph-level task is set to the override too (nodes are what the engine actually runs, but the graph-level task no longer contradicts it). The file is validated (exists, readable, not empty/whitespace-only) **before** the run's workspace is created, with a usage error and a non-zero exit on failure, for every `--config` — so a bad `--task-file` never leaves an orphan workspace directory behind |
| `--max-turns <n>` | 8 | Loop budget (C2/C3 nodes). Must be a positive integer |
| `--max-steps <n>` | 12 | Graph step budget (C3 only). Must be a positive integer |
| `--tool-rounds <n>` | 80 (c1), 30 (c2/c3) | Tool-call budget per interaction. Must be a positive integer |
| `--verify-cmd <cmd>` | `docker compose up -d --build && curl -sf http://localhost:3000/health` | C2 verification command |
| `--with-batteries` | off | After generation, start the stack and run acceptance batteries |
| `--keep` | off | With `--with-batteries`, do **not** tear the stack down |
| `--dry-run` | off | Print the plan JSON and exit without calling the model; creates nothing on disk |
| `--harness-config <path>` | — | JSON `{ mcpServers, skillsDirs }`; wires MCP tools + skills into every harness the run builds |
| `--publish` | off | After the run (and its local git commit), create a **public** GitHub repo for the workspace via `gh` and push it (see below) |
| `--publish-org <org>` | `harness-loop-graph` | GitHub org/user the `--publish` repo is created under |

### Credentials

`MODEL_API_KEY`, `MODEL_ID` and `MODEL_BASE_URL` are read from `process.env`; any that are missing are filled from `.env` at the repository root (simple `key=value` parse, exported to `process.env` so router routes see the same values; the environment always wins). A clear error is raised if the key or model id is missing. `MODEL_BASE_URL` has no provider default: a run that reaches model construction without it fails fast with a clear error naming `MODEL_BASE_URL`. `--dry-run` never constructs a model, so it does not require `MODEL_BASE_URL`.

### Validation

A missing value, non-numeric, fractional, zero or negative `--max-turns`/`--max-steps`/`--tool-rounds` is a usage error (`Usage: --<flag> <n> must be a positive integer ...`) with a non-zero exit, before any workspace or model call. `--task-file` is validated the same way (see the flags table above) before the workspace is created.

## Generated apps live outside the repo

Every run gets its own workspace under `--runs-dir` (default: a `pi-runs`
directory next to this monorepo, resolved from the runner's own file
location — so generated apps are never written inside this repository, even
accidentally). The workspace dir name is
`<model-slug>-<config>-<YYYYMMDDTHHMMSS>` (UTC), e.g.
`test-model-5-2-c1-20260105T030405`; the slug is the model id lowercased with every
run of non-`[a-z0-9]` characters collapsed to a single `-`, trimmed.
`--dry-run` only prints the planned workspace path and creates nothing.

### Per-run repo

After a run finishes — **success or failure** — the workspace is turned into
its own git repo:

1. `git init -b main`.
2. A `.gitignore` is added (or extended) with `node_modules/`, `dist/`,
   `build/`, `coverage/` and `.env*`.
3. Everything is committed (including `run-report.json` and the
   `audit*.jsonl` logs) with message `run: <model> <config> (<status>)`,
   using a fixed local git identity (`pi-runner
   <pi-runner@users.noreply.github.com>`) passed via `-c user.name=`/
   `-c user.email=` — the operator's own git identity is never required.

A failure during this step never loses the run: it's recorded as
`run-report.json`'s `repoError` field and the process continues.

### Publishing (`--publish`, off by default)

`--publish` requires an authenticated `gh` CLI; `gh auth status` is checked
**before** any model call, failing with a usage-style error if it's not
authenticated. After the local commit above, publishing:

Both guards below only ever look at **tracked** files — the exact list
`git -C <workspace> ls-files` returns, i.e. exactly what the per-run commit
(and `--publish`) ships — never the whole working tree, so a gitignored
`.env`, `node_modules/`, `dist/`, etc. can never trip (or hide from) either
guard.

1. Refuses (and never calls `gh`/`git`) if any tracked file is a
   byte-identical copy (sha256 over raw bytes) of a file under
   `experiment/acceptance/` (the hidden bench) — a defensive assertion,
   since the runner never copies that directory into a generated workspace.
   This is a **content** check, not a path check: a generated app's own
   folder that happens to be named `acceptance/` is never flagged, only an
   actual copy of a bench file is, regardless of where it ends up in the
   workspace.
2. Scans every tracked file's raw bytes (so a binary file is matched
   honestly instead of silently skipped) for the exact model API key value
   used by the run, for the value of any `--harness-config` router route's
   `apiKeyEnv`, and for every non-empty `env` value of 8 characters or more
   configured on a `--harness-config` MCP server (shorter values are
   dropped to avoid false positives on non-secret-looking short strings).
   On a hit, it refuses to publish and records `run-report.json`'s
   `publishError: "secret detected in <relative path>"` — the secret's
   **value** is never printed or stored.
3. Otherwise creates a public repo `<org>/run-<workspace dir name>` with
   `gh repo create <repo> --public --source <workspace> --push
   --description "<model> <config> run generated by the PI-I harness"`,
   records `repository: { name, url }` in `run-report.json`, then commits
   and pushes that updated report as a second commit (`run: record
   repository metadata`) rather than guessing the URL before the repo
   exists.

Any failure in this flow (missing `gh` auth, secret found, bench leakage,
`gh`/`git` failure) is recorded in `run-report.json` and makes the process
exit non-zero; the run itself is never lost.

The hidden acceptance batteries (`experiment/acceptance/`) always stay in
this bench repo — the runner never copies them into a generated workspace,
so they can never reach a published repo either.

### Tests

`node --test runner/run-experiment.test.mjs` (Node's built-in test runner; no extra dependency). Covers the `--harness-config` wiring against the harness's fixture MCP server + skill fixtures: `run-report.json`'s `harnessConfig` metadata, the guardrail allowlist extended with MCP tools + `load_skill`, the MCP provider being closed when skill loading fails, and that a run without `--harness-config` registers the same tool set as before. Also covers `createModel()` (returns a plain `OpenAICompatibleModelAdapter` without a router, wraps it in a `RoutingModelAdapter` with the configured routes using an injected `makeAdapter` stub — no network — when one is configured, and propagates a clear missing-env-var error) and `summarizeRouting()` (decision log → counts per route/reason). `run-experiment.mjs` only runs `main()` when executed directly (`node runner/run-experiment.mjs ...`), so importing it for tests has no side effects.

`--task-file` wiring is covered by spawning the real CLI with `--dry-run` (dummy `MODEL_API_KEY`/`MODEL_ID` in the child env, since `loadCredentials()` runs before the dry-run branch): the printed plan's c3 node tasks carry the override text and never mention `SPEC`, and an empty/whitespace-only task file exits non-zero with a `Usage: --task-file ...` message on stderr and no stdout. `compactTraceC3()` is exported and tested directly for copying `loopFailure` into a failed trace entry while leaving it off a successful one.

T3 (runs dir, per-run repo, publish) is covered with no network and no real GitHub: `parseArgs()`'s default `--runs-dir` resolving outside the monorepo and the new `--publish`/`--publish-org` flags; `slugifyModelId()` and `timestampForWorkspace()`; `createWorkspace()`'s `<slug>-<config>-<timestamp>` naming and that `--dry-run` creates nothing (also exercised end-to-end via a real `--dry-run` CLI spawn); `initWorkspaceRepo()` against a real local git repo in a temp dir (branch `main`, one commit with the fixed `pi-runner` identity, `.gitignore` covering `node_modules/`/`dist/`/`build/`/`coverage/`/`.env*`); `scanWorkspaceForSecrets()`/`collectSecretValues()` detecting a planted key (and a configured route's `apiKeyEnv`) without ever asserting on the value itself; `findAcceptancePathInWorkspace()`; and `publishWorkspace()`/`checkGhAuthenticated()` with an injected command-runner stub in place of `gh`, covering the built `gh repo create` command, the `repository` field written to `run-report.json`, and that the secret/acceptance guards refuse before `gh`/`git` is ever invoked.

## Configurations

- **c1** — Single `Harness.run(task)` interaction. No verification, no retry. Fastest, weakest.
- **c2** — `AgentLoop` with corrective turns. Each turn runs the harness, then the verification command decides FINISH / RETRY / FAIL.
- **c3** — `GraphEngine` with a 5-node fixed topology and a custom router.

### C2 docker compose teardown

C2's default `--verify-cmd` starts a docker compose stack
(`docker compose up -d --build`) to run the health check against, which
would otherwise keep running after the process exits and make the next run
on the same (fixed) ports fail. At the end of a c2 run — success, failure,
or a thrown exception, via a `finally` — the runner tears that stack down
(`docker compose down -v`) in the workspace whenever the verify command
mentions `docker compose`, or whenever the workspace has its own
`docker-compose.yml`/`compose.yaml` (the SPEC requires one) regardless of
what `--verify-cmd` says. A teardown failure is recorded as
`run-report.json`'s `teardownError`, never masking the run's own result.
Teardown is skipped when `--with-batteries --keep` was requested together,
since the battery phase already intentionally left the stack up for
inspection. The battery phase below (which starts its own stack) reuses the
same teardown helper.

### C3 topology

| Node | Role | Task essence | Verification |
|------|------|--------------|--------------|
| architect | architect | Write `docs/architecture.md` | `test -f docs/architecture.md` |
| data | data | Implement data layer (migrations + seed) | none |
| backend | backend | Implement NestJS backend (EP-01..EP-20) | none |
| frontend | frontend | Implement React SPA (SCR-01..SCR-08) | none |
| reviewer | reviewer | Review system, write `review-verdict.json` | `test -f review-verdict.json` |

Router:
- Non-reviewer nodes flow linearly: architect → data → backend → frontend → reviewer.
- A failed node is retried once (same node), then the graph fails.
- After reviewer: `acceptable: true` → FINISH; `responsible: X` → NEXT X; otherwise retry reviewer once, then FAIL.
- Before every reviewer visit (including a retry), any `review-verdict.json`
  already in the workspace is deleted first, so a stale verdict from an
  earlier visit can never satisfy this visit's `test -f review-verdict.json`
  verification or be misread by the router above as this visit's result.

## MCP tools and skills (`--harness-config`)

A JSON config (see `harness/examples/harness-config.json`) can add MCP tools
and agent skills identically to C1, C2 and C3:

```json
{
  "mcpServers": { "name": { "command": "...", "args": [], "env": {}, "cwd": "." } },
  "skillsDirs": ["./skills"]
}
```

The runner loads it once per run: one MCP connection (`McpToolProvider`)
is opened and shared across every harness the run builds (C3 builds one
per graph node), and one `SkillCatalog` is loaded once. Each harness's
tool manager gets the same MCP tools plus `load_skill` registered into it,
and the guardrail `allowedTools` list is extended with those tool names —
so guardrails and the audit log apply to MCP/skill calls exactly like the
built-in tools. The connection is always closed at the end of the run
(`finally`), even on failure; a failure while closing it is logged and
recorded under `run-report.json`'s `closeError` field without replacing
the run's own failure. Without `--harness-config`, none of this runs and
output is unchanged.

A missing/invalid config file, a server that fails to connect, or a
skills directory that fails to load are recorded like any other run
failure: `run-report.json` is still written, with `status: "FAILED"` and
`failure: "harness-config: <message>"`, and the process exits non-zero.
`--harness-config` with no path value is a usage error (matching
`--config`), not a raw stack trace.

## Model router (`--harness-config` with a `router` section)

The same `--harness-config` file can also carry an optional `router`
section (see `harness/docs/model-router.md`). It is **not** set in this
repo's own `experiment/harness-config.json` — routing stays off by
default — but a config that opts in looks like:

```json
{
  "skillsDirs": ["./skills"],
  "router": {
    "longContextThreshold": 60000,
    "routes": {
      "longContext": { "model": "gpt-4o-mini-long-context", "apiKeyEnv": "LONG_MODEL_API_KEY" },
      "retry": { "model": "gpt-4o-mini" }
    }
  }
}
```

When set, the runner wraps the model it builds for the run in a
`RoutingModelAdapter` — identically for c1, c2 and c3 — so requests over
`longContextThreshold` go to `longContext`,
retry turns (verification feedback present) go to `retry`, and everything
else keeps going to the default model. Without a `router` section (or
without `--harness-config` at all), the model is unwrapped and behavior
is unchanged.

## Metrics recorded — `routing`

When a router is active, `run-report.json` gains a `routing` field:

```json
{
  "routing": {
    "byRoute": { "default": { "calls": 3, "promptTokens": 120, "completionTokens": 60, "totalTokens": 180, "cost": 0.01 } },
    "decisions": { "default:default": 3, "longContext:long_context": 1 }
  }
}
```

`byRoute` is the per-route usage from `RoutingModelAdapter.getRouting()`.
`decisions` is the route-decision log collapsed into counts per
`"<route>:<reason>"` key rather than the full per-call list, which would
otherwise grow unbounded over a long C2/C3 run; per-route/per-reason
counts are enough to see which rule fired and how often. `harnessConfig`
metadata also gains a `routeNames` array (`["default", ...]`) when a
router is configured.

## Battery phase (`--with-batteries`)

1. `docker compose up -d --build` in the workspace.
2. Poll `GET http://localhost:3000/health` up to 120 s.
3. Run `node run-all.mjs` **from `experiment/acceptance/` as its working
   directory** (the hidden bench, never copied into the workspace) against
   the generated app, with `WORKSPACE` set to the workspace path plus
   `BACKEND_URL`/`FRONTEND_URL`/`DB_URL` for the running stack.
4. Save the aggregated report as `batteries-report.json` in the workspace.
5. `docker compose down -v` (unless `--keep`) — the same teardown helper the
   c2 run-end teardown above uses.

> **Warning:** Ports 5432, 3000 and 8080 are fixed. Run one experiment at a time; concurrent runs will conflict.

## Metrics recorded

Every run writes `run-report.json` into the workspace:

```json
{
  "config": "c1|c2|c3",
  "model": "gpt-4o-mini",
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 0,
  "status": "SUCCESS|FAILED",
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "calls": 0 },
  "turns": 0,
  "steps?": 0,
  "totalLoopTurns?": 0,
  "decision?": {},
  "failure?": "...",
  "trace": [...],
  "harnessConfig?": {
    "path": "...",
    "sha256": "...",
    "mcpServers": ["..."],
    "toolNames": ["mcp__server__tool", "load_skill"],
    "skillNames": ["..."],
    "routeNames?": ["default", "longContext", "retry"]
  },
  "routing?": {
    "byRoute": { "default": { "calls": 0, "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "cost": 0 } },
    "decisions": { "default:default": 0 }
  },
  "closeError?": "...",
  "teardownError?": "...",
  "repoError?": "...",
  "repository?": { "name": "harness-loop-graph/run-...", "url": "https://github.com/..." },
  "publishError?": "..."
}
```

- `turns` — interaction turns (C1/C2) or per-node loop turns aggregated (C3).
- `steps` — graph steps (C3 only).
- `totalLoopTurns` — total loop turns across all nodes (C3 only).
- `trace` — compact per-turn/per-step summaries; no full model content. For
  c3, a step whose `loopStatus` is `"FAILED"` also carries `loopFailure`:
  why that node's loop failed (its own failure summary, or the terminal
  decision reason; with the model error code/message appended, truncated,
  when the final response was an `error`) — so a `FAILED` step is
  actionable instead of a bare status. A successful step has no
  `loopFailure` field.
- `harnessConfig` — only present with `--harness-config`: the config path,
  a sha256 of its content, the configured MCP server names, every
  registered tool name (MCP + `load_skill`), every loaded skill name, and
  (only when `router` is configured) `routeNames` — `["default", ...]`.
  A failure loading/connecting it is recorded as `status: "FAILED"` and
  `failure: "harness-config: ..."` instead (see above).
- `routing` — only present when a `router` section is configured; see
  "Model router" above.
- `failure` — also covers an exception thrown anywhere during the run
  (e.g. `createModel()` rejecting because a router route's `apiKeyEnv` is
  unset, or any harness/loop/graph error): it is caught, `status` is set to
  `"FAILED"` and `failure` records the error message, and `run-report.json`,
  the per-run git repo and `--publish` all still run — a thrown exception
  never loses the run.
- `closeError` — only present if closing the MCP connection at the end of
  the run itself failed; never replaces `failure`.
- `teardownError` — only present if tearing down a c2 run's docker compose
  stack at the end of the run failed (see "C2 docker compose teardown"
  below); never replaces `failure`.
- `repoError` — only present if turning the workspace into a git repo failed
  (see "Per-run repo" above); the run and its report are kept regardless.
- `repository` — only present after a successful `--publish`: the created
  repo's `name` (`<org>/run-<workspace dir name>`) and `url`.
- `publishError` — only present if `--publish` was given and publishing was
  refused or failed (see "Publishing" above); never includes a secret value.

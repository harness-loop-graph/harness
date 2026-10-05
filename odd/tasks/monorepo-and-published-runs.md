# Feature: Monorepo + generated apps published as GitHub repos

## Objective
One repository (`harness-loop-graph/harness`) holds the generator (`harness/`) and the experiment bench (`experiment/`). Every generated app lives outside that repository and can be published as its own GitHub repository for static analysis (SonarCloud).

## Problem / Why
- Advisor objected to two separate repos (`harness`, `experiment`).
- Generated apps were written to `experiment/runs/` inside the bench repo (gitignored). They must be independent projects so each can be analyzed and cited on its own; the user requires them on GitHub.

## Decisions (user, 2026-10-04)
- Surviving repo: `harness-loop-graph/harness` (name kept). `harness-loop-graph/experiment` gets archived with a pointer.
- Generated apps: one GitHub repo per run in the `harness-loop-graph` org.

## Scope
- Monorepo layout: `harness/` (former glm), `experiment/` (former experiment repo), `odd/` at root, root README. Full history of both repos preserved.
- Runner: default runs dir outside the repository; each run workspace becomes a git repo with one commit; opt-in `--publish` creates `harness-loop-graph/run-<model>-<config>-<stamp>` (public) and pushes it; `run-report.json` records the repo URL.

## Constraints
- `experiment/acceptance/` (hidden batteries) never reaches a generated app or a published repo.
- Before publishing, refuse if any file in the workspace contains the model API key value.
- `--publish` is off by default (smoke tests must not create repos).
- No push to `main` / no archive of `experiment` without explicit user approval; warn about the teammate's paths changing.
- Minimal comments.

## TDD
Mode: off (source: no project/session TDD configuration). Checks: `npm test` + `npm run build` in `harness/`; `node --test experiment/runner/run-experiment.test.mjs`.

## Tasks
- [x] T1 — Merge: move glm into `harness/`, experiment into `experiment/`, merge with unrelated histories; root README + .gitignore.
- [x] T2 — Fix paths (runner import, tests, docs) so all checks pass in the new layout.
- [x] T3 — Runner: default runs dir outside the repo; per-run git repo + commit; `--publish` to GitHub with secret guard; report records repo URL; tests + README.
- [x] T3b — Review fixes (user-authorized 2026-10-05): catch run-phase exceptions so report + repo are always written; publish guards scan only `git ls-files`; tear down c2 docker compose stack at run end; delete `review-verdict.json` before each reviewer visit; stale docs (experiment README, battery path, root quick start); env-independent dry-run test; validate task file before creating workspace; validate numeric flags; secret scan includes MCP server env values.
- [ ] T4 — Delivery (user approval): push, archive `experiment` with pointer, update repo description, notify teammate.

## Acceptance criteria
- `git log` shows the history of both former repos.
- All checks pass from the monorepo.
- A run without `--publish` creates a local git repo outside the monorepo; with `--publish` it creates and pushes a public org repo, refusing if the API key appears in any file.

## Progress / Evidence
- T1: glm moved to `harness/` (862f030), experiment moved to `experiment/` in its repo (9a58639), merged with unrelated histories (1a04258); 60 commits reachable. Root `.gitignore` protects `.env` (left at repo root by user permission rules), `experiment/acceptance/` copied and ignored.
- T2: 2615d15 — runner imports `../../harness/dist`, falls back to root `.env`; tests use `harness/tests` fixtures; docs updated; root README. Checks: harness build 0, 102/102 tests; runner 16/16; c1 dry-run OK.
- T3: 794d0fd — default `--runs-dir` is now `<monorepo>/../pi-runs` (resolved from the runner's own file location, via `path.resolve(__dirname, '..', '..', '..', 'pi-runs')`); workspace dir is `<model-slug>-<config>-<YYYYMMDDTHHMMSS>` (`slugifyModelId`, `timestampForWorkspace`). After every run (success or failure), `initWorkspaceRepo()` runs `git init -b main`, writes/extends `.gitignore` (`node_modules/`, `dist/`, `build/`, `coverage/`, `.env*`), and commits everything (including `run-report.json` and the audit logs) with a fixed `pi-runner <pi-runner@users.noreply.github.com>` identity; a failure is recorded as `report.repoError`, never thrown. New `--publish` (off by default) checks `gh auth status` before any model call, then `publishWorkspace()` refuses (no `gh`/`git` call) if the workspace has any `acceptance/`-segment path or if `scanWorkspaceForSecrets()` finds the run's `MODEL_API_KEY` value or any configured router route's `apiKeyEnv` value in a committed file (`publishError: "secret detected in <relative path>"`, value never printed); otherwise it runs `gh repo create <org>/run-<workspace dir> --public --source <ws> --push --description "..."`, records `report.repository = { name, url }`, and commits+pushes the updated report as a second commit. New `--publish-org` (default `harness-loop-graph`). README: flags table, "Generated apps live outside the repo" section (per-run repo layout, publishing flow, secret guard, acceptance never leaves the bench), `run-report.json` fields (`repoError`, `repository`, `publishError`).
  - Deviation: the pre-existing workspace timestamp (`new Date().toISOString().replace(/[:.]/g,'')...`) didn't match the requested `YYYYMMDDTHHMMSS` (it kept `-`/`T` from ISO); replaced with a dedicated `timestampForWorkspace()` producing exactly that format. No other deviation from the task text.
  - Checks: `harness && npm test` 102/102, `npm run build` clean; `node --check` OK; `node --test run-experiment.test.mjs` 31/31 (16 pre-existing + 15 new, no network/no real `gh`, `initWorkspaceRepo()` tested against real local git in a temp dir); `--config c1 --dry-run` prints a workspace path under `.../ProjectoIntegrador1/pi-runs/...` and creates nothing; `git status --short` on the parent `ProjectoIntegrador1` repo identical before/after.
  - Not exercised live (by design, per constraints): a real `--publish` run (no real `gh repo create` was called; command construction and guards are unit-tested with an injected runner).
- T3b — fixed 7 verified review findings in `experiment/runner/run-experiment.mjs`:
  1. The run phase (per-config dispatch + battery phase) now has a `catch` alongside its `finally`: any thrown exception (e.g. `createModel()`/`createRoutedModel()` rejecting because a router route's `apiKeyEnv` is unset) sets `report.status = 'FAILED'` and `report.failure`, then execution still falls through to write `run-report.json`, run `initWorkspaceRepo()` and (if requested) `--publish`; the process exits non-zero via a new `runException` flag.
  2. `walkWorkspaceEntries()` (whole working tree) replaced with `listTrackedFiles()` (`git -C <ws> ls-files -z`, since `ws` is already a git repo by the time either guard runs). `scanWorkspaceForSecrets()` now scans only tracked files, reading each as a `Buffer` and matching every secret value as raw bytes (`Buffer.includes`), so a binary file is matched honestly instead of silently decoded as UTF-8. `findAcceptancePathInWorkspace(ws, benchDir = .../experiment/acceptance)` no longer uses a path-segment regex: it sha256-hashes every file under the bench (skipping `.git`/`node_modules`) and every *tracked* workspace file, and flags the first byte-identical match — so a generated app's own `acceptance/` folder (different content) never trips it, only an actual copy of a bench file does, regardless of its path. `benchDir` and (on `publishWorkspace`) a new `benchDir` param are test-injectable.
  3. `collectSecretValues()` also includes every non-empty `env` value (≥ 8 chars, documented in the README) from a `--harness-config`'s `mcpServers`; `loadHarnessExtras()` now exposes the parsed `mcpServers` config on the returned `harnessExtras` for this.
  4. New `teardownDockerCompose(ws, run)` helper (`docker compose down -v`, never throws, returns an error string or `null`); `runBatteries()` now calls it instead of its own inline teardown. A new `workspaceMayHaveDockerStack(ws, verifyCmd)` check (verify command mentions `docker compose`, or the workspace has its own compose file) gates a c2 run-end teardown added to the existing `finally` block, recorded as `report.teardownError`; skipped when `--with-batteries --keep` was requested together (the battery phase already left the stack up on purpose).
  5. New `clearStaleReviewVerdict(ws)` (sync `rmSync(..., { force: true })`) is called from the c3 node factory before every `reviewer` node visit, so neither that visit's `test -f review-verdict.json` verification nor `buildRouter()` can be satisfied by a stale verdict left from an earlier visit.
  6. `--task-file` is now validated (readable, non-empty) *before* `createWorkspace()` (previously after), so a bad `--task-file` never leaves an orphan workspace directory. New `parsePositiveIntFlag()` rejects a missing, non-numeric, fractional, zero or negative `--max-turns`/`--max-steps`/`--tool-rounds` value with a `Usage: --<flag> <n> must be a positive integer ...` error and non-zero exit.
  7. The `c1 --dry-run ... nothing is created on disk` test no longer asserts on the global default `--runs-dir` (which this machine already had populated from prior real runs, making the test silently pass/fail on unrelated state); it now uses its own temp `--runs-dir` and asserts the exact planned workspace path was not created.
  - Docs: `experiment/README.md` (directory in the monorepo, not "this repository"; generated apps live in `../pi-runs` by default, points to `runner/README.md`); `experiment/runner/README.md` (flags table validation notes, publishing section rewritten for tracked-files + byte + hash-based guards and the MCP-env threshold, new "C2 docker compose teardown" section, C3 router note on `review-verdict.json` clearing, battery-phase step 3 corrected to `node run-all.mjs` run from `experiment/acceptance/` as cwd against the workspace, `teardownError` added to the metrics schema and `failure` bullet mentions caught exceptions); root `README.md` quick start wrapped in a subshell (`(cd harness && ...)`) so the following runner command still runs from the repo root.
  - Checks: `harness && npm test` 102/102, `npm run build` clean (unchanged, no harness source touched); `node --check run-experiment.mjs` OK; `node --test run-experiment.test.mjs` 48/48 (31 pre-existing, rewritten where behavior changed, + 17 new); `--config c1 --dry-run` from the repo root prints a workspace path under `pi-runs/` and creates nothing; root README quick start commands run successfully from the repo root; `git status --short` on the parent `ProjectoIntegrador1` repo identical before/after.
  - Deviation: none from the review findings text. Noted anomaly (not caused by this task, left untouched): during this session `harness/README.md` was found replaced on disk by an untracked `harness/README 2.md` (byte-identical content) — looks like an OS/iCloud sync conflict-copy artifact on this machine, unrelated to any edit made here (only `run-experiment.mjs`, its test file, and the three READMEs listed above were touched). Flagged for the user; not committed.

- T4 (2026-10-05, user-approved steps 1-3): harness main aef423b..0a5d8d3 pushed (fast-forward); `harness-loop-graph/experiment` got an archive notice (a71f20a) and was archived (read-only), description updated; `harness` description updated. Pending: teammate notification (user), optional local folder rename `glm` → `harness`, moving the checkout out of the iCloud-synced folder.

## Next step
Notify the teammate about the path change (`src/` → `harness/src/`). Then the first real C1 run on the full SPEC with Qwen.

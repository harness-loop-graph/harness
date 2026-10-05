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

## Next step
T4 (user-approval delivery: push, archive `experiment`, update repo description, notify teammate).

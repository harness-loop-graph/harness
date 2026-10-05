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
- [ ] T1 — Merge: move glm into `harness/`, experiment into `experiment/`, merge with unrelated histories; root README + .gitignore.
- [ ] T2 — Fix paths (runner import, tests, docs) so all checks pass in the new layout.
- [ ] T3 — Runner: default runs dir outside the repo; per-run git repo + commit; `--publish` to GitHub with secret guard; report records repo URL; tests + README.
- [ ] T4 — Delivery (user approval): push, archive `experiment` with pointer, update repo description, notify teammate.

## Acceptance criteria
- `git log` shows the history of both former repos.
- All checks pass from the monorepo.
- A run without `--publish` creates a local git repo outside the monorepo; with `--publish` it creates and pushes a public org repo, refusing if the API key appears in any file.

## Progress / Evidence
(pending)

## Next step
T1.

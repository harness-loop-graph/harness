# Loop — C2: the corrective loop

C2 wraps the C1 harness with a corrective loop: each turn runs one full
`Harness.run(...)` interaction, then an operator-owned verification command
runs against the workspace, and the loop deterministically decides whether
to stop, retry with feedback, or give up. Implementation:
`src/loop/agent-loop.ts` (`AgentLoop`), contracts in `src/loop/contracts.ts`.

```
starting → generating → observing → verifying → deciding → final
                                                ├─ FINISH (verification passed)
                                                ├─ RETRY  (feedback fed to next turn)
                                                └─ FAIL   (max_turns reached)
```

The decision policy lives entirely in `AgentLoop.decide(...)` — a plain
TypeScript method, not a model call. Verification evidence, not the model's
own claim of success, closes the loop.

## `AgentLoop`

Constructed with `LoopDeps`: `harness: Harness`, `execution: ExecutionManager`,
`verification: VerificationManager`, `workspaceRoot: string`. These are the
same component instances (or fresh ones) used to build the wrapped
`Harness` — the loop needs its own handle on execution/verification because
the verification command is run *after* the harness interaction, outside
the model's tool-call flow.

`run(request: LoopRequest): Promise<LoopResult>` iterates `turn` from `1` to
`request.maxTurns`:

1. **generating** — calls `harness.run(request.task, { feedback, maxToolRounds: request.toolRoundsPerTurn ?? 8 })`. `feedback` is whatever the *previous* turn's `buildFeedback` produced (`undefined` on turn 1).
2. **observing** — no-op phase marker; exists so the state machine names the point between generation and verification.
3. **verifying** (only if `request.verification` is set) — runs
   `execution.run({ command: request.verification.command, cwd: workspaceRoot })`
   and feeds the result to `verification.verify(...)`. The verification
   command is **never shown to the model** — only its pass/fail feedback is,
   via the next turn's `feedback` string.
4. **deciding** — calls `this.decide(finalResponse, verification, maxTurns - turn)` and records `state.lastAction`.
5. Appends a `LoopTurnTrace` entry (`turn`, `phases`, `response`,
   `verification`, `decision`, and `feedback` when the decision was RETRY).
6. On `FINISH` the loop breaks immediately. On `RETRY` it computes feedback
   via `buildFeedback` and continues to the next turn. On `FAIL` it breaks.

After the loop, `state.phase = 'final'` and the result is built:
`status: 'SUCCESS'` iff the last decision was `FINISH`; otherwise `'FAILED'`
with a `failure` string — `` `max_turns (${maxTurns}) reached without
success` `` if the turn counter hit the limit, or the last decision's own
`reason` otherwise.

## Decision policy — `AgentLoop.decide`

```
response.type !== 'finish'
  → turnsLeft > 0 ? RETRY : FAIL   ("Model returned <type/error code>")
response.type === 'finish', no verification configured
  → FINISH  ("Model finished; no verification was configured")
response.type === 'finish', verification.passed
  → FINISH  ("Model finished and verification passed")
response.type === 'finish', verification failed
  → turnsLeft > 0 ? RETRY : FAIL
```

So a `finish` response is *not* sufficient on its own when a verification
command is configured — the workspace has to actually satisfy it. A
`tool_call` response reaching the loop (i.e. the harness returned it as the
final response, which only happens if `maxToolRounds` was exhausted mid
tool-call) is treated the same as any other non-`finish` type: RETRY or FAIL
depending on turns left.

## Feedback — `AgentLoop.buildFeedback`

Built only when the decision is RETRY. Two independent parts, joined with a
space:
- If the harness's final response was an `error`, a sentence naming the
  error `code` and `message`.
- If verification ran and failed, a sentence with `verification.details`
  plus an instruction to fix the workspace so the command passes.

This string becomes `runOptions.feedback` on the harness call for the next
turn, and the harness only injects it into the model-facing request on the
first tool round of that turn (see `Harness.run`, `round === 0`).

## Contracts — `src/loop/contracts.ts`

- **`LoopPhase`** — `'starting' | 'generating' | 'observing' | 'verifying' | 'deciding' | 'final'`.
- **`LoopRequest`** — `task`, `maxTurns` (reaching it without success is a
  FAIL), optional `verification: { command }` (operator-owned; a
  finish response is accepted unverified when absent), optional
  `toolRoundsPerTurn` (default 8, applied by `AgentLoop` when calling
  `harness.run`), optional `instructions`.
- **`LoopState`** — `task`, 1-based `turn`, `phase`, `lastAction` (mirrors
  the latest decision's `action`), `verifications` (oldest first).
- **`LoopDecision`** — `{ action: 'FINISH' | 'RETRY' | 'FAIL', reason }`.
- **`LoopResult`** — `{ status: 'SUCCESS' | 'FAILED', turns, finalResponse?,
  decision, verifications, trace, failure? }`.
- **`LoopTurnTrace`** — `{ turn, phases, response, verification?, decision,
  feedback? }` (feedback present only on RETRY turns).

## Behavior verified by `tests/loop.spec.ts`

The test suite exercises: FINISH on the first turn when verification
passes; RETRY across turns when the model's first claim of completion
doesn't survive verification, with the corrective feedback actually
reaching and fixing the workspace on the second turn; FAIL once `maxTurns`
is exhausted with every verification still failing; RETRY-then-SUCCESS
after the harness itself returns an `error` response; and acceptance of a
plain `finish` response as SUCCESS when no `verification` is configured at
all.

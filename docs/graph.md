# Graph — C3: the multi-agent graph

C3 wraps C2 in a state machine over nodes: each node is one role
(architect, data, backend, frontend, reviewer, ...) that runs its own C2
`AgentLoop`, and edges route to the next node based on that loop's outcome.
Implementation: `src/graph/graph-engine.ts` (`GraphEngine`), contracts in
`src/graph/contracts.ts`.

```
architect --on_success--> data --on_success--> backend ...
reviewer --on_failure--> backend   (returns to the responsible layer)
successful node with no outgoing edge = terminal FINISH
maxSteps = graph-level infinite-loop prevention
```

Routing is deterministic: the reviewer pattern is expressed as a plain
`on_failure` edge from `reviewer` back to the node responsible for the
failure — never a model choice.

## `GraphEngine`

Constructed with `(createLoop: LoopFactory, request: GraphRequest, router?: GraphRouter)`.
`LoopFactory = (node: GraphNode) => AgentLoop` — the caller decides how to
wire each node's `AgentLoop` (its own `Harness`, tool set, guardrails
instance, etc.); the engine itself never constructs harness components.

`run(): Promise<GraphResult>` loops:

1. If `state.step >= maxSteps` (default 10), decide `FAIL` with reason
   `` `maxSteps (${maxSteps}) reached without finishing` `` and stop.
2. Look up `state.currentNode` in the node map; an unknown id decides `FAIL`
   with `` `Unknown node '${id}'` ``.
3. Increment `state.step` and `state.visits[node.id]`.
4. Build the node's `AgentLoop` via `createLoop(node)` and run it with a
   `LoopRequest` derived from the node: `task`, `maxTurns: node.maxTurns ?? 3`,
   `verification: node.verification`, `toolRoundsPerTurn: node.toolRoundsPerTurn ?? 8`,
   `instructions: node.instructions`.
5. Record a `NodeExecution` (`nodeId`, `role`, `status`, `turns`,
   `finalResponse`, `verifications`) and, if the loop's final response was a
   `finish`, store its content in `state.shared[node.id]` — the mechanism by
   which one node's output becomes visible to a later node or to a custom
   router.
6. Decide the next step: `router ? router(node.id, loopResult, state) : this.route(node.id, loopResult.status)`.
7. On `NEXT`, set `state.currentNode = decision.node` and continue the loop.
   On `FINISH` or `FAIL`, stop.

`totalLoopTurns` accumulates every node loop's `turns` across the whole
run. The final `GraphResult.status` is `'SUCCESS'` iff the terminal decision
was `FINISH`.

### Default routing — `GraphEngine.route`

When no custom `router` is supplied, edges are matched against the node
that just ran: filter `request.edges` by `from === nodeId`, pick the edge
whose `condition` matches the loop's outcome (`on_success` if the node's
loop status was `SUCCESS`, `on_failure` otherwise), falling back to an
`always` edge if no conditional match exists. If still no edge matches: a
successful node with no outgoing edge is **terminal** (`FINISH`); a failed
node with no `on_failure` edge **fails the whole graph** (`FAIL`).

### Custom routing — `GraphRouter`

`(nodeId, loopResult, state) => GraphDecision`. Passed as the engine's third
constructor argument, it fully replaces `route` — useful when routing needs
to inspect `state.shared` content rather than just success/failure (verified
by `tests/graph.spec.ts`'s "routes through a custom router" case).

## `maxSteps` — loop prevention

`GraphRequest.maxSteps` (default 10) is a hard cap on the total number of
node executions across the run, independent of any per-node `maxTurns`. It
exists specifically to bound reviewer/builder ping-pong (an `on_failure`
edge sending control back and forth indefinitely): once `state.step` reaches
the cap, the graph fails with a `maxSteps (...) reached without finishing`
reason regardless of individual node outcomes.

## Contracts — `src/graph/contracts.ts`

- **`GraphNode`** — `id`, `role`, `task`, optional `instructions`, optional
  `verification: { command }` (operator-owned, never shown to the model),
  optional `maxTurns` (default 3), optional `toolRoundsPerTurn` (default 8).
- **`GraphEdge`** — `{ from, to, condition: 'on_success' | 'on_failure' | 'always' }`.
- **`GraphRequest`** — `task`, `nodes: GraphNode[]`, `edges: GraphEdge[]`,
  `initialNode`, optional `maxSteps` (default 10).
- **`GraphState`** — `currentNode`, `step`, `visits: Record<string, number>`,
  `nodeResults: NodeExecution[]` (oldest first), `shared: Record<string, string>`.
- **`NodeExecution`** — `{ nodeId, role, status, turns, finalResponse?, verifications }`.
- **`GraphDecision`** — union of `{ action: 'NEXT', node, reason }`,
  `{ action: 'FINISH', reason }`, `{ action: 'FAIL', reason }`.
- **`GraphResult`** — `{ status, steps, decision, state, trace, totalLoopTurns, failure? }`.
- **`GraphStepTrace`** — `{ step, nodeId, loopStatus, decision }`.
- **`GraphRouter`** — `(nodeId, loopResult, state) => GraphDecision`.
- **`LoopFactory`** — `(node: GraphNode) => AgentLoop`.

## Behavior verified by `tests/graph.spec.ts`

The suite covers: a linear architect → builder graph finishing on the
second `on_success` edge with the builder's own output written to
`app.txt`; the reviewer pattern (`builder → reviewer` on success,
`reviewer → builder` on failure) actually bouncing control back to the
builder and converging once the reviewer's cross-layer verification
passes; a `maxSteps` failure when builder/reviewer keep bouncing without
convergence; a `FAIL` when a node fails with no `on_failure` edge defined;
a custom `GraphRouter` overriding static edges based on `state.shared`
content; static edge fallback when no router is given; and an immediate
`FAIL` when `initialNode` doesn't match any declared node.

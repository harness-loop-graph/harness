# Grafo — C3: el grafo multiagente

C3 envuelve a C2 en una máquina de estados sobre nodos: cada nodo es un rol
(architect, data, backend, frontend, reviewer, ...) que ejecuta su propio
`AgentLoop` de C2, y las aristas enrutan al siguiente nodo según el resultado
de ese *loop*. Implementación: `src/graph/graph-engine.ts` (`GraphEngine`),
contratos en `src/graph/contracts.ts`.

```
architect --on_success--> data --on_success--> backend ...
reviewer --on_failure--> backend   (vuelve a la capa responsable)
un nodo exitoso sin arista saliente = FINISH terminal
maxSteps = prevención de bucle infinito a nivel de grafo
```

El enrutamiento es determinista: el patrón de revisor se expresa como una
simple arista `on_failure` desde `reviewer` de vuelta al nodo responsable del
fallo — nunca una decisión del modelo.

## `GraphEngine`

Se construye con `(createLoop: LoopFactory, request: GraphRequest, router?: GraphRouter)`.
`LoopFactory = (node: GraphNode) => AgentLoop` — el llamador decide cómo
conectar el `AgentLoop` de cada nodo (su propio `Harness`, conjunto de
herramientas, instancia de *guardrails*, etc.); el motor en sí nunca
construye componentes del *harness*.

`run(): Promise<GraphResult>` itera:

1. Si `state.step >= maxSteps` (10 por defecto), decide `FAIL` con el motivo
   `` `maxSteps (${maxSteps}) reached without finishing` `` y se detiene.
2. Busca `state.currentNode` en el mapa de nodos; un id desconocido decide
   `FAIL` con `` `Unknown node '${id}'` ``.
3. Incrementa `state.step` y `state.visits[node.id]`.
4. Construye el `AgentLoop` del nodo mediante `createLoop(node)` y lo ejecuta
   con un `LoopRequest` derivado del nodo: `task`,
   `maxTurns: node.maxTurns ?? 3`, `verification: node.verification`,
   `toolRoundsPerTurn: node.toolRoundsPerTurn ?? 8`,
   `instructions: node.instructions`.
5. Registra una `NodeExecution` (`nodeId`, `role`, `status`, `turns`,
   `finalResponse`, `verifications`) y, si la respuesta final del *loop* fue
   un `finish`, guarda su contenido en `state.shared[node.id]` — el mecanismo
   por el cual la salida de un nodo se vuelve visible para un nodo posterior o
   para un router personalizado.
6. Decide el siguiente paso: `router ? router(node.id, loopResult, state) : this.route(node.id, loopResult.status)`.
7. Agrega un `GraphStepTrace` para el paso. Cuando el estado del *loop* del
   nodo fue `'FAILED'`, también lleva `loopFailure`: el propio resumen
   `failure` del *loop*, o `decision.reason` cuando `failure` está ausente;
   cuando la respuesta final del *loop* fue un `error` del modelo, su código y
   mensaje (truncado a 300 caracteres) se agregan como
   `` `<reason> (error <code>: <message>)` ``. Un paso exitoso no lleva ningún
   campo `loopFailure`.
8. En `NEXT`, fija `state.currentNode = decision.node` y continúa el bucle.
   En `FINISH` o `FAIL`, se detiene.

`totalLoopTurns` acumula los `turns` de cada *loop* de nodo a lo largo de toda
la corrida. El `GraphResult.status` final es `'SUCCESS'` si y solo si la
decisión terminal fue `FINISH`.

### Enrutamiento por defecto — `GraphEngine.route`

Cuando no se provee un `router` personalizado, las aristas se comparan contra
el nodo que acaba de ejecutarse: se filtra `request.edges` por `from === nodeId`,
se elige la arista cuya `condition` coincide con el resultado del *loop*
(`on_success` si el estado del *loop* del nodo fue `SUCCESS`, `on_failure` en
caso contrario), recurriendo a una arista `always` si no hay coincidencia
condicional. Si aun así ninguna arista coincide: un nodo exitoso sin arista
saliente es **terminal** (`FINISH`); un nodo fallido sin arista `on_failure`
**hace fallar todo el grafo** (`FAIL`).

### Enrutamiento personalizado — `GraphRouter`

`(nodeId, loopResult, state) => GraphDecision`. Pasado como tercer argumento
del constructor del motor, reemplaza por completo a `route` — útil cuando el
enrutamiento necesita inspeccionar el contenido de `state.shared` en lugar de
solo éxito/fallo (verificado por el caso "routes through a custom router" de
`tests/graph.spec.ts`).

## `maxSteps` — prevención de bucles

`GraphRequest.maxSteps` (10 por defecto) es un tope estricto sobre el número
total de ejecuciones de nodo a lo largo de la corrida, independiente de
cualquier `maxTurns` por nodo. Existe específicamente para acotar el
"ping-pong" revisor/constructor (una arista `on_failure` que envía el control
de un lado a otro indefinidamente): una vez que `state.step` llega al tope, el
grafo falla con un motivo `maxSteps (...) reached without finishing`
independientemente de los resultados de los nodos individuales.

## Contratos — `src/graph/contracts.ts`

- **`GraphNode`** — `id`, `role`, `task`, `instructions` opcional,
  `verification: { command }` opcional (a cargo del operador, nunca mostrado
  al modelo), `maxTurns` opcional (3 por defecto), `toolRoundsPerTurn`
  opcional (8 por defecto).
- **`GraphEdge`** — `{ from, to, condition: 'on_success' | 'on_failure' | 'always' }`.
- **`GraphRequest`** — `task`, `nodes: GraphNode[]`, `edges: GraphEdge[]`,
  `initialNode`, `maxSteps` opcional (10 por defecto).
- **`GraphState`** — `currentNode`, `step`, `visits: Record<string, number>`,
  `nodeResults: NodeExecution[]` (del más antiguo al más nuevo),
  `shared: Record<string, string>`.
- **`NodeExecution`** — `{ nodeId, role, status, turns, finalResponse?, verifications }`.
- **`GraphDecision`** — unión de `{ action: 'NEXT', node, reason }`,
  `{ action: 'FINISH', reason }`, `{ action: 'FAIL', reason }`.
- **`GraphResult`** — `{ status, steps, decision, state, trace, totalLoopTurns, failure? }`.
- **`GraphStepTrace`** — `{ step, nodeId, loopStatus, decision, loopFailure? }`;
  `loopFailure` está presente solo cuando `loopStatus` es `'FAILED'` (ver el
  paso 7 arriba) — es lo que hace que una entrada `FAILED` en el trace de
  `run-report.json` sea accionable en lugar de un simple estado.
- **`GraphRouter`** — `(nodeId, loopResult, state) => GraphDecision`.
- **`LoopFactory`** — `(node: GraphNode) => AgentLoop`.

## Comportamiento verificado por `tests/graph.spec.ts`

La suite cubre: un grafo lineal architect → builder que finaliza en la segunda
arista `on_success` con la propia salida del builder escrita en `app.txt`; el
patrón de revisor (`builder → reviewer` en éxito, `reviewer → builder` en
fallo) efectivamente rebotando el control de vuelta al builder y convergiendo
una vez que la verificación entre capas del revisor pasa; un fallo por
`maxSteps` cuando builder/reviewer siguen rebotando sin converger; un `FAIL`
cuando un nodo falla sin ninguna arista `on_failure` definida; un
`GraphRouter` personalizado que sobrescribe las aristas estáticas según el
contenido de `state.shared`; el comportamiento por defecto con aristas
estáticas cuando no se provee router; un `FAIL` inmediato cuando
`initialNode` no coincide con ningún nodo declarado; la entrada de trace de un
paso fallido llevando `loopFailure` (incluyendo el código/mensaje de error del
modelo y su truncamiento cuando la respuesta final fue un `error`); y la
entrada de trace de un paso exitoso sin ningún campo `loopFailure`.

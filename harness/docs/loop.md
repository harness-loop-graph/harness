# Loop — C2: el loop correctivo

C2 envuelve el *harness* de C1 con un *loop* correctivo: cada turno ejecuta
una interacción completa `Harness.run(...)`, luego corre un comando de
verificación a cargo del operador contra el espacio de trabajo, y el *loop*
decide de forma determinista si detenerse, reintentar con feedback, o
rendirse. Implementación: `src/loop/agent-loop.ts` (`AgentLoop`), contratos en
`src/loop/contracts.ts`.

```
starting → generating → observing → verifying → deciding → final
                                                ├─ FINISH (verificación aprobada)
                                                ├─ RETRY  (feedback alimentado al siguiente turno)
                                                └─ FAIL   (se alcanzó max_turns)
```

La política de decisión vive enteramente en `AgentLoop.decide(...)` — un
método de TypeScript simple, no una llamada al modelo. La evidencia de
verificación, no la propia afirmación de éxito del modelo, cierra el *loop*.

## `AgentLoop`

Se construye con `LoopDeps`: `harness: Harness`, `execution: ExecutionManager`,
`verification: VerificationManager`, `workspaceRoot: string`. Son las mismas
instancias de componente (o instancias nuevas) usadas para construir el
`Harness` envuelto — el *loop* necesita su propio acceso a
execution/verification porque el comando de verificación se ejecuta *después*
de la interacción del *harness*, fuera del flujo de llamadas a herramientas del
modelo.

`run(request: LoopRequest): Promise<LoopResult>` itera `turn` de `1` a
`request.maxTurns`:

1. **generating** — llama a `harness.run(request.task, { feedback, maxToolRounds: request.toolRoundsPerTurn ?? 8 })`. `feedback` es lo que produjo `buildFeedback` en el turno *anterior* (`undefined` en el turno 1).
2. **observing** — marcador de fase sin operación; existe para que la máquina de estados nombre el punto entre generación y verificación.
3. **verifying** (solo si `request.verification` está configurado) — ejecuta
   `execution.run({ command: request.verification.command, cwd: workspaceRoot })`
   y pasa el resultado a `verification.verify(...)`. El comando de
   verificación **nunca se muestra al modelo** — solo su feedback de
   éxito/fallo, a través del string `feedback` del siguiente turno.
4. **deciding** — llama a `this.decide(finalResponse, verification, maxTurns - turn)` y registra `state.lastAction`.
5. Agrega una entrada `LoopTurnTrace` (`turn`, `phases`, `response`,
   `verification`, `decision`, y `feedback` cuando la decisión fue RETRY).
6. En `FINISH` el *loop* se corta de inmediato. En `RETRY` calcula el feedback
   mediante `buildFeedback` y continúa al siguiente turno. En `FAIL` se corta.

Después del *loop*, `state.phase = 'final'` y se construye el resultado:
`status: 'SUCCESS'` si y solo si la última decisión fue `FINISH`; de lo
contrario `'FAILED'` con un string `failure` — `` `max_turns (${maxTurns})
reached without success` `` si el contador de turnos llegó al límite, o el
propio `reason` de la última decisión en otro caso.

## Política de decisión — `AgentLoop.decide`

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

Es decir, una respuesta `finish` *no* es suficiente por sí sola cuando hay un
comando de verificación configurado — el espacio de trabajo tiene que
satisfacerlo realmente. Una respuesta `tool_call` que llega al *loop* (es
decir, el *harness* la devolvió como respuesta final, lo que solo ocurre si
`maxToolRounds` se agotó en medio de una llamada a herramienta) se trata igual
que cualquier otro tipo que no sea `finish`: RETRY o FAIL según los turnos
restantes.

## Feedback — `AgentLoop.buildFeedback`

Se construye solo cuando la decisión es RETRY. Dos partes independientes,
unidas con un espacio:
- Si la respuesta final del *harness* fue un `error`, una oración que nombra
  el `code` y el `message` del error.
- Si la verificación se ejecutó y falló, una oración con `verification.details`
  más una instrucción para corregir el espacio de trabajo de modo que el
  comando pase.

Este string se convierte en `runOptions.feedback` en la llamada al *harness*
del siguiente turno, y el *harness* solo lo inyecta en la solicitud visible
para el modelo en la primera ronda de herramienta de ese turno (ver
`Harness.run`, `round === 0`).

## Contratos — `src/loop/contracts.ts`

- **`LoopPhase`** — `'starting' | 'generating' | 'observing' | 'verifying' | 'deciding' | 'final'`.
- **`LoopRequest`** — `task`, `maxTurns` (alcanzarlo sin éxito es un FAIL),
  `verification: { command }` opcional (a cargo del operador; una respuesta
  finish se acepta sin verificar cuando está ausente), `toolRoundsPerTurn`
  opcional (por defecto 8, aplicado por `AgentLoop` al llamar a
  `harness.run`), `instructions` opcional.
- **`LoopState`** — `task`, `turn` (1-based), `phase`, `lastAction` (refleja
  el `action` de la última decisión), `verifications` (del más antiguo al más
  nuevo).
- **`LoopDecision`** — `{ action: 'FINISH' | 'RETRY' | 'FAIL', reason }`.
- **`LoopResult`** — `{ status: 'SUCCESS' | 'FAILED', turns, finalResponse?,
  decision, verifications, trace, failure? }`.
- **`LoopTurnTrace`** — `{ turn, phases, response, verification?, decision,
  feedback? }` (feedback presente solo en turnos RETRY).

## Comportamiento verificado por `tests/loop.spec.ts`

La suite de tests cubre: FINISH en el primer turno cuando la verificación
pasa; RETRY a través de turnos cuando la primera afirmación de finalización
del modelo no sobrevive a la verificación, con el feedback correctivo
realmente llegando y corrigiendo el espacio de trabajo en el segundo turno;
FAIL una vez agotado `maxTurns` con toda verificación aún fallando;
RETRY-luego-SUCCESS después de que el propio *harness* devuelve una respuesta
`error`; y aceptación de una respuesta `finish` simple como SUCCESS cuando no
hay ninguna `verification` configurada.

# Experimento — Medical Appointments & Clinical History

Este directorio es el **banco de experimentos**, hermano de `harness/` dentro
del monorepo `harness-loop-graph/harness` — no es un repositorio propio ni una
aplicación. Contiene la especificación fija que recibe el sistema generador
(`SPEC.md`), las baterías de aceptación ocultas (definidas antes de la primera
corrida, nunca mostradas al generador), y el runner del experimento. Lo único
que genera código es el *harness* (`../harness/`).

Los sistemas generados no viven aquí: cada corrida se construye en su propio
espacio de trabajo aislado, totalmente fuera de este monorepo — por defecto un
directorio hermano `../pi-runs` (ver `runner/README.md` para la estructura
completa y `--runs-dir`) — y las baterías corren contra ese espacio de
trabajo.

## Contenido

- `SPEC.md` — especificación fija: 27 requisitos funcionales, catálogo de
  endpoints (EP-01..EP-20), pantallas (SCR-01..SCR-08), semilla determinista,
  stack fijo (PostgreSQL 16 / NestJS / React / Vitest / Playwright / Docker
  Compose).
- `AGENTS.md` — reglas de trabajo fijas (estructura de carpetas, orden de
  construcción, qué probar, cuándo la tarea está terminada). El *runner* lo
  copia junto al `SPEC.md` en cada espacio de trabajo y registra su hash en
  `task.agentsSha256`; el *harness* lo inyecta al inicio del *system prompt*.
  Es igual para C1/C2/C3; cambiarlo invalida la comparación con corridas
  previas.
- `acceptance/` — baterías ocultas (ignoradas por git; nunca forman parte de
  lo que ve el generador).
- `skills/` + `harness-config.json` — *skills* entregadas al *harness* en
  cada configuración (ver `skills/README.md`).
- `runner/` — runner del experimento: ejecuta C1/C2/C3 en espacios de trabajo
  aislados y registra métricas (ver `runner/README.md`).

## Política de presupuestos

El recurso que se iguala entre configuraciones es **el dinero**: C1, C2 y C3
tienen el mismo tope de costo (`--max-cost`, USD 6 por defecto). Los límites
de rondas, turnos y pasos **difieren a propósito** (cada capa de ingeniería
trae su propia estructura de control, y medir su costo es parte del
experimento), pero ninguno debe ser el que corte la corrida en la práctica:
el tope de gasto es el límite que manda.

| Config | Tope de costo | Presupuesto de llamadas a herramienta |
|---|---|---|
| C1 | USD 6 | Una interacción con `--tool-rounds` (2000 por defecto: las rondas dejan de ser un límite arbitrario) |
| C2 | USD 6 | Hasta `--max-turns` turnos (40 por defecto) × `--tool-rounds` por turno (80 por defecto) |
| C3 | USD 6 | Hasta `--max-steps` pasos de grafo, cada nodo con su propio *loop* de hasta `--max-turns` turnos (8 por defecto) |

Toda corrida declara **por qué terminó** en `stopReason` de `run-report.json`
(y en la línea `Stopped:` del resumen final); ver `runner/README.md`.

C1 es una sola conversación sin compactación de historial, así que con 2000
rondas puede llenar la ventana de contexto del modelo antes de agotar el
dinero. Ese corte se registra como `stopReason: "context_overflow"` y es un
**resultado del experimento, no un bug**: es el costo de no tener capas que
gestionen el contexto.

Consecuencias para el análisis:

- **La calidad se reporta junto con su costo.** Cada resultado de C1/C2/C3
  se compara normalizado por tokens, costo (USD) y tiempo, tomados de
  `run-report.json`. Una mejora de calidad sin su costo no es un resultado.
- **Lo que debe ser idéntico entre configuraciones:** modelo, parámetros de
  muestreo (`--temperature`, `--top-p`, `--seed`, `--max-tokens`), el
  proveedor de OpenRouter fijado (`--provider`, por defecto `DeepInfra`), SPEC,
  *skills*, servidores MCP y el tope de costo (`--max-cost`). El tope es el
  mecanismo de igualación entre configuraciones, no solo una red de
  seguridad.
- **Repeticiones.** Una corrida por configuración es una anécdota; los
  modelos no son deterministas aunque se fije `seed`. Correr cada
  configuración varias veces (N ≥ 3) con los mismos flags y reportar la
  variación.
- **Reproducibilidad.** Cada `run-report.json` registra `sampling`,
  `budget`, `harnessGitSha` y `harnessGitDirty`; las corridas del experimento
  deben salir de un árbol limpio (`harnessGitDirty: false`).
- **Agregación.** `runner/aggregate-runs.mjs` consolida las corridas en
  CSV/Markdown (media y desviación por config) y excluye con motivo las
  corridas `--task-file`, *legacy* o de árbol sucio; ver `runner/README.md`.

## Por qué el stack está fijo

Si cada corrida eligiera su propio stack, las diferencias observadas entre
las configuraciones C1/C2/C3 serían atribuibles a la tecnología elegida, no a
las capas de ingeniería bajo estudio. Un único lenguaje a través de las capas
también mantiene comparables las mediciones de SonarQube/Semgrep.

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
- `acceptance/` — baterías ocultas (ignoradas por git; nunca forman parte de
  lo que ve el generador).
- `skills/` + `harness-config.json` — *skills* entregadas al *harness* en
  cada configuración (ver `skills/README.md`).
- `runner/` — runner del experimento: ejecuta C1/C2/C3 en espacios de trabajo
  aislados y registra métricas (ver `runner/README.md`).

## Política de presupuestos

Los presupuestos de cómputo **difieren entre configuraciones a propósito**:
cada capa de ingeniería trae su propio costo, y medir ese costo es parte del
experimento.

| Config | Presupuesto de llamadas a herramienta |
|---|---|
| C1 | Una interacción con `--tool-rounds` (200 por defecto) |
| C2 | Hasta `--max-turns` turnos × `--tool-rounds` por turno (30 por defecto) |
| C3 | Hasta `--max-steps` pasos de grafo, cada nodo con su propio *loop* |

Consecuencias para el análisis:

- **La calidad se reporta junto con su costo.** Cada resultado de C1/C2/C3
  se compara normalizado por tokens, costo (USD) y tiempo, tomados de
  `run-report.json`. Una mejora de calidad sin su costo no es un resultado.
- **Lo que debe ser idéntico entre configuraciones:** modelo, parámetros de
  muestreo (`--temperature`, `--top-p`, `--seed`, `--max-tokens`), SPEC,
  *skills*, servidores MCP y el tope de costo (`--max-cost`). El tope es una
  red de seguridad, no un mecanismo de igualación.
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

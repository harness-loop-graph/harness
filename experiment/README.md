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

## Por qué el stack está fijo

Si cada corrida eligiera su propio stack, las diferencias observadas entre
las configuraciones C1/C2/C3 serían atribuibles a la tecnología elegida, no a
las capas de ingeniería bajo estudio. Un único lenguaje a través de las capas
también mantiene comparables las mediciones de SonarQube/Semgrep.

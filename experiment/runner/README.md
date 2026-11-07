# Runner del experimento

CLI en ESM plano que orquesta el *harness* agnóstico de proveedor sobre el
`SPEC.md` fijo, en espacios de trabajo aislados, contra cualquier endpoint de
chat-completions compatible con OpenAI. Es el punto de entrada único para
correr las tres configuraciones del experimento (C1/C2/C3), publicar sus
resultados, y producir el `run-report.json` que se usa para comparar las
capas de ingeniería entre sí.

## Inicio rápido

```bash
node runner/run-experiment.mjs --config c1|c2|c3 [options]
```

Una corrida de validación sin llamar al modelo (imprime el plan y no crea
nada en disco):

```bash
MODEL_API_KEY=dummy MODEL_ID=dummy node runner/run-experiment.mjs --config c1 --dry-run
```

Una corrida real necesita `MODEL_API_KEY`/`MODEL_ID`/`MODEL_BASE_URL` (ver
"Credenciales" más abajo) y, salvo que se pase `--harness-config`, construye
sobre `experiment/SPEC.md` por defecto.

## Configuraciones

- **c1** — Una única interacción `Harness.run(task)`. Sin verificación, sin
  reintento. La más rápida, la más débil.
- **c2** — `AgentLoop` con turnos correctivos. Cada turno ejecuta el
  *harness*, y luego el comando de verificación decide FINISH / RETRY / FAIL.
- **c3** — `GraphEngine` con una topología fija de 5 nodos y un *router*
  personalizado.

### Topología de C3

| Nodo | Rol | Esencia de la tarea | Verificación |
|------|------|--------------|--------------|
| architect | architect | Escribir `docs/architecture.md` | `test -f docs/architecture.md` |
| data | data | Implementar la capa de datos (migraciones + seed) | `test -d backend/src/database/migrations && ls backend/src/database/migrations \| grep -q . && cd backend && npm run build` |
| backend | backend | Implementar el backend NestJS (EP-01..EP-20) | `cd backend && npm run build && npm test` |
| frontend | frontend | Implementar la SPA en React (SCR-01..SCR-08) | `cd frontend && npm run build` |
| reviewer | reviewer | Revisar el sistema, escribir `review-verdict.json` | `test -f review-verdict.json` |

Los cuatro nodos de construcción (architect, data, backend, frontend) usan
`finishOnVerificationPass: true`: su verificación es su definición de "hecho" y
el nodo termina en cuanto pasa, aunque el modelo no haya dicho `finish`
(evita que un modelo perfeccionista gaste todos los turnos puliendo). El texto
de cada tarea conserva su descripción y añade el alcance (`docs/`,
`backend/src/database/`, `backend/`, `frontend/`) y el comando que cierra el
nodo; `--task-file` reemplaza solo la descripción de la tarea, no la
verificación ni la bandera. El reviewer no usa la bandera. `--dry-run` lista
`verification` y `finishOnVerificationPass` de cada nodo en `plan.nodes`. C2
no cambia: sigue exigiendo `finish` más verificación aprobada.

Router:
- Los nodos no-revisores fluyen linealmente: architect → data → backend → frontend → reviewer.
- Un nodo fallido se reintenta una vez (mismo nodo), luego el grafo falla.
- Después del reviewer: `acceptable: true` → FINISH; `responsible: X` → NEXT X; en otro caso, reintentar reviewer una vez, luego FAIL.
- Antes de cada visita al reviewer (incluyendo un reintento), cualquier
  `review-verdict.json` ya presente en el espacio de trabajo se borra primero,
  de modo que un veredicto obsoleto de una visita anterior nunca pueda
  satisfacer la verificación `test -f review-verdict.json` de esta visita, ni
  ser malinterpretado por el router de arriba como el resultado de esta
  visita.

## Flags

| Flag | Valor por defecto | Descripción |
|------|---------|-------------|
| `--config c1\|c2\|c3` | **requerido** | Configuración del experimento |
| `--runs-dir <path>` | `<monorepo>/../pi-runs` (hermano de este repositorio, nunca dentro de él) | Raíz del espacio de trabajo de la corrida |
| `--spec <path>` | `experiment/SPEC.md` | Archivo de especificación fija |
| `--task-file <path>` | — | Sobrescribe la tarea de generación (corridas de validación económicas). En c3, cada nodo conserva su rol y verificación pero trabaja sobre esta tarea en lugar de la SPEC, y la tarea a nivel de grafo del `GraphEngine` también se fija al valor sobrescrito (los nodos son lo que el motor realmente ejecuta, pero la tarea a nivel de grafo ya no lo contradice). El archivo se valida (existe, es legible, no está vacío ni es solo espacios en blanco) **antes** de crear el espacio de trabajo de la corrida, con un error de uso y salida distinta de cero si falla, para cada `--config` — de modo que un `--task-file` inválido nunca deja un directorio de espacio de trabajo huérfano |
| `--max-turns <n>` | 40 (c2), 8 por nodo (c3) | Presupuesto de turnos del *loop* (C2, y cada nodo de C3). Debe ser un entero positivo |
| `--max-steps <n>` | 12 | Presupuesto de pasos del grafo (solo C3). Debe ser un entero positivo |
| `--tool-rounds <n>` | 2000 (c1), 80 (c2), 30 por nodo (c3) | Presupuesto de llamadas a herramienta por interacción. En c1 el valor por defecto es alto a propósito: las rondas no deben ser un límite arbitrario, el que manda es `--max-cost` (y, si la conversación única se llena, `context_overflow`). Debe ser un entero positivo |
| `--temperature <n>` | sin valor (default del proveedor) | Temperatura de muestreo, número en [0, 2]. Se aplica a **todos** los adaptadores que crea el runner (el predeterminado y los de cada ruta del *router*), de modo que C1/C2/C3 muestreen igual |
| `--top-p <n>` | sin valor | `top_p`, número en (0, 1]. Mismo alcance que `--temperature` |
| `--seed <n>` | sin valor | `seed` de muestreo, entero. Mismo alcance que `--temperature` |
| `--max-tokens <n>` | sin valor | `max_tokens` por llamada, entero positivo. Mismo alcance que `--temperature` |
| `--provider <nombre[,nombre...]\|none>` | `DeepInfra` | Fija el enrutamiento de proveedores de OpenRouter (`provider: { order, allow_fallbacks: false }`) en **todas** las llamadas al modelo (adaptador predeterminado y de cada ruta del *router*), para que C1/C2/C3 sean comparables: sin esto, un proveedor *upstream* con el modelo deprecado hizo fallar turnos con `http_400`. `none` no envía el campo `provider`. Una lista vacía o mal formada termina con un error de uso |
| `--allow-provider-fallbacks` | desactivado | Con `--provider`, envía `allow_fallbacks: true` (OpenRouter puede usar otro proveedor si los listados fallan). Con `--provider none` es un error de uso |
| `--model-timeout <s>` | 600 | Timeout por solicitud al modelo, en segundos (entero positivo). Cubre la respuesta completa, cuerpo incluido: OpenRouter responde 200 de inmediato y envía el cuerpo no *streaming* recién al terminar la generación, así que con contextos de 20-35k tokens el default del adaptador (120 s) agota el tiempo en cada reintento (`body_read_error ... aborted due to timeout`). Se pasa como `timeoutMs` a **todos** los adaptadores que crea el runner (el predeterminado y los de cada ruta del *router*; un `timeoutMs` explícito en la configuración de una ruta tiene prioridad). No cambia el default de la biblioteca. Un valor inválido termina con un error de uso |
| `--model-retries <n>` | 8 | Reintentos por llamada al modelo ante 429, 5xx o errores de red (entero positivo). La espera se duplica desde 1 s hasta 30 s (o respeta `Retry-After`), así que 8 reintentos aguantan una saturación del proveedor de unos 2-3 minutos; con 3 (el default del adaptador) una saturación de DeepInfra cortaba la corrida en segundos. Se pasa a todos los adaptadores y queda en `modelRetries` del reporte |
| `--max-cost <usd>` | 6 (USD, para c1, c2 y c3) | Tope de gasto en USD, número positivo. Envuelve el modelo de **todas** las configuraciones (c1/c2/c3, plano o con *router*) en un `BudgetedModelAdapter`: antes de cada llamada, si el costo acumulado (`usage.cost` que reporta el proveedor, p. ej. OpenRouter) ya alcanzó el tope, no se llama al modelo y se devuelve un error `budget_exceeded`. El tope se comprueba *antes* de la llamada, así que la última puede sobrepasarlo por su propio costo. El dinero es el recurso que se iguala entre configuraciones, por eso el mismo valor por defecto aplica a las tres. No existe una forma de correr sin tope: para más margen, pasar un valor mayor. Un valor inválido termina con un error de uso |
| `--verify-cmd <cmd>` | `docker compose up -d --build && curl -sf --retry 60 --retry-delay 2 --retry-all-errors http://localhost:3000/health` | Comando de verificación de C2. El `curl` reintenta hasta ~120 s porque `up -d` vuelve cuando arrancan los contenedores, no cuando el backend ya responde |
| `--with-batteries` | desactivado | Después de la generación, levanta el stack y corre las baterías de aceptación |
| `--keep` | desactivado | Con `--with-batteries`, **no** desmonta el stack al final |
| `--dry-run` | desactivado | Imprime el plan en JSON y termina sin llamar al modelo; no crea nada en disco |
| `--harness-config <path>` | — | JSON `{ mcpServers, skillsDirs }`; conecta herramientas MCP + *skills* a cada *harness* que construye la corrida |
| `--publish` | desactivado | Después de la corrida (y su commit local de git), crea un repositorio **público** de GitHub para el espacio de trabajo vía `gh` y lo empuja (ver abajo) |
| `--publish-org <org>` | `harness-loop-graph` | Organización/usuario de GitHub bajo el que se crea el repositorio de `--publish` |
| `--sonar-org <key>` | `harness-loop-graph` | Organización de SonarCloud bajo la que se crea el proyecto de análisis estático de cada corrida publicada |
| `--publish-only <workspace-dir>` | — | Publica un espacio de trabajo **ya generado** (sin llamar al modelo ni exigir `MODEL_API_KEY`/`MODEL_ID`): ver "Publicar un espacio de trabajo existente" |
| `--update-analysis <workspace-dir>` | — | Refresca **solo** los dos archivos de análisis estático del runner (workflow + `sonar-project.properties`) de una corrida **ya publicada** y los empuja a su `main`: ver "Actualizar el análisis estático de una corrida publicada" |

### Tope de costo (`--max-cost`)

El tope solo funciona si el proveedor informa el costo (`usage.cost`). Si hubo
llamadas pero el costo acumulado sigue en 0, el tope no puede aplicarse: el
runner **no bloquea** la corrida, pero registra `budget.costReported: false`
(más `budget.warning`) en el reporte y lo avisa por stderr. Cuando el tope
agota el presupuesto, las llamadas siguientes reciben un error inmediato (sin
red ni esperas) y los presupuestos de turnos/pasos del *loop* y del grafo
acotan el resto de la corrida (en C3, un nodo fallido se reintenta como máximo
una vez); la corrida queda `FAILED` con `failure` que empieza con
`budget_exceeded:`. El *loop* corta en el primer turno que recibe
`budget_exceeded`, sin ejecutar el `--verify-cmd` ni reintentar.

### Motivo de término (`stopReason`)

Cada corrida (salvo `--dry-run`, cuyo plan no lo incluye) escribe
`stopReason` en `run-report.json` y lo imprime en el resumen final como
`  Stopped:    <stopReason>`, junto a `Status`. Se deriva de la respuesta final
(c1), del resultado del *loop* (c2) o del resultado del grafo (c3):

| `stopReason` | Significado |
|---|---|
| `finished` | El modelo dio una respuesta final (en c2/c3, además la corrida fue `SUCCESS`) |
| `budget_exceeded` | El tope `--max-cost` rechazó al menos una llamada al modelo (tiene prioridad sobre el resto, salvo `runner_error`) |
| `max_tool_rounds` | Se agotaron las rondas de herramienta (`--tool-rounds`) sin respuesta final |
| `max_turns` | c2: se agotaron los turnos sin éxito. c3: un nodo agotó sus turnos y el grafo falló |
| `max_steps` | c3: se agotaron los pasos del grafo (`--max-steps`), o el grafo terminó en `FAILED` tras reintentos sin que fallara el *loop* del último nodo (p. ej. el revisor no aceptó) |
| `context_overflow` | El *prompt* excede la ventana de contexto del modelo (HTTP 400/413 con texto de contexto; ver `harness/docs/model-provider.md`). En c1 (conversación única, sin compactación) es un **resultado**, no un bug |
| `repeated_tool_call` | El modelo repitió la misma llamada con los mismos argumentos hasta el límite del *harness* |
| `empty_content` | El modelo respondió sin contenido ni llamada a herramienta, agotados los reintentos con *nudge* |
| `provider_refused` | El proveedor rechazó la llamada (`http_401` o `http_402`) |
| `model_error` | Cualquier otro código de error del modelo |
| `runner_error` | Excepción del runner (o `--harness-config` inválido), no del modelo |

En c2/c3, si el *loop* agotó todos sus turnos el motivo es `max_turns`, aunque
el último turno también haya terminado en error (por ejemplo `max_tool_rounds`).
Un `FAILED` causado por un error del modelo que cortó el *loop* antes usa la
categoría de ese error (por ejemplo `provider_refused`).

Los flags de muestreo que no se pasan quedan sin definir: el campo se omite
de la solicitud y rige el default del proveedor. Un valor inválido termina con
un error de uso. Si se usa un *router*, todas las rutas reciben el mismo
muestreo.

### Credenciales

`MODEL_API_KEY`, `MODEL_ID` y `MODEL_BASE_URL` se leen de `process.env`;
cualquiera que falte se completa desde `.env` en la raíz del repositorio
(parseo simple `key=value`, exportado a `process.env` de modo que las rutas
del *router* vean los mismos valores; el entorno siempre tiene prioridad). Se
lanza un error claro si falta la clave o el id del modelo. `MODEL_BASE_URL`
no tiene valor por defecto de proveedor: una corrida que llega a la
construcción del modelo sin ella falla rápido con un error claro que nombra
`MODEL_BASE_URL`. `--dry-run` nunca construye un modelo, así que no requiere
`MODEL_BASE_URL`.

## Harness config: MCP, skills y router de modelos

Un JSON de configuración (ver `harness/examples/harness-config.json`) puede
agregar herramientas MCP, *skills* de agente, y un *router* de modelos de
forma idéntica a C1, C2 y C3:

```json
{
  "mcpServers": { "name": { "command": "...", "args": [], "env": {}, "cwd": "." } },
  "skillsDirs": ["./skills"],
  "router": {
    "longContextThreshold": 60000,
    "routes": {
      "longContext": { "model": "gpt-4o-mini-long-context", "apiKeyEnv": "LONG_MODEL_API_KEY" },
      "retry": { "model": "gpt-4o-mini" }
    }
  }
}
```

El runner lo carga una vez por corrida: se abre y comparte una única conexión
MCP (`McpToolProvider`) entre cada *harness* que construye la corrida (C3
construye uno por nodo del grafo), y se carga un único `SkillCatalog` una
vez. El tool manager de cada *harness* recibe las mismas herramientas MCP más
`load_skill` registradas en él, y la lista `allowedTools` de *guardrails* se
extiende con esos nombres de herramienta — de modo que los *guardrails* y el
log de auditoría aplican a las llamadas MCP/skill exactamente igual que a las
herramientas incorporadas. La conexión siempre se cierra al final de la
corrida (`finally`), incluso en caso de fallo; un fallo al cerrarla se
registra en el campo `closeError` de `run-report.json` sin reemplazar el
propio fallo de la corrida. Sin `--harness-config`, nada de esto corre y la
salida no cambia.

Un archivo de configuración faltante o inválido, un servidor que falla al
conectarse, o un directorio de *skills* que falla al cargar, se registran
como cualquier otro fallo de corrida: `run-report.json` igual se escribe, con
`status: "FAILED"` y `failure: "harness-config: <message>"`, y el proceso
termina con código distinto de cero. `--harness-config` sin un valor de ruta
es un error de uso (igual que `--config`), no una traza cruda.

La sección `router` es opcional (ver [`harness/docs/model-router.md`](../../harness/docs/model-router.md)
para el detalle completo) y **no** está configurada en el
`experiment/harness-config.json` propio de este repositorio — el
enrutamiento permanece desactivado por defecto. Cuando está presente, el
runner envuelve el modelo que construye para la corrida en un
`RoutingModelAdapter` — idénticamente para c1, c2 y c3 — de modo que las
solicitudes por encima de `longContextThreshold` van a `longContext`, los
turnos de reintento (con feedback de verificación presente) van a `retry`, y
todo lo demás sigue yendo al modelo por defecto. Sin una sección `router` (o
sin `--harness-config`), el modelo no se envuelve y el comportamiento no
cambia.

### Métricas registradas — `routing`

Cuando un *router* está activo, `run-report.json` gana un campo `routing`:

```json
{
  "routing": {
    "byRoute": { "default": { "calls": 3, "promptTokens": 120, "completionTokens": 60, "totalTokens": 180, "cost": 0.01 } },
    "decisions": { "default:default": 3, "longContext:long_context": 1 }
  }
}
```

`byRoute` es el uso por ruta de `RoutingModelAdapter.getRouting()`.
`decisions` es el registro de decisiones de ruta colapsado en conteos por
clave `"<route>:<reason>"` en lugar de la lista completa por llamada, que de
otro modo crecería sin límite en una corrida larga de C2/C3; los conteos por
ruta/por motivo alcanzan para ver qué regla se disparó y cuántas veces. Los
metadatos de `harnessConfig` también ganan un arreglo `routeNames`
(`["default", ...]`) cuando hay un *router* configurado.

## Apps generadas y publicación

### Las apps generadas viven fuera del repositorio

Cada corrida recibe su propio espacio de trabajo bajo `--runs-dir` (por
defecto: un directorio `pi-runs` junto a este monorepo, resuelto desde la
ubicación del propio archivo del runner — de modo que las apps generadas
nunca se escriben dentro de este repositorio, ni siquiera por accidente). El
nombre del directorio del espacio de trabajo es
`<model-slug>-<config>-<YYYYMMDDTHHMMSS>` (UTC), p. ej.
`test-model-5-2-c1-20260105T030405`; el slug es el id del modelo en minúsculas
con cada racha de caracteres que no sean `[a-z0-9]` colapsada a un único `-`,
recortado. `--dry-run` solo imprime la ruta planeada del espacio de trabajo y
no crea nada.

### Repositorio por corrida

Al terminar una corrida — **éxito o fallo** — el espacio de trabajo se
convierte en su propio repositorio git:

1. `git init -b main`.
2. Se agrega (o extiende) un `.gitignore` con `node_modules/`, `dist/`,
   `build/`, `coverage/`, `.env*` y `reasoning.jsonl`.
3. Todo se commitea (incluyendo `run-report.json` y los logs
   `audit*.jsonl`) con el mensaje `run: <model> <config> (<status>)`, usando
   una identidad local fija de git (`pi-runner
   <pi-runner@users.noreply.github.com>`) pasada vía `-c user.name=`/
   `-c user.email=` — nunca se requiere la propia identidad de git del
   operador.

Un fallo durante este paso nunca pierde la corrida: se registra en el campo
`repoError` de `run-report.json` y el proceso continúa.

### Publicación (`--publish`, desactivado por defecto)

`--publish` requiere una CLI `gh` autenticada; `gh auth status` se verifica
**antes** de cualquier llamada al modelo, fallando con un error de estilo de
uso si no está autenticada. Después del commit local de arriba, la
publicación:

Las dos salvaguardas de abajo solo miran **archivos rastreados** —
exactamente la lista que devuelve `git -C <workspace> ls-files`, es decir
exactamente lo que embarca el commit por corrida (y `--publish`) — nunca todo
el árbol de trabajo, de modo que un `.env` ignorado por git, `node_modules/`,
`dist/`, etc. nunca pueden activar (ni esconderse de) ninguna de las dos
salvaguardas.

1. Se rehúsa (y nunca llama a `gh`/`git`) si algún archivo rastreado es una
   copia byte-a-byte (sha256 sobre los bytes crudos) de un archivo bajo
   `experiment/acceptance/` (el banco oculto) — una aserción defensiva, ya
   que el runner nunca copia ese directorio a un espacio de trabajo generado.
   Es una verificación de **contenido**, no de ruta: una carpeta propia de
   una app generada que resulte llamarse `acceptance/` nunca se marca, solo
   una copia real de un archivo del banco se marca, sin importar dónde
   termine en el espacio de trabajo. Las salidas de corrida que `run-all.mjs`
   y Playwright escriben dentro del banco (`report.json`, `test-results/`,
   `playwright-report/`) no se comparan: son resultados, y `report.json` se
   copia tal cual a `batteries-report.json`.
2. Escanea los bytes crudos de cada archivo rastreado (de modo que un archivo
   binario se compara honestamente en lugar de omitirse en silencio) en
   busca del valor exacto de la clave de API del modelo usada por la
   corrida, del valor de `apiKeyEnv` de cualquier ruta de *router* de
   `--harness-config`, y de cada valor `env` no vacío de 8 caracteres o más
   configurado en un servidor MCP de `--harness-config` (los valores más
   cortos se descartan para evitar falsos positivos en strings cortos que no
   parecen secretos). Si hay coincidencia, se rehúsa a publicar y registra
   `publishError: "secret detected in <relative path>"` en
   `run-report.json` — el **valor** del secreto nunca se imprime ni se
   guarda.
3. **Análisis estático** (ver abajo): quita los *workflows* del modelo,
   inyecta los del runner y crea el proyecto de SonarCloud. Las salvaguardas
   1 y 2 se vuelven a aplicar sobre los archivos inyectados.
4. En otro caso, crea un repositorio público `<org>/run-<workspace dir name>`
   con `gh repo create <repo> --public --source <workspace> --push
   --description "<model> <config> run generated by the PI-I harness"`,
   registra `repository: { name, url }` en `run-report.json`, y luego
   commitea y empuja ese reporte actualizado como un segundo commit
   (`run: record repository metadata`) en lugar de adivinar la URL antes de
   que el repositorio exista.

#### Análisis estático (SonarCloud + Semgrep)

El modelo puede escribir cualquier archivo en su espacio de trabajo, incluido
`.github/workflows/*.yml` (una corrida real lo hizo). Publicarlo tal cual
haría que GitHub ejecute CI escrito por el modelo en nuestra organización, y
los archivos del modelo podrían manipular el análisis. Por eso, **antes** de
`gh repo create` (y después de las salvaguardas 1 y 2), `--publish`:

1. **Quita** todo archivo rastreado bajo `.github/workflows/` y lo commitea
   como `harness: remove model-authored workflows` (sin commit si no había
   ninguno). Las rutas quitadas quedan en `staticAnalysis.removedWorkflows`.
2. **Inyecta** `.github/workflows/static-analysis.yml` y
   `sonar-project.properties` (propiedad del runner, sobrescriben lo que haya
   escrito el modelo) y los commitea como
   `harness: add static analysis workflow`. El texto exacto del *workflow*
   vive en la constante exportada `STATIC_ANALYSIS_WORKFLOW`
   (`run-experiment.mjs`). Corre en *push* a `main` y `workflow_dispatch`,
   con permisos `contents: read`, `security-events: write`, `actions: read`:
   - job `semgrep`: contenedor `semgrep/semgrep`, `semgrep scan --config
     p/default --config p/typescript --sarif --output semgrep.sarif || true`
     (los hallazgos no hacen fallar el job) y `github/codeql-action/upload-sarif@v3`
     con `category: semgrep`.
   - job `coverage` (**sin secretos**, `permissions: contents: read`,
     `persist-credentials: false`): `actions/checkout@v4`,
     `actions/setup-node@v4` (Node 20) y, para `backend/` y `frontend/` (solo
     si tienen `package.json` **y** un script `test`), `npm ci || npm install`,
     instala `@vitest/coverage-v8` con el mismo *major* que el `vitest`
     instalado (si no hay `vitest`, se omite la cobertura sin fallar) y corre
     `npx vitest run --coverage --coverage.provider=v8
     --coverage.reporter=lcov --coverage.reportsDirectory=coverage` con
     `CI=true`, `continue-on-error: true` y `timeout-minutes: 20`. Las rutas
     relativas de `lcov.info` se prefijan con el directorio del proyecto
     (Sonar las resuelve desde la raíz del repositorio). Sube
     `backend/coverage/lcov.info` y `frontend/coverage/lcov.info` como
     artefacto `coverage-reports` (`if-no-files-found: ignore`).
   - job `sonarcloud` (`needs: coverage`, `if: always()`): `actions/checkout@v4`
     con `fetch-depth: 0`, descarga el artefacto de cobertura (si falta, sigue),
     `SonarSource/sonarqube-scan-action@v5` con `SONAR_TOKEN` (secreto de
     Actions) y `SONAR_HOST_URL: https://sonarcloud.io`, y —solo en *push* a
     `main`— dos pasos informativos (`continue-on-error: true`, nunca hacen
     fallar el job): **esperar el análisis** (lee `ceTaskUrl` de
     `.scannerwork/report-task.txt` y consulta `/api/ce/task` cada 5 s, hasta
     ~150 s, hasta `SUCCESS`/`FAILED`/`CANCELED`) y **criterios de calidad**.

   **Código generado solo en un job sin secretos.** `npm ci`/`vitest` ejecutan
   código del modelo, así que corren únicamente en el job `coverage`, que no
   recibe `SONAR_TOKEN` ni ningún secreto. El job `sonarcloud` (con el token)
   solo descarga `lcov.info` y escanea; nunca instala ni ejecuta el código del
   modelo. Los reportes de cobertura son la única entrada que cruza entre
   ambos jobs.

   **Criterios de calidad (informativos).** El paso consulta
   `https://sonarcloud.io/api/measures/component?component=<projectKey>&branch=main&metricKeys=coverage,sqale_index,complexity`
   y `api/issues/search?componentKeys=<projectKey>&branch=main&types=VULNERABILITY&severities=CRITICAL,BLOCKER&resolved=false&ps=1`
   (el `projectKey` se lee de `sonar-project.properties`, la misma clave que
   recibe Sonar), compara con las metas de la rúbrica y escribe en
   `$GITHUB_STEP_SUMMARY` una tabla `Criterio | Valor | Meta | Estado` (✅/❌);
   si algún criterio falla emite un `::warning`. **Nunca bloquea**: es solo
   información para el análisis posterior.

   | Criterio | Meta (variable) |
   |---|---|
   | Cobertura (%) | ≥ 65 (`MIN_COVERAGE`) |
   | Deuda técnica (min, `sqale_index`) | ≤ 960 (`MAX_DEBT_MIN`) |
   | Complejidad (`complexity`) | ≤ 50 (`MAX_COMPLEXITY`) |
   | Vulnerabilidades críticas/bloqueantes | = 0 (`MAX_VULNERABILITIES`) |

   `complexity` es la **suma de todo el proyecto**, tal como la define la
   rúbrica: cualquier aplicación completa superará 50, así que ese criterio
   casi siempre aparecerá en ❌. Se reporta igual, sin ajustar la meta.
3. `sonar-project.properties` fija `sonar.organization=<--sonar-org>`,
   `sonar.projectKey=<org>_run-<workspace dir name>`,
   `sonar.projectName=run-<workspace dir name>`, `sonar.sources=.` y
   `sonar.exclusions` con `node_modules`, `dist`, `build`, `coverage`,
   `run-report.json`, `batteries-report.json`, `audit*.jsonl`, `SPEC.md`,
   `AGENTS.md`, `.github/**` y los archivos de prueba. Los tests se declaran
   como tales con `sonar.tests=.` y `sonar.test.inclusions=**/*.spec.ts,
   **/*.test.ts,**/*.spec.tsx,**/*.test.tsx,e2e/**` (así Sonar no los cuenta
   como código fuente), y la cobertura entra por
   `sonar.javascript.lcov.reportPaths=backend/coverage/lcov.info,frontend/coverage/lcov.info`.
4. **Crea el proyecto de SonarCloud** con `POST
   https://sonarcloud.io/api/projects/create` (`organization`, `project`,
   `name`, `visibility=public`; cabecera `Authorization: Bearer
   $SONAR_TOKEN`). Un HTTP 400 "key already exists" se tolera (republicar es
   idempotente); cualquier otro fallo registra `publishError` y se detiene
   **antes** de `gh repo create`. Después renombra la rama principal del
   proyecto a `main` (`POST .../api/project_branches/rename`): SonarCloud la
   crea como `master`, y el `main` empujado se analizaría como rama
   secundaria, cuyas métricas una organización gratuita no puede leer. Si el
   renombre falla, también registra `publishError` antes de `gh repo create`.
5. Registra `staticAnalysis: { sonarOrganization, sonarProjectKey,
   semgrepConfig, workflowSha256, removedWorkflows }` en `run-report.json`.

**Configuración que debe hacer el operador:**

- `SONAR_TOKEN` local: en el entorno o en el `.env` de la raíz del
  repositorio (igual que `MODEL_*`). Solo se exige al publicar: sin él,
  `--publish` falla temprano con `publishError` (cierra en falso: una corrida
  pública sin análisis no sirve) y **antes** de crear el repositorio. No se
  exige en corridas sin `--publish`. Su valor entra al escaneo de secretos de
  la publicación y se quita del entorno de los comandos del modelo.
- Secreto de Actions **a nivel de organización** `SONAR_TOKEN` (GitHub →
  organización → Settings → Secrets and variables → Actions → New
  organization secret), con acceso a repositorios públicos. Sin él, el job
  `sonarcloud` de cada repositorio publicado falla.
- La organización de GitHub debe estar vinculada a la organización de
  SonarCloud indicada en `--sonar-org`.

#### Recolección del análisis estático (`collect-static-analysis.mjs`)

Los resultados de SonarCloud y Semgrep llegan **de forma asíncrona**, unos
minutos después de publicar (el *workflow* tiene que correr en GitHub
Actions). Ejecutá la recolección una vez que las corridas ya estén
publicadas, y antes de agregar:

```bash
node runner/collect-static-analysis.mjs [--runs-dir <dir>] [--force]
```

- `--runs-dir` — por defecto el mismo directorio de corridas del runner.
- Procesa cada corrida con `repository` y `staticAnalysis` en
  `run-report.json`; las demás se ignoran.
- SonarCloud: `GET https://sonarcloud.io/api/measures/component` (proyecto
  público, sin autenticación; si `SONAR_TOKEN` está definido se envía como
  `Authorization: Bearer`). Semgrep: `gh api --paginate
  repos/<owner>/<repo>/code-scanning/alerts?state=open&per_page=100`,
  filtrando las alertas cuyo nombre de herramienta empieza con "semgrep"
  (sin distinguir mayúsculas). Requiere `gh` autenticado.
- Métricas de Sonar pedidas: `ncloc`, `bugs`, `vulnerabilities`, `code_smells`,
  `security_hotspots`, `duplicated_lines_density`, `cognitive_complexity`,
  `sqale_index`, `reliability_rating`, `security_rating`, `sqale_rating`,
  `coverage` y `complexity` (las dos últimas, de la cobertura y la rúbrica de
  calidad; `complexity` es la suma de todo el proyecto).
- Escribe `<ws>/static-analysis.json` con `collectedAt`, `status`
  (`complete` | `pending` | `error`), `sonar` (`status`, `projectKey`,
  `measures`) y `semgrep` (`status`, `openAlerts`, `bySeverity`,
  `bySecuritySeverity`). El estado global es `complete` solo si ambos lo son.
- **Semgrep exige un análisis subido.** Mientras GitHub no tenga un análisis de
  code scanning de Semgrep para el repo, el resultado es `pending`: una lista de
  alertas vacía antes del análisis no es "cero hallazgos".
- **`pending` es normal** los primeros minutos tras publicar (Sonar responde
  404 / sin medidas; `gh` dice "no analysis found"). Volvé a ejecutar el
  comando más tarde: las corridas ya `complete` se saltan; las `pending` y
  `error` se recolectan de nuevo.
- `--force` — recolecta también las corridas ya `complete` y sobrescribe su
  archivo.
- Imprime una línea por corrida; nunca falla por una sola corrida y sale con
  código 0 salvo que **todas** las corridas publicadas hayan dado `error`.

#### Actualizar el análisis estático de una corrida publicada (`--update-analysis`)

`node run-experiment.mjs --update-analysis <workspace-dir> [--sonar-org <key>]
[--harness-config <path>]` lleva a una corrida **ya publicada** al workflow y
las propiedades de Sonar actuales (cobertura + criterios de calidad) sin
regenerar nada. Exige un `run-report.json` **con `repository`** (si no, se
rehúsa con un error de uso), que el directorio sea un repositorio git, una CLI
`gh` autenticada (igual que `--publish-only`) y `SONAR_TOKEN` (entorno o `.env`
de la raíz). Reescribe **solo** `.github/workflows/static-analysis.yml` y
`sonar-project.properties` (el código del modelo no se toca), agrega con
`git add -f` únicamente esas dos rutas, las commitea con la identidad del runner,
`--no-verify` y el mensaje `runner: update static analysis (coverage + quality
criteria)`, y empuja a `main` del repositorio registrado en
`repository.name`. Reutiliza las salvaguardas de `--publish`: hooks y
`.git/config` neutralizados, nunca sigue enlaces simbólicos plantados por el
modelo y el escaneo de secretos corre **antes** de commitear y empujar. La
organización de Sonar es la registrada en `staticAnalysis.sonarOrganization`
(tiene prioridad sobre `--sonar-org`). Si los archivos ya están al día no hay
commit ni *push*. Al terminar registra `staticAnalysis.updatedAt` (y el nuevo
`workflowSha256`) en `run-report.json`, sin commitear ese archivo; un fallo se
guarda en `updateError` y el comando termina con código distinto de cero y un
mensaje claro.

#### Publicar un espacio de trabajo existente (`--publish-only`)

`node run-experiment.mjs --publish-only <workspace-dir> [--publish-org <org>]
[--sonar-org <key>] [--harness-config <path>]` carga
`<workspace-dir>/run-report.json`, exige que el directorio sea un repositorio
git, corre el mismo flujo de publicación y reescribe `run-report.json` con
`repository`/`staticAnalysis` (o `publishError`). Termina con código distinto
de cero si hay `publishError`. El escaneo de secretos busca las mismas claves
que `--publish`: `MODEL_API_KEY` (del entorno o del `.env` de la raíz) y, si
se pasa el `--harness-config` de la corrida, las claves de las rutas del
*router* y los valores `env` de los servidores MCP (sin conectarlos).
No requiere `MODEL_API_KEY`/`MODEL_ID` ni `--config`. Si el reporte ya tiene
`repository`, se rehúsa con un error de uso (no hay doble publicación).

Cualquier fallo en este flujo (autenticación de `gh` faltante, secreto
encontrado, filtración del banco, fallo de `gh`/`git`) se registra en
`run-report.json` y hace que el proceso termine con código distinto de cero;
la corrida en sí nunca se pierde.

Las baterías de aceptación ocultas (`experiment/acceptance/`) siempre se
quedan en este repositorio banco — el runner nunca las copia a un espacio de
trabajo generado, así que tampoco pueden llegar jamás a un repositorio
publicado.

## Fase de baterías (`--with-batteries`)

1. `docker compose up -d --build` en el espacio de trabajo. Si falla, se
   registra en `batteryPhase.stack` y la fase **continúa** (no se sondea la
   salud).
2. Sondea `GET http://localhost:3000/health` hasta 120 s (solo si el paso 1
   levantó el stack). Si nunca pasa, también se registra en
   `batteryPhase.stack` y la fase continúa.
3. Corre `node run-all.mjs` **con `experiment/acceptance/` como directorio de
   trabajo** (el banco oculto, nunca copiado al espacio de trabajo) contra la
   app generada, con `WORKSPACE` fijado a la ruta del espacio de trabajo más
   `BACKEND_URL`/`FRONTEND_URL`/`DB_URL` para el stack en ejecución, con un
   timeout de 30 minutos (`BATTERY_TIMEOUT_MS`): las baterías espacian sus
   logins ~61 s para respetar el límite de autenticación de RF-14. Se corre
   siempre, aunque el stack no haya levantado: las baterías 1-3 registran sus
   propios fallos de conexión y la batería 4 (coherencia) es estática. Así un
   sistema que ni arranca no se ve mejor que uno que arranca y falla
   chequeos (sin reporte, el agregador lo excluiría de las medias).
4. Guarda el reporte agregado como `batteries-report.json` en el espacio de
   trabajo (siempre que `run-all.mjs` haya producido salida).
5. `docker compose down -v` (salvo `--keep`) — el mismo ayudante de cierre
   que usa el cierre de fin de corrida de c2 (ver "Salvaguardas" abajo).

> **Advertencia:** los puertos 5432, 3000 y 8080 están fijos. Correr un
> experimento a la vez; corridas concurrentes entrarán en conflicto.

## Seguir una corrida en vivo

Cada decisión de *guardrails* se agrega a `<espacio-de-trabajo>/audit.jsonl`
(`audit-<nodo>.jsonl` en C3) apenas se toma, de modo que se puede seguir lo que
hace el modelo con `tail -f`. Cada línea trae `decision`, `reason`, `at` y la
acción evaluada: `tool` más `path` (`read_file`/`write_file`/`search_replace`) o
`name` (`load_skill`), o `command` (`run_command`, recortado a 300 caracteres
con `…`). Nunca incluye contenido de archivos ni los cuerpos de
`search`/`replace`.

```sh
tail -f <espacio-de-trabajo>/audit.jsonl
```

Si tenés `jq` (el runner no lo requiere), una vista compacta:

```sh
tail -f <espacio-de-trabajo>/audit.jsonl | jq -r '"\(.at[11:19]) \(.decision) \(.tool // "cmd") \(.path // .command // .name // "")"'
```

### Ver el razonamiento del modelo

Para ver, al menos a grandes rasgos, *por qué* el modelo hace cada acción, el
runner agrega a `<espacio-de-trabajo>/reasoning.jsonl` una línea por respuesta
del modelo que traiga texto de razonamiento (el que OpenRouter devuelve en
`message.reasoning`/`reasoning_details` para modelos de razonamiento): `at`,
`model`, `provider`, `reasoningChars`, `reasoning` (recortado a 2000 caracteres
con `…`) y `action` (`tool_call <herramienta> <path|name|comando>`, `finish` o
`error <código>`). Las respuestas sin razonamiento no escriben nada. En C3 todos
los nodos comparten el mismo archivo; con `--dry-run` no se crea.

```sh
tail -f <espacio-de-trabajo>/reasoning.jsonl
```

Con `jq` (opcional), hora, acción y los primeros ~200 caracteres del razonamiento:

```sh
tail -f <espacio-de-trabajo>/reasoning.jsonl | jq -r '"\(.at[11:19]) \(.action)\n    \(.reasoning[:200] | gsub("\n"; " "))"'
```

Este archivo es **solo local**: está en el `.gitignore` del espacio de trabajo
(`reasoning.jsonl`), así que no se commitea ni se publica con el repositorio de
la corrida.

## Referencia de `run-report.json`

Cada corrida escribe `run-report.json` en el espacio de trabajo. `sampling`
(`null` por cada parámetro sin definir), `provider` (`{ order, allowFallbacks }`,
o `null` con `--provider none`), `usage.providersUsed` (proveedores *upstream*
que devolvieron las respuestas, con su conteo, sumados entre adaptadores), `harnessGitSha` (`git rev-parse HEAD`
del repositorio del *harness*) y `harnessGitDirty` (`git status --porcelain`
no vacío) están presentes en toda corrida, también las fallidas y el plan de
`--dry-run`; los dos últimos valen `null` si git no está disponible:

`task` (`{ source, path, sha256, specSha256 }`; también presente en toda corrida,
incluidas las fallidas y el plan de `--dry-run`) identifica la tarea que
recibió el modelo: `source` es `spec` (tarea por defecto, sobre
`experiment/SPEC.md`) o `task-file` (corrida de validación barata con
`--task-file`); `path` es relativo a la raíz del repositorio cuando el archivo
está dentro de él (si no, absoluto); `sha256` es el hash del texto exacto de
la tarea y `specSha256` el de los bytes de `SPEC.md` (que se copia a todo
espacio de trabajo, así que también es entrada del modelo). Las corridas anteriores a este campo no lo tienen y se tratan como
*legacy* al agregar.

`modelTimeoutMs` (timeout por solicitud al modelo en milisegundos, derivado de
`--model-timeout`; 600000 por defecto) también está presente en toda corrida,
incluidas las fallidas y el plan de `--dry-run`.

`stopReason` (todo reporte de corrida, salvo el plan de `--dry-run`) es uno de
`finished`, `budget_exceeded`, `max_tool_rounds`, `max_turns`, `max_steps`,
`context_overflow`, `repeated_tool_call`, `empty_content`, `provider_refused`,
`model_error` o `runner_error`; ver "Motivo de término (`stopReason`)".

`budget` (también presente en toda corrida, incluidas las fallidas y el plan de
`--dry-run`) vale `{ maxCostUsd, exhausted, costReported }`: `maxCostUsd` es
`6` por defecto (sobrescribible con `--max-cost`); `exhausted` es `true` cuando el costo acumulado
alcanzó el tope; `costReported` es `true`/`false` según el proveedor haya
informado costo (`null` si aún no hubo llamadas). Si el tope rechazó alguna
llamada, `status` es `FAILED` y `failure` empieza con `budget_exceeded:` (el
motivo original del *loop*/grafo queda entre paréntesis). Con `costReported:
false` y un tope definido se agrega `budget.warning`.

```json
{
  "config": "c1|c2|c3",
  "model": "gpt-4o-mini",
  "sampling": { "temperature": null, "topP": null, "seed": null, "maxTokens": null },
  "provider": { "order": ["DeepInfra"], "allowFallbacks": false },
  "modelTimeoutMs": 600000,
  "harnessGitSha": "<git rev-parse HEAD del repo, o null>",
  "harnessGitDirty": false,
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 0,
  "status": "SUCCESS|FAILED",
  "stopReason": "finished|budget_exceeded|max_tool_rounds|max_turns|max_steps|context_overflow|repeated_tool_call|empty_content|provider_refused|model_error|runner_error",
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "calls": 0, "providersUsed": { "DeepInfra": 0 } },
  "budget": { "maxCostUsd": 6, "exhausted": false, "costReported": null },
  "turns": 0,
  "steps?": 0,
  "totalLoopTurns?": 0,
  "decision?": {},
  "finalResponse?": "...",
  "failure?": "...",
  "trace": [...],
  "harnessConfig?": {
    "path": "...",
    "sha256": "...",
    "mcpServers": ["..."],
    "toolNames": ["mcp__server__tool", "load_skill"],
    "skillNames": ["..."],
    "routeNames?": ["default", "longContext", "retry"]
  },
  "routing?": {
    "byRoute": { "default": { "calls": 0, "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "cost": 0 } },
    "decisions": { "default:default": 0 }
  },
  "batteryPhase?": { "ran": true, "stack": { "up": true, "healthy": true, "error?": "..." }, "passed": true, "error?": "..." },
  "closeError?": "...",
  "teardownError?": "...",
  "repoError?": "...",
  "repository?": { "name": "harness-loop-graph/run-...", "url": "https://github.com/..." },
  "publishError?": "..."
}
```

- `turns` — turnos de interacción (C1/C2) o turnos de *loop* por nodo
  agregados (C3).
- `steps` — pasos del grafo (solo C3).
- `totalLoopTurns` — total de turnos de *loop* a través de todos los nodos
  (solo C3).
- `finalResponse` — el contenido de la respuesta `finish` del modelo,
  truncado a 2000 caracteres, cuando la corrida (C1/C2) terminó con una
  respuesta `finish`. Ausente en C3 y en cualquier corrida que no haya
  terminado con `finish`.
- `trace` — resúmenes compactos por turno/por paso; sin el contenido
  completo del modelo. Para c2, cada turno lleva además `verificationDetails`
  (el final de la salida del comando de verificación) y, desde el segundo
  turno, `feedbackReceived` (el feedback que ese turno recibió: el error de
  verificación más el resumen del turno anterior); ambos se recortan a 2000
  caracteres, para ver en una corrida fallida qué se le dijo al modelo. Para c3, un paso cuyo `loopStatus` es `"FAILED"`
  también lleva `loopFailure`: por qué falló el *loop* de ese nodo (su
  propio resumen de fallo, o el motivo de la decisión terminal; con el
  código/mensaje de error del modelo agregado, truncado, cuando la
  respuesta final fue un `error`) — de modo que un paso `FAILED` es
  accionable en lugar de un simple estado. Un paso exitoso no tiene ningún
  campo `loopFailure`.
- `harnessConfig` — presente solo con `--harness-config`: la ruta de la
  configuración, un sha256 de su contenido, los nombres de servidor MCP
  configurados, cada nombre de herramienta registrado (MCP + `load_skill`),
  cada nombre de *skill* cargada, y (solo cuando `router` está configurado)
  `routeNames` — `["default", ...]`. Un fallo al cargarla/conectarla se
  registra en cambio como `status: "FAILED"` y
  `failure: "harness-config: ..."` (ver arriba).
- `routing` — presente solo cuando hay una sección `router` configurada; ver
  "Métricas registradas — routing" arriba.
- `batteryPhase` — presente solo con `--with-batteries`: `ran` siempre
  `true` cuando la fase corrió, `stack` (`{ up, healthy, error? }`) registra
  por separado si `docker compose up` levantó el stack, si el health check
  pasó y el motivo si no (las baterías corren igual y `batteries-report.json`
  se escribe igual), `passed` indica si las baterías de aceptación pasaron
  (es `false` si el stack no está sano) y `error` solo está presente si
  falló `run-all.mjs` en sí (spawn, timeout) o el cierre del stack.
- `failure` — también cubre una excepción lanzada en cualquier punto de la
  corrida (p. ej. `createModel()` rechazando porque `apiKeyEnv` de una ruta
  de *router* no está configurada, o cualquier error de harness/loop/graph):
  se captura, `status` se fija a `"FAILED"` y `failure` registra el mensaje
  del error, y `run-report.json`, el repositorio git por corrida y
  `--publish` igual corren — una excepción lanzada nunca pierde la corrida.
- `closeError` — presente solo si cerrar la conexión MCP al final de la
  corrida falló; nunca reemplaza a `failure`.
- `teardownError` — presente solo si desmontar el stack de docker compose de
  una corrida c2 al final de la corrida falló (ver "Salvaguardas" abajo);
  nunca reemplaza a `failure`.
- `repoError` — presente solo si convertir el espacio de trabajo en un
  repositorio git falló (ver "Repositorio por corrida" arriba); la corrida y
  su reporte se conservan de todos modos.
- `repository` — presente solo después de un `--publish` exitoso: el `name`
  (`<org>/run-<workspace dir name>`) y la `url` del repositorio creado.
- `staticAnalysis` — presente solo después de crear el proyecto de SonarCloud
  en una publicación: `sonarOrganization`, `sonarProjectKey`,
  `semgrepConfig`, `workflowSha256` (sha256 del *workflow* inyectado) y
  `removedWorkflows` (ver "Análisis estático").
- `staticAnalysis.updatedAt` — ISO-8601 de la última ejecución exitosa de
  `--update-analysis` (que además refresca `workflowSha256`); `updateError`
  guarda el motivo si esa actualización falló.
- `publishError` — presente solo si se pasó `--publish` (o `--publish-only`) y la publicación fue
  rehusada o falló (ver "Publicación" arriba); nunca incluye un valor de
  secreto.

## Agregación de corridas (`aggregate-runs.mjs`)

El directorio de corridas mezcla corridas SPEC válidas con corridas de
validación baratas (`--task-file`). `aggregate-runs.mjs` las separa y produce
las tablas de comparación:

```bash
node runner/aggregate-runs.mjs [--runs-dir <dir>] [--harness-sha <sha-o-prefijo>] [--model <id>] [--out <dir>]
```

- `--runs-dir` — por defecto el mismo directorio de corridas del runner.
- Se leen todos los subdirectorios inmediatos con `run-report.json` (los demás
  se ignoran); un JSON malformado se reporta como excluido, nunca rompe.
- **Se incluye** una corrida solo si `task.source === 'spec'`,
  `harnessGitDirty === false` y coincide con `--harness-sha` (prefijo) y
  `--model` cuando se pasan. **Todo lo demás se excluye con motivo explícito**
  (`no task identity (legacy run)`, `task-file run`, `no SPEC hash (legacy run)`, `dirty harness tree`,
  `harness sha mismatch`, `model mismatch`, `malformed run-report.json (...)`).
- Salidas en `--out` (por defecto `<runs-dir>/_aggregate`): `runs.csv` (una fila
  por corrida incluida: config, modelo, sha, estado, duración, llamadas,
  reintentos, tokens, costo, `budget.exhausted`, checks aprobados/total por
  batería, `batteriesPassed` y URL de publicación), `summary.csv` (una fila por
  config: `n`, éxitos de generación, baterías aprobadas, razón media de
  aprobación por batería junto con cuántas corridas tienen datos de esa batería
  (`n`, que puede ser menor que el `n` de la config), y media y desviación estándar muestral de costo,
  tokens y duración; la desviación queda vacía con n < 2) y `summary.md`
  (resumen por config, corridas incluidas y excluidas con su motivo). También
  imprime `summary.md` por stdout. Las celdas de batería quedan vacías si falta
  `batteries-report.json` o tiene `parseError`.
- **Columnas de análisis estático** (leídas de `<ws>/static-analysis.json`, ver
  "Recolección del análisis estático"): `sonar_ncloc`, `sonar_bugs`,
  `sonar_vulnerabilities`, `sonar_code_smells`, `sonar_duplicated_lines_density`,
  `sonar_cognitive_complexity`, `sonar_sqale_index` y `semgrep_open_alerts`, en
  `runs.csv` y en la tabla de corridas de `summary.md`. Quedan vacías si el
  archivo falta, está malformado o su estado no es `complete`. `summary.csv`
  agrega, para cada una, `<columna>_mean`, `<columna>_stddev` y `<columna>_n`
  (corridas que sí tienen el valor, que puede ser menor que el `n` de la
  config); `summary.md` muestra la media como `media (n=k)`.
- Si las corridas incluidas usan más de una versión de `SPEC.md` o del
  *harness*, `summary.md` lo marca en una sección **Warnings**: no son
  comparables entre sí y conviene filtrar con `--harness-sha`.

## Salvaguardas

- **Git del espacio de trabajo neutralizado.** El espacio de trabajo es
  escribible por el modelo, incluido un `.git` que haya creado o tocado. Antes
  de cada `git`/`gh` del runner sobre él (el commit de la corrida y todo el
  flujo de `--publish`), los hooks de `.git/hooks` se borran, `.git/config` se
  reescribe a una configuración mínima propia del runner (sin hooks, sin
  `core.fsmonitor`, sin reescrituras `url.*.insteadOf` que redirijan el push)
  y cada comando corre con `core.hooksPath=/dev/null` por entorno, de modo que
  ningún hook plantado se ejecuta con `SONAR_TOKEN` ni con la sesión de `gh`.
- **Validación de flags.** Un `--max-turns`/`--max-steps`/`--tool-rounds`
  faltante, no numérico, fraccionario, cero o negativo es un error de uso
  (`Usage: --<flag> <n> must be a positive integer ...`) con código de
  salida distinto de cero, antes de cualquier espacio de trabajo o llamada
  al modelo. `--task-file` se valida de la misma manera (ver la tabla de
  flags arriba) antes de crear el espacio de trabajo.
- **Cierre del stack de Docker (C2).** El `--verify-cmd` por defecto de C2
  levanta un stack de docker compose (`docker compose up -d --build`) para
  correr el health check, que de otro modo seguiría corriendo después de que
  el proceso termina y haría fallar la siguiente corrida en los mismos
  puertos (fijos). Al final de una corrida c2 — éxito, fallo, o una excepción
  lanzada, vía un `finally` — el runner desmonta ese stack
  (`docker compose down -v`) en el espacio de trabajo cuando el comando de
  verificación menciona `docker compose`, o cuando el espacio de trabajo
  tiene su propio `docker-compose.yml`/`compose.yaml` (la SPEC requiere uno)
  sin importar lo que diga `--verify-cmd`. Un fallo en el desmontaje se
  registra en el campo `teardownError` de `run-report.json`, sin enmascarar
  nunca el resultado propio de la corrida. El desmontaje se omite cuando se
  pidieron juntos `--with-batteries --keep`, ya que la fase de baterías ya
  dejó intencionalmente el stack levantado para inspección. La fase de
  baterías (arriba) reutiliza este mismo ayudante de desmontaje.
- **Secretos fuera del entorno del código generado.** `MODEL_API_KEY` (y
  `MODEL_BASE_URL`) se exportan a `process.env` del runner, pero los comandos
  emitidos por el modelo y el `--verify-cmd` (`LocalExecutionManager`) y los
  procesos de la fase de baterías y `docker compose up` ya no los heredan: se
  eliminan del entorno heredado las variables cuyo nombre contiene `API_KEY`,
  `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, etc., más el `apiKeyEnv` de cada
  ruta del router. Las variables pasadas explícitamente (`BACKEND_URL`,
  `FRONTEND_URL`, `DB_URL`, `WORKSPACE`) siguen llegando a las baterías. Los
  procesos `git`/`gh` conservan el entorno completo.
- **Guardas de publicación.** El escaneo de secretos y la verificación de
  filtración del banco de aceptación descritos en "Publicación" arriba
  corren antes de cualquier llamada a `gh`/`git`, y solo sobre archivos
  rastreados por git.

## Tests

`node --test runner/aggregate-runs.test.mjs` cubre el agregador (filtros y motivos de exclusión, celdas de batería vacías, media/desviación por config, escape CSV y la CLI) con fixtures en directorios temporales y las columnas de análisis estático.

`node --test runner/collect-static-analysis.test.mjs` cubre la recolección con `fetch` y `gh` inyectados (sin red): caso completo, `pending`, `error`, salto de archivos `complete`, `--force` y corridas no publicadas.

`node --test runner/run-experiment.test.mjs` (el test runner incorporado de
Node; sin dependencia extra). Cubre la conexión de `--harness-config` contra
el servidor MCP de fixture y los fixtures de *skills* del *harness*: los
metadatos `harnessConfig` de `run-report.json`, la lista blanca de
*guardrails* extendida con las herramientas MCP + `load_skill`, que el
proveedor MCP se cierre cuando falla la carga de una *skill*, y que una
corrida sin `--harness-config` registre el mismo conjunto de herramientas que
antes. También cubre `createModel()` (devuelve un `OpenAICompatibleModelAdapter`
simple sin *router*, lo envuelve en un `RoutingModelAdapter` con las rutas
configuradas usando un stub `makeAdapter` inyectado — sin red — cuando hay
uno configurado, y propaga un error claro de variable de entorno faltante) y
`summarizeRouting()` (log de decisiones → conteos por ruta/motivo).
`run-experiment.mjs` solo ejecuta `main()` cuando se corre directamente
(`node runner/run-experiment.mjs ...`), de modo que importarlo para tests no
tiene efectos secundarios.

La conexión de `--task-file` se cubre lanzando la CLI real con `--dry-run`
(con `MODEL_API_KEY`/`MODEL_ID` ficticios en el entorno del hijo, ya que
`loadCredentials()` corre antes de la rama de dry-run): las tareas de los
nodos c3 en el plan impreso llevan el texto sobrescrito y nunca mencionan
`SPEC`, y un archivo de tarea vacío o solo de espacios en blanco termina con
código distinto de cero con un mensaje `Usage: --task-file ...` en stderr y
sin salida en stdout. `compactTraceC3()` se exporta y se prueba directamente
por copiar `loopFailure` en una entrada de trace fallida mientras lo omite en
una exitosa.

T3 (directorio de corridas, repositorio por corrida, publicación) se cubre
sin red y sin GitHub real: el `--runs-dir` por defecto de `parseArgs()`
resolviendo fuera del monorepo y los flags nuevos `--publish`/`--publish-org`;
`slugifyModelId()` y `timestampForWorkspace()`; el nombrado
`<slug>-<config>-<timestamp>` de `createWorkspace()` y que `--dry-run` no
crea nada (también ejercitado de punta a punta vía un lanzamiento real de la
CLI con `--dry-run`); `initWorkspaceRepo()` contra un repositorio git local
real en un directorio temporal (rama `main`, un commit con la identidad fija
`pi-runner`, `.gitignore` cubriendo
`node_modules/`/`dist/`/`build/`/`coverage/`/`.env*`/`reasoning.jsonl`);
`scanWorkspaceForSecrets()`/`collectSecretValues()` detectando una clave
plantada (y el `apiKeyEnv` de una ruta configurada) sin nunca hacer
aserciones sobre el valor en sí; `findAcceptancePathInWorkspace()`; y
`publishWorkspace()`/`checkGhAuthenticated()` con un stub de ejecutor de
comandos inyectado en lugar de `gh`, cubriendo el comando `gh repo create`
construido, el campo `repository` escrito en `run-report.json`, y que las
guardas de secreto/banco se rehúsan antes de que `gh`/`git` sean siquiera
invocados.

El análisis estático de la publicación también se cubre sin red: repositorios
git temporales con `run` y `fetch` inyectados verifican que se quitan los
*workflows* del modelo (y que sin ellos no hay commit de quita), el contenido
exacto de los archivos inyectados, la llamada a SonarCloud (parámetros y
cabecera `Bearer`), la tolerancia al 400 "already exists", que cualquier otro
fallo o un `SONAR_TOKEN` ausente dejan `publishError` sin llamar a `gh`, que
el escaneo de secretos detecta un `SONAR_TOKEN` plantado, `--sonar-org` y
`--publish-only` (rechazo de reportes ya publicados, sin credenciales de
modelo). Los pasos del *workflow* (job `coverage` sin secretos, espera del
análisis y tabla de criterios) se verifican por su texto exacto, y
`--update-analysis` con `run`/`fs` inyectados: rechazo de reportes sin
`repository`, solo las dos rutas propias en `git add`, entorno sin hooks en
cada llamada a git, escaneo de secretos antes de commitear/empujar y sin
commit cuando ya está al día.

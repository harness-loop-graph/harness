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
| data | data | Implementar la capa de datos (migraciones + seed) | ninguna |
| backend | backend | Implementar el backend NestJS (EP-01..EP-20) | ninguna |
| frontend | frontend | Implementar la SPA en React (SCR-01..SCR-08) | ninguna |
| reviewer | reviewer | Revisar el sistema, escribir `review-verdict.json` | `test -f review-verdict.json` |

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
| `--max-turns <n>` | 8 | Presupuesto de turnos del *loop* (nodos C2/C3). Debe ser un entero positivo |
| `--max-steps <n>` | 12 | Presupuesto de pasos del grafo (solo C3). Debe ser un entero positivo |
| `--tool-rounds <n>` | 80 (c1), 30 (c2/c3) | Presupuesto de llamadas a herramienta por interacción. Debe ser un entero positivo |
| `--verify-cmd <cmd>` | `docker compose up -d --build && curl -sf http://localhost:3000/health` | Comando de verificación de C2 |
| `--with-batteries` | desactivado | Después de la generación, levanta el stack y corre las baterías de aceptación |
| `--keep` | desactivado | Con `--with-batteries`, **no** desmonta el stack al final |
| `--dry-run` | desactivado | Imprime el plan en JSON y termina sin llamar al modelo; no crea nada en disco |
| `--harness-config <path>` | — | JSON `{ mcpServers, skillsDirs }`; conecta herramientas MCP + *skills* a cada *harness* que construye la corrida |
| `--publish` | desactivado | Después de la corrida (y su commit local de git), crea un repositorio **público** de GitHub para el espacio de trabajo vía `gh` y lo empuja (ver abajo) |
| `--publish-org <org>` | `harness-loop-graph` | Organización/usuario de GitHub bajo el que se crea el repositorio de `--publish` |

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
   `build/`, `coverage/` y `.env*`.
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
   termine en el espacio de trabajo.
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
3. En otro caso, crea un repositorio público `<org>/run-<workspace dir name>`
   con `gh repo create <repo> --public --source <workspace> --push
   --description "<model> <config> run generated by the PI-I harness"`,
   registra `repository: { name, url }` en `run-report.json`, y luego
   commitea y empuja ese reporte actualizado como un segundo commit
   (`run: record repository metadata`) en lugar de adivinar la URL antes de
   que el repositorio exista.

Cualquier fallo en este flujo (autenticación de `gh` faltante, secreto
encontrado, filtración del banco, fallo de `gh`/`git`) se registra en
`run-report.json` y hace que el proceso termine con código distinto de cero;
la corrida en sí nunca se pierde.

Las baterías de aceptación ocultas (`experiment/acceptance/`) siempre se
quedan en este repositorio banco — el runner nunca las copia a un espacio de
trabajo generado, así que tampoco pueden llegar jamás a un repositorio
publicado.

## Fase de baterías (`--with-batteries`)

1. `docker compose up -d --build` en el espacio de trabajo.
2. Sondea `GET http://localhost:3000/health` hasta 120 s.
3. Corre `node run-all.mjs` **con `experiment/acceptance/` como directorio de
   trabajo** (el banco oculto, nunca copiado al espacio de trabajo) contra la
   app generada, con `WORKSPACE` fijado a la ruta del espacio de trabajo más
   `BACKEND_URL`/`FRONTEND_URL`/`DB_URL` para el stack en ejecución.
4. Guarda el reporte agregado como `batteries-report.json` en el espacio de
   trabajo.
5. `docker compose down -v` (salvo `--keep`) — el mismo ayudante de cierre
   que usa el cierre de fin de corrida de c2 (ver "Salvaguardas" abajo).

> **Advertencia:** los puertos 5432, 3000 y 8080 están fijos. Correr un
> experimento a la vez; corridas concurrentes entrarán en conflicto.

## Referencia de `run-report.json`

Cada corrida escribe `run-report.json` en el espacio de trabajo:

```json
{
  "config": "c1|c2|c3",
  "model": "gpt-4o-mini",
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 0,
  "status": "SUCCESS|FAILED",
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "calls": 0 },
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
  "batteryPhase?": { "ran": true, "passed": true, "error?": "..." },
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
  completo del modelo. Para c3, un paso cuyo `loopStatus` es `"FAILED"`
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
  `true` cuando la fase corrió, `passed` indica si las baterías de
  aceptación pasaron, `error` solo está presente si la propia fase de
  baterías falló (p. ej. el health check nunca pasó).
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
- `publishError` — presente solo si se pasó `--publish` y la publicación fue
  rehusada o falló (ver "Publicación" arriba); nunca incluye un valor de
  secreto.

## Salvaguardas

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
- **Guardas de publicación.** El escaneo de secretos y la verificación de
  filtración del banco de aceptación descritos en "Publicación" arriba
  corren antes de cualquier llamada a `gh`/`git`, y solo sobre archivos
  rastreados por git.

## Tests

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
`node_modules/`/`dist/`/`build/`/`coverage/`/`.env*`);
`scanWorkspaceForSecrets()`/`collectSecretValues()` detectando una clave
plantada (y el `apiKeyEnv` de una ruta configurada) sin nunca hacer
aserciones sobre el valor en sí; `findAcceptancePathInWorkspace()`; y
`publishWorkspace()`/`checkGhAuthenticated()` con un stub de ejecutor de
comandos inyectado en lugar de `gh`, cubriendo el comando `gh repo create`
construido, el campo `repository` escrito en `run-report.json`, y que las
guardas de secreto/banco se rehúsan antes de que `gh`/`git` sean siquiera
invocados.

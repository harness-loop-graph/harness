# Harness — C1 / C2 / C3

*Harness* (entorno de ejecución del agente) agnóstico de proveedor que convierte una descripción de tarea en llamadas a herramientas sobre un espacio de trabajo, construido en tres configuraciones incrementales: un ciclo de interacción (C1), un *loop* (bucle) correctivo de verificación sobre éste (C2), y un grafo multiagente sobre ese *loop* (C3). Se comunica con cualquier endpoint de chat-completions compatible con OpenAI, de modo que la misma implementación corre sin cambios contra distintos proveedores de modelo — que es justamente para lo que la usa el experimento en `../experiment/`, para comparar las tres configuraciones con el modelo fijo.

Para los nombres de clase, rutas de archivo y detalles de proveedor reales detrás de este documento, ver [`docs/README.md`](./docs/README.md).

## Configuraciones

**C1** — El *harness* como sistema en ejecución. Un ciclo de interacción:

```
task ──► ContextManager ──► ModelRequest ──► ModelAdapter
                                                  │
                     ┌────────────────────────────┤
                     ▼                            ▼
                tool_call                     finish / error
                     │
           Guardrails (allowed / denied)
                     ▼
           ToolManager (validar + ejecutar)
                     ▼
           ToolResult ──► de vuelta al modelo ──► respuesta final
```

**C2** — El *loop* correctivo encima (`src/loop/`). Cada turno ejecuta una interacción completa del *harness* y luego el *loop* verifica el espacio de trabajo con un comando a cargo del operador, y decide:

```
starting → generating → observing → verifying → deciding → final
                                                ├─ FINISH (verificación aprobada)
                                                ├─ RETRY  (feedback alimentado al siguiente turno)
                                                └─ FAIL   (se alcanzó max_turns)
```

La política de decisión es determinista y vive en `AgentLoop`, no en el modelo: la evidencia de verificación, no las afirmaciones del modelo, cierra el *loop*.
Contratos: `LoopRequest` (task + maxTurns + verification), `LoopState`,
`LoopDecision` (FINISH/RETRY/FAIL), `LoopResult` (SUCCESS/FAILED + trace).

**C3** — El grafo multiagente encima (`src/graph/`). Una máquina de estados sobre nodos donde cada nodo ejecuta su propio *loop* C2; las aristas enrutan según el resultado del *loop*, con ramificación condicional:

```
architect --on_success--> data --on_success--> backend ...
reviewer --on_failure--> backend   (vuelve a la capa responsable)
un nodo exitoso sin arista saliente = FINISH terminal
maxSteps = prevención de bucle infinito a nivel de grafo
```

Contratos: `GraphRequest` (task + nodes + edges + initialNode +
maxSteps), `GraphNode` (id/role/task/instructions/verification),
`GraphEdge` (from/to/on_success|on_failure|always), `GraphState`
(current node, visits, results, shared notes), `GraphDecision`
(NEXT/FINISH/FAIL), `GraphResult` (SUCCESS/FAILED + step trace +
metrics). El enrutamiento es determinista: el patrón de revisor es una
arista `on_failure`, no una decisión del modelo.

## Componentes (6)

1. **Context Manager** (`FsContextManager`) — escaneo determinista del espacio de trabajo
2. **Model Adapter** — interfaz + un adaptador concreto para un endpoint compatible con OpenAI
3. **Tool Manager** (`RegistryToolManager`) — registro, verificación de *guardrails*, ejecución
   de `write_file`, `read_file`, `run_command`
4. **Execution Manager** (`LocalExecutionManager`) — lanza comandos confinados al
   espacio de trabajo, captura stdout/stderr, timeout estricto
5. **Verification Manager** (`RecordingVerificationManager`) — evalúa resultados de
   comandos, guarda historial (en memoria + JSONL)
6. **Guardrails** (`PolicyGuardrails`) — lista blanca de herramientas, lista blanca de prefijos de
   comando, confinamiento de rutas, límites de tamaño, auditoría de solo-append

## Harness

`src/harness.ts` compone los seis componentes y ejecuta exactamente un
ciclo de interacción (`maxToolRounds` por defecto es 1). Cada corrida devuelve la
respuesta final del modelo, una traza por turno, el log de auditoría de *guardrails* y el
historial de verificación.

## Herramientas MCP y skills (opcional)

El *harness* puede consumir herramientas de servidores MCP y cargar *skills* de agente
(`SKILL.md`), encima de las herramientas incorporadas:

- `McpToolProvider` se conecta a servidores MCP por stdio, lista sus herramientas, y
  las registra (con el espacio de nombres `mcp__<server>__<tool>`) en un
  `RegistryToolManager`, de modo que cada llamada queda verificada por *guardrails* y auditada.
- `SkillCatalog` carga archivos `SKILL.md` (frontmatter `name`/`description`);
  el context manager expone solo nombre/descripción, y la herramienta `load_skill`
  devuelve el cuerpo completo bajo demanda.
- `loadHarnessConfig(path)` / `wireHarnessConfig(config, manager)` conectan una
  configuración JSON (`{ mcpServers, skillsDirs }`) a un *harness*.

Ver [`docs/mcp-skills.md`](./docs/mcp-skills.md) para el detalle completo y
`examples/harness-config.json` para un ejemplo funcional.

## Router de modelos (opcional)

`RoutingModelAdapter` enruta cada solicitud a un `ModelAdapter` nombrado por
regla (custom → long-context → retry → default), desactivado salvo que la sección
`router` de una configuración de *harness* lo habilite. Las mismas reglas aplican idénticamente a
C1/C2/C3 — ninguna regla depende del nodo/rol del grafo. Ver
[`docs/model-router.md`](./docs/model-router.md).

## Ejecutar los tests

```bash
npm install
npm test
```

## Prueba de humo en vivo (endpoint de modelo real)

Crear un archivo `.env` ignorado por git (ver abajo) y ejecutar:

```bash
MODEL_API_KEY=<your provider API key>
MODEL_ID=<your model id>
npm run smoke         # C1: ciclo de interacción único
npm run smoke:loop    # C2: loop correctivo con verificación oculta
npm run smoke:graph   # C3: grafo multiagente architect -> builder
```

La prueba de humo crea un espacio de trabajo temporal aislado, le pide al modelo que escriba
`smoke.txt` a través del pipeline de herramientas, y termina con código distinto de cero si el ciclo no
finaliza exitosamente.

### Variables de entorno

| Variable | Requerida | Valor por defecto | Notas |
| --- | --- | --- | --- |
| `MODEL_API_KEY` | sí | — | Clave de API del proveedor al que se apunta |
| `MODEL_ID` | sí | — | Id del modelo, cualquier modelo compatible con OpenAI |
| `MODEL_BASE_URL` | sí | — (sin valor por defecto de proveedor) | Cualquier base URL compatible con OpenAI, p. ej. `https://openrouter.ai/api/v1` |

Las variables son genéricas de proveedor a propósito: el adaptador habla el
dialecto compatible con OpenAI, de modo que apuntar `MODEL_BASE_URL` a un proveedor
distinto funciona sin cambios de código (ver los tests del adaptador). No hay
valor por defecto de proveedor para `MODEL_BASE_URL`: debe estar configurada, o la construcción
falla rápido con un error claro. El adaptador también envía un `User-Agent` personalizado
identificando al *harness*, y combina cualquier `headers` configurado en cada
solicitud, para un endpoint que necesite un encabezado personalizado.

## Build

```bash
npm run build
```

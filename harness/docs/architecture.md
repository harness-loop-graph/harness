# Arquitectura — C1: el harness

C1 es el *harness* como sistema en ejecución: un ciclo de interacción desde una
tarea hasta una respuesta final del modelo, mediado por seis componentes y un
único conjunto de contratos compartidos.

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

## Los seis componentes

| # | Rol | Interfaz | Implementación real | Archivo |
|---|------|-----------|----------------------|------|
| 1 | Context Manager | `ContextManager` | `FsContextManager` | `src/components/context-manager.ts` |
| 2 | Model Adapter | `ModelAdapter` | `OpenAICompatibleModelAdapter` | `src/components/model-adapter.ts`, `src/components/openai-compatible-adapter.ts` |
| 3 | Tool Manager | `ToolManager` | `RegistryToolManager` | `src/components/tool-manager.ts` |
| 4 | Execution Manager | `ExecutionManager` | `LocalExecutionManager` | `src/components/execution-manager.ts` |
| 5 | Verification Manager | `VerificationManager` | `RecordingVerificationManager` | `src/components/verification-manager.ts` |
| 6 | Guardrails | `Guardrails` | `PolicyGuardrails` | `src/components/guardrails.ts` |

Cada componente también tiene una implementación `Stub*` (`StubContextManager`,
`StubModelAdapter`, `StubToolManager`, `StubExecutionManager`,
`StubVerificationManager`, `StubGuardrails`) usada por los tests unitarios que
no necesitan el comportamiento real.

### 1. Context Manager — `FsContextManager`

`prepare(task, projectRoot)` recorre el espacio de trabajo desde `projectRoot`,
omitiendo `node_modules`, `.git`, `dist`, `.cache`, con un tope de 500 archivos
y una profundidad de recursión de 6 (`MAX_FILES`, `MAX_DEPTH`). Los
directorios no legibles se omiten en lugar de hacer fallar el ciclo. Devuelve un
`Context` con la raíz resuelta, la lista de archivos relativos, una estimación
gruesa de `language` derivada de las extensiones de archivo (`typescript`,
`javascript`, `python`, `go`, o `undefined`), y el string de la tarea. Es un
escaneo determinista — no interviene ninguna llamada al modelo.

### 2. Model Adapter — interfaz + `OpenAICompatibleModelAdapter`

`ModelAdapter` (`src/components/model-adapter.ts`) es la abstracción
(`complete(request): Promise<ModelResponse>`). La implementación concreta
usada por el experimento, `OpenAICompatibleModelAdapter`, habla con cualquier
endpoint de chat-completions compatible con OpenAI; ver
[`model-provider.md`](./model-provider.md) para el detalle completo.

### 3. Tool Manager — `RegistryToolManager`

Mantiene un registro de pares `ToolSpec` + `ToolHandler` (`register`). En
`execute(call)`:
1. Busca la especificación; un nombre de herramienta desconocido devuelve un
   `ToolResult` fallido sin llamar a *guardrails*.
2. Llama a `guardrails.evaluate({ kind: 'tool', tool, args })`. Una decisión
   `denied` corta el flujo con un `ToolResult` fallido que lleva el motivo de
   la denegación.
3. Ejecuta el handler registrado; las excepciones del handler se capturan y se
   convierten en un `ToolResult` fallido en lugar de propagarse.

`registerBuiltinTools(manager, { execution, workspaceRoot })` registra las
tres herramientas incorporadas y devuelve su `ToolSpec[]`:

- `write_file` — escribe contenido UTF-8 en una ruta relativa a la raíz del
  espacio de trabajo, creando los directorios padre.
- `read_file` — lee un archivo UTF-8, truncado a 256 KiB (`MAX_READ_BYTES`).
- `run_command` — delega al `ExecutionManager` con `cwd` fijado a la raíz del
  espacio de trabajo.

### 4. Execution Manager — `LocalExecutionManager`

`run(req)` resuelve `req.cwd` contra `workspaceRoot` y rechaza cualquier ruta
resuelta fuera de ella (`exitCode: 126`) antes de lanzar nada. Lanza el comando
con `child_process.spawn(..., { shell: true })`, captura stdout/stderr
topeados en 512 KiB (`MAX_OUTPUT_BYTES`), y aplica un timeout estricto
(`timeoutMs`, 30 000 ms por defecto) que hace `SIGKILL` al hijo y reporta
`exitCode: 124` con un marcador `[timeout]` en stderr. Un error de spawn en sí
mismo se traduce en `exitCode: 127`.

### 5. Verification Manager — `RecordingVerificationManager`

`verify(result: ExecutionResult)` convierte un resultado de ejecución en un
`VerificationResult`: `passed` es `result.exitCode === 0`, `details` lleva los
últimos 2000 caracteres (`MAX_DETAIL_CHARS`) de stdout (en éxito) o
stderr-o-stdout (en fallo), y `metrics.exitCode` registra el código de salida
crudo. Cada verificación se agrega a un arreglo `history` en memoria y, cuando
se le pasa una ruta `historyFile` al constructor, también a un archivo JSONL.
`getHistory()` devuelve una copia del historial acumulado.

### 6. Guardrails — `PolicyGuardrails`

`evaluate(action: GuardrailAction)` decide y registra una `GuardrailDecision`
(`{ decision: 'allowed' | 'denied', reason }`) para uno de dos tipos de acción:
`{ kind: 'tool', tool, args }` o `{ kind: 'command', command, cwd }`. La
política (`GuardrailPolicy`) es: `workspaceRoot`, `allowedTools`,
`allowedCommandPrefixes`, `maxFileBytes`. Ver
[`decisions.md`](./decisions.md) para la justificación de diseño (lista blanca
de herramientas, lista blanca de prefijos de comando, confinamiento de rutas,
límites de tamaño, rastro de auditoría).
`getAuditLog()` devuelve cada decisión tomada hasta el momento, en orden;
cuando se construye con una ruta `auditFile`, las decisiones también se
agregan a ese archivo como JSONL con una marca de tiempo `at`.

## El harness — `src/harness.ts`

`Harness` compone los seis componentes (`HarnessComponents`) más opciones
estáticas (`HarnessOptions`: `workspaceRoot`, `availTools`, `instructions`,
`maxToolRounds` — por defecto `1`, que es el contrato de C1 de una única
interacción sin reintento correctivo; los *loops* de C2 sobrescriben esto por
corrida mediante `HarnessRunOptions.maxToolRounds`).

`run(task, runOptions)`:

1. Llama a `context.prepare(task, workspaceRoot)` una vez para construir el
   `Context`.
2. Recorre `round` de `0` a `maxToolRounds` inclusive, construyendo un
   `ModelRequest` en cada iteración con el `history` acumulado (entradas
   `ModelResponse | ToolResult` realimentadas al modelo) y, solo en
   `round === 0`, cualquier string `feedback` pasado desde un intento fallido
   anterior (reintento del *loop* — el *loop*, no el *harness*, es dueño del
   feedback entre turnos).
3. Llama a `model.complete(request)`. Si la respuesta no es un `tool_call`, el
   bucle se corta inmediatamente (el modelo terminó o falló).
4. Si no, ejecuta la herramienta mediante `tools.execute(response)`, agrega
   tanto la llamada a la herramienta como su `ToolResult` a `history`, y — si
   el payload del resultado de la herramienta parece un `ExecutionResult`
   (`exitCode`/`stdout`/`stderr`, verificado por `isExecutionResult`) —
   ejecuta `verification.verify(...)` y lo adjunta al turno.
5. Si se alcanza el límite de rondas sin una respuesta que no sea `tool_call`,
   el *harness* sintetiza una respuesta `error` con código `max_tool_rounds`.

El valor de retorno (`HarnessRunResult`) es `{ finalResponse, turns, audit,
verifications }`: `turns` es la traza completa por ronda (`InteractionTurn[]`),
`audit` es `guardrails.getAuditLog()`, y `verifications` es
`verification.getHistory()` — es decir, cada verificación producida durante la
corrida, no solo las adjuntadas a turnos individuales.

## Contratos — `src/contracts/core.ts`

Estos son los tipos que comparten cada componente y el *harness*:

- **`Context`** — `projectRoot`, `files: string[]`, `language` opcional,
  `framework`, `task`.
- **`ModelRequest`** — `task`, `context`, `availTools: ToolSpec[]`,
  opcionales `instructions`, `feedback` (feedback de verificación de un
  intento fallido anterior — solo reintento del *loop*), `history` (entradas
  `ModelResponse | ToolResult` previas de esta interacción).
- **`ModelResponse`** — una unión de `ToolCallResponse`
  (`{ type: 'tool_call', tool, args }`), `ErrorResponse`
  (`{ type: 'error', code, message }`), `FinishResponse`
  (`{ type: 'finish', content }`).
- **`ToolResult`** — `{ type: 'tool_result', tool, success, result }`.
- **`ExecutionRequest`** / **`ExecutionResult`** — `{ command, cwd, env? }`
  y `{ exitCode, stdout, stderr }`, el contrato entre la capa de herramientas
  y `ExecutionManager`.
- **`VerificationResult`** — `{ passed, details, metrics? }`.
- **`GuardrailDecision`** — `{ decision: 'allowed' | 'denied', reason }`.
- **`ToolSpec`** — `{ name, description, inputSchema }`, la forma tipo
  JSON-Schema enviada al modelo como definición de función/herramienta.

Todo esto se exporta desde `src/index.ts` junto con cada clase concreta de
componente, el `Harness`, y los contratos y motores de C2/C3.

## Opcional: herramientas MCP y skills

Dos añadidos opcionales conviven junto a los seis componentes sin cambiar
ninguno de ellos: un proveedor de herramientas MCP (herramientas provenientes
de servidores MCP externos) y un catálogo de *skills* (divulgación progresiva
de `SKILL.md`). Ambos se registran en el mismo camino
`RegistryToolManager`/`Guardrails` que las herramientas incorporadas. Ver
[`mcp-skills.md`](./mcp-skills.md).

## Opcional: router de modelos

`RoutingModelAdapter` es un tercer añadido opcional: un `ModelAdapter` que
enruta cada solicitud a un adaptador delegado nombrado por regla (custom →
long context → retry → default), desactivado salvo que la sección `router` de
una configuración del *harness* lo habilite. Se sitúa detrás de la interfaz
`ModelAdapter`, de modo que nada más en este documento cambia. Ver
[`model-router.md`](./model-router.md).

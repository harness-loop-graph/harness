# Decisiones de arquitectura

Decisiones detrás del diseño agnóstico de proveedor del *harness*, registradas
como un breve registro de decisiones de arquitectura: contexto, decisión y
consecuencias para cada una, con la evidencia de código que la respalda. Ver
[`architecture.md`](./architecture.md) para cómo funcionan los componentes
afectados en el día a día; este documento solo cubre por qué están construidos
de esa manera.

## ADR 1 — El acceso al proveedor es un valor de configuración en tiempo de ejecución, no una clase

**Contexto.** Las primeras corridas del experimento apuntaron el adaptador a
GLM, accedido a través de OpenCode Go (https://opencode.ai/docs/go/) en lugar
de un endpoint nativo de Z.ai/GLM, porque OpenCode Go habla el dialecto
chat-completions de OpenAI (`messages`, `tools`,
`choices[0].message.tool_calls`) — no hacía falta parseo específico del
endpoint.

**Decisión.** Esa elección histórica no quedó fijada en el código.
`OpenAICompatibleModelAdapter` (`src/components/openai-compatible-adapter.ts`)
no lleva ningún nombre de clase específico de proveedor, URL base por defecto,
ni encabezado fijo. `MODEL_BASE_URL` no tiene valor por defecto y debe
configurarse explícitamente, apuntando al endpoint compatible con OpenAI que use
cada corrida — OpenCode Go, OpenRouter, o cualquier otro.

**Consecuencias.** `tests/openai-compatible-adapter.spec.ts` reutiliza la
misma clase contra `https://api.openai.com/v1` sin ningún cambio de código, de
modo que la afirmación de agnosticismo de proveedor queda demostrada, no solo
declarada. Un llamador que necesite un encabezado personalizado para su
endpoint (el encabezado de enrutamiento/sesión de OpenCode Go, por ejemplo) lo
configura a través del `headers` genérico del adaptador, nunca mediante código
de adaptador específico de un proveedor.

## ADR 2 — Los nombres de las variables de entorno son genéricos de proveedor

**Contexto.** Las tres variables que lee el *harness* — `MODEL_API_KEY`,
`MODEL_ID`, `MODEL_BASE_URL` — podrían haberse llamado según el proveedor
usado en las primeras corridas (`GLM_API_KEY` / `ZAI_API_KEY` /
`OPENCODE_...`).

**Decisión.** No fue así. Los mismos tres nombres genéricos funcionan para
cualquier proveedor compatible con OpenAI; la clase del adaptador, su
configuración y sus valores por defecto son agnósticos de proveedor por
construcción.

**Consecuencias.** Cambiar de proveedor es puramente un cambio de
configuración (`MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_ID`, más una
entrada opcional `headers`), nunca un cambio de código — ver ADR 1.

## ADR 3 — El loop y el grafo deciden según evidencia, nunca según la afirmación del modelo

**Contexto.** Un modelo puede declarar que una tarea está terminada sin que el
espacio de trabajo realmente la satisfaga. Si el *loop* o el grafo confiaran
directamente en esa afirmación, un fallo podría pasar silenciosamente como un
éxito.

**Decisión.** Tanto C2 como C3 enrutan según evidencia:

- `AgentLoop.decide` (`src/loop/agent-loop.ts`) solo devuelve `FINISH` cuando
  no se configuró ningún comando de verificación, o cuando el código de salida
  del comando de verificación fue `0` — una respuesta `finish` por sí sola
  nunca alcanza. Es un método de TypeScript síncrono y simple, sin ninguna
  llamada al modelo dentro.
- `GraphEngine.route` (`src/graph/graph-engine.ts`) hace coincidir aristas
  puramente contra `loopResult.status` (`'SUCCESS' | 'FAILED'`, a su vez
  derivado de la decisión determinista del *loop*), o contra un `GraphRouter`
  provisto por el llamador que inspecciona `GraphState` — nunca el modelo.
- El patrón de revisor (`tests/graph.spec.ts`, `smoke-graph.ts`) se expresa
  puramente como una `GraphEdge` de tipo `on_failure` desde un nodo revisor de
  vuelta al nodo responsable del fallo; no hay ninguna decisión de "¿debería
  volver atrás?" del lado del modelo en ningún punto del enrutamiento.

**Consecuencias.** Esto aísla lo que se confía al modelo (producir llamadas a
herramientas y una respuesta final) de lo que cierra el *loop* — un comando de
verificación de shell a cargo del operador, cuyo resultado es un simple código
de salida. También hace comparables a C1/C2/C3: lo único que cambia entre
configuraciones es la capa de ingeniería, no cómo se decide el "éxito".

## ADR 4 — Los guardrails son verificaciones de política estáticas, previas a la ejecución

**Contexto.** Las llamadas a herramientas y comandos de shell que vienen de un
modelo necesitan un límite de confianza que no dependa de que el modelo se
comporte bien.

**Decisión.** `PolicyGuardrails` (`src/components/guardrails.ts`) aplica esta
defensa puramente mediante verificaciones estáticas evaluadas antes de que
nada se ejecute — ningún juicio de modelo o basado en LLM interviene en la
decisión de permitir/denegar:

- **Lista blanca de herramientas** — `GuardrailPolicy.allowedTools`; un nombre
  de herramienta no listado se deniega antes de que corra cualquier handler.
- **Lista blanca de prefijos de comando** — `GuardrailPolicy.allowedCommandPrefixes`;
  solo se verifica el primer token delimitado por espacios de un string
  `run_command` (p. ej. `npm`, `git`, `node`). Una expresión regular además
  deniega siempre las variantes de `rm -r`/`rm -f`
  (`/(^|\s)rm\s+-[rf]/`) aunque `rm` mismo esté en la lista blanca.
- **Confinamiento de rutas** — cualquier argumento de ruta se resuelve contra
  la raíz del espacio de trabajo y se deniega si resuelve fuera de ella
  (escapes con `..`, o una ruta absoluta que apunte a otro lugar);
  `LocalExecutionManager.run` vuelve a verificar de forma independiente el
  `cwd` resuelto, de modo que el confinamiento se aplica en dos capas.
- **Límites de tamaño** — `GuardrailPolicy.maxFileBytes` acota una sola
  llamada a `write_file`; `read_file` y la salida de comandos están limitados
  en bytes de forma independiente dentro de la propia capa de
  herramientas/ejecución.
- **Rastro de auditoría de solo-append** — cada decisión se agrega a un
  registro en memoria y, cuando se configura con una ruta `auditFile`, se
  agrega también como JSONL — el archivo nunca se trunca ni se reescribe,
  solo se le agrega contenido.

**Consecuencias.** `Harness.run` expone cada decisión de *guardrails* tomada
durante una corrida a través de `HarnessRunResult.audit`, de modo que el
rastro de auditoría forma parte de la evidencia registrada de la corrida, no
solo un canal lateral de depuración. Ver
[`architecture.md`](./architecture.md#6-guardrails--policyguardrails) para la
interfaz completa de `PolicyGuardrails`.

# Proveedor de modelo — chat completions compatible con OpenAI

El *harness* habla con un modelo a través de cualquier endpoint de
chat-completions compatible con OpenAI (configurado mediante
`MODEL_BASE_URL`/`MODEL_API_KEY`/`MODEL_ID`). Históricamente las primeras
corridas apuntaron esto a **GLM** a través de **OpenCode Go**
(https://opencode.ai/docs/go/); OpenRouter y OpenCode Go son dos ejemplos de
endpoints que funcionan, no un requisito. El adaptador concreto es
`OpenAICompatibleModelAdapter` en `src/components/openai-compatible-adapter.ts`.

## Por qué una interfaz genérica

`ModelAdapter` (`src/components/model-adapter.ts`) es una interfaz de un solo
método: `complete(request: ModelRequest): Promise<ModelResponse>`. Cualquier
otro componente del *harness* (`ContextManager`, `ToolManager`,
`ExecutionManager`, `VerificationManager`, `Guardrails`) es ciego al
proveedor; `OpenAICompatibleModelAdapter` es el **único** componente que sabe
hablar con un endpoint específico, y no lleva ningún nombre de clase
específico de proveedor, URL base por defecto, ni encabezado fijo — cualquier
endpoint compatible con OpenAI se conecta construyendo el adaptador con un
`baseUrl`/`model` distinto (y, si el endpoint lo necesita, un encabezado
personalizado vía `headers`). Esto queda demostrado directamente por el test
`'works unchanged against any OpenAI-compatible endpoint (e.g., OpenAI)'` de
`tests/openai-compatible-adapter.spec.ts`, que apunta la misma clase a
`https://api.openai.com/v1` y verifica que la forma de la solicitud es
idéntica. Ver [`decisions.md`](./decisions.md) para la historia de por qué las
primeras corridas del experimento usaron GLM a través de OpenCode Go, y por
qué el diseño en sí se mantiene agnóstico de proveedor.

## Configuración — `OpenAICompatibleAdapterConfig`

| Campo | Fuente | Valor de respaldo |
|---|---|---|
| `apiKey` | argumento del constructor | `process.env.MODEL_API_KEY` |
| `baseUrl` | argumento del constructor | `process.env.MODEL_BASE_URL` — **sin valor por defecto de proveedor**; la construcción lanza error si ninguno está configurado |
| `model` | argumento del constructor | `process.env.MODEL_ID` (p. ej. `gpt-4o-mini`) |
| `fetchImpl` | argumento del constructor | `fetch` global (inyectable para tests) |
| `timeoutMs` | argumento del constructor | `120_000` |
| `headers` | argumento del constructor | `{}` — combinado en cada solicitud, para un endpoint que necesite un encabezado personalizado |
| `userAgent` | argumento del constructor | `'pi-harness/0.1.0'` |
| `temperature` | argumento del constructor | sin valor (default del proveedor); se envía como `temperature` |
| `topP` | argumento del constructor | sin valor (default del proveedor); se envía como `top_p` |
| `seed` | argumento del constructor | sin valor (default del proveedor); se envía como `seed` |
| `maxTokens` | argumento del constructor | sin valor (default del proveedor); se envía como `max_tokens` |

Los cuatro campos de muestreo son opcionales: cada uno se incluye en el cuerpo
de la solicitud **solo si está definido** (el `0` cuenta como definido); si no,
el campo se omite y rige el default del proveedor. `getSamplingConfig()`
devuelve los valores efectivos `{ temperature, topP, seed, maxTokens }` con
`null` para los no definidos, de modo que quien invoca pueda registrarlos
(el runner del experimento los guarda en `run-report.json`).

El constructor lanza error inmediatamente (`MODEL_API_KEY is not set...` /
`MODEL_ID is not set...` / `MODEL_BASE_URL is not set...`) si la clave, el
modelo, o la URL base resuelven a un string vacío, de modo que una corrida mal
configurada falla rápido en lugar de hacer una llamada HTTP condenada al
fracaso.

### Variables de entorno

`MODEL_API_KEY`, `MODEL_ID`, `MODEL_BASE_URL` son las tres variables que lee
el *harness*. Sus nombres son deliberadamente **genéricos de proveedor**, no
`GLM_API_KEY` / `ZAI_API_KEY` / etc. — ver [`decisions.md`](./decisions.md)
(ADR 2). `MODEL_BASE_URL` es **obligatoria** (no hay valor por defecto de
proveedor); apunta a cualquier endpoint compatible con OpenAI, p. ej.
`https://openrouter.ai/api/v1` o `https://opencode.ai/zen/go/v1`.

## Forma de la solicitud

`complete(request)` hace POST a `` `${baseUrl}/chat/completions` `` con:

```json
{
  "model": "<MODEL_ID>",
  "messages": [ ... ],
  "tools": [ ... ],   // se omite cuando availTools está vacío
  "temperature": 0.2, // opcionales: solo si están configurados
  "top_p": 0.9,
  "seed": 42,
  "max_tokens": 4096
}
```

Encabezados:

```
Content-Type: application/json
Authorization: Bearer <MODEL_API_KEY>
User-Agent: pi-harness/0.1.0          (o el userAgent configurado)
...headers                            (cualquier `headers` configurado combinado)
```

`headers` permite que un llamador agregue lo que un endpoint específico
necesite (p. ej. un encabezado de sesión/enrutamiento que algunos proxies
requieren); el adaptador en sí no tiene ninguna opinión sobre qué, si acaso
algo, va ahí.

Las solicitudes expiran mediante `AbortSignal.timeout(timeoutMs)` (120 s por
defecto).

## Construcción de mensajes — `buildMessages`

- Un mensaje `system` se emite solo si hay algo para poner en él:
  `request.instructions` y/o una lista renderizada de `request.availTools`
  (líneas `- name: description` bajo `Available tools:`).
- La tarea se convierte en un mensaje `user`, con los primeros 200 archivos de
  `request.context.files` agregados, la raíz del espacio de trabajo, y el
  lenguaje estimado; si `request.feedback` está presente (reintento del
  *loop*) se agrega bajo un marcador
  `[feedback from previous failed attempt]`.
- `request.history` (entradas previas `ModelResponse | ToolResult`) se
  reproduce como mensajes al estilo OpenAI: un `tool_call` se convierte en un
  mensaje `assistant` con `tool_calls` (id sintético `` call_${tool} ``); un
  `tool_result` se convierte en un mensaje `role: 'tool'` con el
  `tool_call_id` correspondiente, contenido topeado a 8000 caracteres conservando inicio y final (marcador
  `…[truncated N chars]…` en el medio; no es JSON válido); un
  `finish` se convierte en un mensaje `assistant` simple; cualquier otra cosa
  (un `error`) se convierte en un mensaje `assistant` que resume el código y
  el texto del error.

## Mapeo de respuesta — `complete`

- Fallo de red (fetch lanza error) → `{ type: 'error', code: 'network_error', message }`
  (tras agotar los reintentos, ver "Política de reintentos").
- HTTP no 2xx → `{ type: 'error', code: 'http_<status>', message }` (cuerpo
  truncado a 2000 caracteres; tras agotar los reintentos, ver "Política de reintentos").
- Cuerpo no JSON → `{ type: 'error', code: 'invalid_json', ... }`.
- Un campo `error` JSON en el payload → `{ type: 'error', code, message }`.
- `choices[0].finish_reason` es `length` → `{ type: 'error', code: 'output_truncated', ... }`; es `content_filter` → `{ type: 'error', code: 'content_filtered', ... }`. Se evalúa antes de leer `content`/`tool_calls`, así una respuesta cortada nunca se toma como final ni como llamada a herramienta (el uso de tokens igual se contabiliza).
- Sin `choices[0].message` → `{ type: 'error', code: 'empty_response', ... }`.
- `message.tool_calls[0]` presente → parsea `function.arguments` como JSON y
  devuelve `{ type: 'tool_call', tool, args }`; argumentos no parseables se
  convierten en `{ type: 'error', code: 'invalid_tool_arguments', ... }`.
- `message.content` es un string no vacío → `{ type: 'finish', content }`.
- Ninguno de los anteriores → `{ type: 'error', code: 'empty_content', ... }`.

El uso de tokens (`payload.usage.prompt_tokens` / `completion_tokens`) se
acumula a través de cada llamada en la instancia y se expone mediante
`getUsage(): { promptTokens, completionTokens, totalTokens, calls, retries, cost, modelsUsed }`.
Los intentos fallidos no traen `usage`, así que un reintento nunca duplica
tokens ni costo: solo cuenta el payload del intento exitoso. `calls` cuenta
llamadas a `complete()` (no intentos HTTP); `retries` cuenta los intentos
repetidos por fallos transitorios, para que los reportes de corrida muestren
la inestabilidad del proveedor (`report.usage.retries`).

## Política de reintentos

`complete()` reintenta los fallos transitorios en lugar de abortar el turno:

- **Se reintenta**: HTTP 429, 500, 502, 503, 504; errores de red (fetch
  rechaza: `TypeError`, `ECONNRESET`, etc.) y el aborto por *timeout* de la
  solicitud (`timeoutMs`). También se reintenta una respuesta 2xx cuyo
  **cuerpo** falla: (a) la lectura del cuerpo rechaza (conexión cortada a
  mitad del cuerpo, o el *timeout* se dispara mientras el cuerpo se
  descarga), (b) el cuerpo está vacío, o (c) el cuerpo no es JSON válido
  (p. ej. una página HTML de error de un proxy). Cada intento repetido suma
  a `retries`, y el uso solo se acumula del payload exitoso ya parseado.
  Igual se reintenta un 200 cuyo JSON trae un objeto `error` con `code`
  numérico (o cadena numérica) en 429, 500, 502, 503, 504 o 408: es un fallo
  transitorio del proveedor upstream (p. ej. OpenRouter).
- **No se reintenta**: cualquier otro 4xx (400, 401, 403, 404, 422) ni un
  payload exitoso pero semánticamente inválido (JSON válido con `error` de
  otro código, p. ej. 400, 401, 402 sin créditos o 403; `empty_response`, `output_truncated`, etc.); esos se devuelven de
  inmediato. Si el JSON trae un objeto `error`, el mensaje devuelto incluye
  su `message` y `code`.
- **Espera**: *backoff* exponencial con *jitter*: `base * 2^(n-1)` (base 1 s,
  tope 30 s), multiplicado por un factor aleatorio en [0.5, 1]. Si la
  respuesta trae `Retry-After` (segundos o fecha HTTP) se usa ese valor en
  lugar del *backoff*, topeado a 60 s.
- **Agotados los reintentos**: se devuelve la misma forma de error de siempre
  (`http_<status>` o `network_error`) con el mensaje terminado en
  `(after N attempts)`. Los fallos de cuerpo usan `body_read_error` (la
  lectura falló) o `invalid_json` (cuerpo vacío o no parseable); su mensaje
  incluye el error subyacente, el status HTTP, el `content-type`, el largo
  del cuerpo y los primeros ~300 caracteres en una sola línea, para poder
  diagnosticarlo después. Nunca incluye cabeceras de la solicitud (la API key).

Configuración en `OpenAICompatibleAdapterConfig` (todo opcional):

| Campo | Default | Descripción |
|---|---|---|
| `maxRetries` | `3` | Reintentos tras el primer intento (hasta 4 intentos). `0` desactiva. |
| `retryBaseDelayMs` | `1000` | Base del *backoff* exponencial. |
| `sleep` | `setTimeout` | `(ms) => Promise<void>` inyectable para que los tests no esperen. |
| `random` | `Math.random` | Fuente `[0, 1)` inyectable para el *jitter*. |

## Opcional: tope de costo — `BudgetedModelAdapter`

`BudgetedModelAdapter` envuelve cualquier `ModelAdapter` que exponga
`getUsage()` (el adaptador OpenAI-compatible o el `RoutingModelAdapter`) con un
tope `maxCostUsd`. Antes de cada `complete()`, si el `cost` acumulado
(`usage.cost` del proveedor, p. ej. OpenRouter) ya alcanzó el tope, **no** llama
al modelo interno y devuelve `{ type: 'error', code: 'budget_exceeded', message }`
con lo gastado y el límite; no lanza excepciones ni espera. El tope se evalúa
antes de la llamada, por lo que la última puede sobrepasarlo. Reenvía
`getUsage()` y, si el adaptador interno los tiene, `getRouting()` y
`getSamplingConfig()`. Expone `isExhausted()`, `blockedCalls` y
`costReported` (`false` si hubo llamadas pero el costo sigue en 0: el tope no
puede aplicarse; es informativo y nunca bloquea). El runner lo activa con
`--max-cost` (ver `experiment/runner/README.md`). Pruebas:
`tests/budgeted-model-adapter.spec.ts`.

## Dónde está conectado

`OpenAICompatibleModelAdapter` se instancia directamente (sin indirección de
fábrica/registro) en los tres puntos de entrada de prueba de humo en vivo:

- `src/smoke.ts` — un `OpenAICompatibleModelAdapter()` para una única
  interacción de C1.
- `src/smoke-loop.ts` — un adaptador reutilizado a través de cada turno de un
  `AgentLoop` de C2.
- `src/smoke-graph.ts` — un adaptador construido por nodo dentro del
  `LoopFactory`.

## Comportamiento verificado por `tests/openai-compatible-adapter.spec.ts`

La ausencia de `MODEL_API_KEY` / `MODEL_ID` / `MODEL_BASE_URL` lanza error con
un mensaje que nombra la variable faltante; una respuesta `tool_calls` se
mapea a `tool_call`; los `headers` configurados se combinan en la solicitud
junto con `Authorization` y `User-Agent`; una respuesta de contenido simple se
mapea a `finish`; apuntar `baseUrl` a `https://api.openai.com/v1` produce la
forma de solicitud idéntica contra un proveedor distinto; HTTP 401 y fallos de
red se mapean ambos a respuestas `error` tipadas; el uso se acumula a través
de llamadas y vuelve a cero por defecto cuando el payload lo omite; la
política de reintentos (429/5xx/red/*timeout* y cuerpos ilegibles, vacíos o
no-JSON y `error` 429/5xx/408 dentro de un 200 sí; otros 4xx y payloads semánticamente inválidos no; `Retry-After`, tope de *backoff*, `retries` en `getUsage()` y
sin doble conteo de uso); los parámetros de muestreo (ausentes del cuerpo
si no se configuran, presentes con nombres y valores exactos si se
configuran, y `getSamplingConfig()`); y
`history` se reconstruye correctamente en mensajes `assistant`/`tool`.

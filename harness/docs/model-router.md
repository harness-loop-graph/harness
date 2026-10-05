# Router de modelos

Enrutamiento de solicitudes opcional y desactivado por defecto, encima de la
interfaz `ModelAdapter`: envía cada solicitud a un modelo/endpoint distinto
según una regla, inspirado en
[claude-code-router](https://github.com/musistudio/claude-code-router). A
diferencia de ese proyecto, este *router* no lleva ninguna configuración por
agente/rol — ver "Por qué no hay enrutamiento por rol" más abajo.

## Qué es

`RoutingModelAdapter` (`src/components/routing-model-adapter.ts`) envuelve un
conjunto de `ModelAdapter`s nombrados detrás de un único `ModelAdapter`. Los
llamadores (el *harness*, el *loop*, el motor de grafo) nunca ven el *router*
— llaman a `complete(request)` exactamente como lo harían con cualquier
adaptador.

```
ModelRequest ──► RoutingModelAdapter ──► decide route ──► routes[route].complete(request)
                                              │
                                  custom → longContext → retry → default
```

## Reglas y precedencia

Evaluadas en este orden fijo; la primera regla que coincide gana:

1. **custom** — si hay un `customRouter(request, ctx)` configurado, corre
   primero. Devolver un nombre de ruta fuerza esa ruta (motivo `'custom'`);
   devolver `null` cae a las reglas de abajo. Devolver un nombre de ruta
   desconocido lanza error.
2. **longContext** — si hay una ruta `longContext` configurada y el conteo
   estimado de tokens de la solicitud supera `longContextThreshold` (60000
   por defecto).
3. **retry** — si hay una ruta `retry` configurada y `request.feedback` es un
   string no vacío (feedback de verificación de un intento fallido anterior —
   ver `ModelRequest.feedback` en `src/contracts/core.ts`).
4. **default** — en cualquier otro caso. Es siempre el adaptador que ya tenía
   el llamador; nunca se declara en un archivo de configuración.

La estimación de tokens (cuando no se da una anulación `estimateTokens`) es
una heurística aproximada, no un tokenizador: la longitud en caracteres
serializada de `task` + `context` + `instructions` + `history` + `feedback`,
dividida por 4.

## Uso

```ts
const router = new RoutingModelAdapter({
  routes: {
    default: new OpenAICompatibleModelAdapter({ apiKey, model: 'gpt-4o-mini' }),
    longContext: new OpenAICompatibleModelAdapter({ apiKey, model: 'gpt-4o-mini-long-context' }),
    retry: new OpenAICompatibleModelAdapter({ apiKey, model: 'gpt-4o-mini' }),
  },
  longContextThreshold: 60_000,
});
```

`getUsage()` devuelve la misma forma que
`OpenAICompatibleModelAdapter.getUsage()` (`promptTokens`,
`completionTokens`, `totalTokens`, `calls`, `cost`, `modelsUsed`), agregada a
través de cada ruta — de modo que un llamador que solo lee `getUsage()` (p.
ej. `report.usage` del runner del experimento) no necesita ningún cambio
cuando se introduce un *router*. `getRouting()` es la superficie específica
del *router*: `{ byRoute: { <name>: { calls, promptTokens, completionTokens,
totalTokens, cost } }, decisions: { route, reason }[] }`.

## Conexión en la configuración del harness

Un archivo de configuración del *harness* (ver `docs/mcp-skills.md`) puede
llevar una sección `router` opcional:

```json
{
  "router": {
    "longContextThreshold": 60000,
    "routes": {
      "longContext": { "model": "gpt-4o-mini-long-context", "apiKeyEnv": "LONG_MODEL_API_KEY" },
      "retry": { "model": "gpt-4o-mini" }
    },
    "customRouterPath": "./my-custom-router.mjs"
  }
}
```

- `default` nunca se declara aquí — es siempre el adaptador de modelo que ya
  tenía el llamador.
- Los nombres de ruta son `longContext`, `retry`, o cualquier otro nombre que
  solo un *router* personalizado pueda devolver (las reglas incorporadas solo
  eligen `longContext`/`retry`/`default`).
- Las claves de API nunca son literales en el archivo de configuración:
  `apiKeyEnv` nombra una variable de entorno; una ruta sin `apiKeyEnv` recurre
  a las propias variables de entorno del modelo por defecto
  (`MODEL_API_KEY`, y `MODEL_BASE_URL` si `baseUrl` también se omite). Una
  variable de entorno faltante falla rápido, nombrando la ruta y la variable.
- `customRouterPath` se resuelve relativo al archivo de configuración y se
  importa dinámicamente con `import()`; su exportación por defecto (o una
  exportación nombrada `route`) debe ser una función
  `(request, ctx) => routeName | null`.

`parseHarnessConfig`/`loadHarnessConfig` validan esta sección (ver
`src/harness-config.ts`); `createRoutedModel(routerConfig, defaultAdapter,
{ makeAdapter? })` construye el `RoutingModelAdapter` a partir de ella —
`makeAdapter` tiene por defecto `OpenAICompatibleModelAdapter` y es
inyectable para tests.

## Por qué no hay enrutamiento por rol

`claude-code-router` (y herramientas similares) a menudo enrutan según qué
agente/rol está llamando — p. ej. un rol "planner" recibe un modelo más
potente que un rol "coder". Este *harness* deliberadamente no lo hace:
`ModelRequest`/`Context` no llevan ninguna identidad de nodo/rol, y ninguna
regla de enrutamiento puede depender de una. La razón es el experimento al
que da soporte este *harness*: C1/C2/C3 (una interacción, un *loop*
correctivo, un grafo multiagente) se comparan entre sí manteniendo fijo el
modelo. El enrutamiento por rol permitiría que la estructura de grafo de C3 se
"comprara" en silencio un modelo más potente por nodo, confundiendo la
comparación grafo-vs-loop-vs-interacción-única con una elección de modelo. Las
mismas reglas de *router* por lo tanto aplican idénticamente a C1, C2 y C3, y
están desactivadas salvo que una configuración del *harness* las habilite.

## Tests

- `tests/routing-model-adapter.spec.ts` — cada regla, precedencia, el
  fallback a `null` del *router* personalizado, el error de ruta desconocida,
  la agregación de uso (incluyendo dos nombres de ruta compartiendo una misma
  instancia de adaptador).
- `tests/harness-config.spec.ts` — validación de la sección `router` y
  `createRoutedModel` (construcción de rutas, errores de variable de entorno
  faltante, carga de `customRouterPath`).

# Documentación del harness — empezar aquí

Documentación interna, a nivel de implementación, de `harness/`: los nombres de
clase, archivos y detalles de proveedor reales detrás del
[`harness/README.md`](../README.md) público. Leer una página de esta carpeta
cuando haga falta verificar una afirmación concreta contra el código fuente, no
solo el comportamiento de alto nivel. El propio `harness/README.md` se mantiene
deliberadamente agnóstico de proveedor (`ModelAdapter`, "endpoint compatible con
OpenAI"); esta carpeta nombra las implementaciones concretas.

Cada afirmación en estos documentos está respaldada por el código bajo `src/` y
por el comportamiento verificado por los tests bajo `tests/`.

## Orden de lectura

| # | Documento | Qué cubre |
|---|----------|--------|
| 1 | [`architecture.md`](./architecture.md) | C1: los seis componentes, el ciclo de interacción, `Harness`, y los contratos centrales — **empezar aquí** |
| 2 | [`loop.md`](./loop.md) | C2: el *loop* correctivo (`AgentLoop`), su máquina de estados, y la política determinista de decisión FINISH/RETRY/FAIL |
| 3 | [`graph.md`](./graph.md) | C3: el grafo multiagente (`GraphEngine`), el modelo de nodos y aristas, y la prevención de bucles infinitos con `maxSteps` |
| 4 | [`model-provider.md`](./model-provider.md) | El adaptador de modelo real (`OpenAICompatibleModelAdapter`), la forma de la solicitud/respuesta, y las variables de entorno |
| 5 | [`model-router.md`](./model-router.md) | El `RoutingModelAdapter` opcional, la sección `router` de la configuración del *harness*, y por qué las reglas de enrutamiento nunca dependen del nodo/rol del grafo |
| 6 | [`mcp-skills.md`](./mcp-skills.md) | El proveedor de herramientas MCP, el catálogo de *skills*, y el cargador de configuración del *harness* que conecta ambos a C1/C2/C3 de forma idéntica |
| 7 | [`decisions.md`](./decisions.md) | Registro de decisiones de arquitectura: elección de proveedor, nomenclatura de variables de entorno, la política determinista de decisión, el diseño de *guardrails* |

Los documentos 2–7 son independientes una vez leído `architecture.md`; léanse
en el orden que corresponda a lo que se esté verificando.

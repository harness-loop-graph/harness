# Herramientas MCP y skills

Dos añadidos sobre el *harness* C1/C2/C3: herramientas provenientes de
servidores MCP externos, y *skills* de agente (`SKILL.md`) cargadas a
demanda. Ambas pasan por el mismo camino de *guardrails* y auditoría que
las herramientas incorporadas — no existe una ruta de ejecución paralela
para ellas.

## Proveedor de herramientas MCP — `McpToolProvider`

`src/components/mcp-tool-provider.ts`. La forma de la configuración sigue
la convención común `{ mcpServers: { name: { command, args, env, cwd } } }`.

- `connect()` lanza cada servidor sobre stdio (`StdioClientTransport`),
  llama a `listTools()`, y construye un `ToolSpec` por cada herramienta
  remota, nombrado `mcp__<server>__<tool>` (saneado a `[a-zA-Z0-9_-]`, con
  un tope de 64 caracteres). Un fallo de conexión lanza una excepción de
  inmediato — un servidor ausente de forma silenciosa corrompería una
  corrida del experimento, así que no existe una ruta de fallo silencioso.
  Si algún servidor falla al conectar, o dos herramientas sanean al mismo
  nombre, todo cliente ya abierto se cierra antes de relanzar el error —
  un `connect()` parcial nunca deja procesos de servidor huérfanos.
- Una colisión de nombre de herramienta — dos herramientas MCP que sanean
  al mismo nombre, o una herramienta MCP que choca con una herramienta ya
  registrada en el gestor de destino (una incorporada, `load_skill`, u
  otra herramienta MCP) — lanza un error claro que nombra ambos orígenes
  en lugar de sobrescribir en silencio el registro anterior.
- `registerInto(manager)` registra las herramientas descubiertas
  (especificación + handler) en un `RegistryToolManager`, de modo que cada
  llamada pasa por la verificación de *guardrails* y queda auditada
  exactamente igual que `write_file`/`read_file`/`run_command`.
  `connect()` y `registerInto()` están separados a propósito: una misma
  conexión MCP puede compartirse entre varias instancias de
  `RegistryToolManager`, que es justo lo que hace el ejecutor del
  experimento para C3 (un *harness*, y un gestor de herramientas, por
  nodo del grafo — ver `experiment/runner/run-experiment.mjs`).
- El handler registrado llama a `client.callTool(...)`; un resultado con
  `isError: true` se convierte en un error lanzado (`RegistryToolManager`
  lo transforma en un `ToolResult` fallido), y las partes de contenido
  `text` de un resultado normal se unen y se devuelven.
- `close()` cierra toda conexión de cliente abierta y descarta los
  registros descubiertos (de lo contrario sus handlers llamarían a
  clientes ya cerrados).

Tests: `tests/mcp-tool-provider.spec.ts` ejercita un pequeño servidor MCP
de fixture (`tests/fixtures/mcp-fixture-server.mjs`, construido sobre el
`Server` de bajo nivel del SDK + `StdioServerTransport`) de punta a punta,
incluyendo la ruta de `isError` y el compartir una conexión entre dos
gestores de herramientas.

## Catálogo de skills — `SkillCatalog`

`src/components/skill-catalog.ts`. Carga cada `<dir>/<skill>/SKILL.md`
bajo uno o más directorios, procesando los directorios en el orden en que
se pasan y, dentro de cada directorio, los subdirectorios ordenados por
nombre — de modo que `list()` y el prompt "Available skills" renderizado
son estables entre corridas sin importar el orden de `readdir` del
sistema operativo. `list()` en sí también queda ordenado por nombre de
*skill*. Un archivo de *skill* debe comenzar con un bloque de frontmatter
`---` que contenga `name` y `description` (líneas simples `key: value`,
se permiten valores entre comillas — sin dependencia de YAML). Un
frontmatter ausente o inválido y los nombres de *skill* duplicados lanzan
una excepción en ambos casos, nombrando el archivo responsable. Un
directorio de *skills* configurado que falta lanza una excepción; dentro
de un directorio, solo un `SKILL.md` ausente (ENOENT) se trata como "no es
una skill" y se omite — cualquier otro fallo de lectura (permisos, un
`SKILL.md` que es en realidad un directorio, etc.) falla de inmediato,
nombrando el archivo.

Divulgación progresiva: `catalog.list()` devuelve solo pares `{ name,
description }`, que `FsContextManager` (cuyo constructor ahora acepta un
`SkillCatalog` opcional) coloca en `Context.skills`, y que
`OpenAICompatibleModelAdapter` renderiza como una sección de mensaje de
sistema "Available skills" — solo cuando hay al menos una skill cargada —
instruyendo al modelo a llamar a `load_skill` antes de hacer trabajo que
una skill cubra. El cuerpo completo (sin el frontmatter), el directorio de
la skill, y la lista de archivos complementarios disponibles dentro de
ella (todo archivo bajo el directorio de la skill salvo el propio
`SKILL.md`, de forma recursiva, con rutas relativas estilo POSIX, p. ej.
`reference/page-object-model.md`) solo los devuelve la herramienta
`load_skill` (`registerSkillTool`), a demanda. Un nombre de skill
desconocido produce un `ToolResult` fallido que lista los nombres de
skill disponibles.

### Lectura de los archivos complementarios de una skill

Las skills suelen referenciar archivos junto a `SKILL.md` (p. ej.
`reference/page-object-model.md`) que el modelo no puede abrir de otro
modo, porque `read_file` está confinado al espacio de trabajo de la
corrida, no al directorio de skills. `load_skill` acepta un argumento
opcional `file` — una ruta relativa al propio directorio de esa skill,
tomada de la lista `files` que se devuelve cuando se llama a `load_skill`
sin `file` — y devuelve el contenido de texto de ese archivo en lugar del
cuerpo de la skill:

- **Confinamiento**: la ruta resuelta debe permanecer dentro del
  directorio de la skill. Las rutas absolutas y los escapes `..` se
  rechazan antes de tocar el sistema de archivos; un symlink (ya sea el
  propio archivo complementario, o un directorio en el camino hacia él)
  que resuelva fuera del directorio de la skill también se rechaza,
  verificado mediante `fs.realpath` tanto sobre la ruta candidata como
  sobre el directorio de la skill, de modo que un salto de symlink no
  pueda terminar fuera del árbol confinado.
- **Tope de tamaño**: topeado al mismo `MAX_READ_BYTES` (256 KB) que
  `read_file`, pero a diferencia de `read_file` (que trunca en silencio),
  un archivo que excede el tope produce un `ToolResult` fallido que
  nombra el límite — truncar en silencio un documento de referencia sería
  peor que decirle al modelo que pida un archivo más acotado.
- **Archivo desconocido**: un `ToolResult` fallido que lista los archivos
  complementarios disponibles de la skill, el mismo patrón que un nombre
  de skill desconocido.
- Solo lectura, y enrutado a través de la misma verificación de lista
  blanca de *guardrails* que cualquier otra llamada a herramienta
  (`load_skill` debe estar en `allowedTools`) — no hay una ruta de
  ejecución separada para el argumento `file`.

Tests: `tests/skill-catalog.spec.ts` cubre el parseo de frontmatter
(válido, ausente, incompleto, duplicado), la población de
`Context.skills` (presente vs. ausente), el renderizado condicional del
adapter, `load_skill` sin `file` (encontrada vs. desconocida, incluyendo
la lista de archivos complementarios), y `load_skill` con `file` (lectura
de un archivo complementario anidado, un escape `..`, una ruta absoluta,
un symlink que resuelve fuera del directorio de la skill, el tope de
tamaño, y un archivo desconocido).

## Cargador de configuración del harness — `src/harness-config.ts`

`loadHarnessConfig(path)` lee y valida un archivo JSON
`{ mcpServers?, skillsDirs? }`: las entradas de `skillsDirs` y el `cwd` de
cada servidor se resuelven relativos al propio directorio del archivo de
configuración (no al `cwd` del llamador), de modo que una configuración es
portable. Las formas inválidas (`command` ausente, `args` que no es
arreglo o con entradas que no son string, `env` que no es un registro de
strings, `cwd` que no es string, `mcpServers` que no es objeto,
`skillsDirs` que no es arreglo, JSON inválido, archivo illegible) lanzan
todas una excepción con la ruta de configuración (y, para un campo de
servidor, el nombre del servidor) en el mensaje. La lógica de parseo y
validación de JSON vive en `parseHarnessConfig(text, configDir,
resolvedPath)`, una función pura que `loadHarnessConfig` llama después de
leer el archivo — un llamador que también necesite los bytes crudos (p.
ej. para calcular su hash) puede leer el archivo una sola vez y pasar el
mismo buffer a ambas, en lugar de leerlo dos veces.

`wireHarnessConfig(config, manager)` es una conveniencia para el caso
común de un único harness: conecta un `McpToolProvider` nuevo, carga un
`SkillCatalog` nuevo, registra todo en `manager`, y devuelve
`{ specs, catalog, allowedToolNames, close }`. Si algo falla después de
un `connect()` exitoso (la verificación de colisión de `registerInto()`,
o `SkillCatalog.load()`), el proveedor se cierra antes de relanzar el
error. Deliberadamente **no** intenta compartir conexiones entre gestores
— una corrida que construye varios *harnesses* (C3) conecta un
`McpToolProvider` y carga un `SkillCatalog` una sola vez, y luego llama a
`provider.registerInto(manager)` / `registerSkillTool(manager, catalog)`
por cada harness directamente, reutilizando la misma conexión MCP e
instancia de catálogo de skills. `experiment/runner/run-experiment.mjs`
hace exactamente esto.

Tests: `tests/harness-config.spec.ts`, contra
`examples/harness-config.json` (que apunta al servidor MCP de fixture y a
una skill de ejemplo `greeter` bajo `examples/skills/`).

## Qué obtienen C1/C2/C3 de forma idéntica

El ejecutor conecta las mismas herramientas MCP, `load_skill`, y la lista
blanca de *guardrails* en el *harness* (o los *harnesses*) de cada
configuración — ver `experiment/runner/README.md`. Sin
`--harness-config`, ninguna parte de esta ruta de código se ejecuta, así
que el comportamiento de C1/C2/C3 queda sin cambios.

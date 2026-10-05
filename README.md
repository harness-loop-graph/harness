# Ingeniería de Harness, Loop y Grafo

Un *harness* (entorno de ejecución del agente) agnóstico de proveedor que
genera sistemas de software completos a partir de una especificación fija, y
el banco de experimentos que mide cómo cada capa de ingeniería afecta la
calidad del código generado.

El generador está construido en tres configuraciones incrementales. Cada una
agrega una capa sobre la anterior, de modo que sus resultados se pueden
comparar directamente:

| Config | Capas | Qué agrega |
|---|---|---|
| **C1** | Harness | Un ciclo de interacción: context → model → guardrailed tools → verification → final answer |
| **C2** | Harness + loop | Un *loop* correctivo: después de cada turno, un comando de verificación decide `FINISH`, `RETRY` (con feedback) o `FAIL` |
| **C3** | Harness + loop + graph | Un grafo multiagente: architect → data → backend → frontend → reviewer, con enrutamiento condicional determinista |

## Características

- **Agnóstico de modelo.** Funciona con cualquier endpoint de
  chat-completions compatible con OpenAI (OpenRouter, OpenCode Go, un
  servidor autoalojado…), configurado solo mediante variables de entorno.
- **Guardrails.** Cada llamada a herramienta se verifica contra una lista
  blanca de herramientas y prefijos de comando, se confina al espacio de
  trabajo de la corrida, y se escribe en un log de auditoría.
- **Herramientas MCP.** Se conecta a servidores MCP por stdio y expone sus
  herramientas al modelo, bajo los mismos *guardrails*.
- **Agent skills.** Carga *skills* `SKILL.md` con divulgación progresiva:
  solo los nombres y descripciones entran al contexto; el cuerpo se carga bajo
  demanda.
- **Router de modelos.** Opcionalmente enruta cada solicitud a un modelo
  distinto según una regla (contexto largo, reintento tras un intento
  fallido, o un script de *router* personalizado).
- **Corridas reproducibles.** Cada corrida registra su configuración, modelo,
  uso de tokens, costo, motivos de fallo por nodo y un hash de la
  configuración del *harness*.

## Estructura del repositorio

```
harness/      El generador (TypeScript): harness, loop, graph, adapters, tools
experiment/   El banco de experimentos: SPEC.md, runner, skills, harness config
```

Las aplicaciones generadas nunca viven en este repositorio. Cada corrida se
escribe en su propio directorio fuera de él y se convierte en un repositorio
Git independiente que se puede publicar en GitHub para análisis estático.

## Requisitos

- Node.js 20 o superior
- Docker (la verificación de C2 y las baterías de aceptación levantan el
  stack generado)
- [GitHub CLI](https://cli.github.com/) autenticado, solo para publicar
  corridas

## Inicio rápido

```bash
(cd harness && npm install && npm run build && npm test)
node experiment/runner/run-experiment.mjs --config c1 --dry-run
```

Crear un archivo `.env` en la raíz del repositorio (está en `.gitignore`):

```
MODEL_BASE_URL=https://openrouter.ai/api/v1
MODEL_API_KEY=<your key>
MODEL_ID=qwen/qwen3-235b-a22b-2507
```

Las variables de entorno tienen precedencia sobre el archivo.

## Ejecutar el experimento

```bash
# Construir el sistema completo a partir de SPEC.md con cada configuración
node experiment/runner/run-experiment.mjs --config c1 --harness-config experiment/harness-config.json
node experiment/runner/run-experiment.mjs --config c2 --harness-config experiment/harness-config.json
node experiment/runner/run-experiment.mjs --config c3 --harness-config experiment/harness-config.json

# Publicar la app generada como su propio repositorio público en la organización
node experiment/runner/run-experiment.mjs --config c1 --harness-config experiment/harness-config.json --publish

# Corrida de validación económica con una tarea corta en lugar de la especificación completa
node experiment/runner/run-experiment.mjs --config c3 --task-file experiment/runner/validation-task.txt
```

Cada corrida escribe `run-report.json` (estado, uso de tokens y costo, conteo
de turnos/pasos, trace) dentro del repositorio generado. La misma
configuración de *harness* — servidores MCP y *skills* — se aplica de forma
idéntica a C1, C2 y C3, de modo que las diferencias entre configuraciones
provienen de las capas de ingeniería, no de la configuración de base.

Ver [`experiment/runner/README.md`](experiment/runner/README.md) para cada
flag, el formato del reporte y las salvaguardas de publicación, y
[`harness/README.md`](harness/README.md) para la arquitectura del *harness*.

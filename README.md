# Agent Harness — C1 Skeleton

Model-agnostic agent harness for experimental AI code-generation.

## Iteration

**C1** — Base contracts and component interfaces with minimal stub implementations.

## Components (6)

1. **Context Manager** — selects and prepares relevant project context
2. **Model Adapter** — abstracts LLM interaction (stub in C1)
3. **Tool Manager** — validates and executes tool calls
4. **Execution Manager** — runs commands in isolated workspaces
5. **Verification Manager** — evaluates execution results and artifacts
6. **Guardrails** — policy enforcement with audit trail

## Run tests

```bash
npm install
npm test
```

## Build

```bash
npm run build
```

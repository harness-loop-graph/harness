import { describe, it, expect } from 'vitest';
import { BudgetedModelAdapter, BUDGET_EXCEEDED_CODE } from '../src/components/budgeted-model-adapter.js';
import { RoutingModelAdapter } from '../src/components/routing-model-adapter.js';
import type { ModelAdapter } from '../src/components/model-adapter.js';
import type { Context, ModelRequest, ModelResponse } from '../src/contracts/core.js';

function request(): ModelRequest {
  const context: Context = { projectRoot: '/tmp/ws', files: [], language: 'typescript' };
  return { task: 'do something', context, availTools: [] };
}

/** Stub whose getUsage() matches OpenAICompatibleModelAdapter's shape, with a fixed cost per call. */
class CostStubAdapter implements ModelAdapter {
  public completeCalls = 0;
  private cost = 0;
  constructor(private readonly perCallCost: number) {}

  async complete(): Promise<ModelResponse> {
    this.completeCalls += 1;
    this.cost += this.perCallCost;
    return { type: 'finish', content: 'ok' };
  }

  getUsage() {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      calls: this.completeCalls,
      retries: 0,
      cost: this.cost,
      modelsUsed: ['stub'],
    };
  }

  getSamplingConfig() {
    return { temperature: 0.3, topP: null, seed: null, maxTokens: null };
  }

  getProviderConfig() {
    return { order: ['DeepInfra'], allowFallbacks: false };
  }
}

describe('BudgetedModelAdapter', () => {
  it('passes calls through while accumulated cost is under the limit', async () => {
    const inner = new CostStubAdapter(0.01);
    const model = new BudgetedModelAdapter(inner, { maxCostUsd: 0.05 });

    const first = await model.complete(request());
    const second = await model.complete(request());

    expect(first).toEqual({ type: 'finish', content: 'ok' });
    expect(second).toEqual({ type: 'finish', content: 'ok' });
    expect(inner.completeCalls).toBe(2);
    expect(model.isExhausted()).toBe(false);
    expect(model.blockedCalls).toBe(0);
  });

  it('blocks once cost reaches the limit, without calling the inner model', async () => {
    const inner = new CostStubAdapter(0.03);
    const model = new BudgetedModelAdapter(inner, { maxCostUsd: 0.05 });

    await model.complete(request()); // 0.03
    await model.complete(request()); // 0.06 >= 0.05
    expect(model.isExhausted()).toBe(true);

    const blocked = await model.complete(request());

    expect(inner.completeCalls).toBe(2);
    expect(blocked.type).toBe('error');
    if (blocked.type === 'error') {
      expect(blocked.code).toBe(BUDGET_EXCEEDED_CODE);
      expect(blocked.code).toBe('budget_exceeded');
      expect(blocked.message).toContain('0.0600');
      expect(blocked.message).toContain('0.0500');
    }
    expect(model.blockedCalls).toBe(1);
  });

  it('blocks when cost lands exactly on the limit', async () => {
    const inner = new CostStubAdapter(0.05);
    const model = new BudgetedModelAdapter(inner, { maxCostUsd: 0.05 });

    await model.complete(request());
    const blocked = await model.complete(request());

    expect(blocked.type).toBe('error');
    expect(inner.completeCalls).toBe(1);
  });

  it('forwards getUsage() and optional inner methods so reporting keeps working', async () => {
    const inner = new CostStubAdapter(0.01);
    const model = new BudgetedModelAdapter(inner, { maxCostUsd: 1 });
    await model.complete(request());

    expect(model.getUsage()).toEqual(inner.getUsage());
    expect(model.getSamplingConfig?.()).toEqual(inner.getSamplingConfig());
    expect(model.getProviderConfig?.()).toEqual(inner.getProviderConfig());
    expect(model.getRouting).toBeUndefined();
  });

  it('only exposes getProviderConfig() when the inner adapter has it', () => {
    const bare = { complete: async () => ({ type: 'finish' as const, content: '' }), getUsage: () => ({ calls: 0, cost: 0 }) };
    expect(new BudgetedModelAdapter(bare, { maxCostUsd: 1 }).getProviderConfig).toBeUndefined();
  });

  it('forwards getRouting() when the inner adapter is a router', async () => {
    const router = new RoutingModelAdapter({ routes: { default: new CostStubAdapter(0.01) } });
    const model = new BudgetedModelAdapter(router, { maxCostUsd: 1 });
    await model.complete(request());

    expect(typeof model.getRouting).toBe('function');
    expect(model.getRouting?.()).toEqual(router.getRouting());
  });

  it('reports costReported=false when calls happened but cost stayed 0 (cap cannot work), without blocking', async () => {
    const inner = new CostStubAdapter(0);
    const model = new BudgetedModelAdapter(inner, { maxCostUsd: 0.05 });

    expect(model.costReported).toBeNull();
    for (let i = 0; i < 3; i++) {
      const response = await model.complete(request());
      expect(response.type).toBe('finish');
    }

    expect(model.costReported).toBe(false);
    expect(model.isExhausted()).toBe(false);
    expect(inner.completeCalls).toBe(3);
  });

  it('reports costReported=true once the provider reports a positive cost', async () => {
    const model = new BudgetedModelAdapter(new CostStubAdapter(0.001), { maxCostUsd: 1 });
    await model.complete(request());
    expect(model.costReported).toBe(true);
  });

  it('rejects a non-positive or non-finite maxCostUsd', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new BudgetedModelAdapter(new CostStubAdapter(0), { maxCostUsd: bad })).toThrow(/maxCostUsd/);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { RoutingModelAdapter } from '../src/components/routing-model-adapter.js';
import type { ModelAdapter } from '../src/components/model-adapter.js';
import type { Context, ModelRequest, ModelResponse } from '../src/contracts/core.js';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  const context: Context = { projectRoot: '/tmp/ws', files: ['a.txt'], language: 'typescript' };
  return { task: 'do something', context, availTools: [], ...overrides };
}

/** Stub adapter with a controllable per-call usage delta, matching GlmModelAdapter's getUsage() shape. */
class UsageStubAdapter implements ModelAdapter {
  private promptTokens = 0;
  private completionTokens = 0;
  private cost = 0;
  private calls = 0;
  public readonly seenRequests: ModelRequest[] = [];

  constructor(
    private readonly response: ModelResponse = { type: 'finish', content: 'ok' },
    private readonly perCall = { promptTokens: 10, completionTokens: 5, cost: 0.01 },
  ) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.seenRequests.push(req);
    this.calls += 1;
    this.promptTokens += this.perCall.promptTokens;
    this.completionTokens += this.perCall.completionTokens;
    this.cost += this.perCall.cost;
    return this.response;
  }

  getUsage() {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      calls: this.calls,
      cost: this.cost,
      modelsUsed: [] as string[],
    };
  }
}

/** No getUsage() at all, to exercise the calls-only fallback. */
class BareStubAdapter implements ModelAdapter {
  calls = 0;
  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return { type: 'finish', content: 'bare' };
  }
}

describe('RoutingModelAdapter', () => {
  it('requires a default route', () => {
    expect(() => new RoutingModelAdapter({ routes: {} })).toThrow(/requires a 'default' route/);
  });

  it('routes to default when no rule matches', async () => {
    const def = new UsageStubAdapter();
    const router = new RoutingModelAdapter({ routes: { default: def } });

    await router.complete(request());

    expect(router.getRouting().decisions).toEqual([{ route: 'default', reason: 'default' }]);
  });

  it('routes to longContext when the estimate exceeds the threshold', async () => {
    const def = new UsageStubAdapter();
    const long = new UsageStubAdapter();
    const router = new RoutingModelAdapter({
      routes: { default: def, longContext: long },
      longContextThreshold: 100,
      estimateTokens: () => 101,
    });

    await router.complete(request());

    expect(router.getRouting().decisions).toEqual([{ route: 'longContext', reason: 'long_context' }]);
    expect(long.seenRequests).toHaveLength(1);
  });

  it('does not route to longContext when no longContext route is configured, even over threshold', async () => {
    const def = new UsageStubAdapter();
    const router = new RoutingModelAdapter({
      routes: { default: def },
      longContextThreshold: 100,
      estimateTokens: () => 999,
    });

    await router.complete(request());

    expect(router.getRouting().decisions).toEqual([{ route: 'default', reason: 'default' }]);
  });

  it('routes to retry when feedback is a non-empty string and a retry route exists', async () => {
    const def = new UsageStubAdapter();
    const retry = new UsageStubAdapter();
    const router = new RoutingModelAdapter({ routes: { default: def, retry }, estimateTokens: () => 1 });

    await router.complete(request({ feedback: 'previous attempt failed' }));

    expect(router.getRouting().decisions).toEqual([{ route: 'retry', reason: 'retry' }]);
  });

  it('does not route to retry on empty feedback or a missing retry route', async () => {
    const def = new UsageStubAdapter();
    const router = new RoutingModelAdapter({ routes: { default: def }, estimateTokens: () => 1 });

    await router.complete(request({ feedback: '' }));
    await router.complete(request({ feedback: 'has feedback but no retry route configured' }));

    expect(router.getRouting().decisions).toEqual([
      { route: 'default', reason: 'default' },
      { route: 'default', reason: 'default' },
    ]);
  });

  it('applies precedence: custom > longContext > retry > default', async () => {
    const def = new UsageStubAdapter();
    const long = new UsageStubAdapter();
    const retry = new UsageStubAdapter();
    const custom = new UsageStubAdapter();
    const router = new RoutingModelAdapter({
      routes: { default: def, longContext: long, retry, custom },
      longContextThreshold: 100,
      estimateTokens: () => 999,
      customRouter: () => 'custom',
    });

    await router.complete(request({ feedback: 'irrelevant, custom wins' }));

    expect(router.getRouting().decisions).toEqual([{ route: 'custom', reason: 'custom' }]);
  });

  it('falls back to the built-in rules when the custom router returns null', async () => {
    const def = new UsageStubAdapter();
    const long = new UsageStubAdapter();
    const router = new RoutingModelAdapter({
      routes: { default: def, longContext: long },
      longContextThreshold: 100,
      estimateTokens: () => 999,
      customRouter: () => null,
    });

    await router.complete(request());

    expect(router.getRouting().decisions).toEqual([{ route: 'longContext', reason: 'long_context' }]);
  });

  it('supports an async custom router', async () => {
    const def = new UsageStubAdapter();
    const retry = new UsageStubAdapter();
    const router = new RoutingModelAdapter({
      routes: { default: def, retry },
      customRouter: async () => 'retry',
    });

    await router.complete(request());

    expect(router.getRouting().decisions).toEqual([{ route: 'retry', reason: 'custom' }]);
  });

  it('throws a clear error when the custom router returns an unknown route', async () => {
    const def = new UsageStubAdapter();
    const router = new RoutingModelAdapter({ routes: { default: def }, customRouter: () => 'nonexistent' });

    await expect(router.complete(request())).rejects.toThrow(/unknown route 'nonexistent'/);
  });

  it('throws unknown-route even for inherited plain-object property names like toString or constructor', async () => {
    const def = new UsageStubAdapter();
    const routerToString = new RoutingModelAdapter({ routes: { default: def }, customRouter: () => 'toString' });
    const routerConstructor = new RoutingModelAdapter({ routes: { default: def }, customRouter: () => 'constructor' });

    await expect(routerToString.complete(request())).rejects.toThrow(/unknown route 'toString'/);
    await expect(routerConstructor.complete(request())).rejects.toThrow(/unknown route 'constructor'/);
  });

  it('aggregates usage across routes in getUsage(), and splits it per route in getRouting()', async () => {
    const def = new UsageStubAdapter({ type: 'finish', content: 'ok' }, { promptTokens: 10, completionTokens: 5, cost: 0.01 });
    const long = new UsageStubAdapter({ type: 'finish', content: 'ok' }, { promptTokens: 100, completionTokens: 50, cost: 0.1 });
    const router = new RoutingModelAdapter({
      routes: { default: def, longContext: long },
      longContextThreshold: 100,
      estimateTokens: (req) => (req.task === 'big' ? 999 : 1),
    });

    await router.complete(request());
    await router.complete(request({ task: 'big' }));
    await router.complete(request());

    const usage = router.getUsage();
    expect(usage).toMatchObject({ promptTokens: 120, completionTokens: 60, totalTokens: 180, calls: 3, modelsUsed: [] });
    expect(usage.cost).toBeCloseTo(0.12);

    const { byRoute } = router.getRouting();
    expect(byRoute.default).toMatchObject({ calls: 2, promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    expect(byRoute.default.cost).toBeCloseTo(0.02);
    expect(byRoute.longContext).toEqual({ calls: 1, promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.1 });
  });

  it('counts calls for adapters without getUsage(), with zeroed token/cost fields', async () => {
    const bare = new BareStubAdapter();
    const router = new RoutingModelAdapter({ routes: { default: bare } });

    await router.complete(request());
    await router.complete(request());

    expect(router.getUsage()).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 2, cost: 0, modelsUsed: [] });
  });

  it('records the call and any usage delta when the delegate throws, then rethrows', async () => {
    class ThrowingAdapter implements ModelAdapter {
      private promptTokens = 0;
      private calls = 0;
      async complete(): Promise<ModelResponse> {
        this.calls += 1;
        this.promptTokens += 10; // e.g. a provider that bills the prompt before failing on the response
        throw new Error('delegate failed');
      }
      getUsage() {
        return { promptTokens: this.promptTokens, completionTokens: 0, totalTokens: this.promptTokens, calls: this.calls, cost: 0, modelsUsed: [] };
      }
    }
    const def = new ThrowingAdapter();
    const router = new RoutingModelAdapter({ routes: { default: def } });

    await expect(router.complete(request())).rejects.toThrow('delegate failed');

    expect(router.getUsage()).toMatchObject({ calls: 1, promptTokens: 10 });
    expect(router.getRouting().byRoute.default).toMatchObject({ calls: 1, promptTokens: 10 });
  });

  it('splits usage correctly when two route names share the same adapter instance', async () => {
    const shared = new UsageStubAdapter({ type: 'finish', content: 'ok' }, { promptTokens: 10, completionTokens: 5, cost: 0.01 });
    const router = new RoutingModelAdapter({
      routes: { default: shared, retry: shared },
      estimateTokens: () => 1,
    });

    await router.complete(request());
    await router.complete(request({ feedback: 'retry this' }));

    const { byRoute } = router.getRouting();
    expect(byRoute.default).toEqual({ calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.01 });
    expect(byRoute.retry).toEqual({ calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.01 });
  });
});

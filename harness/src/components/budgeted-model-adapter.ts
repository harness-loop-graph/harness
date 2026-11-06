import type { ModelRequest, ModelResponse } from '../contracts/core.js';
import type { ModelAdapter } from './model-adapter.js';
import type { ProviderRoutingConfig, SamplingConfig } from './openai-compatible-adapter.js';
import type { RoutingModelAdapter } from './routing-model-adapter.js';

/** Error code returned (never thrown) once the cost ceiling is reached. */
export const BUDGET_EXCEEDED_CODE = 'budget_exceeded';

export interface BudgetedModelAdapterConfig {
  /** Spend ceiling in USD, compared against the inner adapter's accumulated `getUsage().cost`. Must be positive. */
  maxCostUsd: number;
}

/** The slice of `getUsage()` the budget needs; `OpenAICompatibleModelAdapter` and `RoutingModelAdapter` both satisfy it. */
export type BudgetableModelAdapter = ModelAdapter & { getUsage(): { cost: number; calls: number } };

/**
 * Cost ceiling around any `ModelAdapter` that reports usage. Before each
 * `complete()`, once the inner adapter's accumulated cost has reached
 * `maxCostUsd`, the call is NOT forwarded and an error-shaped `ModelResponse`
 * with code `budget_exceeded` is returned instead (callers already handle
 * error responses; nothing is thrown, nothing sleeps, nothing hits the
 * network). The cap is checked before a call, so the last call may overshoot
 * the limit by its own cost.
 *
 * `getUsage()` is forwarded, and `getRouting()` / `getSamplingConfig()` / `getProviderConfig()` only
 * exist on the wrapper when the inner adapter has them, so `typeof
 * model.getRouting === 'function'` checks keep behaving as without the wrapper.
 */
export class BudgetedModelAdapter<T extends BudgetableModelAdapter = BudgetableModelAdapter> implements ModelAdapter {
  readonly maxCostUsd: number;
  /** Calls refused because the budget was already exhausted. */
  blockedCalls = 0;

  getRouting?: () => ReturnType<RoutingModelAdapter['getRouting']>;
  getSamplingConfig?: () => SamplingConfig;
  getProviderConfig?: () => ProviderRoutingConfig | null;

  constructor(private readonly inner: T, config: BudgetedModelAdapterConfig) {
    if (!Number.isFinite(config.maxCostUsd) || config.maxCostUsd <= 0) {
      throw new Error(`BudgetedModelAdapter requires a positive, finite maxCostUsd (got: ${config.maxCostUsd})`);
    }
    this.maxCostUsd = config.maxCostUsd;

    const routable = inner as unknown as { getRouting?: BudgetedModelAdapter['getRouting'] };
    if (typeof routable.getRouting === 'function') this.getRouting = () => routable.getRouting!();
    const sampled = inner as unknown as { getSamplingConfig?: BudgetedModelAdapter['getSamplingConfig'] };
    if (typeof sampled.getSamplingConfig === 'function') this.getSamplingConfig = () => sampled.getSamplingConfig!();
    const pinned = inner as unknown as { getProviderConfig?: BudgetedModelAdapter['getProviderConfig'] };
    if (typeof pinned.getProviderConfig === 'function') this.getProviderConfig = () => pinned.getProviderConfig!();
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const spent = this.spentUsd();
    if (spent >= this.maxCostUsd) {
      this.blockedCalls += 1;
      return {
        type: 'error',
        code: BUDGET_EXCEEDED_CODE,
        message: `Cost budget exceeded: spent $${spent.toFixed(4)} of $${this.maxCostUsd.toFixed(4)} limit; the model was not called`,
      };
    }
    return this.inner.complete(request);
  }

  getUsage(): ReturnType<T['getUsage']> {
    return this.inner.getUsage() as ReturnType<T['getUsage']>;
  }

  /** True once accumulated cost has reached the limit (the next `complete()` will be refused). */
  isExhausted(): boolean {
    return this.spentUsd() >= this.maxCostUsd;
  }

  /**
   * Whether the provider reports cost at all: `null` before any call,
   * `false` once calls happened but cost is still 0 (the cap cannot work —
   * e.g. a provider without `usage.cost`), `true` otherwise. Informational:
   * it never blocks a run.
   */
  get costReported(): boolean | null {
    const { calls, cost } = this.inner.getUsage();
    if (cost > 0) return true;
    return calls > 0 ? false : null;
  }

  private spentUsd(): number {
    return this.inner.getUsage().cost;
  }
}

import type { ModelRequest, ModelResponse } from '../contracts/core.js';
import type { ModelAdapter } from './model-adapter.js';

export type RouteReason = 'custom' | 'long_context' | 'retry' | 'default';

export interface RouteDecision {
  route: string;
  reason: RouteReason;
}

export interface RouteUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface RouterContext {
  /** Estimated request size in tokens, from `estimateTokens` (or the default heuristic). */
  estimatedTokens: number;
  /** Configured route names, including 'default'. */
  routes: string[];
}

/** Returns a route name to force, or null to fall back to the built-in rules. */
export type CustomRouter = (request: ModelRequest, ctx: RouterContext) => string | null | Promise<string | null>;

export interface RoutingModelAdapterConfig {
  /** Named model adapters this router dispatches to. Must include 'default'. */
  routes: Record<string, ModelAdapter>;
  /** Token estimate above which a request routes to 'longContext' (if configured). Default 60000. */
  longContextThreshold?: number;
  /** Tried before the built-in longContext/retry rules; returning null falls through to them. */
  customRouter?: CustomRouter;
  /** Overrides the default token-count estimate. */
  estimateTokens?: (request: ModelRequest) => number;
}

interface UsageLike {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  modelsUsed?: string[];
}

function hasUsage(adapter: ModelAdapter): adapter is ModelAdapter & { getUsage(): UsageLike } {
  return typeof (adapter as { getUsage?: unknown }).getUsage === 'function';
}

/**
 * Estimate only (no tokenizer): total serialized character length of the
 * request's task/context/instructions/history/feedback, divided by 4.
 */
function defaultEstimateTokens(request: ModelRequest): number {
  const parts = [
    request.task,
    JSON.stringify(request.context),
    request.instructions ?? '',
    JSON.stringify(request.history ?? []),
    request.feedback ?? '',
  ];
  return Math.ceil(parts.reduce((sum, part) => sum + part.length, 0) / 4);
}

/**
 * Routes each request to one of several named `ModelAdapter`s by rule
 * (claude-code-router style), applied identically regardless of caller —
 * no rule may depend on graph node/role, since `ModelRequest` carries none.
 * Precedence: custom router → longContext → retry → default.
 */
export class RoutingModelAdapter implements ModelAdapter {
  private readonly routes: Record<string, ModelAdapter>;
  private readonly longContextThreshold: number;
  private readonly customRouter?: CustomRouter;
  private readonly estimateTokens: (request: ModelRequest) => number;
  private readonly usageByRoute = new Map<string, RouteUsage>();
  private readonly decisions: RouteDecision[] = [];
  private readonly modelsUsed = new Set<string>();

  constructor(config: RoutingModelAdapterConfig) {
    if (!config.routes.default) {
      throw new Error("RoutingModelAdapter requires a 'default' route");
    }
    this.routes = config.routes;
    this.longContextThreshold = config.longContextThreshold ?? 60_000;
    this.customRouter = config.customRouter;
    this.estimateTokens = config.estimateTokens ?? defaultEstimateTokens;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const estimatedTokens = this.estimateTokens(request);
    const decision = await this.decide(request, estimatedTokens);
    this.decisions.push(decision);

    const adapter = this.routes[decision.route];
    const before = hasUsage(adapter) ? adapter.getUsage() : undefined;
    const response = await adapter.complete(request);
    const after = hasUsage(adapter) ? adapter.getUsage() : undefined;
    this.recordUsage(decision.route, before, after);

    return response;
  }

  private async decide(request: ModelRequest, estimatedTokens: number): Promise<RouteDecision> {
    if (this.customRouter) {
      const routeNames = Object.keys(this.routes);
      const chosen = await this.customRouter(request, { estimatedTokens, routes: routeNames });
      if (chosen != null) {
        if (!this.routes[chosen]) {
          throw new Error(`customRouter returned unknown route '${chosen}'. Configured routes: ${routeNames.join(', ')}`);
        }
        return { route: chosen, reason: 'custom' };
      }
    }

    if (this.routes.longContext && estimatedTokens > this.longContextThreshold) {
      return { route: 'longContext', reason: 'long_context' };
    }

    if (this.routes.retry && typeof request.feedback === 'string' && request.feedback.length > 0) {
      return { route: 'retry', reason: 'retry' };
    }

    return { route: 'default', reason: 'default' };
  }

  /**
   * Deltas the route adapter's own cumulative `getUsage()` around this one
   * call, so usage is attributed correctly even when two route names share
   * the same adapter instance. Adapters without `getUsage()` still count
   * towards `calls`, with zeroed token/cost fields.
   */
  private recordUsage(route: string, before: UsageLike | undefined, after: UsageLike | undefined): void {
    const entry = this.usageByRoute.get(route) ?? { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
    entry.calls += 1;
    if (before && after) {
      entry.promptTokens += after.promptTokens - before.promptTokens;
      entry.completionTokens += after.completionTokens - before.completionTokens;
      entry.totalTokens += after.totalTokens - before.totalTokens;
      entry.cost += after.cost - before.cost;
      for (const model of after.modelsUsed ?? []) {
        if (!(before.modelsUsed ?? []).includes(model)) this.modelsUsed.add(model);
      }
    }
    this.usageByRoute.set(route, entry);
  }

  /** Aggregated usage across every route, in the same shape as `GlmModelAdapter.getUsage()`. */
  getUsage(): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    calls: number;
    cost: number;
    modelsUsed: string[];
  } {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let calls = 0;
    let cost = 0;
    for (const usage of this.usageByRoute.values()) {
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
      totalTokens += usage.totalTokens;
      calls += usage.calls;
      cost += usage.cost;
    }
    return { promptTokens, completionTokens, totalTokens, calls, cost, modelsUsed: [...this.modelsUsed] };
  }

  /** Per-route usage plus the ordered route-decision log, for reporting/diagnostics. */
  getRouting(): { byRoute: Record<string, RouteUsage>; decisions: RouteDecision[] } {
    return {
      byRoute: Object.fromEntries(this.usageByRoute),
      decisions: [...this.decisions],
    };
  }
}

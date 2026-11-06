import { appendFileSync } from 'node:fs';
import type { ModelRequest, ModelResponse } from '../contracts/core.js';
import type { ModelAdapter } from './model-adapter.js';
import { truncateMiddle } from './truncate.js';

/** Max chars of a serialized tool result sent back to the model. */
const MAX_TOOL_RESULT_CHARS = 8000;

/** HTTP statuses worth retrying: rate limits and transient server-side failures. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Cap for the exponential backoff delay. */
const MAX_BACKOFF_MS = 30_000;
/** Max chars of a bad response body quoted in an error message. */
const MAX_BODY_SNIPPET_CHARS = 300;
/** Cap for a provider-supplied Retry-After delay. */
const MAX_RETRY_AFTER_MS = 60_000;
/** Max chars of reasoning text kept per line of the reasoning log. */
const MAX_REASONING_LOG_CHARS = 2000;
/** Max chars of a `command` argument quoted in a reasoning log action. */
const MAX_ACTION_COMMAND_CHARS = 200;

export interface OpenAICompatibleAdapterConfig {
  /** API key. Falls back to process.env.MODEL_API_KEY. */
  apiKey?: string;
  /**
   * Base URL of an OpenAI-compatible chat-completions endpoint, e.g.
   * 'https://openrouter.ai/api/v1' or 'https://opencode.ai/zen/go/v1'.
   * Falls back to process.env.MODEL_BASE_URL. There is no provider
   * default: one of the two must be set, or construction fails fast.
   */
  baseUrl?: string;
  /** Model identifier, e.g. 'gpt-4o-mini'. Falls back to process.env.MODEL_ID. */
  model?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** Extra headers merged into every request, for endpoints that need one (e.g. a session/routing header). */
  headers?: Record<string, string>;
  /** Custom user agent identifying this harness. Default 'pi-harness/0.1.0'. */
  userAgent?: string;
  /**
   * Retries after a transient failure (HTTP 429/500/502/503/504, network
   * error or request timeout). Default 3, so up to 4 attempts per call. 0
   * disables retrying.
   */
  maxRetries?: number;
  /** Base of the exponential backoff in ms (doubles each retry, capped at 30s). Default 1000. */
  retryBaseDelayMs?: number;
  /** Injectable sleep for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable [0, 1) random source for backoff jitter. Defaults to Math.random. */
  random?: () => number;
  /** Sampling temperature. Sent as `temperature` only when set; unset leaves the provider default. */
  temperature?: number;
  /** Nucleus sampling mass. Sent as `top_p` only when set. */
  topP?: number;
  /** Sampling seed for best-effort reproducibility. Sent as `seed` only when set. */
  seed?: number;
  /** Max completion tokens. Sent as `max_tokens` only when set. */
  maxTokens?: number;
  /**
   * OpenRouter provider routing. Sent as `provider: { order, allow_fallbacks }`
   * only when set, pinning every call to the listed upstream providers.
   */
  provider?: ProviderRoutingConfig;
  /**
   * JSONL file that receives, after each successful completion, the model's
   * reasoning text (clipped) with a short description of the action it chose.
   * Completions without reasoning text write nothing; write failures are
   * swallowed. Unset (default) logs nothing. Never changes the request body.
   */
  reasoningLogFile?: string;
}

/** OpenRouter provider routing: tried in `order`; with `allowFallbacks` false, no other provider is used. */
export interface ProviderRoutingConfig {
  order: string[];
  allowFallbacks: boolean;
}

/** Effective sampling settings; `null` means unset (provider default, field omitted from requests). */
export interface SamplingConfig {
  temperature: number | null;
  topP: number | null;
  seed: number | null;
  maxTokens: number | null;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  model?: string;
  provider?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
      /** Reasoning text, as returned by OpenRouter for reasoning models. */
      reasoning?: string | null;
      reasoning_details?: Array<{ type?: string; text?: string; summary?: string }>;
    };
  }>;
  error?: { code?: string | number; message?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
}

/** Parses a Retry-After header (delta-seconds or HTTP date) into ms, capped at 60s. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  const seconds = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : NaN;
  const ms = Number.isNaN(seconds) ? Date.parse(trimmed) - Date.now() : seconds * 1000;
  if (Number.isNaN(ms)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}

type ApiError = NonNullable<ChatCompletionResponse['error']>;

/** True when a 200 payload's `error.code` (number or numeric string) is a transient HTTP status. */
function isRetryableApiError(error: ApiError): boolean {
  const code = typeof error.code === 'string' && /^\d+$/.test(error.code.trim()) ? Number(error.code) : error.code;
  return typeof code === 'number' && (RETRYABLE_STATUSES.has(code) || code === 408);
}

const CONTEXT_OVERFLOW_PATTERN =
  /context length|context window|maximum context|too many tokens|context_length_exceeded|prompt is too long/i;

/**
 * True when a provider rejection means the prompt does not fit the model's
 * context window: an HTTP 400/413 whose text names the limit. Permanent, so
 * it is never in RETRYABLE_STATUSES.
 */
function isContextOverflow(status: number, text: string): boolean {
  return (status === 400 || status === 413) && CONTEXT_OVERFLOW_PATTERN.test(text);
}

/** Maps a payload `error` object to a typed error, keeping message and code diagnosable. */
function describeApiError(error: ApiError): Extract<ModelResponse, { type: 'error' }> {
  const message = error.message ?? 'Unknown API error';
  const numericCode = typeof error.code === 'string' && /^\d+$/.test(error.code.trim()) ? Number(error.code) : error.code;
  if (typeof numericCode === 'number' && isContextOverflow(numericCode, message)) {
    return { type: 'error', code: 'context_overflow', message: `${message} (code: ${error.code})` };
  }
  return {
    type: 'error',
    code: String(error.code ?? 'api_error'),
    message: error.code === undefined ? message : `${message} (code: ${error.code})`,
  };
}

/** Reasoning text of a completion: `message.reasoning`, else the joined `reasoning_details` texts/summaries. */
function extractReasoning(message: NonNullable<NonNullable<ChatCompletionResponse['choices']>[number]['message']> | undefined): string {
  if (!message) return '';
  if (typeof message.reasoning === 'string' && message.reasoning.trim() !== '') return message.reasoning;
  if (!Array.isArray(message.reasoning_details)) return '';
  return message.reasoning_details
    .map((d) => d?.text ?? d?.summary ?? '')
    .filter((t) => typeof t === 'string' && t.trim() !== '')
    .join('\n');
}

/** Short description of what the model returned, for the reasoning log. */
function describeAction(response: ModelResponse): string {
  if (response.type === 'finish') return 'finish';
  if (response.type === 'error') return `error ${response.code}`;
  const { path, name, command } = response.args;
  const detail =
    typeof path === 'string' ? path
    : typeof name === 'string' ? name
    : typeof command === 'string' ? command.slice(0, MAX_ACTION_COMMAND_CHARS)
    : '';
  return detail === '' ? `tool_call ${response.tool}` : `tool_call ${response.tool} ${detail}`;
}

/**
 * OpenAI-compatible chat-completions adapter. The only harness component
 * that knows how to talk to a provider; swapping providers means pointing
 * this class at a different `baseUrl`/`model`, never swapping the class.
 */
export class OpenAICompatibleModelAdapter implements ModelAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly sampling: SamplingConfig;
  private readonly provider: ProviderRoutingConfig | null;
  private readonly reasoningLogFile: string | null;
  private retries = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private cost = 0;
  private calls = 0;
  private modelsUsed = new Set<string>();
  private providersUsed = new Map<string, number>();

  constructor(config: OpenAICompatibleAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.MODEL_API_KEY ?? '';
    const baseUrl = config.baseUrl ?? process.env.MODEL_BASE_URL ?? '';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = config.model ?? process.env.MODEL_ID ?? '';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.headers = config.headers ?? {};
    this.userAgent = config.userAgent ?? 'pi-harness/0.1.0';
    this.maxRetries = Math.max(0, Math.floor(config.maxRetries ?? 3));
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = config.random ?? Math.random;
    this.sampling = {
      temperature: config.temperature ?? null,
      topP: config.topP ?? null,
      seed: config.seed ?? null,
      maxTokens: config.maxTokens ?? null,
    };
    this.provider = config.provider
      ? { order: [...config.provider.order], allowFallbacks: config.provider.allowFallbacks }
      : null;
    this.reasoningLogFile = config.reasoningLogFile ?? null;

    if (this.apiKey === '') {
      throw new Error('MODEL_API_KEY is not set. Export it before constructing OpenAICompatibleModelAdapter.');
    }
    if (this.model === '') {
      throw new Error('MODEL_ID is not set. Export it (e.g. MODEL_ID=gpt-4o-mini) before constructing OpenAICompatibleModelAdapter.');
    }
    if (this.baseUrl === '') {
      throw new Error(
        'MODEL_BASE_URL is not set. Export it (e.g. MODEL_BASE_URL=https://api.openai.com/v1) or pass baseUrl before constructing OpenAICompatibleModelAdapter.',
      );
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    const body = {
      model: this.model,
      messages: this.buildMessages(request),
      tools: request.availTools.length > 0 ? this.buildTools(request) : undefined,
      ...(this.sampling.temperature !== null && { temperature: this.sampling.temperature }),
      ...(this.sampling.topP !== null && { top_p: this.sampling.topP }),
      ...(this.sampling.seed !== null && { seed: this.sampling.seed }),
      ...(this.sampling.maxTokens !== null && { max_tokens: this.sampling.maxTokens }),
      ...(this.provider !== null && {
        provider: { order: this.provider.order, allow_fallbacks: this.provider.allowFallbacks },
      }),
    };

    const fetched = await this.fetchWithRetry(body);
    if (fetched.type === 'error') return fetched;
    const payload = fetched.payload;

    if (payload.model) {
      this.modelsUsed.add(payload.model);
    }
    if (payload.provider) {
      this.providersUsed.set(payload.provider, (this.providersUsed.get(payload.provider) ?? 0) + 1);
    }

    if (payload.usage) {
      this.promptTokens += payload.usage.prompt_tokens ?? 0;
      this.completionTokens += payload.usage.completion_tokens ?? 0;
      this.cost += payload.usage.cost ?? 0;
    }

    const result = this.interpretPayload(payload);
    this.logReasoning(payload, result);
    return result;
  }

  /** Maps a parsed 2xx payload to a ModelResponse. Usage accounting happens before, in complete(). */
  private interpretPayload(payload: ChatCompletionResponse): ModelResponse {
    if (payload.error) return describeApiError(payload.error);

    // A cut-off or blocked completion is never a valid answer or tool call.
    // Checked after usage accounting: the tokens were spent either way.
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (finishReason === 'length') {
      return {
        type: 'error',
        code: 'output_truncated',
        message: 'Model output truncated (finish_reason: length)',
      };
    }
    if (finishReason === 'content_filter') {
      return {
        type: 'error',
        code: 'content_filtered',
        message: 'Model output blocked by content filter (finish_reason: content_filter)',
      };
    }

    const message = payload.choices?.[0]?.message;
    if (!message) {
      return { type: 'error', code: 'empty_response', message: 'No choice in the API response' };
    }

    const toolCall = message.tool_calls?.[0];
    if (toolCall) {
      try {
        const args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
        return { type: 'tool_call', tool: toolCall.function.name, args };
      } catch {
        return {
          type: 'error',
          code: 'invalid_tool_arguments',
          message: `Tool '${toolCall.function.name}' returned non-JSON arguments`,
        };
      }
    }

    if (typeof message.content === 'string' && message.content !== '') {
      return { type: 'finish', content: message.content };
    }

    return { type: 'error', code: 'empty_content', message: 'The model returned neither content nor a tool call' };
  }

  /** Appends one JSONL line with the clipped reasoning and the chosen action; never throws. */
  private logReasoning(payload: ChatCompletionResponse, result: ModelResponse): void {
    if (this.reasoningLogFile === null) return;
    try {
      const reasoning = extractReasoning(payload.choices?.[0]?.message);
      if (reasoning === '') return;
      const clipped = reasoning.length > MAX_REASONING_LOG_CHARS ? `${reasoning.slice(0, MAX_REASONING_LOG_CHARS)}…` : reasoning;
      const line = {
        at: new Date().toISOString(),
        model: payload.model ?? this.model,
        ...(payload.provider && { provider: payload.provider }),
        reasoningChars: reasoning.length,
        reasoning: clipped,
        action: describeAction(result),
      };
      appendFileSync(this.reasoningLogFile, `${JSON.stringify(line)}\n`);
    } catch {
      // Observability only: a failed write must never break the model call.
    }
  }

  /**
   * POSTs the request, retrying transient failures (see RETRYABLE_STATUSES,
   * network errors and timeouts) with exponential backoff and jitter.
   * A 2xx response whose body cannot be read, is empty or is not JSON is
   * transient too (proxy error pages, connection resets mid-body, timeouts
   * while streaming) and retried under the same policy. Failed attempts carry
   * no usage, so nothing is accumulated for them. Any other non-2xx status is
   * returned immediately; a parsed 2xx payload is handed back for semantic
   * validation, which is never retried. The exception is a 2xx JSON payload
   * whose `error.code` is a retryable status (or 408): that is a transient
   * upstream failure and retried too.
   */
  private async fetchWithRetry(
    body: unknown,
  ): Promise<{ type: 'payload'; payload: ChatCompletionResponse } | Extract<ModelResponse, { type: 'error' }>> {
    const serialized = JSON.stringify(body);
    for (let attempt = 1; ; attempt += 1) {
      let failure: Extract<ModelResponse, { type: 'error' }>;
      let retryAfterMs: number | undefined;

      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            ...this.headers,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': this.userAgent,
          },
          body: serialized,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) {
          const parsed = await this.readJsonBody(response);
          if (parsed.type === 'payload') {
            // A 200 wrapping a transient upstream error (e.g. OpenRouter) is retried like the HTTP status would be.
            const apiError = parsed.payload.error;
            if (!apiError || !isRetryableApiError(apiError)) return parsed;
            failure = describeApiError(apiError);
          } else {
            failure = parsed;
          }
        } else {
          const text = await response.text().catch(() => '');
          failure = isContextOverflow(response.status, text)
            ? { type: 'error', code: 'context_overflow', message: text.slice(0, 2000) }
            : { type: 'error', code: `http_${response.status}`, message: text.slice(0, 2000) };
          if (!RETRYABLE_STATUSES.has(response.status)) return failure;
          retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        }
      } catch (err) {
        // fetch only rejects on network failures and aborts (incl. timeout).
        failure = {
          type: 'error',
          code: 'network_error',
          message: err instanceof Error ? err.message : String(err),
        };
      }

      if (attempt > this.maxRetries) {
        return attempt > 1 ? { ...failure, message: `${failure.message} (after ${attempt} attempts)` } : failure;
      }

      this.retries += 1;
      await this.sleep(retryAfterMs ?? this.backoffDelay(attempt));
    }
  }

  /**
   * Reads a 2xx body as text and parses it. Read failures (including an abort
   * while streaming) and empty/non-JSON bodies come back as retryable errors
   * whose message carries enough context to diagnose them afterwards: the
   * underlying error, status, content-type, body length and a short snippet.
   * Request headers (the API key) are never included.
   */
  private async readJsonBody(
    response: Response,
  ): Promise<{ type: 'payload'; payload: ChatCompletionResponse } | Extract<ModelResponse, { type: 'error' }>> {
    const contentType = response.headers.get('content-type') ?? 'none';
    // Single line, control chars collapsed: the parse error itself may quote the raw body.
    // eslint-disable-next-line no-control-regex
    const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
    const describe = (reason: string, text?: string): string => {
      const parts = [oneLine(reason), `status ${response.status}`, `content-type ${contentType}`];
      if (text !== undefined) {
        parts.push(`body length ${text.length}`);
        parts.push(`body: ${oneLine(text).slice(0, MAX_BODY_SNIPPET_CHARS)}`);
      }
      return parts.join('; ');
    };

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { type: 'error', code: 'body_read_error', message: describe(`Failed to read response body: ${reason}`) };
    }

    if (text.trim() === '') {
      return { type: 'error', code: 'invalid_json', message: describe('The endpoint returned an empty body', text) };
    }
    try {
      return { type: 'payload', payload: JSON.parse(text) as ChatCompletionResponse };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        type: 'error',
        code: 'invalid_json',
        message: describe(`The endpoint returned non-JSON content (${reason})`, text),
      };
    }
  }

  /** Exponential backoff (base * 2^(attempt-1), capped) with jitter in [50%, 100%]. */
  private backoffDelay(attempt: number): number {
    const exponential = Math.min(MAX_BACKOFF_MS, this.retryBaseDelayMs * 2 ** (attempt - 1));
    return Math.round(exponential * (0.5 + this.random() * 0.5));
  }

  /** Maps a ModelRequest to chat messages, including fed-back tool results. */
  private buildMessages(request: ModelRequest): ChatMessage[] {
    const messages: ChatMessage[] = [];

    const systemParts: string[] = [];
    for (const file of request.context.contextFiles ?? []) {
      const note = file.truncated ? '\n\n[truncated: the file is longer than the size limit]' : '';
      systemParts.push(`Project instructions (from ${file.path}):\n${file.content}${note}`);
    }
    if (request.instructions) systemParts.push(request.instructions);
    if (request.availTools.length > 0) {
      const toolList = request.availTools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join('\n');
      systemParts.push(`Available tools:\n${toolList}`);
    }
    if (request.context.skills && request.context.skills.length > 0) {
      const skillList = request.context.skills
        .map((s) => `- ${s.name}: ${s.description}`)
        .join('\n');
      systemParts.push(
        `Available skills:\n${skillList}\n\nCall load_skill with the skill name before doing work a skill covers.`,
      );
    }
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    }

    const contextLines = [
      `Workspace root: ${request.context.projectRoot}`,
      `Language: ${request.context.language ?? 'unknown'}`,
      `Files (${request.context.files.length}):`,
      ...request.context.files.slice(0, 200).map((f) => `- ${f}`),
    ];
    messages.push({
      role: 'user',
      content:
        `${request.task}\n\nProject context:\n${contextLines.join('\n')}` +
        (request.feedback ? `\n\n[feedback from previous failed attempt]\n${request.feedback}` : ''),
    });

    for (const entry of request.history ?? []) {
      if (entry.type === 'tool_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${entry.tool}`,
              type: 'function',
              function: { name: entry.tool, arguments: JSON.stringify(entry.args) },
            },
          ],
        });
      } else if (entry.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: `call_${entry.tool}`,
          content: truncateMiddle(JSON.stringify(entry.result), MAX_TOOL_RESULT_CHARS),
        });
      } else if (entry.type === 'finish') {
        messages.push({ role: 'assistant', content: entry.content });
      } else {
        messages.push({ role: 'assistant', content: `Error: ${entry.code} — ${entry.message}` });
      }
    }

    if (request.nudge) messages.push({ role: 'user', content: request.nudge });

    return messages;
  }

  /** Effective sampling settings (null = unset), for recording in run reports. */
  getSamplingConfig(): SamplingConfig {
    return { ...this.sampling };
  }

  /** Effective provider routing (null = unset, field omitted from requests), for recording in run reports. */
  getProviderConfig(): ProviderRoutingConfig | null {
    return this.provider && { order: [...this.provider.order], allowFallbacks: this.provider.allowFallbacks };
  }

  getUsage(): {
    modelsUsed: string[];
    cost: number;
    calls: number;
    /** Attempts repeated after a transient failure; not part of `calls`. */
    retries: number;
    promptTokens: number;
    totalTokens: number;
    completionTokens: number;
    /** Upstream provider names returned in responses (`payload.provider`), with how many responses each served. */
    providersUsed: Record<string, number>;
  } {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      calls: this.calls,
      retries: this.retries,
      cost: this.cost,
      modelsUsed: [...this.modelsUsed],
      providersUsed: Object.fromEntries(this.providersUsed),
    };
  }

  private buildTools(request: ModelRequest): Array<Record<string, unknown>> {
    return request.availTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
}

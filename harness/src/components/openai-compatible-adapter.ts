import type { ModelRequest, ModelResponse } from '../contracts/core.js';
import type { ModelAdapter } from './model-adapter.js';

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
  private promptTokens = 0;
  private completionTokens = 0;
  private cost = 0;
  private calls = 0;
  private modelsUsed = new Set<string>();

  constructor(config: OpenAICompatibleAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.MODEL_API_KEY ?? '';
    const baseUrl = config.baseUrl ?? process.env.MODEL_BASE_URL ?? '';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = config.model ?? process.env.MODEL_ID ?? '';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.headers = config.headers ?? {};
    this.userAgent = config.userAgent ?? 'pi-harness/0.1.0';

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
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': this.userAgent,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return {
        type: 'error',
        code: 'network_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        type: 'error',
        code: `http_${response.status}`,
        message: text.slice(0, 2000),
      };
    }

    let payload: ChatCompletionResponse;
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch {
      return { type: 'error', code: 'invalid_json', message: 'The endpoint returned non-JSON content' };
    }

    if (payload.model) {
      this.modelsUsed.add(payload.model);
    }

    if (payload.usage) {
      this.promptTokens += payload.usage.prompt_tokens ?? 0;
      this.completionTokens += payload.usage.completion_tokens ?? 0;
      this.cost += payload.usage.cost ?? 0;
    }

    if (payload.error) {
      return {
        type: 'error',
        code: String(payload.error.code ?? 'api_error'),
        message: payload.error.message ?? 'Unknown API error',
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

  /** Maps a ModelRequest to chat messages, including fed-back tool results. */
  private buildMessages(request: ModelRequest): ChatMessage[] {
    const messages: ChatMessage[] = [];

    const systemParts: string[] = [];
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
          content: JSON.stringify(entry.result).slice(0, 8000),
        });
      } else if (entry.type === 'finish') {
        messages.push({ role: 'assistant', content: entry.content });
      } else {
        messages.push({ role: 'assistant', content: `Error: ${entry.code} — ${entry.message}` });
      }
    }

    return messages;
  }

  getUsage(): {
    modelsUsed: string[];
    cost: number;
    calls: number;
    promptTokens: number;
    totalTokens: number;
    completionTokens: number
  } {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      calls: this.calls,
      cost: this.cost,
      modelsUsed: [...this.modelsUsed],
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

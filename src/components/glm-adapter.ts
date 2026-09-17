import type { ModelRequest, ModelResponse } from '../contracts/core.js';
import type { ModelAdapter } from './model-adapter.js';

/**
 * Default endpoint: OpenCode Go (https://opencode.ai/docs/go/), the
 * provider this experiment accesses GLM through. Override with
 * MODEL_BASE_URL for any other OpenAI-compatible endpoint.
 */
export const DEFAULT_GLM_BASE_URL = 'https://opencode.ai/zen/go/v1';

export interface GlmAdapterConfig {
  /** API key. Falls back to process.env.MODEL_API_KEY. */
  apiKey?: string;
  /** Base URL. Falls back to process.env.MODEL_BASE_URL, then OpenCode Go. */
  baseUrl?: string;
  /** Model identifier, e.g. 'glm-5.2'. Falls back to process.env.MODEL_ID. */
  model?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /**
   * Stable per-conversation session id, sent as x-opencode-session.
   * OpenCode Go requires it for routing and prompt caching.
   */
  sessionId?: string;
  /** Custom user agent identifying this harness. OpenCode Go requires it. */
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
}

/**
 * OpenAI-compatible chat-completions adapter (OpenCode Go by default).
 * The only harness component that knows how to talk to a provider;
 * swapping providers means swapping or reconfiguring this class.
 */
export class GlmModelAdapter implements ModelAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sessionId?: string;
  private readonly userAgent: string;

  constructor(config: GlmAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.MODEL_API_KEY ?? '';
    this.baseUrl = (config.baseUrl ?? process.env.MODEL_BASE_URL ?? DEFAULT_GLM_BASE_URL).replace(/\/$/, '');
    this.model = config.model ?? process.env.MODEL_ID ?? '';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.sessionId = config.sessionId;
    this.userAgent = config.userAgent ?? 'harness-glm/0.1.0';

    if (this.apiKey === '') {
      throw new Error('MODEL_API_KEY is not set. Export it before constructing GlmModelAdapter.');
    }
    if (this.model === '') {
      throw new Error('MODEL_ID is not set. Export it (e.g. MODEL_ID=glm-5.2) before constructing GlmModelAdapter.');
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
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
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': this.userAgent,
          ...(this.sessionId ? { 'x-opencode-session': this.sessionId } : {}),
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

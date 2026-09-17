import type { ModelRequest, ModelResponse } from '../contracts/core.js';
import type { ModelAdapter } from './model-adapter.js';

/** Where to reach the OpenAI-compatible endpoint of Z.ai. */
export const DEFAULT_GLM_BASE_URL = 'https://api.z.ai/api/paas/v4';

export interface GlmAdapterConfig {
  /** API key. Falls back to process.env.GLM_API_KEY. */
  apiKey?: string;
  /** Base URL. Falls back to process.env.GLM_BASE_URL, then the Z.ai default. */
  baseUrl?: string;
  /** Model identifier, e.g. 'glm-4.7'. Falls back to process.env.GLM_MODEL. */
  model?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Default 120_000. */
  timeoutMs?: number;
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
 * Real model adapter for GLM (Z.ai) against its OpenAI-compatible
 * chat completions endpoint. Everything the harness knows about GLM
 * lives here and only here — swapping models means swapping this
 * adapter, per the harness/model contract.
 */
export class GlmModelAdapter implements ModelAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: GlmAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.GLM_API_KEY ?? '';
    this.baseUrl = (config.baseUrl ?? process.env.GLM_BASE_URL ?? DEFAULT_GLM_BASE_URL).replace(/\/$/, '');
    this.model = config.model ?? process.env.GLM_MODEL ?? '';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 120_000;

    if (this.apiKey === '') {
      throw new Error('GLM_API_KEY is not set. Export it before constructing GlmModelAdapter.');
    }
    if (this.model === '') {
      throw new Error('GLM_MODEL is not set. Export it (e.g. GLM_MODEL=glm-4.7) before constructing GlmModelAdapter.');
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
      content: `${request.task}\n\nProject context:\n${contextLines.join('\n')}`,
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

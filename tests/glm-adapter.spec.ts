import { describe, it, expect, vi, afterEach } from 'vitest';
import { GlmModelAdapter } from '../src/components/glm-adapter.js';
import type { Context, ModelRequest, ToolSpec } from '../src/contracts/core.js';

const TOOLS: ToolSpec[] = [
  {
    name: 'write_file',
    description: 'Write a text file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

function request(history: ModelRequest['history'] = []): ModelRequest {
  const context: Context = { projectRoot: '/tmp/ws', files: ['a.txt'], language: 'typescript' };
  return { task: 'do something', context, availTools: TOOLS, instructions: 'Be brief.', history };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ENV_BACKUP = { ...process.env };

afterEach(() => {
  process.env = { ...ENV_BACKUP };
  vi.restoreAllMocks();
});

describe('GlmModelAdapter', () => {
  it('throws a clear error when MODEL_API_KEY is missing', () => {
    delete process.env.MODEL_API_KEY;
    process.env.MODEL_ID = 'glm-4.7';
    expect(() => new GlmModelAdapter()).toThrow(/MODEL_API_KEY/);
  });

  it('throws a clear error when MODEL_ID is missing', () => {
    process.env.MODEL_API_KEY = 'test-key';
    delete process.env.MODEL_ID;
    expect(() => new GlmModelAdapter()).toThrow(/MODEL_ID/);
  });

  it('maps a tool_calls response to a tool_call ModelResponse', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'glm-4.7';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path":"x.txt","content":"hi"}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const adapter = new GlmModelAdapter({
      sessionId: 'session-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await adapter.complete(request());

    expect(response).toEqual({
      type: 'tool_call',
      tool: 'write_file',
      args: { path: 'x.txt', content: 'hi' },
    });
    // Request shape: OpenAI-compatible body against the OpenCode Go endpoint.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['x-opencode-session']).toBe('session-1');
    expect(headers['User-Agent']).toBe('harness-glm/0.1.0');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('glm-4.7');
    expect(body.tools[0].function.name).toBe('write_file');
  });

  it('maps a content response to a finish ModelResponse', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'glm-4.7';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'All done.' } }],
      }),
    );
    const adapter = new GlmModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await adapter.complete(request());

    expect(response).toEqual({ type: 'finish', content: 'All done.' });
  });

  it('works unchanged against any OpenAI-compatible endpoint (e.g., OpenAI)', async () => {
    process.env.MODEL_API_KEY = 'openai-key';
    process.env.MODEL_ID = 'gpt-5.6-luna';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      }),
    );
    const adapter = new GlmModelAdapter({
      baseUrl: 'https://api.openai.com/v1',
      sessionId: 'session-openai',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await adapter.complete(request());

    // Same request shape, different provider: only the base URL and model change.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.tools[0].type).toBe('function');
    expect(response).toEqual({ type: 'finish', content: 'ok' });
  });

  it('maps HTTP errors to an error ModelResponse', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'glm-4.7';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { code: 401, message: 'Invalid API key' } }),
    );
    const adapter = new GlmModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await adapter.complete(request());

    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.code).toBe('http_401');
      expect(response.message).toContain('Invalid API key');
    }
  });

  it('maps network failures to an error ModelResponse', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'glm-4.7';
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const adapter = new GlmModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await adapter.complete(request());

    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.code).toBe('network_error');
      expect(response.message).toContain('ECONNREFUSED');
    }
  });

  it('accumulates usage across multiple complete() calls', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'glm-4.7';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'First.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Second.' } }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
      );
    const adapter = new GlmModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await adapter.complete(request());
    await adapter.complete(request());

    expect(adapter.getUsage()).toEqual({
      promptTokens: 30,
      completionTokens: 13,
      totalTokens: 43,
      calls: 2,
    });
  });

  it('counts a call and contributes zeros when usage is absent', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'glm-4.7';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'No usage.' } }],
      }),
    );
    const adapter = new GlmModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await adapter.complete(request());

    expect(adapter.getUsage()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      calls: 1,
    });
  });

  it('feeds history back as assistant tool_calls plus tool-role messages', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'glm-4.7';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      }),
    );
    const adapter = new GlmModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await adapter.complete(
      request([
        { type: 'tool_call', tool: 'write_file', args: { path: 'x.txt', content: 'hi' } },
        { type: 'tool_result', tool: 'write_file', success: true, result: { bytes: 2 } },
      ]),
    );

    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    const roles = body.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(body.messages[2].tool_calls[0].function.name).toBe('write_file');
    expect(body.messages[3].tool_call_id).toBe('call_write_file');
  });
});

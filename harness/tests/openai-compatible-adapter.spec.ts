import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatibleModelAdapter } from '../src/components/openai-compatible-adapter.js';
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

describe('OpenAICompatibleModelAdapter', () => {
  it('throws a clear error when MODEL_API_KEY is missing', () => {
    delete process.env.MODEL_API_KEY;
    process.env.MODEL_ID = 'test-model';
    expect(() => new OpenAICompatibleModelAdapter()).toThrow(/MODEL_API_KEY/);
  });

  it('throws a clear error when MODEL_ID is missing', () => {
    process.env.MODEL_API_KEY = 'test-key';
    delete process.env.MODEL_ID;
    expect(() => new OpenAICompatibleModelAdapter()).toThrow(/MODEL_ID/);
  });

  it('throws a clear error when MODEL_BASE_URL is missing and no baseUrl is given', () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    delete process.env.MODEL_BASE_URL;
    expect(() => new OpenAICompatibleModelAdapter()).toThrow(/MODEL_BASE_URL/);
  });

  it('maps a tool_calls response to a tool_call ModelResponse', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_123',
                        type: 'function',
                        function: {
                          name: 'write_file',
                          arguments: JSON.stringify({
                            path: 'test.txt',
                            content: 'hello',
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
        ),
    );

    const adapter = new OpenAICompatibleModelAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test/v1',
      model: 'test-model',
      fetchImpl,
    });

    const result = await adapter.complete(request());

    expect(result).toEqual({
      type: 'tool_call',
      tool: 'write_file',
      args: {
        path: 'test.txt',
        content: 'hello',
      },
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(
        'https://api.example.test/v1/chat/completions',
    );

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBe('pi-harness/0.1.0');

    const body = JSON.parse(String(init.body));

    expect(body.model).toBe('test-model');
    expect(body.messages).toBeDefined();
    expect(body.tools).toBeDefined();
  });

  it('merges a configured headers object into every request, without dropping the built-in ones', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      }),
    );

    const adapter = new OpenAICompatibleModelAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test/v1',
      model: 'test-model',
      userAgent: 'custom-agent/1.0.0',
      headers: { 'x-custom-routing': 'session-123' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await adapter.complete(request());

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-custom-routing']).toBe('session-123');
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['User-Agent']).toBe('custom-agent/1.0.0');
  });

  it('maps a content response to a finish ModelResponse', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'All done.' } }],
      }),
    );
    const adapter = new OpenAICompatibleModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

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
    const adapter = new OpenAICompatibleModelAdapter({
      baseUrl: 'https://api.openai.com/v1',
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
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { code: 401, message: 'Invalid API key' } }),
    );
    const adapter = new OpenAICompatibleModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await adapter.complete(request());

    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.code).toBe('http_401');
      expect(response.message).toContain('Invalid API key');
    }
  });

  it('maps network failures to an error ModelResponse', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const adapter = new OpenAICompatibleModelAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });

    const response = await adapter.complete(request());

    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.code).toBe('network_error');
      expect(response.message).toContain('ECONNREFUSED');
    }
  });

  it('accumulates usage across multiple complete() calls', async () => {
    const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: 'first response',
                      },
                    },
                  ],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                    cost: 0.000001,
                  },
                }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
            ),
        )
        .mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: 'second response',
                      },
                    },
                  ],
                  usage: {
                    prompt_tokens: 20,
                    completion_tokens: 8,
                    total_tokens: 28,
                    cost: 0.000002,
                  },
                }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

    const adapter = new OpenAICompatibleModelAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://test.example/v1',
      model: 'test-model',
      fetchImpl,
    });

    await adapter.complete(request());
    await adapter.complete(request());

    expect(adapter.getUsage()).toEqual({
      promptTokens: 30,
      completionTokens: 13,
      totalTokens: 43,
      calls: 2,
      retries: 0,
      cost: 0.000003,
      modelsUsed: [],
      providersUsed: {},
    });
  });

  it('counts a call and contributes zeros when usage is absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'response without usage',
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
        ),
    );

    const adapter = new OpenAICompatibleModelAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://test.example/v1',
      model: 'test-model',
      fetchImpl,
    });

    const result = await adapter.complete(request());

    expect(result).toEqual({
      type: 'finish',
      content: 'response without usage',
    });

    expect(adapter.getUsage()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      calls: 1,
      retries: 0,
      cost: 0,
      modelsUsed: [],
      providersUsed: {},
    });
  });

  it('feeds history back as assistant tool_calls plus tool-role messages', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      }),
    );
    const adapter = new OpenAICompatibleModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

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

  it('keeps the tail of a long tool result so trailing errors reach the model', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      }),
    );
    const adapter = new OpenAICompatibleModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const stdout = 'BUILD START\n' + 'noise line\n'.repeat(5000) + 'error TS2322: final failure';

    await adapter.complete(
      request([
        { type: 'tool_call', tool: 'write_file', args: { path: 'x.txt' } },
        { type: 'tool_result', tool: 'write_file', success: false, result: { exitCode: 2, stdout } },
      ]),
    );

    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    const content: string = body.messages[3].content;
    expect(content.length).toBeLessThanOrEqual(8000);
    expect(content).toContain('BUILD START');
    expect(content).toContain('error TS2322: final failure');
    expect(content).toMatch(/\[truncated \d+ chars\]/);
  });

  it('returns invalid_tool_arguments when a tool call has malformed JSON arguments', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';

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
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"test.txt",',
                    },
                  },
                ],
              },
            },
          ],
        }),
    );

    const adapter = new OpenAICompatibleModelAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await adapter.complete(request());

    expect(response).toEqual({
      type: 'error',
      code: 'invalid_tool_arguments',
      message: "Tool 'write_file' returned non-JSON arguments",
    });
  });

  it('returns empty_response when the API returns no choices', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';

    const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          choices: [],
        }),
    );

    const adapter = new OpenAICompatibleModelAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await adapter.complete(request());

    expect(response).toEqual({
      type: 'error',
      code: 'empty_response',
      message: 'No choice in the API response',
    });
  });

  it('returns empty_content when the model returns neither content nor tool calls', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';

    const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: null,
              },
            },
          ],
        }),
    );

    const adapter = new OpenAICompatibleModelAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await adapter.complete(request());

    expect(response).toEqual({
      type: 'error',
      code: 'empty_content',
      message: 'The model returned neither content nor a tool call',
    });
  });

  describe('non-clean finish_reason', () => {
    function adapterFor(body: unknown): OpenAICompatibleModelAdapter {
      process.env.MODEL_API_KEY = 'test-key';
      process.env.MODEL_ID = 'test-model';
      process.env.MODEL_BASE_URL = 'https://test.example/v1';
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
      return new OpenAICompatibleModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });
    }

    const USAGE = { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 };

    it('returns an error instead of a finish when finish_reason is length', async () => {
      const adapter = adapterFor({
        choices: [
          { finish_reason: 'length', message: { role: 'assistant', content: 'The answer is cut o' } },
        ],
        usage: USAGE,
      });

      const response = await adapter.complete(request());

      expect(response).toEqual({
        type: 'error',
        code: 'output_truncated',
        message: 'Model output truncated (finish_reason: length)',
      });
    });

    it('does not return a tool_call when finish_reason is length', async () => {
      const adapter = adapterFor({
        choices: [
          {
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path": "a.t' },
                },
              ],
            },
          },
        ],
        usage: USAGE,
      });

      const response = await adapter.complete(request());

      expect(response).toEqual({
        type: 'error',
        code: 'output_truncated',
        message: 'Model output truncated (finish_reason: length)',
      });
    });

    it('does not return a complete tool_call when finish_reason is length', async () => {
      const adapter = adapterFor({
        choices: [
          {
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path": "a.txt"}' },
                },
              ],
            },
          },
        ],
      });

      const response = await adapter.complete(request());

      expect(response.type).toBe('error');
    });

    it('returns an error when finish_reason is content_filter', async () => {
      const adapter = adapterFor({
        choices: [
          { finish_reason: 'content_filter', message: { role: 'assistant', content: 'partial' } },
        ],
      });

      const response = await adapter.complete(request());

      expect(response).toEqual({
        type: 'error',
        code: 'content_filtered',
        message: 'Model output blocked by content filter (finish_reason: content_filter)',
      });
    });

    it('still accumulates usage for a truncated call', async () => {
      const adapter = adapterFor({
        choices: [
          { finish_reason: 'length', message: { role: 'assistant', content: 'cut o' } },
        ],
        usage: USAGE,
      });

      await adapter.complete(request());

      expect(adapter.getUsage()).toMatchObject({
        calls: 1,
        promptTokens: 10,
        completionTokens: 4096,
        totalTokens: 4106,
      });
    });

    it.each(['stop', 'tool_calls', 'function_call'])(
      'keeps normal behavior for finish_reason %s',
      async (finishReason) => {
        const adapter = adapterFor({
          choices: [
            { finish_reason: finishReason, message: { role: 'assistant', content: 'done' } },
          ],
        });

        expect(await adapter.complete(request())).toEqual({ type: 'finish', content: 'done' });
      },
    );
  });

  it('reconstructs multiple tool-call/tool-result history entries correctly', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';

    const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Task completed.',
              },
            },
          ],
        }),
    );

    const adapter = new OpenAICompatibleModelAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const testRequest = request([
      {
        type: 'tool_call',
        tool: 'read_file',
        args: {
          path: 'src/index.ts',
        },
      },
      {
        type: 'tool_result',
        tool: 'read_file',
        success: true,
        result: {
          content: 'console.log("hello");',
        },
      },
      {
        type: 'tool_call',
        tool: 'write_file',
        args: {
          path: 'src/index.ts',
          content: 'console.log("hello world");',
        },
      },
      {
        type: 'tool_result',
        tool: 'write_file',
        success: true,
        result: {
          ok: true,
        },
      },
    ]);

    const response = await adapter.complete(testRequest);

    expect(response).toEqual({
      type: 'finish',
      content: 'Task completed.',
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    const messages = body.messages;

    const toolCalls = messages.filter(
        (message: { role: string }) => message.role === 'assistant',
    );

    const toolResults = messages.filter(
        (message: { role: string }) => message.role === 'tool',
    );

    expect(toolCalls).toHaveLength(2);
    expect(toolResults).toHaveLength(2);

    expect(toolCalls[0].tool_calls[0].function.name).toBe('read_file');
    expect(toolCalls[1].tool_calls[0].function.name).toBe('write_file');

    expect(toolResults[0].tool_call_id).toBe('call_read_file');
    expect(toolResults[1].tool_call_id).toBe('call_write_file');
  });

  it('includes previous-attempt feedback in the user message', async () => {
    process.env.MODEL_API_KEY = 'test-key';
    process.env.MODEL_ID = 'test-model';
    process.env.MODEL_BASE_URL = 'https://test.example/v1';

    const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'I will fix it.',
              },
            },
          ],
        }),
    );

    const adapter = new OpenAICompatibleModelAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await adapter.complete({
      task: 'Fix the failing endpoint.',
      context: {
        projectRoot: '/tmp/ws',
        files: ['src/index.ts'],
        language: 'typescript',
      },
      availTools: TOOLS,
      instructions: 'Be brief.',
      history: [],
      feedback: 'The test failed: expected status 200 but received 500.',
    });

    expect(response).toEqual({
      type: 'finish',
      content: 'I will fix it.',
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    const userMessage = body.messages.find(
        (message: { role: string }) => message.role === 'user',
    );

    expect(userMessage).toBeDefined();

    expect(userMessage.content).toContain(
        '[feedback from previous failed attempt]',
    );

    expect(userMessage.content).toContain(
        'expected status 200 but received 500',
    );
  });

  describe('retry policy', () => {
    const OK_BODY = {
      model: 'm-1',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'fine' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    };

    function retryAdapter(
      fetchImpl: ReturnType<typeof vi.fn>,
      extra: { maxRetries?: number; random?: () => number } = {},
    ) {
      const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
      const adapter = new OpenAICompatibleModelAdapter({
        apiKey: 'test-key',
        baseUrl: 'https://test.example/v1',
        model: 'test-model',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep,
        random: extra.random ?? (() => 0.5),
        ...(extra.maxRetries !== undefined ? { maxRetries: extra.maxRetries } : {}),
      });
      return { adapter, sleep };
    }

    it('retries a 429 and succeeds, reporting one retry', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'slow down' } }))
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const { adapter, sleep } = retryAdapter(fetchImpl);

      const result = await adapter.complete(request());

      expect(result).toEqual({ type: 'finish', content: 'fine' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(adapter.getUsage()).toMatchObject({ calls: 1, retries: 1 });
    });

    it.each([500, 502, 503, 504])('retries HTTP %i', async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(status, { error: { message: 'boom' } }))
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const { adapter } = retryAdapter(fetchImpl);

      expect(await adapter.complete(request())).toEqual({ type: 'finish', content: 'fine' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('returns an error mentioning the attempt count once retries are exhausted', async () => {
      const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(503, { error: { message: 'unavailable' } }));
      const { adapter, sleep } = retryAdapter(fetchImpl, { maxRetries: 2 });

      const result = await adapter.complete(request());

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(result.type).toBe('error');
      if (result.type === 'error') {
        expect(result.code).toBe('http_503');
        expect(result.message).toContain('unavailable');
        expect(result.message).toMatch(/3 attempts/);
      }
      expect(adapter.getUsage()).toMatchObject({ calls: 1, retries: 2, promptTokens: 0, cost: 0 });
    });

    it('uses maxRetries 3 by default (4 fetch calls)', async () => {
      const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(503, {}));
      const { adapter } = retryAdapter(fetchImpl);

      const result = await adapter.complete(request());

      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/4 attempts/);
    });

    it('does not retry when maxRetries is 0', async () => {
      const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(503, { error: { message: 'down' } }));
      const { adapter, sleep } = retryAdapter(fetchImpl, { maxRetries: 0 });

      const result = await adapter.complete(request());

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(result.type).toBe('error');
    });

    it.each([400, 401, 403, 404, 422])('does not retry HTTP %i', async (status) => {
      const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(status, { error: { message: 'nope' } }));
      const { adapter, sleep } = retryAdapter(fetchImpl);

      const result = await adapter.complete(request());

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(result).toMatchObject({ type: 'error', code: `http_${status}` });
      expect(adapter.getUsage().retries).toBe(0);
    });

    it('does not retry a successful-but-invalid payload', async () => {
      const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, { choices: [] }));
      const { adapter } = retryAdapter(fetchImpl);

      const result = await adapter.complete(request());

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ type: 'error', code: 'empty_response' });
    });

    it('retries a network TypeError and succeeds', async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const { adapter } = retryAdapter(fetchImpl);

      expect(await adapter.complete(request())).toEqual({ type: 'finish', content: 'fine' });
      expect(adapter.getUsage().retries).toBe(1);
    });

    it('retries a per-request timeout abort', async () => {
      const timeout = new DOMException('The operation timed out.', 'TimeoutError');
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const { adapter } = retryAdapter(fetchImpl);

      expect(await adapter.complete(request())).toEqual({ type: 'finish', content: 'fine' });
    });

    it('reports network_error with the attempt count when a network failure persists', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const { adapter } = retryAdapter(fetchImpl, { maxRetries: 1 });

      const result = await adapter.complete(request());

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ type: 'error', code: 'network_error' });
      if (result.type === 'error') {
        expect(result.message).toContain('fetch failed');
        expect(result.message).toMatch(/2 attempts/);
      }
    });

    it('honors Retry-After in seconds', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }),
        )
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const { adapter, sleep } = retryAdapter(fetchImpl);

      await adapter.complete(request());

      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('honors Retry-After as an HTTP date', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(
            new Response('{}', { status: 503, headers: { 'Retry-After': 'Tue, 01 Jan 2030 00:00:05 GMT' } }),
          )
          .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
        const { adapter, sleep } = retryAdapter(fetchImpl);

        await adapter.complete(request());

        expect(sleep).toHaveBeenCalledWith(5000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('caps Retry-After at 60 seconds', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{}', { status: 429, headers: { 'Retry-After': '86400' } }),
        )
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const { adapter, sleep } = retryAdapter(fetchImpl);

      await adapter.complete(request());

      expect(sleep).toHaveBeenCalledWith(60_000);
    });

    it('backs off exponentially with jitter, capped at 30s', async () => {
      const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(500, {}));
      const { adapter, sleep } = retryAdapter(fetchImpl, { maxRetries: 7, random: () => 1 });

      await adapter.complete(request());

      const delays = sleep.mock.calls.map(([ms]) => ms);
      expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    });

    it('applies jitter within [50%, 100%] of the exponential delay', async () => {
      const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(500, {}));
      const { adapter, sleep } = retryAdapter(fetchImpl, { maxRetries: 2, random: () => 0 });

      await adapter.complete(request());

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
    });

    it('counts usage from the successful attempt once, not from failed attempts', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, { usage: { prompt_tokens: 999, completion_tokens: 999, cost: 9 } }))
        .mockResolvedValueOnce(jsonResponse(503, {}))
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const { adapter } = retryAdapter(fetchImpl);

      await adapter.complete(request());

      expect(adapter.getUsage()).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        calls: 1,
        retries: 2,
        cost: 0.001,
        modelsUsed: ['m-1'],
        providersUsed: {},
      });
    });

    describe('response body failures', () => {
      function textResponse(body: string, status = 200, contentType = 'text/html'): Response {
        return new Response(body, { status, headers: { 'Content-Type': contentType } });
      }

      /** A 200 response whose body stream errors out while being read. */
      function brokenBodyResponse(message: string): Response {
        const stream = new ReadableStream({
          start(controller) {
            controller.error(new Error(message));
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      it('retries a 200 whose body is not JSON, then succeeds', async () => {
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(textResponse('<html>Bad gateway</html>'))
          .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
        const { adapter, sleep } = retryAdapter(fetchImpl);

        const result = await adapter.complete(request());

        expect(result).toEqual({ type: 'finish', content: 'fine' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(adapter.getUsage()).toMatchObject({ calls: 1, retries: 1 });
      });

      it('retries a 200 with an empty body, then succeeds', async () => {
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(textResponse(''))
          .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
        const { adapter } = retryAdapter(fetchImpl);

        expect(await adapter.complete(request())).toEqual({ type: 'finish', content: 'fine' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(adapter.getUsage().retries).toBe(1);
      });

      it('retries when reading the body rejects, then succeeds', async () => {
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(brokenBodyResponse('socket hang up'))
          .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
        const { adapter } = retryAdapter(fetchImpl);

        expect(await adapter.complete(request())).toEqual({ type: 'finish', content: 'fine' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(adapter.getUsage().retries).toBe(1);
      });

      it('returns a diagnosable invalid_json error once retries are exhausted', async () => {
        const fetchImpl = vi
          .fn()
          .mockImplementation(async () => textResponse('<html>\n\t<body>Bad gateway</body>\n</html>'));
        const { adapter, sleep } = retryAdapter(fetchImpl, { maxRetries: 2 });

        const result = await adapter.complete(request());

        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(result.type).toBe('error');
        if (result.type === 'error') {
          expect(result.code).toBe('invalid_json');
          expect(result.message).toContain('<html> <body>Bad gateway</body> </html>');
          expect(result.message).toContain('200');
          expect(result.message).toContain('text/html');
          expect(result.message).toContain('(after 3 attempts)');
          expect(result.message).not.toContain('test-key');
          expect(result.message).not.toMatch(/[\n\t]/);
        }
        expect(adapter.getUsage()).toMatchObject({ calls: 1, retries: 2 });
      });

      it('reports an empty body as invalid_json', async () => {
        const fetchImpl = vi.fn().mockImplementation(async () => textResponse(''));
        const { adapter } = retryAdapter(fetchImpl, { maxRetries: 1 });

        const result = await adapter.complete(request());

        expect(result).toMatchObject({ type: 'error', code: 'invalid_json' });
        if (result.type === 'error') expect(result.message).toMatch(/length 0/);
      });

      it('truncates the body snippet to about 300 chars', async () => {
        const fetchImpl = vi.fn().mockImplementation(async () => textResponse('x'.repeat(5000)));
        const { adapter } = retryAdapter(fetchImpl, { maxRetries: 0 });

        const result = await adapter.complete(request());

        expect(result.type).toBe('error');
        if (result.type === 'error') {
          expect(result.message).toContain('5000');
          expect(result.message.length).toBeLessThan(700);
        }
      });

      it('returns body_read_error with the underlying message when every read fails', async () => {
        const fetchImpl = vi.fn().mockImplementation(async () => brokenBodyResponse('socket hang up'));
        const { adapter } = retryAdapter(fetchImpl, { maxRetries: 1 });

        const result = await adapter.complete(request());

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(result.type).toBe('error');
        if (result.type === 'error') {
          expect(result.code).toBe('body_read_error');
          expect(result.message).toContain('socket hang up');
          expect(result.message).toContain('application/json');
          expect(result.message).toContain('(after 2 attempts)');
        }
      });

      it('does not retry a valid-JSON payload carrying a non-retryable error object, but surfaces its message', async () => {
        const fetchImpl = vi
          .fn()
          .mockImplementation(async () =>
            jsonResponse(200, { error: { message: 'Provider returned error', code: 402 } }),
          );
        const { adapter, sleep } = retryAdapter(fetchImpl);

        const result = await adapter.complete(request());

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expect(result.type).toBe('error');
        if (result.type === 'error') {
          expect(result.message).toContain('Provider returned error');
          expect(result.message).toContain('402');
        }
      });

      it.each([
        [502, 'numeric 502'],
        ['503', 'numeric-string 503'],
        [408, 'request timeout 408'],
        [429, 'rate limit 429'],
      ])('retries a 200 carrying error code %s (%s), then succeeds', async (code) => {
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(jsonResponse(200, { error: { message: 'Provider returned error', code } }))
          .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
        const { adapter, sleep } = retryAdapter(fetchImpl);

        expect(await adapter.complete(request())).toEqual({ type: 'finish', content: 'fine' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(adapter.getUsage()).toMatchObject({ calls: 1, retries: 1 });
      });

      it('keeps the message and code, plus the attempts suffix, when a retryable error code never clears', async () => {
        const fetchImpl = vi
          .fn()
          .mockImplementation(async () =>
            jsonResponse(200, { error: { message: 'Provider returned error', code: 502 } }),
          );
        const { adapter } = retryAdapter(fetchImpl, { maxRetries: 2 });

        const result = await adapter.complete(request());

        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(result).toEqual({
          type: 'error',
          code: '502',
          message: 'Provider returned error (code: 502) (after 3 attempts)',
        });
        expect(adapter.getUsage().retries).toBe(2);
      });

      it.each([400, 401, 402, 403])('does not retry a 200 carrying error code %i', async (code) => {
        const fetchImpl = vi
          .fn()
          .mockImplementation(async () => jsonResponse(200, { error: { message: 'nope', code } }));
        const { adapter, sleep } = retryAdapter(fetchImpl);

        const result = await adapter.complete(request());

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expect(result).toMatchObject({ type: 'error', code: String(code) });
      });

      it('counts usage once after a retried body failure', async () => {
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(textResponse('not json'))
          .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
        const { adapter } = retryAdapter(fetchImpl);

        await adapter.complete(request());

        expect(adapter.getUsage()).toMatchObject({
          promptTokens: 10,
          completionTokens: 5,
          calls: 1,
          retries: 1,
          cost: 0.001,
        });
      });
    });
  });

  describe('sampling parameters', () => {
    const OK = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] };

    function samplingAdapter(sampling: Record<string, number> = {}) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, OK));
      const adapter = new OpenAICompatibleModelAdapter({
        apiKey: 'k',
        model: 'm',
        baseUrl: 'https://api.example.test/v1',
        fetchImpl,
        ...sampling,
      });
      const sentBody = () => JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
      return { adapter, sentBody };
    }

    it('omits every sampling field from the request body when none is set', async () => {
      const { adapter, sentBody } = samplingAdapter();
      await adapter.complete(request());
      const body = sentBody();
      for (const key of ['temperature', 'top_p', 'seed', 'max_tokens']) {
        expect(key in body).toBe(false);
      }
      expect(adapter.getSamplingConfig()).toEqual({ temperature: null, topP: null, seed: null, maxTokens: null });
    });

    it('sends each set field with the provider names and exact values', async () => {
      const { adapter, sentBody } = samplingAdapter({ temperature: 0.2, topP: 0.9, seed: 42, maxTokens: 4096 });
      await adapter.complete(request());
      const body = sentBody();
      expect(body.temperature).toBe(0.2);
      expect(body.top_p).toBe(0.9);
      expect(body.seed).toBe(42);
      expect(body.max_tokens).toBe(4096);
      expect(adapter.getSamplingConfig()).toEqual({ temperature: 0.2, topP: 0.9, seed: 42, maxTokens: 4096 });
    });

    it('treats zero as set (temperature 0, seed 0) and omits only the unset fields', async () => {
      const { adapter, sentBody } = samplingAdapter({ temperature: 0, seed: 0 });
      await adapter.complete(request());
      const body = sentBody();
      expect(body.temperature).toBe(0);
      expect(body.seed).toBe(0);
      expect('top_p' in body).toBe(false);
      expect('max_tokens' in body).toBe(false);
      expect(adapter.getSamplingConfig()).toEqual({ temperature: 0, topP: null, seed: 0, maxTokens: null });
    });
  });

  describe('provider routing', () => {
    const OK = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] };

    function providerAdapter(
      provider?: { order: string[]; allowFallbacks: boolean },
      bodies: unknown[] = [OK],
    ) {
      const fetchImpl = vi.fn<typeof fetch>();
      for (const body of bodies) fetchImpl.mockResolvedValueOnce(jsonResponse(200, body));
      const adapter = new OpenAICompatibleModelAdapter({
        apiKey: 'k',
        model: 'm',
        baseUrl: 'https://api.example.test/v1',
        fetchImpl,
        ...(provider && { provider }),
      });
      const sentBody = () => JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
      return { adapter, sentBody };
    }

    it('omits the provider field and reports a null config when unset', async () => {
      const { adapter, sentBody } = providerAdapter();
      await adapter.complete(request());
      expect('provider' in sentBody()).toBe(false);
      expect(adapter.getProviderConfig()).toBeNull();
    });

    it('sends provider.order and provider.allow_fallbacks (snake_case) when set', async () => {
      const { adapter, sentBody } = providerAdapter({ order: ['DeepInfra', 'Fireworks'], allowFallbacks: false });
      await adapter.complete(request());
      expect(sentBody().provider).toEqual({ order: ['DeepInfra', 'Fireworks'], allow_fallbacks: false });
      expect(adapter.getProviderConfig()).toEqual({ order: ['DeepInfra', 'Fireworks'], allowFallbacks: false });
    });

    it('sends allow_fallbacks true when fallbacks are allowed', async () => {
      const { adapter, sentBody } = providerAdapter({ order: ['DeepInfra'], allowFallbacks: true });
      await adapter.complete(request());
      expect(sentBody().provider).toEqual({ order: ['DeepInfra'], allow_fallbacks: true });
    });

    it('does not let callers mutate the configured order afterwards', async () => {
      const order = ['DeepInfra'];
      const { adapter, sentBody } = providerAdapter({ order, allowFallbacks: false });
      order.push('Other');
      adapter.getProviderConfig()!.order.push('Mutated');
      await adapter.complete(request());
      expect(sentBody().provider).toEqual({ order: ['DeepInfra'], allow_fallbacks: false });
    });

    it('counts the upstream providers returned in responses, per provider name', async () => {
      const { adapter } = providerAdapter(undefined, [
        { ...OK, provider: 'DeepInfra' },
        { ...OK, provider: 'DeepInfra' },
        { ...OK, provider: 'Fireworks' },
        OK,
      ]);
      for (let i = 0; i < 4; i += 1) await adapter.complete(request());
      expect(adapter.getUsage().providersUsed).toEqual({ DeepInfra: 2, Fireworks: 1 });
    });

    it('returns a copy of providersUsed so callers cannot mutate internal counts', async () => {
      const { adapter } = providerAdapter(undefined, [{ ...OK, provider: 'DeepInfra' }]);
      await adapter.complete(request());
      adapter.getUsage().providersUsed.DeepInfra = 99;
      expect(adapter.getUsage().providersUsed).toEqual({ DeepInfra: 1 });
    });
  });

});

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
  it('throws a clear error when GLM_API_KEY is missing', () => {
    delete process.env.GLM_API_KEY;
    process.env.GLM_MODEL = 'glm-4.7';
    expect(() => new GlmModelAdapter()).toThrow(/GLM_API_KEY/);
  });

  it('throws a clear error when GLM_MODEL is missing', () => {
    process.env.GLM_API_KEY = 'test-key';
    delete process.env.GLM_MODEL;
    expect(() => new GlmModelAdapter()).toThrow(/GLM_MODEL/);
  });

  it('maps a tool_calls response to a tool_call ModelResponse', async () => {
    process.env.GLM_API_KEY = 'test-key';
    process.env.GLM_MODEL = 'glm-4.7';
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
    const adapter = new GlmModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await adapter.complete(request());

    expect(response).toEqual({
      type: 'tool_call',
      tool: 'write_file',
      args: { path: 'x.txt', content: 'hi' },
    });
    // Request shape: OpenAI-compatible body against the Z.ai endpoint.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('glm-4.7');
    expect(body.tools[0].function.name).toBe('write_file');
  });

  it('maps a content response to a finish ModelResponse', async () => {
    process.env.GLM_API_KEY = 'test-key';
    process.env.GLM_MODEL = 'glm-4.7';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'All done.' } }],
      }),
    );
    const adapter = new GlmModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await adapter.complete(request());

    expect(response).toEqual({ type: 'finish', content: 'All done.' });
  });

  it('maps HTTP errors to an error ModelResponse', async () => {
    process.env.GLM_API_KEY = 'test-key';
    process.env.GLM_MODEL = 'glm-4.7';
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
    process.env.GLM_API_KEY = 'test-key';
    process.env.GLM_MODEL = 'glm-4.7';
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const adapter = new GlmModelAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await adapter.complete(request());

    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.code).toBe('network_error');
      expect(response.message).toContain('ECONNREFUSED');
    }
  });

  it('feeds history back as assistant tool_calls plus tool-role messages', async () => {
    process.env.GLM_API_KEY = 'test-key';
    process.env.GLM_MODEL = 'glm-4.7';
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

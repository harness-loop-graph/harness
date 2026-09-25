#!/usr/bin/env node
// Tiny MCP stdio server for tests: two tools, one of which always fails.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fixture-server', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes back the given text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'fail',
      description: 'Always returns an error result.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'echo') {
    return { content: [{ type: 'text', text: `echo: ${args?.text ?? ''}` }] };
  }
  if (name === 'fail') {
    return { content: [{ type: 'text', text: 'fixture failure' }], isError: true };
  }
  throw new Error(`Unknown tool '${name}'`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

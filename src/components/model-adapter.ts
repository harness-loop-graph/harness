import type { ModelRequest, ModelResponse } from '../contracts/core.js';

/** Abstraction over an LLM completion endpoint. */
export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Stub adapter that always returns a canned finish response. */
export class StubModelAdapter implements ModelAdapter {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    return {
      type: 'finish',
      content: `Stub response for task: ${request.task}`,
    };
  }
}

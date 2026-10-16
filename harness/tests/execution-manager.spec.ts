import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { LocalExecutionManager } from '../src/components/execution-manager.js';

describe('LocalExecutionManager output capture', () => {
  it('keeps the tail of output that exceeds the cap', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir(), timeoutMs: 20_000 });
    const script =
      "process.stdout.write('FIRST_LINE\\n' + 'x'.repeat(1024*1024) + '\\nLAST_LINE\\n');" +
      "process.stderr.write('y'.repeat(1024*1024) + '\\nERR_LAST\\n');";
    const res = await mgr.run({ command: `node -e "${script}"`, cwd: '.' });
    expect(res.stdout).toContain('FIRST_LINE');
    expect(res.stdout).toContain('LAST_LINE');
    expect(res.stdout).toMatch(/\[truncated \d+ chars\]/);
    expect(res.stdout.length).toBeLessThanOrEqual(512 * 1024);
    expect(res.stderr).toContain('ERR_LAST');
    expect(res.stderr.length).toBeLessThanOrEqual(512 * 1024);
  });

  it('leaves output under the cap untouched', async () => {
    const mgr = new LocalExecutionManager({ workspaceRoot: os.tmpdir() });
    const res = await mgr.run({ command: 'echo hello', cwd: '.' });
    expect(res.stdout.trim()).toBe('hello');
  });
});

import { describe, it, expect } from 'vitest';
import { RecordingVerificationManager } from '../src/components/verification-manager.js';

describe('RecordingVerificationManager failure details', () => {
  it('surfaces error lines buried in the middle of long output', async () => {
    const noise = (n: number) => Array.from({ length: n }, (_, i) => `#${i} step output line ${i}`).join('\n');
    const stderr = [
      noise(300),
      'npm ERR! code ERESOLVE',
      'npm ERR! Could not resolve dependency: peer react@"^17" from react-router@5',
      noise(300),
      'target frontend: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
    ].join('\n');
    const v = await new RecordingVerificationManager().verify({ exitCode: 1, stdout: '', stderr });
    expect(v.passed).toBe(false);
    expect(v.details).toContain('npm ERR! code ERESOLVE');
    expect(v.details).toContain('Could not resolve dependency');
    expect(v.details).toContain('failed to solve');
    expect(v.details.length).toBeLessThanOrEqual(6000);
  });

  it('keeps the start of the output, not only the end', async () => {
    const stderr = 'yaml: line 42: did not find expected key\n' + 'x\n'.repeat(5000);
    const v = await new RecordingVerificationManager().verify({ exitCode: 1, stdout: '', stderr });
    expect(v.details).toContain('did not find expected key');
  });

  it('reports a short failure unchanged', async () => {
    const v = await new RecordingVerificationManager().verify({ exitCode: 7, stdout: '', stderr: 'curl: (7) refused' });
    expect(v.details).toContain('exit code 7');
    expect(v.details).toContain('curl: (7) refused');
  });
});

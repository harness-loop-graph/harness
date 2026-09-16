import type { ExecutionResult, VerificationResult } from '../contracts/core.js';

/** Runs tests/checks and stores verification results. */
export interface VerificationManager {
  verify(result: ExecutionResult): Promise<VerificationResult>;
}

/** Minimal stub: always passes. */
export class StubVerificationManager implements VerificationManager {
  async verify(result: ExecutionResult): Promise<VerificationResult> {
    return {
      passed: result.exitCode === 0,
      details: `Verified execution with exit code ${result.exitCode}`,
    };
  }
}

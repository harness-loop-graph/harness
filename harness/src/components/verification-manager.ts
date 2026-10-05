import type { ExecutionResult, VerificationResult } from '../contracts/core.js';
import * as fs from 'node:fs';

/** Runs tests/checks and stores verification results. */
export interface VerificationManager {
  verify(result: ExecutionResult): Promise<VerificationResult>;
  /** History of every verification produced so far. */
  getHistory(): VerificationResult[];
}

const MAX_DETAIL_CHARS = 2000;

/** Evaluates executions (exit code + output tail) and records history, optionally as JSONL. */
export class RecordingVerificationManager implements VerificationManager {
  private readonly history: VerificationResult[] = [];

  constructor(private readonly historyFile?: string) {}

  async verify(result: ExecutionResult): Promise<VerificationResult> {
    const tail = (result.stderr || result.stdout).slice(-MAX_DETAIL_CHARS);
    const verification: VerificationResult = {
      passed: result.exitCode === 0,
      details:
        result.exitCode === 0
          ? `Command succeeded. Output tail: ${result.stdout.slice(-MAX_DETAIL_CHARS)}`
          : `Command failed with exit code ${result.exitCode}. Output tail: ${tail}`,
      metrics: { exitCode: result.exitCode },
    };
    this.history.push(verification);
    if (this.historyFile) {
      fs.appendFileSync(this.historyFile, JSON.stringify(verification) + '\n');
    }
    return verification;
  }

  getHistory(): VerificationResult[] {
    return [...this.history];
  }
}

/** Stub for unit tests. */
export class StubVerificationManager implements VerificationManager {
  private readonly history: VerificationResult[] = [];

  async verify(result: ExecutionResult): Promise<VerificationResult> {
    const verification: VerificationResult = {
      passed: result.exitCode === 0,
      details: `Verified execution with exit code ${result.exitCode}`,
    };
    this.history.push(verification);
    return verification;
  }

  getHistory(): VerificationResult[] {
    return [...this.history];
  }
}

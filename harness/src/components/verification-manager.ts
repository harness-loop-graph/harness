import type { ExecutionResult, VerificationResult } from '../contracts/core.js';
import * as fs from 'node:fs';
import { truncateMiddle } from './truncate.js';

/** Runs tests/checks and stores verification results. */
export interface VerificationManager {
  verify(result: ExecutionResult): Promise<VerificationResult>;
  /** History of every verification produced so far. */
  getHistory(): VerificationResult[];
}

const MAX_DETAIL_CHARS = 2000;
const MAX_FAILURE_OUTPUT_CHARS = 3000;
const MAX_ERROR_LINES = 12;
const MAX_ERROR_LINE_CHARS = 200;
const ERROR_LINE = /\b(error|failed|failure|cannot|not found|exception|fatal)\b|\bERR!/i;

/**
 * Failure details for the next turn's feedback. Build tools (docker, npm) print
 * the cause far above their last line, so error-looking lines are listed first
 * and the output keeps its head and tail.
 */
function describeFailure(result: ExecutionResult): string {
  const output = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n');
  const errorLines: string[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!ERROR_LINE.test(line)) continue;
    const clipped = line.length <= MAX_ERROR_LINE_CHARS ? line : line.slice(0, MAX_ERROR_LINE_CHARS - 1) + '…';
    if (!errorLines.includes(clipped)) errorLines.push(clipped);
    if (errorLines.length === MAX_ERROR_LINES) break;
  }
  const parts = [`Command failed with exit code ${result.exitCode}.`];
  if (errorLines.length > 0) parts.push(`Error lines:\n${errorLines.join('\n')}`);
  parts.push(`Output (start and end): ${truncateMiddle(output, MAX_FAILURE_OUTPUT_CHARS)}`);
  return parts.join('\n');
}

/** Evaluates executions (exit code + output) and records history, optionally as JSONL. */
export class RecordingVerificationManager implements VerificationManager {
  private readonly history: VerificationResult[] = [];

  constructor(private readonly historyFile?: string) {}

  async verify(result: ExecutionResult): Promise<VerificationResult> {
    const verification: VerificationResult = {
      passed: result.exitCode === 0,
      details:
        result.exitCode === 0
          ? `Command succeeded. Output tail: ${result.stdout.slice(-MAX_DETAIL_CHARS)}`
          : describeFailure(result),
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

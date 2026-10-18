import type { ModelResponse, ToolResult } from '../contracts/core.js';
import type { InteractionTurn } from '../harness.js';

/** Total budget for the rendered summary, header included. */
export const MAX_TURN_SUMMARY_CHARS = 2500;

const MAX_FILES = 40;
const MAX_COMMANDS = 10;
const MAX_ENDING_MESSAGE_CHARS = 300;
const MAX_PATH_CHARS = 120;
const MAX_COMMAND_CHARS = 160;
const DENIED_PREFIX = 'Denied by guardrails';

/** The slice of a harness run the summary is built from. */
export interface TurnActivity {
  finalResponse: ModelResponse;
  turns: ReadonlyArray<Pick<InteractionTurn, 'response' | 'toolResult'>>;
}

/**
 * Deterministic digest of what one harness run did, so the next loop turn
 * (a fresh conversation) does not start blind. Built only from the recorded
 * tool activity — no model call. Returns undefined when the run recorded
 * nothing.
 */
export function summarizeTurn(run: TurnActivity): string | undefined {
  if (run.turns.length === 0) return undefined;

  const files: string[] = [];
  const commands: string[] = [];
  let denied = 0;

  for (const { response, toolResult } of run.turns) {
    if (response.type !== 'tool_call' || !toolResult) continue;

    if (isDenied(toolResult)) {
      denied += 1;
      continue;
    }

    if (response.tool === 'write_file' && toolResult.success) {
      const target = response.args.path;
      if (typeof target === 'string' && !files.includes(target)) files.push(target);
    } else if (response.tool === 'run_command') {
      const command = response.args.command;
      if (typeof command === 'string') commands.push(`[${describeExit(toolResult)}] ${clip(oneLine(command), MAX_COMMAND_CHARS)}`);
    }
  }

  const lines = ['Previous turn summary (what your last attempt did, recorded by the harness):'];
  lines.push(`- Ended with: ${describeEnding(run.finalResponse)}`);

  if (files.length > 0) {
    const shown = files.slice(0, MAX_FILES).map((f) => clip(f, MAX_PATH_CHARS));
    const more = files.length > MAX_FILES ? ` (+${files.length - MAX_FILES} more)` : '';
    lines.push(`- Files written: ${shown.join(', ')}${more}`);
  }

  if (commands.length > 0) {
    const omitted = commands.length - MAX_COMMANDS;
    lines.push(`- Commands run (last ${Math.min(commands.length, MAX_COMMANDS)}${omitted > 0 ? ` of ${commands.length}` : ''}):`);
    for (const command of commands.slice(-MAX_COMMANDS)) lines.push(`  - ${command}`);
  }

  if (denied > 0) lines.push(`- Denied tool calls: ${denied}`);

  return clip(lines.join('\n'), MAX_TURN_SUMMARY_CHARS);
}

function describeEnding(response: ModelResponse): string {
  if (response.type === 'error') {
    return `error '${response.code}': ${clip(oneLine(response.message), MAX_ENDING_MESSAGE_CHARS)}`;
  }
  return response.type === 'finish' ? 'finish (you reported the task as done)' : response.type;
}

function isDenied(result: ToolResult): boolean {
  return !result.success && typeof result.result === 'string' && result.result.startsWith(DENIED_PREFIX);
}

function describeExit(result: ToolResult): string {
  if (!result.success) return 'failed';
  const value = result.result;
  if (typeof value === 'object' && value !== null && 'exitCode' in value) return `exit ${String(value.exitCode)}`;
  return 'exit ?';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

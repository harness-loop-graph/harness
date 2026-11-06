import type { GuardrailDecision } from '../contracts/core.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitCommandSegments, type CommandSegment } from './command-segments.js';

/**
 * An action the agent wants to perform, evaluated against the policy
 * before any tool or command actually runs.
 */
export type GuardrailAction =
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'command'; command: string; cwd: string };

/** Static policy that decides which agent actions are permitted. */
export interface GuardrailPolicy {
  /** Absolute path the agent is confined to. */
  workspaceRoot: string;
  /** Tool names the agent may invoke. */
  allowedTools: string[];
  /** Command prefixes allowed for run_command (e.g. ['npm', 'node', 'git']). */
  allowedCommandPrefixes: string[];
  /** Max bytes for a single file write. */
  maxFileBytes: number;
}

/** Policy enforcement with an audit trail. */
export interface Guardrails {
  evaluate(action: GuardrailAction): Promise<GuardrailDecision>;
  getAuditLog(): GuardrailDecision[];
}

export const DEFAULT_ALLOWED_TOOLS = ['write_file', 'read_file', 'search_replace', 'run_command'];
export const DEFAULT_ALLOWED_COMMAND_PREFIXES = [
  'npm', 'node', 'npx', 'git', 'ls', 'cat', 'echo', 'mkdir', 'docker', 'pnpm', 'psql',
  'cd', 'head', 'tail', 'grep', 'sed', 'awk', 'find', 'touch', 'cp', 'mv', 'rm',
  'chmod', 'curl', 'bash', 'sh', 'test', 'diff', 'wc', 'sort', 'uniq', 'tr', 'cut',
  'xargs', 'tee', 'env', 'printenv', 'which', 'sleep', 'true', 'false',
];

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

/** Commands that run another command; maps each to the short options that take a separate value. */
const WRAPPER_OPTIONS_WITH_VALUE: Record<string, string> = {
  env: 'uC',
  xargs: 'adEILnPs',
  time: 'fo',
  nice: 'n',
  nohup: '',
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function skipAssignments(words: string[], from: number): number {
  let i = from;
  while (i < words.length && ASSIGNMENT.test(words[i])) i++;
  return i;
}

/** First word that is actually executed: after assignments, or undefined for an assignment-only segment. */
function commandWord(words: string[]): string | undefined {
  return words[skipAssignments(words, 0)];
}

/** True when an option of `rm` is a recursive/force flag (short cluster or GNU long option, abbreviations included). */
function hasRecursiveOrForceOption(args: string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0];
      if (name.length > 2 && ('--recursive'.startsWith(name) || '--force'.startsWith(name))) return true;
    } else if (/^-[A-Za-z]+$/.test(arg) && /[rRf]/.test(arg)) {
      return true;
    }
  }
  return false;
}

/** True when a shell's arguments name a script file; `-s` or no operand means the script comes from stdin. */
function hasScriptOperand(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return i + 1 < args.length;
    if (/^[-+]o$/.test(arg)) {
      i++;
    } else if (/^-[A-Za-z]*s/.test(arg)) {
      return false;
    } else if (!arg.startsWith('-') && !arg.startsWith('+')) {
      return true;
    }
  }
  return false;
}

/**
 * Index of the command wrapped by `wrapper` (words.length when it wraps none), or a denial
 * reason. Unknown options are assumed to take no value, so a misparse lands on a word the
 * whitelist then rejects rather than skipping past the real command.
 */
function skipWrapperArguments(wrapper: string, words: string[], from: number): number | string {
  const optionsWithValue = WRAPPER_OPTIONS_WITH_VALUE[wrapper];
  const splitStringDenied = `'${wrapper} -S' runs a string that cannot be inspected and is denied`;
  let i = from;
  while (i < words.length) {
    const word = words[i];
    if (word === '--') return i + 1;
    if (wrapper === 'env' && ASSIGNMENT.test(word)) {
      i++;
    } else if (word.startsWith('--')) {
      const name = word.split('=')[0];
      if (wrapper === 'env' && name.length > 2 && '--split-string'.startsWith(name)) return splitStringDenied;
      i++;
    } else if (word.startsWith('-') && word.length > 1) {
      let takesValue = false;
      for (let j = 1; j < word.length; j++) {
        if (wrapper === 'env' && word[j] === 'S') return splitStringDenied;
        if (optionsWithValue.includes(word[j])) {
          takesValue = j === word.length - 1;
          break;
        }
      }
      i += takesValue ? 2 : 1;
    } else {
      return i;
    }
  }
  return words.length;
}

const AUDIT_COMMAND_MAX_CHARS = 300;

function clip(text: string): string {
  return text.length > AUDIT_COMMAND_MAX_CHARS ? text.slice(0, AUDIT_COMMAND_MAX_CHARS) + '…' : text;
}

/** Compact, bounded description of an action for the audit file: never file contents or other args. */
function summarizeAction(action: GuardrailAction): Record<string, string> {
  if (action.kind === 'command') return { command: clip(action.command) };
  const summary: Record<string, string> = { tool: action.tool };
  const { args } = action;
  if (action.tool === 'run_command') {
    if (typeof args.command === 'string') summary.command = clip(args.command);
  } else if (action.tool === 'load_skill') {
    if (typeof args.name === 'string') summary.name = args.name;
  } else if (['read_file', 'write_file', 'search_replace'].includes(action.tool)) {
    if (typeof args.path === 'string') summary.path = args.path;
  }
  return summary;
}

/** Policy guardrails: path confinement, tool/command whitelists, size limits, audit trail. */
export class PolicyGuardrails implements Guardrails {
  private readonly audit: GuardrailDecision[] = [];

  constructor(
    private readonly policy: GuardrailPolicy,
    private readonly auditFile?: string,
  ) {}

  async evaluate(action: GuardrailAction): Promise<GuardrailDecision> {
    const decision = this.decide(action);
    this.audit.push(decision);
    this.appendAudit(action, decision);
    return decision;
  }

  getAuditLog(): GuardrailDecision[] {
    return [...this.audit];
  }

  private decide(action: GuardrailAction): GuardrailDecision {
    if (action.kind === 'command') return this.decideCommand(action);
    return this.decideTool(action);
  }

  private decideTool(action: Extract<GuardrailAction, { kind: 'tool' }>): GuardrailDecision {
    if (!this.policy.allowedTools.includes(action.tool)) {
      return { decision: 'denied', reason: `Tool '${action.tool}' is not in the allowed tool list` };
    }
    if (action.tool === 'run_command') {
      const command = typeof action.args.command === 'string' ? action.args.command : '';
      return this.decideCommand({ kind: 'command', command, cwd: this.policy.workspaceRoot });
    }
    const relPath = typeof action.args.path === 'string' ? action.args.path : '';
    if (action.tool === 'write_file' || action.tool === 'read_file' || action.tool === 'search_replace') {
      const pathDecision = this.checkPath(relPath);
      if (pathDecision.decision === 'denied') return pathDecision;
    }
    if (action.tool === 'write_file' || action.tool === 'search_replace') {
      const field = action.tool === 'write_file' ? 'content' : 'replace';
      const content = typeof action.args[field] === 'string' ? (action.args[field] as string) : '';
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > this.policy.maxFileBytes) {
        return {
          decision: 'denied',
          reason: `Write of ${bytes} bytes exceeds the limit of ${this.policy.maxFileBytes} bytes`,
        };
      }
    }
    return { decision: 'allowed', reason: `Tool '${action.tool}' is allowed by policy` };
  }

  private decideCommand(action: Extract<GuardrailAction, { kind: 'command' }>): GuardrailDecision {
    const command = action.command.trim();
    if (command === '') {
      return { decision: 'denied', reason: 'Empty command' };
    }
    const cwdDecision = this.checkPath(action.cwd, true);
    if (cwdDecision.decision === 'denied') return cwdDecision;
    const parsed = splitCommandSegments(command);
    if (!parsed.ok) return { decision: 'denied', reason: parsed.reason };
    if (parsed.segments.length === 0) return { decision: 'denied', reason: 'Empty command' };
    for (const segment of parsed.segments) {
      const denial = this.checkSegment(segment);
      if (denial) return denial;
    }
    const first = commandWord(parsed.segments[0].words);
    return {
      decision: 'allowed',
      reason: first ? `Command '${first}' is allowed by policy` : 'Command line is allowed by policy',
    };
  }

  /** Returns a denial for the first rule a segment breaks, or null when it is allowed. */
  private checkSegment(segment: CommandSegment): GuardrailDecision | null {
    const { words } = segment;
    if (words.length === 0 && !segment.hasRedirection) {
      return { decision: 'denied', reason: 'Empty command segment between shell operators' };
    }
    let i = skipAssignments(words, 0);
    while (i < words.length) {
      const word = words[i];
      if (word === '{' || word === '}') {
        return { decision: 'denied', reason: 'Subshells and command grouping are not allowed' };
      }
      if (!this.policy.allowedCommandPrefixes.includes(word)) {
        return { decision: 'denied', reason: `Command '${word}' is not in the allowed command prefix list` };
      }
      const args = words.slice(i + 1);
      if (SHELLS.has(word) && args.some((arg) => /^-[A-Za-z]*c/.test(arg))) {
        return { decision: 'denied', reason: `Inline scripts (${word} -c) cannot be inspected and are denied` };
      }
      if (SHELLS.has(word) && !hasScriptOperand(args)) {
        return {
          decision: 'denied',
          reason: `A ${word} without a script file reads its script from stdin, which cannot be inspected; run a script file instead`,
        };
      }
      // `rm` run by any command (find -exec, timeout, xargs, ...) is checked too, not only at command position.
      for (let j = i; j < words.length; j++) {
        if (words[j] === 'rm' && hasRecursiveOrForceOption(words.slice(j + 1))) {
          return { decision: 'denied', reason: 'Recursive/forced rm is always denied' };
        }
      }
      if (!(word in WRAPPER_OPTIONS_WITH_VALUE)) break;
      const next = skipWrapperArguments(word, words, i + 1);
      if (typeof next === 'string') return { decision: 'denied', reason: next };
      i = next;
    }
    return null;
  }

  /** Relative paths are confined to the workspace; `..` escapes are rejected. */
  private checkPath(target: string, isAbsoluteOk = false): GuardrailDecision {
    if (target === '') {
      return { decision: 'denied', reason: 'Missing path argument' };
    }
    const root = path.resolve(this.policy.workspaceRoot);
    const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
    if (path.relative(root, resolved).startsWith('..') || path.isAbsolute(path.relative(root, resolved))) {
      return {
        decision: 'denied',
        reason: `Path '${target}' escapes the workspace root`,
      };
    }
    if (!isAbsoluteOk && path.isAbsolute(target) && resolved !== root) {
      return { decision: 'denied', reason: 'Absolute paths outside the workspace are denied' };
    }
    return { decision: 'allowed', reason: `Path '${target}' is inside the workspace` };
  }

  private appendAudit(action: GuardrailAction, decision: GuardrailDecision): void {
    if (!this.auditFile) return;
    const entry = { ...decision, ...summarizeAction(action), at: new Date().toISOString() };
    fs.appendFileSync(this.auditFile, JSON.stringify(entry) + '\n');
  }
}

/** Stub for unit tests. */
export class StubGuardrails implements Guardrails {
  private readonly audit: GuardrailDecision[] = [];
  private readonly whitelist: string[];

  constructor(whitelist: string[] = DEFAULT_ALLOWED_TOOLS) {
    this.whitelist = whitelist;
  }

  async evaluate(action: GuardrailAction): Promise<GuardrailDecision> {
    const decision: GuardrailDecision =
      action.kind === 'tool' && this.whitelist.includes(action.tool)
        ? { decision: 'allowed', reason: 'Tool is whitelisted' }
        : { decision: 'denied', reason: 'Tool is not whitelisted' };
    this.audit.push(decision);
    return decision;
  }

  getAuditLog(): GuardrailDecision[] {
    return [...this.audit];
  }
}

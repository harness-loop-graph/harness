import type { GuardrailDecision } from '../contracts/core.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

export const DEFAULT_ALLOWED_TOOLS = ['write_file', 'read_file', 'run_command'];
export const DEFAULT_ALLOWED_COMMAND_PREFIXES = ['npm', 'node', 'npx', 'git', 'ls', 'cat', 'echo', 'mkdir'];

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
    this.appendAudit(decision);
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
    if (action.tool === 'write_file' || action.tool === 'read_file') {
      const pathDecision = this.checkPath(relPath);
      if (pathDecision.decision === 'denied') return pathDecision;
    }
    if (action.tool === 'write_file') {
      const content = typeof action.args.content === 'string' ? action.args.content : '';
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
    const firstToken = command.split(/\s+/)[0];
    if (!this.policy.allowedCommandPrefixes.includes(firstToken)) {
      return {
        decision: 'denied',
        reason: `Command '${firstToken}' is not in the allowed command prefix list`,
      };
    }
    if (/(^|\s)rm\s+-[rf]/.test(command)) {
      return { decision: 'denied', reason: 'Recursive/forced rm is always denied' };
    }
    return { decision: 'allowed', reason: `Command '${firstToken}' is allowed by policy` };
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

  private appendAudit(decision: GuardrailDecision): void {
    if (!this.auditFile) return;
    fs.appendFileSync(this.auditFile, JSON.stringify({ ...decision, at: new Date().toISOString() }) + '\n');
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

import type { GuardrailDecision } from '../contracts/core.js';

/** Policy enforcement with an audit trail. */
export interface Guardrails {
  evaluate(action: string, policy?: string): Promise<GuardrailDecision>;
  getAuditLog(): GuardrailDecision[];
}

/** Minimal stub: allows whitelisted actions, denies others. */
export class StubGuardrails implements Guardrails {
  private readonly audit: GuardrailDecision[] = [];
  private readonly whitelist = new Set(['read', 'write', 'execute']);

  async evaluate(action: string, _policy?: string): Promise<GuardrailDecision> {
    const decision: GuardrailDecision = this.whitelist.has(action)
      ? { decision: 'allowed', reason: 'Action is whitelisted' }
      : { decision: 'denied', reason: 'Action is not whitelisted' };
    this.audit.push(decision);
    return decision;
  }

  getAuditLog(): GuardrailDecision[] {
    return [...this.audit];
  }
}

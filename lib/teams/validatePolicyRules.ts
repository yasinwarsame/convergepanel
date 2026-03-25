/**
 * Teams API helpers: auth context, policy validation, and membership rules.
 */

import type { PolicyRule } from "@/lib/governance/policyEngine";

export function validatePolicyRules(rules: unknown): rules is PolicyRule[] {
  if (!Array.isArray(rules) || rules.length > 80) return false;
  for (const r of rules) {
    if (!r || typeof r !== "object") return false;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.length > 120) return false;
    if (typeof o.name !== "string") return false;
    if (typeof o.description !== "string") return false;
    if (typeof o.enabled !== "boolean") return false;
    if (!["flag", "block", "require_review"].includes(String(o.action))) return false;
    const c = o.condition as Record<string, unknown> | undefined;
    if (!c || typeof c !== "object") return false;
    if (!["consensus_below", "evidence_quality", "model_health"].includes(String(c.type))) return false;
    if (c.threshold !== undefined && (typeof c.threshold !== "number" || Number.isNaN(c.threshold))) {
      return false;
    }
  }
  return true;
}

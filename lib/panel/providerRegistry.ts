/**
 * The ONE canonical registry of executing providers (Order 33, owner ruling B — Order 6 class 7).
 *
 * A stored or runtime `provider` token establishes who executed a row ONLY when it normalizes to a registered canonical
 * provider. Normalization is deterministic and nothing more: `trim()` + `toLowerCase()`. Everything else — an empty or
 * whitespace-only string, "none", "n/a", "na", "unknown", "missing", "unresolved", "null", "undefined", any
 * unregistered string ("acme", "forged"), a non-string — is not a recorded provider (no independence is established
 * from it).
 *
 * The list is every provider value the code has ever written onto a result row (inventory in the Order 33 evidence):
 *  - "openai" | "anthropic" | "xai" | "perplexity" | "google" — `PanelModelConfig.provider` (lib/panelModels.ts, the
 *    only values that union has ever held), stamped by `runPanel` (lib/panel.ts) on every research row and frozen onto
 *    `perModel` by Step 6.2a (`runtimeModelProvenance`); since Order 33 also stamped by the claim dispatch
 *    (lib/verification/runClaimVerificationPanel.ts, `CLAIM_CONNECTOR_PROVIDER`).
 *  - "deepseek" — the DeepSeek substitution (lib/panel.ts `runSlotWithFallback`, `provider: "deepseek"`), persisted the
 *    same way, and recorded on substituted claim rows (buildClaimModelEvidence).
 * "unknown" (the normalize.ts display default) was never a recorded provider. Video rows record no provider.
 *
 * Pure, client-safe, imports nothing.
 */

export const CANONICAL_PROVIDERS = Object.freeze(["openai", "anthropic", "xai", "perplexity", "google", "deepseek"] as const);

export type CanonicalProvider = (typeof CANONICAL_PROVIDERS)[number];

const REGISTERED: ReadonlySet<string> = new Set(CANONICAL_PROVIDERS);

/** The canonical provider a token records (trim + lowercase, then registry membership), or null when it records none. */
export function canonicalProvider(value: unknown): CanonicalProvider | null {
  if (typeof value !== "string") return null;
  const p = value.trim().toLowerCase();
  return REGISTERED.has(p) ? (p as CanonicalProvider) : null;
}

/**
 * Saved-run provenance honesty (S1) — the ONE place that decides what the UI
 * says about a substituted model slot (the per-card badge, the synthesis
 * "Model health" chip + tooltip, and the copied synthesis markdown).
 *
 * Rule: a substitution label names a provider, requested model, actual model or
 * reason only when the result row actually carries that fact. A live row always
 * carries them, so live output is unchanged; a saved row carries only what was
 * persisted with the run (Step 6.2a onward), so an older substituted run may say
 * "Substituted" but never names a provider/model/reason it did not record. The
 * logical slot (`modelId`) is used only as the slot's own name — never as the
 * substitute or the requested model.
 *
 * Pure and client-safe.
 */

import { getModelDisplayNameSafe } from "@/lib/panelModels";
import { coerceStatus } from "./normalize";

type SubstitutionRow = {
  modelId: string;
  status: string;
  provider?: unknown;
  requestedModel?: unknown;
  actualModel?: unknown;
  substitutionReason?: unknown;
};

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "XAI",
  perplexity: "Perplexity",
  google: "Google",
};

/** Display name for a recorded provider; null when none was recorded. */
export function providerDisplayName(provider: unknown): string | null {
  if (!present(provider)) return null;
  const p = provider.trim().toLowerCase();
  return PROVIDER_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

const isSubstituted = (r: SubstitutionRow) => coerceStatus(r.status) === "substituted";

/** Per-card badge: "Substituted: <Provider>" only when the provider is recorded. */
export function substitutionBadgeText(row: SubstitutionRow): string {
  const provider = providerDisplayName(row.provider);
  return provider ? `Substituted: ${provider}` : "Substituted";
}

/** Unique recorded substitute providers (for the copied synthesis markdown). */
export function substitutedProviderNames(rows: SubstitutionRow[]): string[] {
  const names = rows.filter(isSubstituted).map((r) => providerDisplayName(r.provider));
  return [...new Set(names.filter((n): n is string => n !== null))];
}

/**
 * The "Model health" substitution chip: its label and tooltip.
 *  - label: the substitute model's display name only when `actualModel` was
 *    supplied and exactly one slot was substituted; otherwise the count.
 *  - tooltip: one line per substituted slot. With both requested and actual
 *    model recorded it reads exactly as before ("Slot: req → act (reason)");
 *    otherwise it states only the recorded facts.
 */
export function modelHealthSubstitution(rows: SubstitutionRow[]): { label: string | null; tooltip: string } {
  const substituted = rows.filter(isSubstituted);
  const count = substituted.length;
  const actualLabels = substituted
    .filter((r) => present(r.actualModel))
    .map((r) => getModelDisplayNameSafe(r.actualModel as string))
    .filter((l, i, arr) => arr.indexOf(l) === i);
  const label = count === 1 && actualLabels.length === 1 ? actualLabels[0] : count > 1 ? `${count}` : count > 0 ? "1" : null;

  const tooltip = substituted
    .map((r) => {
      const slot = getModelDisplayNameSafe(r.modelId);
      const raw = present(r.substitutionReason) ? String(r.substitutionReason) : "";
      const sanitized = raw.replace(/[\n\r]+/g, " ").trim();
      const reason = sanitized ? (sanitized.length > 28 ? `${sanitized.slice(0, 25)}…` : sanitized) : "";
      const suffix = reason ? ` (${reason})` : "";
      if (present(r.requestedModel) && present(r.actualModel)) return `${slot}: ${r.requestedModel} → ${r.actualModel}${suffix}`;
      const facts = [present(r.requestedModel) ? `requested ${r.requestedModel}` : null, present(r.actualModel) ? `answered by ${r.actualModel}` : null].filter(Boolean);
      return `${slot}: substituted${facts.length ? ` (${facts.join(", ")})` : ""}${suffix}`;
    })
    .join("\n");

  return { label, tooltip };
}

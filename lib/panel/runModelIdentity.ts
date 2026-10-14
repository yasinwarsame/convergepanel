/**
 * Completed-run model identity — the ONE place that decides how a finished
 * run, its exports, its share text and its review surfaces name a model.
 *
 * Two different things share the word "model" and must never be confused:
 *
 *  - the LOGICAL SLOT (`modelId`: chatgpt / claude / grok / perplexity /
 *    gemini). It names a product family, never a concrete model version.
 *    `runModelFamilyName()` renders it ("ChatGPT", "Claude", …).
 *  - the FROZEN PROVENANCE ConvergePanel recorded for that slot on that run
 *    (`requestedModel`, `provider`, substitution facts — persisted per row
 *    since Step 6.2a, frozen into exports since Step 6.2b).
 *    `runModelIdentityLabel()` renders it ("ChatGPT · requested: gpt-4o-mini").
 *
 * `requestedModel` is an ORCHESTRATION fact: the model string ConvergePanel
 * asked the provider for. It is not provider-attested proof of the model that
 * answered, so nothing here says "actual", "verified" or "confirmed".
 *
 * Deliberately independent of `lib/panelModels.ts`: those product labels
 * ("GPT 5.2", "Claude Opus 4.5", …) are selection/marketing copy and may
 * change at any time; a historical run's identity must not move with them,
 * nor with the current connector configuration. Nothing here reads either.
 * A missing fact is stated as not recorded, never inferred from the slot.
 *
 * Pure, client-safe, never throws.
 */

import type { ModelId } from "@/lib/types";
import type { AdaptiveExportRunProvenance } from "@/lib/adaptiveSchema/researchExport";

/** Version-free product-family names for the logical slots. */
export const RUN_MODEL_FAMILY_NAMES: Readonly<Record<ModelId, string>> = Object.freeze({
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
  perplexity: "Perplexity",
  gemini: "Gemini",
});

export const MODEL_NOT_RECORDED = "model not recorded";
export const PROVIDER_NOT_RECORDED = "provider not recorded";

const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  deepseek: "DeepSeek",
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "XAI",
  perplexity: "Perplexity",
  google: "Google",
});

/**
 * The frozen facts for one slot of one completed run. Every field except
 * `modelId` is optional and absent means NOT RECORDED. `substituted` is
 * tri-state: `undefined` means the substitution state itself is unknown.
 */
export type RunModelProvenanceFacts = {
  modelId: string;
  provider?: string;
  requestedModel?: string;
  substituted?: boolean;
  /** Persisted "<provider>:<model>" of what was originally requested (substituted rows only). */
  substitutedFrom?: string;
};

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Single-line display text: newlines/control characters collapsed, length bounded. */
function displayText(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 79)}…`;
}

function isSlotId(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(RUN_MODEL_FAMILY_NAMES, value.trim().toLowerCase());
}

/** The slot's product-family name. Never a version. Unknown slots render as recorded. */
export function runModelFamilyName(modelId: unknown): string {
  if (!present(modelId)) return "Unknown model";
  const id = modelId.trim();
  return Object.prototype.hasOwnProperty.call(RUN_MODEL_FAMILY_NAMES, id) ? RUN_MODEL_FAMILY_NAMES[id as ModelId] : displayText(id);
}

/**
 * Display name for a recorded provider; null when none was recorded. The live
 * normalizer's placeholder `"unknown"` is not a recorded provider either.
 */
export function providerDisplayName(provider: unknown): string | null {
  if (!present(provider)) return null;
  const p = provider.trim().toLowerCase();
  if (p === "unknown") return null;
  return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, p) ? PROVIDER_LABELS[p] : displayText(p.charAt(0).toUpperCase() + p.slice(1));
}

/**
 * The recorded requested model, or undefined. A value equal to a logical slot
 * id ("chatgpt") is a placeholder fallback, not a model identity, and is
 * treated as not recorded.
 */
function recordedRequestedModel(facts: RunModelProvenanceFacts): string | undefined {
  if (!present(facts.requestedModel) || isSlotId(facts.requestedModel)) return undefined;
  return displayText(facts.requestedModel);
}

/** The model part of a persisted "<provider>:<model>" substitutedFrom, or undefined. */
function substitutedFromModel(facts: RunModelProvenanceFacts): string | undefined {
  if (!present(facts.substitutedFrom)) return undefined;
  const s = facts.substitutedFrom.trim();
  const idx = s.indexOf(":");
  const model = idx > 0 ? s.slice(idx + 1).trim() : "";
  return model.length > 0 && !isSlotId(model) ? displayText(model) : undefined;
}

/**
 * Everything after the family name: "requested: gpt-4o-mini",
 * "model not recorded", or the substitution clause. Exposed for surfaces that
 * already show the family elsewhere (e.g. next to a model chip).
 */
export function runModelIdentityDetail(facts: RunModelProvenanceFacts): string {
  if (facts.substituted === true) {
    const original = recordedRequestedModel(facts) ?? substitutedFromModel(facts);
    const answeredBy = providerDisplayName(facts.provider) ?? PROVIDER_NOT_RECORDED;
    return `${original !== undefined ? `requested: ${original}` : MODEL_NOT_RECORDED} · substituted, answered by: ${answeredBy}`;
  }
  const requested = recordedRequestedModel(facts);
  return requested !== undefined ? `requested: ${requested}` : MODEL_NOT_RECORDED;
}

/**
 * The canonical completed-run identity of one slot:
 *   "ChatGPT · requested: gpt-4o-mini"
 *   "ChatGPT · model not recorded"
 *   "ChatGPT · requested: gpt-4o-mini · substituted, answered by: DeepSeek"
 */
export function runModelIdentityLabel(facts: RunModelProvenanceFacts): string {
  return `${runModelFamilyName(facts.modelId)} · ${runModelIdentityDetail(facts)}`;
}

/**
 * Facts from a saved or live panel result row (`PanelResultPublic` /
 * `PersistedPanelResultPublic`). Reads only what the row carries; a status of
 * "substituted" is the only substitution claim, any other present status is a
 * recorded non-substitution, and a missing status leaves it unknown.
 */
export function runModelProvenanceFromResultRow(row: {
  modelId: string;
  status?: unknown;
  provider?: unknown;
  requestedModel?: unknown;
  substitutedFrom?: unknown;
}): RunModelProvenanceFacts {
  const status = typeof row.status === "string" && row.status.length > 0 ? row.status : undefined;
  const substituted = status === undefined ? undefined : status === "substituted";
  return {
    modelId: row.modelId,
    ...(present(row.provider) ? { provider: row.provider } : {}),
    ...(present(row.requestedModel) ? { requestedModel: row.requestedModel } : {}),
    ...(substituted !== undefined ? { substituted } : {}),
    ...(substituted === true && present(row.substitutedFrom) ? { substitutedFrom: row.substitutedFrom } : {}),
  };
}

/**
 * Facts for one slot from an export's FROZEN run provenance (already read
 * back with `readFrozenRunProvenance`). A pre-6.2b export (`null`) or a slot
 * with no frozen entry yields only the slot — i.e. "model not recorded".
 */
export function runModelProvenanceFromExport(provenance: AdaptiveExportRunProvenance | null, modelId: string): RunModelProvenanceFacts {
  const entry = provenance?.models.find((m) => m.modelId === modelId);
  if (!entry) return { modelId };
  return {
    modelId,
    ...(present(entry.provider) ? { provider: entry.provider } : {}),
    ...(present(entry.requestedModel) ? { requestedModel: entry.requestedModel } : {}),
    ...(typeof entry.substituted === "boolean" ? { substituted: entry.substituted } : {}),
    ...(entry.substituted === true && present(entry.substitutedFrom) ? { substitutedFrom: entry.substitutedFrom } : {}),
  };
}

/**
 * The label for one slot given the run rows the caller holds. A slot whose
 * row the caller holds gets its full identity label (which may itself say
 * "model not recorded" when that row carries no requested model); a slot the
 * caller holds NO row for gets only its family name — a surface that never
 * received the record must not claim the model was "not recorded" either.
 */
export function runModelLabel(modelId: string, provenance?: readonly RunModelProvenanceFacts[] | null): string {
  const facts = provenance?.find((f) => f.modelId === modelId);
  return facts ? runModelIdentityLabel(facts) : runModelFamilyName(modelId);
}

/** `runModelLabel` over a list of slots. */
export function runModelLabels(modelIds: readonly string[], provenance?: readonly RunModelProvenanceFacts[] | null): string[] {
  return modelIds.map((id) => runModelLabel(id, provenance));
}

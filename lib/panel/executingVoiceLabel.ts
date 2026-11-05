/**
 * Executing-model attribution for agreement / consensus / key-finding displays.
 *
 * Owner rule: the identity of the model that ACTUALLY wrote a slot's text is
 * authoritative. A slot answered by the DeepSeek fallback (`status:
 * "substituted"`) is never named as its requested model ("ChatGPT agreed");
 * it is named "DeepSeek (substituting ChatGPT)" — the phrasing
 * `synthesizeReport` uses. Several slots answered by one substitute are ONE
 * independent model (`independentVoices` / `executingModelKey`), so a list of
 * agreeing slots is grouped by executing model before it is counted or named:
 * chatgpt + claude both answered by DeepSeek → one voice,
 * "DeepSeek (substituting ChatGPT, Claude)".
 *
 * Inputs are the run rows a surface already holds (live `ModelResult`s, saved
 * `PersistedPanelResultPublic` rows, or `RunModelProvenanceFacts`). A slot is
 * substituted only when its row SAYS so (`status: "substituted"` or
 * `substituted: true`); a slot the caller holds no row for is named by its
 * family only — nothing is inferred. Nothing stored is read-modified.
 *
 * Pure, client-safe, never throws.
 */

import { coerceStatus } from "./normalize";
import { executingModelKey, resolveExecutingModelKeys } from "./independentVoices";
import { providerDisplayName, runModelFamilyName } from "./runModelIdentity";

/** A row as any surface holds it: a result row (`status`) or provenance facts (`substituted`). */
export type ExecutingIdentityRow = {
  modelId: string;
  status?: unknown;
  substituted?: unknown;
  provider?: unknown;
};

/** Used when a substituted row recorded no provider (older saved runs). */
export const SUBSTITUTE_PROVIDER_NOT_RECORDED = "Substitute model";

function isSubstitutedRow(row: ExecutingIdentityRow | undefined): boolean {
  if (!row) return false;
  if (row.substituted === true) return true;
  return typeof row.status === "string" && coerceStatus(row.status) === "substituted";
}

function rowFor(slotId: string, rows: readonly ExecutingIdentityRow[] | null | undefined): ExecutingIdentityRow | undefined {
  if (!rows) return undefined;
  const id = String(slotId).trim();
  return rows.find((r) => r && String(r.modelId).trim() === id);
}

/** The display name of a substitute provider ("DeepSeek"), or the not-recorded fallback. */
function substituteName(provider: unknown): string {
  return providerDisplayName(provider) ?? SUBSTITUTE_PROVIDER_NOT_RECORDED;
}

/**
 * The executing model of one slot, for a surface naming who agreed / supported:
 *  - substituted slot → "DeepSeek (substituting ChatGPT)";
 *  - otherwise (or no row held) → the slot's family name ("ChatGPT").
 */
export function executingVoiceName(slotId: string, rows: readonly ExecutingIdentityRow[] | null | undefined): string {
  const row = rowFor(slotId, rows);
  if (!isSubstitutedRow(row)) return runModelFamilyName(slotId);
  return `${substituteName(row!.provider)} (substituting ${runModelFamilyName(slotId)})`;
}

export type ExecutingVoiceGroup = {
  /** `executingModelKey` of the group — one per independent executing model. */
  key: string;
  /** The slots this executing model answered, in input order. */
  slotIds: string[];
  /** "ChatGPT", or "DeepSeek (substituting ChatGPT, Claude)". */
  label: string;
  substituted: boolean;
};

/**
 * Group the slots of one agreement list by the model that executed them.
 * The number of groups is the number of INDEPENDENT models in the list;
 * repeated slot ids collapse too. Order: first appearance.
 */
export function groupSlotsByExecutingVoice(
  slotIds: readonly string[],
  rows: readonly ExecutingIdentityRow[] | null | undefined
): ExecutingVoiceGroup[] {
  const groups: ExecutingVoiceGroup[] = [];
  const byKey = new Map<string, ExecutingVoiceGroup>();
  const entries = slotIds
    .map((raw) => String(raw).trim())
    .filter((slotId) => slotId.length > 0)
    .map((slotId) => {
      const row = rowFor(slotId, rows);
      const substituted = isSubstitutedRow(row);
      return { slotId, substituted, key: executingModelKey({ modelId: slotId, status: substituted ? "substituted" : "ok", provider: row?.provider }) };
    });
  // An unrecorded substitute merges into a recorded substitute of the same list (it may have been that model).
  const keys = resolveExecutingModelKeys(entries.map((e) => e.key));
  for (let i = 0; i < entries.length; i++) {
    const { slotId, substituted } = entries[i];
    const key = keys[i];
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.slotIds.includes(slotId)) existing.slotIds.push(slotId);
      continue;
    }
    const group: ExecutingVoiceGroup = { key, slotIds: [slotId], label: "", substituted };
    byKey.set(key, group);
    groups.push(group);
  }
  for (const g of groups) {
    const families = g.slotIds.map((id) => runModelFamilyName(id)).join(", ");
    // Name the substitute by a recorded provider when any slot of the group recorded one.
    const recorded = g.slotIds.map((id) => rowFor(id, rows)?.provider).find((p) => providerDisplayName(p) !== null);
    g.label = g.substituted ? `${substituteName(recorded ?? rowFor(g.slotIds[0], rows)?.provider)} (substituting ${families})` : families;
  }
  return groups;
}

/** How many independent executing models a list of slots represents. */
export function independentVoiceCount(slotIds: readonly string[], rows: readonly ExecutingIdentityRow[] | null | undefined): number {
  return groupSlotsByExecutingVoice(slotIds, rows).length;
}

/** "1 model" / "2 models" — the count is of independent executing models. */
export function independentModelCountText(count: number): string {
  return `${count} model${count === 1 ? "" : "s"}`;
}

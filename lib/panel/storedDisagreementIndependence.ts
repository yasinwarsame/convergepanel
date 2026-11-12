/**
 * Whether a STORED research disagreement may be presented as a disagreement between models.
 *
 * Owner rule: the model that actually executed a slot determines identity and independence. Two slots answered by the
 * DeepSeek fallback are ONE model, so "ChatGPT says 1789, Claude says 1792" from a run where DeepSeek answered both
 * slots is one model contradicting itself, not two models disagreeing. Stored synthesis text is never rewritten; this
 * module only classifies each stored item for display, from what the run document persisted:
 *  - "cross_model": a genuine disagreement between independent executing models — shown as a disagreement;
 *  - "same_executing_model": the item's positions are attributed to slots answered by one executing model (in a run
 *    that does have ≥ 2 independent models) — not a cross-model disagreement;
 *  - "single_independent_model": the run's persisted rows reduce to fewer than two independent executing models — no
 *    disagreement between models can exist;
 *  - "independence_unverified": execution identity was not persisted (`storedRunPerModelRows` null), or the item
 *    cannot be attributed to slots in a run where some slots collapse onto one executing model.
 *
 * Attribution: an item names slots through `positionsByModel` keys (StructuredSynthesis), `positions[].model` (V2
 * report) or `models` (legacy `keyDisagreements`). A name maps to a persisted row by slot id, by family name
 * ("ChatGPT"), or by the executing-model label `synthesizeReport` writes ("DeepSeek (substituting ChatGPT, Claude)").
 * Any name that maps to no row makes the item unattributable; nothing is inferred from slots. An item attributed to
 * ≥ 2 slots is a disagreement between models only when those slots are ≥ 2 independent executing models
 * (`independentVoiceCount`), else "same_executing_model" — the only path to that label, so it is used only when the
 * named slots really collapsed onto one executing model. An item attributed to fewer than two slots (or
 * unattributable) falls back to the run: genuine only when every usable slot is its own independent model. An item
 * whose raw `positionsByModel` keys already reduce to one executing model (the synthesis path's original rule) is never
 * genuine either.
 *
 * ONE rule for every surface: the governance queue (stored rows, `classifyStoredDisagreement`) and the live panel /
 * gate / share / panel verdict (`crossModelDisagreements`, live rows) both call `classifyDisagreementAgainstRows`, so
 * the same record is never a model disagreement on one surface and not on another. With ≥ 2 independent executing
 * models and no collapsed slots every item is "cross_model" — exactly the behaviour before executing-model attribution.
 *
 * Pure, server- and client-safe; never mutates its input.
 */

import { coerceStatus } from "./normalize";
import {
  clientRowText,
  independentSynthesisResponders,
  storedRunConsensusIndependence,
  storedRunPerModelRows,
  type ClientSynthesisRow,
  type StoredConsensusIndependence,
} from "./independentVoices";
import { runModelFamilyName } from "./runModelIdentity";
import { independentVoiceCount } from "./executingVoiceLabel";

export type StoredDisagreementBasis = "cross_model" | "same_executing_model" | "single_independent_model" | "independence_unverified";

/** A stored item that is NOT presented as a cross-model disagreement. */
export type QualifiedDisagreementBasis = Exclude<StoredDisagreementBasis, "cross_model">;

/** Display text for a stored disagreement that is not a disagreement between independent models. */
export const QUALIFIED_DISAGREEMENT_TEXT: Readonly<Record<QualifiedDisagreementBasis, string>> = Object.freeze({
  same_executing_model: "Same executing model — not a disagreement between independent models",
  single_independent_model: "One independent model — not a disagreement between models",
  independence_unverified: "Model independence unverified — not confirmed as a disagreement between models",
});

/** What one stored run proves about execution identity, computed once per run. */
export type StoredRunIndependenceContext = {
  independence: StoredConsensusIndependence;
  rows: ClientSynthesisRow[] | null;
  /** Usable slots outnumber independent executing models (some slots were answered by the same model). */
  collapsed: boolean;
};

/** A row that answered (ok / substituted) with stored text — the rows independence is judged from. */
function isUsableRow(r: ClientSynthesisRow): boolean {
  const s = coerceStatus(r.status);
  return (s === "ok" || s === "substituted") && clientRowText(r).trim().length > 0;
}

export function storedRunIndependenceContext(data: Record<string, unknown> | null | undefined): StoredRunIndependenceContext {
  const rows = storedRunPerModelRows(data);
  const independence = storedRunConsensusIndependence(data);
  if (!rows) return { independence, rows: null, collapsed: false };
  return { independence, rows, collapsed: rowsCollapsed(rows) };
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** The persisted slot ids one stored model name refers to, or null when it maps to no row. */
function slotsForName(name: string, rows: readonly ClientSynthesisRow[]): string[] | null {
  const n = norm(name);
  if (n.length === 0) return null;
  const direct = rows.find((r) => norm(r.modelId) === n || norm(runModelFamilyName(r.modelId)) === n);
  if (direct) return [direct.modelId.trim()];
  // "DeepSeek (substituting ChatGPT, Claude)" — the executing-model label synthesizeReport writes.
  const m = /\(substituting ([^)]+)\)\s*$/i.exec(name.trim());
  if (!m) return null;
  const out: string[] = [];
  for (const part of m[1].split(",")) {
    const slots = slotsForName(part, rows);
    if (!slots) return null;
    out.push(...slots);
  }
  return out.length > 0 ? out : null;
}

/** The model names a stored disagreement item carries, or null when it carries none (a plain string, or no names). */
export function storedDisagreementModelNames(item: unknown): string[] | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const names: string[] = [];
  if (o.positionsByModel && typeof o.positionsByModel === "object" && !Array.isArray(o.positionsByModel)) {
    names.push(...Object.keys(o.positionsByModel as Record<string, unknown>));
  }
  if (Array.isArray(o.positions)) {
    for (const p of o.positions) {
      if (p && typeof p === "object" && typeof (p as Record<string, unknown>).model === "string") names.push((p as { model: string }).model);
    }
  }
  if (Array.isArray(o.models)) {
    for (const m of o.models) if (typeof m === "string") names.push(m);
  }
  const cleaned = names.map((x) => x.trim()).filter((x) => x.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

/** The trimmed, non-empty `positionsByModel` keys of an item (the synthesis path's raw attribution). */
function rawPositionKeys(item: unknown): string[] {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const pbm = (item as Record<string, unknown>).positionsByModel;
  if (!pbm || typeof pbm !== "object" || Array.isArray(pbm)) return [];
  return Array.from(new Set(Object.keys(pbm as Record<string, unknown>).map((k) => k.trim()).filter((k) => k.length > 0)));
}

/**
 * Whether the run's usable rows outnumber its independent executing models (some slots were answered by one model).
 * Rows without stored text are not usable, so rows that carry no text never read as collapsed.
 */
export function rowsCollapsed(rows: readonly ClientSynthesisRow[]): boolean {
  return rows.filter(isUsableRow).length > independentSynthesisResponders(rows).length;
}

/**
 * Classify one disagreement item (string or object) against a run's rows — the one rule behind the queue
 * (`classifyStoredDisagreement`) and the live panel / gate / share (`crossModelDisagreements`).
 */
export function classifyDisagreementAgainstRows(item: unknown, ctx: StoredRunIndependenceContext): StoredDisagreementBasis {
  if (ctx.independence === "unverified" || !ctx.rows) return "independence_unverified";
  if (ctx.independence === "insufficient") return "single_independent_model";
  const rows = ctx.rows;
  // The synthesis path's original rule: raw keys that reduce to one executing model are one model's positions.
  const raw = rawPositionKeys(item);
  if (raw.length >= 2 && independentVoiceCount(raw, rows) < 2) return "same_executing_model";
  const names = storedDisagreementModelNames(item);
  let slots: string[] | null = null;
  if (names) {
    slots = [];
    for (const name of names) {
      const s = slotsForName(name, rows);
      if (!s) {
        slots = null;
        break;
      }
      slots.push(...s);
    }
  }
  const distinct = slots ? Array.from(new Set(slots)) : [];
  if (distinct.length < 2) {
    // Unattributable (or one slot named): judged by the run — genuine only when no slots collapsed onto one model.
    return ctx.collapsed ? "independence_unverified" : "cross_model";
  }
  return independentVoiceCount(distinct, rows) >= 2 ? "cross_model" : "same_executing_model";
}

/** Classify one stored disagreement item (string or object) against its run. */
export function classifyStoredDisagreement(item: unknown, ctx: StoredRunIndependenceContext): StoredDisagreementBasis {
  return classifyDisagreementAgainstRows(item, ctx);
}

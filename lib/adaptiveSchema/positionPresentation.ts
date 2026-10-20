/**
 * Disagreement-position presentation (Order 5, Contract P)
 *
 * The one place that decides how a report marked `presentation.disagreementPositionVersion === 1` states model
 * positions, agreement and disagreement. It never computes, rescores or rewrites anything stored: it READS the
 * persisted rows (`alignedClaims`, the authority for every position) and the stored report, and returns a read-time
 * view of the report — never persisted, never exported as JSON — in which:
 *
 *  - a claim row reads by its validated per-slot positions; only a SPLIT claim row is described by a claim kind
 *    (recorded opposing positions, recorded opposition, unresolved positions, …), never a consensus or majority row;
 *  - a field-derived row (metric / scenario / step / scalar value) reads as a computed comparison of stated values —
 *    never as a vote, a claim split, "support" or "consensus", whatever its stored stance enum says; no median or
 *    tolerance basis is ever stated (the comparator's basis is not recoverable from stored data);
 *  - every stored per-claim entry joins its row by exact claim text, unique, or shows that position details are
 *    unavailable — never by array index alone, never by similar wording;
 *  - a slot is named by its recorded logical slot ("Claude slot"), with its recorded substitution, never as the
 *    verified author of a position;
 *  - all model-written prose (narrative, explanations, bias observations, coverage notes) is withheld, with a computed
 *    disclosure — never filtered, never rewritten, never replaced by an invented panel position.
 *
 * A report without the exact marker is returned unchanged (the same object): historical and unmarked records render
 * exactly as before. Computed values — status, scores, certainty, gate — are never changed.
 *
 * Pure and client-safe: no "server-only", no I/O, no mutation of its inputs.
 */

import type { AdaptiveSynthesisReport, AdaptiveVerdictCard, AlignedClaimStatus, PresentedAnswerClaim, PresentedClaim, PresentedDisagreement, PresentedUnresolvedClaim } from "./types";
import { ALIGNED_CLAIM_STATUSES } from "./types";
import { NO_CONSENSUS_IDENTIFIED, LIMITED_COVERAGE_REASON, ROW_AGREEMENT_WORDING } from "./agreementNarrative";
import { normalizeForComparison } from "./comparisonNormalization";
import { CAUTION_NEXT_STEP_WITHOUT_DISAGREEMENT, VERDICT_NEXT_STEPS } from "./config";
import { providerDisplayName, runModelFamilyName, type RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";

// ─── Marker ─────────────────────────────────────────────────────────────────

export const DISAGREEMENT_POSITION_MARKER = "disagreementPositionVersion" as const;
export const DISAGREEMENT_POSITION_VERSION = 1 as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Marked iff report.presentation is an object whose disagreementPositionVersion is exactly the number 1. Anything else fails closed to the historical path. */
export function isPositionMarked(report: unknown): boolean {
  if (!isPlainObject(report)) return false;
  const p = report.presentation;
  return isPlainObject(p) && Object.prototype.hasOwnProperty.call(p, DISAGREEMENT_POSITION_MARKER) && p[DISAGREEMENT_POSITION_MARKER] === DISAGREEMENT_POSITION_VERSION;
}

// ─── Provenance ─────────────────────────────────────────────────────────────

export const PANEL_SLOT_HEADING = "Panel slot (as recorded)";
export const POSITIONS_BY_SLOT_HEADING = "Positions by panel slot (as recorded)";

export type SlotLabelFormat = "full" | "compact";

/**
 * A slot named by its recorded logical slot — never as the verified author of a position.
 *  full:    "Claude slot", "Claude slot (substituted; answered by DeepSeek)", "… answered by provider not recorded"
 *  compact: the family name; null for a substituted slot (a constrained format omits the attribution rather than drop
 *           the qualifier).
 */
export function slotLabel(slot: string, provenance: readonly RunModelProvenanceFacts[] | null | undefined, format: SlotLabelFormat): string | null {
  const family = runModelFamilyName(slot);
  const facts = provenance?.find((f) => f && f.modelId === slot);
  if (facts?.substituted === true) {
    if (format === "compact") return null;
    return `${family} slot (substituted; answered by ${providerDisplayName(facts.provider) ?? "provider not recorded"})`;
  }
  return format === "full" ? `${family} slot` : family;
}

// ─── Read-side validator ────────────────────────────────────────────────────

const STANCES = ["agrees", "partial", "disputes", "unclear"] as const;
type Stance = (typeof STANCES)[number];
const isStance = (v: unknown): v is Stance => typeof v === "string" && (STANCES as readonly string[]).includes(v);

export type CellOrigin = "claim" | "inferred" | "computed" | "not_recorded" | "unrecognized";

export type SlotReading =
  | { slot: string; kind: "position"; stance: Stance; origin: CellOrigin; excerpt: string | null; raw: unknown }
  | { slot: string; kind: "conflicting"; stances: Stance[] }
  | { slot: string; kind: "unrecognized" }
  | { slot: string; kind: "unreadable" }
  | { slot: string; kind: "none" };

export interface RowReading {
  slots: SlotReading[];
  /** Stored entries that name no slot of this panel (unknown / missing / non-string modelId, non-object cells). */
  unattributable: number;
}

function originOf(cell: Record<string, unknown>): CellOrigin {
  const o = cell.origin;
  if (o === undefined) return cell.backfilled === true ? "inferred" : "not_recorded";
  if (!isPlainObject(o)) return "unrecognized";
  if (o.kind === "claim") return "claim";
  if (o.kind === "inferred") return "inferred";
  if (o.kind === "field_derived") return "computed";
  return "unrecognized";
}

/**
 * Reads a row's stored cells against the panel roster without trusting them. A cell is attributed by its own modelId
 * (never by array position); same-stance duplicates collapse to one position; a slot holding different stances is
 * "conflicting" (disclosed, never first-wins); an unknown stance is unrecognized; a cell naming no slot of this panel
 * is unattributable. A slot whose own index holds an unreadable entry reads as unreadable, not as silent.
 */
export function readSlots(cells: unknown, roster: readonly string[]): RowReading {
  if (!Array.isArray(cells)) return { slots: roster.map((slot) => ({ slot, kind: "unreadable" as const })), unattributable: 0 };
  const bySlot = new Map<string, Record<string, unknown>[]>();
  let unattributable = 0;
  cells.forEach((c) => {
    if (c === null || c === undefined) return;
    if (!isPlainObject(c) || typeof c.modelId !== "string" || !roster.includes(c.modelId)) {
      unattributable += 1;
      return;
    }
    bySlot.set(c.modelId, [...(bySlot.get(c.modelId) ?? []), c]);
  });
  const slots = roster.map((slot, i): SlotReading => {
    const own = bySlot.get(slot);
    if (own && own.length > 0) {
      const stored = [...new Set(own.map((c) => c.stance))];
      if (stored.length > 1) {
        const readable = stored.filter(isStance);
        return readable.length > 0 ? { slot, kind: "conflicting", stances: readable } : { slot, kind: "unrecognized" };
      }
      if (!isStance(stored[0])) return { slot, kind: "unrecognized" };
      const c = own[0];
      return { slot, kind: "position", stance: stored[0], origin: originOf(c), excerpt: typeof c.excerpt === "string" && c.excerpt.trim() ? c.excerpt : null, raw: c.raw };
    }
    const atIndex = cells[i];
    if (atIndex === null || atIndex === undefined) return { slot, kind: "none" };
    // The entry stored at this slot's index belongs to another readable slot: this slot is simply silent.
    if (isPlainObject(atIndex) && typeof atIndex.modelId === "string" && roster.includes(atIndex.modelId) && atIndex.modelId !== slot) return { slot, kind: "none" };
    return { slot, kind: "unreadable" };
  });
  return { slots, unattributable };
}

const isOpaque = (r: RowReading) => r.unattributable > 0 || r.slots.some((s) => s.kind === "unrecognized" || s.kind === "unreadable");
const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;

/** Disclosures for anything the reading could not attribute or read — appended to every row statement that has any. */
function readingTail(r: RowReading): string[] {
  const conflicting = r.slots.filter((s) => s.kind === "conflicting").length;
  const unreadable = r.slots.filter((s) => s.kind === "unreadable" || s.kind === "unrecognized").length;
  return [
    conflicting ? `${plural(conflicting, "panel slot")} with conflicting stored positions` : "",
    r.unattributable ? `${plural(r.unattributable, "stored position")} could not be attributed to a panel slot` : "",
    unreadable ? `${plural(unreadable, "position")} could not be read` : "",
  ].filter(Boolean);
}

// ─── Row type ───────────────────────────────────────────────────────────────

export type RowType = "claim" | "metric" | "scenario" | "step" | "scalar" | "empty" | "unknown";
const FIELD_TYPES = ["metric", "scenario", "step", "scalar"] as const;

/** From the cells' recorded origins only: claim / inferred → claim; field_derived → its field type; no cells → empty; mixed, unrecorded or unknown → unknown (fails closed). */
export function rowTypeOf(cells: unknown): RowType {
  if (!Array.isArray(cells)) return "unknown";
  const kinds = new Set<string>();
  for (const c of cells) {
    if (c === null || c === undefined) continue;
    if (!isPlainObject(c)) {
      kinds.add("unknown");
      continue;
    }
    const o = c.origin;
    if (isPlainObject(o) && (o.kind === "claim" || o.kind === "inferred")) kinds.add("claim");
    else if (isPlainObject(o) && o.kind === "field_derived" && (FIELD_TYPES as readonly unknown[]).includes(o.fieldType)) kinds.add(String(o.fieldType));
    else if (o === undefined && c.backfilled === true) kinds.add("claim");
    else kinds.add("unknown");
  }
  if (kinds.size === 0) return "empty";
  return kinds.size === 1 ? ([...kinds][0] as RowType) : "unknown";
}

// ─── Claim rows ─────────────────────────────────────────────────────────────

export type ClaimKind =
  | "opposing_positions"
  | "conflicting_only"
  | "recorded_opposition"
  | "opposition_with_unresolved"
  | "partial_without_opposition"
  | "support_with_unresolved"
  | "no_clear_position"
  | "no_positions";

const supports = (s: SlotReading) => (s.kind === "position" && (s.stance === "agrees" || s.stance === "partial")) || (s.kind === "conflicting" && s.stances.some((x) => x === "agrees" || x === "partial"));
const disputes = (s: SlotReading) => (s.kind === "position" && s.stance === "disputes") || (s.kind === "conflicting" && s.stances.includes("disputes"));

/** The kind of a SPLIT claim row, from its validated slots. Opposition requires a supporting slot and a disputing slot that are different slots. */
export function claimKind(r: RowReading): ClaimKind {
  const supSlots = r.slots.filter(supports).map((s) => s.slot);
  const disSlots = r.slots.filter(disputes).map((s) => s.slot);
  if (supSlots.length > 0 && disSlots.length > 0) return supSlots.some((a) => disSlots.some((b) => a !== b)) ? "opposing_positions" : "conflicting_only";
  const unclear = r.slots.some((s) => s.kind === "position" && s.stance === "unclear");
  if (disSlots.length > 0) return !isOpaque(r) && !unclear && r.slots.every((s) => s.kind === "none" || disputes(s)) && r.slots.every((s) => s.kind !== "conflicting") ? "recorded_opposition" : "opposition_with_unresolved";
  if (supSlots.length > 0) return r.slots.some((s) => s.kind === "position" && s.stance === "agrees") ? "support_with_unresolved" : "partial_without_opposition";
  return r.slots.every((s) => s.kind === "none") && !isOpaque(r) ? "no_positions" : "no_clear_position";
}

function claimKindText(kind: ClaimKind, r: RowReading): string {
  const sup = r.slots.filter(supports).length;
  const dis = r.slots.filter(disputes).length;
  const unclear = r.slots.filter((s) => s.kind === "position" && s.stance === "unclear").length;
  const conflicting = r.slots.filter((s) => s.kind === "conflicting").length;
  const amongReadable = isOpaque(r) ? " among readable, attributable positions" : "";
  const tail = [unclear ? `${unclear} unclear` : "", ...readingTail(r)].filter(Boolean);
  const t = tail.length ? `; ${tail.join("; ")}` : "";
  switch (kind) {
    case "opposing_positions":
      return `${plural(sup, "panel slot")} supporting or partially supporting and ${dis} disputing${conflicting ? " (including conflicting stored positions)" : ""}${t}.`;
    case "conflicting_only":
      return `Conflicting stored positions within ${plural(conflicting, "panel slot")}; no opposition between different panel slots is recorded${t}; not a split between panel slots.`;
    case "recorded_opposition":
      return `Every panel slot with a position disputes the claim (${dis}); recorded opposition to the claim, not a split between panel slots.`;
    case "opposition_with_unresolved":
      return `${dis} disputing and no supporting position recorded${amongReadable}${t}; not a split between panel slots.`;
    case "partial_without_opposition":
      return `Partial or qualified positions only (${sup}); no disputing position recorded${amongReadable}${t}; not a split between panel slots.`;
    case "support_with_unresolved":
      return `${sup} supporting or partially supporting; no disputing position recorded${amongReadable}${t}; not a split between panel slots.`;
    case "no_clear_position":
      return `No clear supporting or disputing position is recorded${t}.`;
    case "no_positions":
      return NO_RECORDED_POSITIONS;
  }
}

export const NO_RECORDED_POSITIONS = "No recorded model positions.";

const STATUS_HEADING: Readonly<Record<AlignedClaimStatus, RowHeading>> = {
  consensus: "Consensus",
  majority: "Majority support",
  limited_coverage: "Limited coverage",
  split: "Unresolved claim",
  single_source: "Single source",
};

const isKnownStatus = (s: unknown): s is AlignedClaimStatus => typeof s === "string" && (ALIGNED_CLAIM_STATUSES as readonly string[]).includes(s);

/** A non-split claim row's computed status, worded as stored statuses always are, but counted from its validated slots (a duplicated slot is counted once). */
function claimStatusText(status: AlignedClaimStatus, r: RowReading, claimText: string, dispatched: number): string {
  const positions = r.slots.filter((s): s is Extract<SlotReading, { kind: "position" }> => s.kind === "position");
  const facts = {
    claimId: "",
    claimText,
    status,
    supporting: positions.filter((s) => s.stance === "agrees" || s.stance === "partial").length,
    disputing: positions.filter((s) => s.stance === "disputes").length,
    listed: positions.length,
    assessed: positions.filter((s) => s.stance !== "unclear").length,
    dispatched,
    contestedNote: null,
  };
  const tail = readingTail(r);
  return `${ROW_AGREEMENT_WORDING[status](facts)}${tail.length ? `; ${tail.join("; ")}` : ""}`;
}

// ─── Field rows ─────────────────────────────────────────────────────────────

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A number for display: at most 4 decimal places, no float noise ("0.45", "45", "0.0001"). */
export function formatNumber(v: number): string {
  const rounded = Math.round(v * 10_000) / 10_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

interface FieldResult {
  heading: RowHeading;
  text: string;
  /** Per slot, how the slot's stated value reads in this comparison. */
  slotValue: Map<string, string>;
}

function fieldPresentation(type: (typeof FIELD_TYPES)[number], r: RowReading): FieldResult {
  const slotValue = new Map<string, string>();
  for (const s of r.slots) slotValue.set(s.slot, s.kind === "none" ? "No value" : s.kind === "position" ? "" : s.kind === "conflicting" ? "Conflicting stored values" : "Unreadable value");
  const positions = r.slots.filter((s): s is Extract<SlotReading, { kind: "position" }> => s.kind === "position");
  const notStated = (n: number) => (n > 0 ? `; ${plural(n, "panel slot")} gave no comparable value` : "");

  if (type === "metric" || type === "scenario") {
    const values = positions.map((s) => {
      const raw = isPlainObject(s.raw) ? s.raw : {};
      const v = type === "metric" ? raw.value : raw.probability;
      const unit = type === "metric" && typeof raw.unit === "string" ? raw.unit.trim() : "";
      return { slot: s.slot, v, unit };
    });
    const numeric = values.filter((x): x is { slot: string; v: number; unit: string } => finite(x.v));
    const show = (x: { v: number; unit: string }) => (type === "scenario" ? `${formatNumber(x.v * 100)}%` : `${formatNumber(x.v)}${x.unit ? ` ${x.unit}` : ""}`);
    for (const x of values) slotValue.set(x.slot, finite(x.v) ? show({ v: x.v, unit: x.unit }) : "No numeric value");
    const missing = values.length - numeric.length;
    if (numeric.length === 0) return { heading: "Comparison", text: "Not comparable: no numeric values were given.", slotValue };
    const units = [...new Set(numeric.map((x) => x.unit.toLowerCase()))];
    if (type === "metric" && units.length > 1) return { heading: "Comparison", text: `Not compared: the values use different units (${units.map((u) => (u ? `“${u}”` : "no unit")).join(", ")}).`, slotValue };
    if (numeric.length === 1) return { heading: "Comparison", text: `Only 1 numeric value was given; there is nothing to compare it with${notStated(missing)}.`, slotValue };
    const distinct = [...new Set(numeric.map((x) => x.v))].sort((a, b) => a - b);
    if (distinct.length === 1) return { heading: "Values match", text: `All ${numeric.length} numeric values are identical${notStated(missing)}.`, slotValue };
    const lo = show({ v: distinct[0], unit: numeric[0].unit });
    const hi = show({ v: distinct[distinct.length - 1], unit: numeric[0].unit });
    return { heading: "Values differ", text: `Values differ: ${numeric.length} numeric values, ${distinct.length} distinct, from ${lo} to ${hi}${notStated(missing)}. A computed comparison of the stated values, not model positions.`, slotValue };
  }

  // step / scalar: grouped by the comparator's own normalizer (case and common punctuation ignored).
  const textOf = (s: Extract<SlotReading, { kind: "position" }>) => {
    const raw = isPlainObject(s.raw) ? s.raw : {};
    const t = type === "step" && typeof raw.action === "string" ? raw.action : s.excerpt;
    return typeof t === "string" && t.trim() ? t : null;
  };
  const groups = new Map<string, string[]>();
  let missing = 0;
  for (const s of positions) {
    const t = textOf(s);
    if (t === null) {
      missing += 1;
      slotValue.set(s.slot, type === "step" ? "No step text" : "No answer");
      continue;
    }
    const key = normalizeForComparison(t);
    groups.set(key, [...(groups.get(key) ?? []), s.slot]);
  }
  const noun = type === "step" ? "step" : "answer";
  for (const slots of groups.values())
    for (const sl of slots) slotValue.set(sl, slots.length > 1 ? `Same ${type === "step" ? "wording" : "answer"} as ${plural(slots.length - 1, "other panel slot")}` : `${type === "step" ? "Wording" : "Answer"} given by no other panel slot`);
  const given = [...groups.values()].reduce((n, g) => n + g.length, 0);
  const sizes = [...groups.values()].map((g) => g.length).sort((a, b) => b - a);
  if (given === 0) return { heading: "Comparison", text: type === "step" ? "Not comparable: no step text was given at this position." : "No answers to compare.", slotValue };
  if (given === 1) return { heading: "Comparison", text: `Only 1 panel slot gave ${type === "step" ? "a step at this position" : "an answer"}; there is nothing to compare it with${notStated(missing)}.`, slotValue };
  const ignoring = "ignoring case and punctuation";
  if (groups.size === 1) return { heading: "Values match", text: type === "step" ? `All ${given} panel slots that gave a step at this position use the same wording (${ignoring})${notStated(missing)}.` : `All ${given} answers match (${ignoring})${notStated(missing)}.`, slotValue };
  if (type === "step") return { heading: "Values differ", text: `${groups.size} different wordings at this position among ${given} panel slots (compared by wording only, ${ignoring})${notStated(missing)}. A computed comparison, not model positions.`, slotValue };
  if (sizes[0] === 1) return { heading: "Values differ", text: `No two panel slots gave the same ${noun} (${groups.size} different ${noun}s, ${ignoring})${notStated(missing)}.`, slotValue };
  if (sizes[0] === sizes[1]) return { heading: "Values differ", text: `Answers differ: ${groups.size} different answers, with no single most common answer (${ignoring})${notStated(missing)}.`, slotValue };
  return { heading: "Values differ", text: `Answers differ: ${groups.size} different answers; the most common was given by ${sizes[0]} of ${given} panel slots (${ignoring})${notStated(missing)}.`, slotValue };
}

// ─── One row ────────────────────────────────────────────────────────────────

export type RowHeading =
  | "Recorded opposing positions"
  | "Unresolved claim"
  | "Consensus"
  | "Majority support"
  | "Limited coverage"
  | "Single source"
  | "Unrecognised status"
  | "Values match"
  | "Values differ"
  | "Comparison"
  | "No recorded positions"
  | "Position details unavailable";

export interface PresentedSlotPosition {
  slot: string;
  /** slotLabel(…, "full"). */
  label: string;
  /** How the slot's position reads: "Supports", "Disputes", a stated value, "No position recorded", … */
  position: string;
  /** The stored excerpt, never shown as a verbatim quote, with how it was recorded; null when none. */
  excerpt: { text: string; note: string } | null;
}

export interface RowView {
  rowType: RowType;
  heading: RowHeading;
  /** The row's computed statement, e.g. "1 panel slot supporting or partially supporting and 1 disputing; 1 unclear." */
  text: string;
  /** True only for a split claim row with supporting and disputing positions in different slots. */
  isOpposition: boolean;
  /** The claim row's stored status, when it is a claim row with a known status. */
  claimStatus: AlignedClaimStatus | null;
  slots: PresentedSlotPosition[];
  /** Slots supporting / disputing a CLAIM row (full labels); empty for every other row type. */
  supporters: string[];
  disputers: string[];
  /** The canonical contested note of a claim row, when its stored contested dimensions are well-formed. */
  contested: string | null;
}

export const POSITION_DETAILS_UNAVAILABLE = "Position details unavailable: the stored claim could not be matched to a unique recorded row.";
export const ROW_TYPE_UNRECORDED = "Position details unavailable: this row's comparison type was not recorded.";

const EXCERPT_NOTE: Readonly<Record<CellOrigin, string>> = {
  claim: "recorded excerpt; may be paraphrased",
  inferred: "inferred from the response text, not stated by the model",
  computed: "stated value",
  not_recorded: "recorded excerpt; origin not recorded",
  unrecognized: "recorded excerpt; origin not recognized",
};

const CLAIM_POSITION: Readonly<Record<Stance, string>> = {
  agrees: "Supports",
  partial: "Partially supports",
  disputes: "Disputes",
  unclear: "Position unclear",
};

function validContested(row: Record<string, unknown>): string | null {
  const c = row.contested;
  if (!isPlainObject(c) || c.marked !== true) return null;
  const { markedCount, listedCount } = c;
  if (!Number.isInteger(markedCount) || !Number.isInteger(listedCount) || (markedCount as number) < 1 || (listedCount as number) < (markedCount as number)) return null;
  const withCells = Array.isArray(row.cells) ? row.cells.filter(Boolean).length : 0;
  const m = markedCount as number;
  const l = listedCount as number;
  if (m === l && l === withCells) return l === 1 ? "the 1 model that listed this claim marks it contested" : `all ${l} models that listed this claim mark it contested`;
  return `${m} of ${l} model${l === 1 ? "" : "s"} that listed this claim ${m === 1 ? "marks" : "mark"} it contested`;
}

/** The single entry point every consumer uses for one stored row. */
export function rowView(row: unknown, roster: readonly string[], provenance?: readonly RunModelProvenanceFacts[] | null): RowView {
  const r = isPlainObject(row) ? row : {};
  const cells = r.cells;
  const type = rowTypeOf(cells);
  const reading = readSlots(cells, roster);
  const label = (slot: string) => slotLabel(slot, provenance, "full")!;
  const base = { rowType: type, isOpposition: false, claimStatus: null as AlignedClaimStatus | null, supporters: [] as string[], disputers: [] as string[], contested: null as string | null };

  const slotPositions = (valueOf: (s: SlotReading) => string): PresentedSlotPosition[] =>
    reading.slots.map((s) => ({
      slot: s.slot,
      label: label(s.slot),
      position: valueOf(s),
      excerpt: s.kind === "position" && s.excerpt && s.origin !== "computed" ? { text: s.excerpt, note: EXCERPT_NOTE[s.origin] } : null,
    }));
  const claimPosition = (s: SlotReading) =>
    s.kind === "position" ? CLAIM_POSITION[s.stance] : s.kind === "conflicting" ? "Conflicting stored positions" : s.kind === "unrecognized" ? "Unrecognized position" : s.kind === "unreadable" ? "No readable position" : "No position recorded";

  if (type === "empty") return { ...base, heading: "No recorded positions", text: NO_RECORDED_POSITIONS, slots: slotPositions(claimPosition) };
  if (type === "unknown") return { ...base, heading: "Position details unavailable", text: ROW_TYPE_UNRECORDED, slots: slotPositions(() => "Position details unavailable") };

  if (type === "claim") {
    const status = r.status;
    const claimText = typeof r.claimText === "string" ? r.claimText : "";
    const supporters = reading.slots.filter((s) => s.kind === "position" && (s.stance === "agrees" || s.stance === "partial")).map((s) => label(s.slot));
    const disputers = reading.slots.filter((s) => s.kind === "position" && s.stance === "disputes").map((s) => label(s.slot));
    const common = { ...base, slots: slotPositions(claimPosition), supporters, disputers, contested: validContested(r) };
    if (status === "split") {
      const kind = claimKind(reading);
      return { ...common, claimStatus: "split", heading: kind === "opposing_positions" ? "Recorded opposing positions" : kind === "no_positions" ? "No recorded positions" : "Unresolved claim", text: claimKindText(kind, reading), isOpposition: kind === "opposing_positions" };
    }
    if (!isKnownStatus(status)) return { ...common, heading: "Unrecognised status", text: `unrecognised status — not presented as agreement${readingTail(reading).length ? `; ${readingTail(reading).join("; ")}` : ""}` };
    return { ...common, claimStatus: status, heading: STATUS_HEADING[status], text: claimStatusText(status, reading, claimText, roster.length) };
  }

  const field = fieldPresentation(type, reading);
  return { ...base, heading: field.heading, text: field.text, slots: slotPositions((s) => field.slotValue.get(s.slot) ?? "No value") };
}

// ─── Panel statement ────────────────────────────────────────────────────────

export interface PanelCounts {
  rows: number;
  dispatched: number;
  claimByStatus: Record<Exclude<AlignedClaimStatus, "split">, number>;
  opposing: number;
  unresolved: number;
  unrecognised: number;
  valuesMatch: number;
  valuesDiffer: number;
  notComparable: number;
  noPositions: number;
  unavailable: number;
}

export function panelCounts(rows: readonly unknown[], roster: readonly string[]): PanelCounts {
  const c: PanelCounts = { rows: rows.length, dispatched: roster.length, claimByStatus: { consensus: 0, majority: 0, limited_coverage: 0, single_source: 0 }, opposing: 0, unresolved: 0, unrecognised: 0, valuesMatch: 0, valuesDiffer: 0, notComparable: 0, noPositions: 0, unavailable: 0 };
  for (const row of rows) {
    const v = rowView(row, roster);
    if (v.heading === "No recorded positions") c.noPositions += 1;
    else if (v.rowType === "unknown") c.unavailable += 1;
    else if (v.rowType === "claim") {
      if (v.claimStatus === "split") v.isOpposition ? (c.opposing += 1) : (c.unresolved += 1);
      else if (v.claimStatus) c.claimByStatus[v.claimStatus] += 1;
      else c.unrecognised += 1;
    } else if (v.heading === "Values match") c.valuesMatch += 1;
    else if (v.heading === "Values differ") c.valuesDiffer += 1;
    else c.notComparable += 1;
  }
  return c;
}

/**
 * The panel statement, restated from the rows: claim rows by their computed status (split claim rows by their recorded
 * kind), field rows as value comparisons — never "a split on N" for rows that are not claim splits.
 */
export function renderPositionPanelStatement(c: PanelCounts): string {
  if (c.rows === 0) return "";
  const claims = (n: number) => plural(n, "claim");
  const parts = [
    c.claimByStatus.consensus ? `consensus on ${claims(c.claimByStatus.consensus)}` : "",
    c.claimByStatus.majority ? `majority support on ${claims(c.claimByStatus.majority)}` : "",
    c.claimByStatus.limited_coverage ? `limited coverage on ${claims(c.claimByStatus.limited_coverage)} (${LIMITED_COVERAGE_REASON})` : "",
    c.claimByStatus.single_source ? `a single source only on ${claims(c.claimByStatus.single_source)}` : "",
    c.opposing ? `recorded opposing positions on ${claims(c.opposing)}` : "",
    c.unresolved ? `unresolved positions on ${claims(c.unresolved)}` : "",
    c.unrecognised ? `an unrecognised status on ${claims(c.unrecognised)} (not counted as agreement)` : "",
    c.valuesMatch ? `${plural(c.valuesMatch, "value comparison")} with matching values` : "",
    c.valuesDiffer ? `${plural(c.valuesDiffer, "value comparison")} with differing values` : "",
    c.notComparable ? `${plural(c.notComparable, "value comparison")} not comparable` : "",
    c.noPositions ? `no recorded positions on ${plural(c.noPositions, "row")}` : "",
    c.unavailable ? `position details unavailable on ${plural(c.unavailable, "row")}` : "",
  ].filter(Boolean);
  const statement = `Of ${plural(c.rows, "scored row")} across ${plural(c.dispatched, "dispatched panel slot")}: ${parts.join("; ")}.`;
  return c.claimByStatus.consensus + c.claimByStatus.majority === 0 ? `${NO_CONSENSUS_IDENTIFIED} ${statement}` : statement;
}

// ─── Joins ──────────────────────────────────────────────────────────────────

export type RowJoin = { row: Record<string, unknown> } | { row: null; reason: "no_rows" | "not_found" | "ambiguous" | "unreadable_entry" | "mismatch" };

const claimTextOf = (row: unknown) => (isPlainObject(row) && typeof row.claimText === "string" ? row.claimText : null);

/** The unique stored row whose claimText equals `claim` exactly (optionally restricted to statuses). Similar wording never joins; two equal rows are ambiguous. */
export function uniqueRowByClaim(rows: readonly unknown[] | null, claim: unknown, statuses?: readonly string[]): RowJoin {
  if (!rows) return { row: null, reason: "no_rows" };
  if (typeof claim !== "string") return { row: null, reason: "unreadable_entry" };
  const same = rows.filter((r) => claimTextOf(r) === claim);
  const eligible = statuses ? same.filter((r) => statuses.includes(String((r as Record<string, unknown>).status))) : same;
  if (same.length > 1) return { row: null, reason: "ambiguous" };
  if (eligible.length === 1) return { row: eligible[0] as Record<string, unknown> };
  return { row: null, reason: "not_found" };
}

/** A stored per-split-row entry (disagreements[i], presentation.disagree[i]): joins the i-th stored split row only when its text equals that row's claimText exactly and that text is unique among the rows. */
export function splitRowAt(rows: readonly unknown[] | null, index: number, text: unknown): RowJoin {
  if (!rows) return { row: null, reason: "no_rows" };
  const splits = rows.filter((r) => isPlainObject(r) && r.status === "split");
  const row = splits[index];
  if (!row) return { row: null, reason: "not_found" };
  if (typeof text !== "string" || claimTextOf(row) !== text) return { row: null, reason: "mismatch" };
  if (rows.filter((r) => claimTextOf(r) === text).length > 1) return { row: null, reason: "ambiguous" };
  return { row: row as Record<string, unknown> };
}

// ─── Disclosures ────────────────────────────────────────────────────────────

/** D-3 (owner wording pending): the one disclosure for withheld model-written explanation. */
export const MODEL_PROSE_WITHHELD = "Model-written explanation is not shown for this report: it cannot be checked against the recorded panel positions.";
export function biasWithheldNotice(n: number): string {
  return `${plural(n, "model-flagged bias observation")} not shown: ${n === 1 ? "it cannot" : "they cannot"} be checked against the recorded panel positions.`;
}
export function coverageWithheldNotice(n: number): string {
  return `${plural(n, "model-written coverage note")} not shown: ${n === 1 ? "it cannot" : "they cannot"} be checked against the recorded panel positions.`;
}
export const NO_RECORDED_OPPOSING_POSITIONS = "No recorded opposing positions.";
export const NEUTRAL_KEY_CLAIM_STEP = "Treat the key claim as unresolved — independently verify it before relying on it.";
export const NEUTRAL_KEY_VALUES_STEP = "Treat the key value comparison as unresolved — independently verify the values before relying on them.";

// ─── The position-safe report view ──────────────────────────────────────────

/** Read-time data the view carries for consumers (never serialized: a symbol-keyed property is dropped by JSON). */
export interface PositionView {
  version: typeof DISAGREEMENT_POSITION_VERSION;
  roster: string[];
  /** Whether the scored rows were available to this view. */
  rowsAvailable: boolean;
  /** One per report.disagreements entry, same order: the joined row's view and positions, or null (unavailable). */
  disagreements: (RowView | null)[];
  modelProseWithheld: boolean;
  biasFindingsWithheld: number;
  coverageGapsWithheld: number;
  verdict: { topHeading: string; keyHeading: string; noKeyText: string; topIsClaim: boolean };
}

const POSITION_VIEW = Symbol.for("convergepanel.positionView");

/** The view data of a report returned by presentPositionSafeReport; null for an unmarked report or a raw stored one. */
export function positionView(report: unknown): PositionView | null {
  return isPlainObject(report) ? ((report as Record<symbol, unknown>)[POSITION_VIEW] as PositionView | undefined) ?? null : null;
}

export interface PositionSafeInput {
  rows: readonly unknown[] | null | undefined;
  roster: readonly string[];
  provenance?: readonly RunModelProvenanceFacts[] | null;
}

function joinedResult(join: RowJoin, roster: readonly string[], provenance: PositionSafeInput["provenance"]): { view: RowView | null; result: string } {
  if (!join.row) return { view: null, result: POSITION_DETAILS_UNAVAILABLE };
  const view = rowView(join.row, roster, provenance);
  return { view, result: view.text };
}

function presentedAnswer(c: PresentedAnswerClaim, rows: readonly unknown[] | null, input: PositionSafeInput, statuses: readonly string[], nameSupporters: boolean): PresentedAnswerClaim {
  const { view, result } = joinedResult(uniqueRowByClaim(rows, c.claim, statuses), input.roster, input.provenance);
  const supporters = nameSupporters && view && view.rowType === "claim" && view.supporters.length > 0 ? view.supporters.join(", ") : undefined;
  return { claim: c.claim, result, ...(view?.contested ? { contested: view.contested } : {}), ...(supporters ? { supporters } : {}) };
}

function presentedClaim(c: PresentedClaim, join: RowJoin, input: PositionSafeInput): PresentedClaim {
  const { view, result } = joinedResult(join, input.roster, input.provenance);
  return { claim: c.claim, result, ...(view?.contested ? { contested: view.contested } : {}) };
}

/**
 * The read-time view of a stored report. Unmarked (historical) reports: the same object, unchanged. Marked reports: a
 * new object (inputs never mutated) with every position statement restated from the rows, model prose withheld and the
 * PositionView attached. Idempotent: a report this function returned is returned as is.
 */
export function presentPositionSafeReport<R extends AdaptiveSynthesisReport | null | undefined>(report: R, input: PositionSafeInput): R {
  if (!report || !isPositionMarked(report) || positionView(report)) return report;
  const rows = Array.isArray(input.rows) ? input.rows : null;
  const roster = [...input.roster];
  const src = report as AdaptiveSynthesisReport;
  const p = src.presentation!;
  const failed = src.gate === "fail";

  const answerStatuses = failed ? ["split"] : ["consensus", "majority"];
  const answer = isPlainObject(p.answer) && Array.isArray(p.answer.claims)
    ? { note: p.answer.note ?? null, claims: p.answer.claims.map((c) => presentedAnswer(c, rows, input, answerStatuses, !failed)) }
    : p.answer;
  const agree = Array.isArray(p.agree) ? p.agree.map((c) => presentedClaim(c, uniqueRowByClaim(rows, c?.claim, ["consensus", "majority"]), input)) : p.agree;
  const storedDisagree = Array.isArray(p.disagree) ? p.disagree : [];
  const disagreements = Array.isArray(src.disagreements) ? src.disagreements : [];
  const disagreementViews: (RowView | null)[] = [];
  const disagree: PresentedDisagreement[] = disagreements.map((d, i) => {
    const join = splitRowAt(rows, i, d?.topic);
    const stored = storedDisagree[i];
    const entryJoin = join.row && stored && stored.claim !== d.topic ? ({ row: null, reason: "mismatch" } as RowJoin) : join;
    const { view, result } = joinedResult(entryJoin, roster, input.provenance);
    disagreementViews.push(view);
    return { claim: typeof d?.topic === "string" ? d.topic : "", result, ...(view?.contested ? { contested: view.contested } : {}), whySource: "computed" };
  });
  const storedUnresolved = (p.verificationGate as { unresolvedLoadBearing?: unknown } | undefined)?.unresolvedLoadBearing;
  const verificationGate = p.verificationGate
    ? {
        unresolvedLoadBearing: Array.isArray(storedUnresolved)
          ? storedUnresolved.map((u: PresentedUnresolvedClaim) => {
              if (!isPlainObject(u) || typeof u.claim !== "string") return u;
              const { view, result } = joinedResult(uniqueRowByClaim(rows, u.claim, ["split"]), roster, input.provenance);
              const claimRow = view && view.rowType === "claim";
              return {
                claim: u.claim,
                result,
                ...(view?.contested ? { contested: view.contested } : {}),
                ...(claimRow && view.supporters.length ? { supporters: view.supporters.join(", ") } : {}),
                ...(claimRow && view.disputers.length ? { disputers: view.disputers.join(", ") } : {}),
              };
            })
          : storedUnresolved,
      }
    : undefined;

  const modelProseWithheld =
    p.executiveSummarySource === "model_explanation" ||
    !!p.certaintyExplanation ||
    (Array.isArray(src.narrativeSections) && src.narrativeSections.length > 0) ||
    storedDisagree.some((d) => d?.whySource === "model_explanation");

  const { verdictCard, panelVerdict, verdict } = presentVerdict(src, rows, input);

  const presentation = {
    ...p,
    panelAgreement: rows ? renderPositionPanelStatement(panelCounts(rows, roster)) : "Position details are unavailable: the scored rows are not available to this view.",
    answer: answer as typeof p.answer,
    agree: agree as typeof p.agree,
    disagree,
    executiveSummarySource: "unified_answer" as const,
    ...(verificationGate ? { verificationGate: verificationGate as typeof p.verificationGate } : {}),
  };
  delete (presentation as { certaintyExplanation?: string }).certaintyExplanation;

  const view: PositionView = {
    version: DISAGREEMENT_POSITION_VERSION,
    roster,
    rowsAvailable: !!rows,
    disagreements: disagreementViews,
    modelProseWithheld,
    biasFindingsWithheld: Array.isArray(src.biasAndBlindSpots) ? src.biasAndBlindSpots.length : 0,
    coverageGapsWithheld: Array.isArray(src.panelCoverageGaps) ? src.panelCoverageGaps.length : 0,
    verdict,
  };

  const out: AdaptiveSynthesisReport = {
    ...src,
    presentation,
    panelVerdict,
    narrativeSections: [],
    disagreements: disagreements.map((d) => ({ ...d, whyTheyDiffer: "", positions: [] })),
    biasAndBlindSpots: [],
    panelCoverageGaps: [],
    verdictCard,
  };
  Object.defineProperty(out, POSITION_VIEW, { value: view, enumerable: false });
  return out as R;
}

function presentVerdict(src: AdaptiveSynthesisReport, rows: readonly unknown[] | null, input: PositionSafeInput): { verdictCard: AdaptiveVerdictCard; panelVerdict: string; verdict: PositionView["verdict"] } {
  const card = src.verdictCard;
  const certainty = `certainty ${Math.round((typeof src.runCertainty === "number" ? src.runCertainty : 0) * 100)}%; gate: ${src.gate}.`;
  let topHeading = "Top consensus";
  let topIsClaim = false;
  let panelVerdict = src.panelVerdict;
  let top: Partial<AdaptiveVerdictCard> = {};
  if (card.topConsensus !== NO_CONSENSUS_IDENTIFIED) {
    const join = uniqueRowByClaim(rows, card.topConsensus, ["consensus", "majority"]);
    const view = join.row ? rowView(join.row, input.roster, input.provenance) : null;
    if (view && view.rowType === "claim") {
      topIsClaim = true;
      top = { topConsensusAgreement: view.text, consensusModelCount: view.supporters.length, ...(view.contested ? { topConsensusContested: view.contested } : {}) };
    } else if (view) {
      topHeading = "Top value comparison";
      top = { topConsensusAgreement: view.text, consensusModelCount: 0 };
      panelVerdict = `Top value comparison: ${quoteText(card.topConsensus)} — ${view.text} Run ${certainty}`;
    } else {
      topHeading = "Top claim";
      top = { topConsensusAgreement: POSITION_DETAILS_UNAVAILABLE, consensusModelCount: 0 };
      panelVerdict = `Top claim: position details unavailable. Run ${certainty}`;
    }
  }
  let keyHeading = "Key unresolved claim";
  let key: Partial<AdaptiveVerdictCard> = {};
  let keyIsOpposition = false;
  let keyIsField = false;
  if (card.keyDisagreement) {
    const join = uniqueRowByClaim(rows, card.keyDisagreement, ["split"]);
    const view = join.row ? rowView(join.row, input.roster, input.provenance) : null;
    if (view) {
      keyHeading = view.rowType === "claim" ? view.heading : `Key value comparison: ${view.heading.toLowerCase()}`;
      keyIsOpposition = view.isOpposition;
      keyIsField = view.rowType !== "claim";
      const flagged = typeof (join.row as Record<string, unknown>).disagreementType === "string" ? `Flagged as ${String((join.row as Record<string, unknown>).disagreementType).replace(/_/g, " ")}.` : null;
      key = { keyDisagreementAgreement: view.text, disagreementDetail: flagged, disagreementModelCount: view.slots.filter((s) => s.position !== "No position recorded" && s.position !== "No value").length };
    } else {
      key = { keyDisagreementAgreement: POSITION_DETAILS_UNAVAILABLE, disagreementDetail: null };
    }
  }
  const steps = (Array.isArray(card.recommendedNextSteps) ? card.recommendedNextSteps : [])
    .filter((s) => s !== VERDICT_NEXT_STEPS.caution[2])
    .map((s) => (s === VERDICT_NEXT_STEPS.caution[0] && !keyIsOpposition ? (card.keyDisagreement ? (keyIsField ? NEUTRAL_KEY_VALUES_STEP : NEUTRAL_KEY_CLAIM_STEP) : CAUTION_NEXT_STEP_WITHOUT_DISAGREEMENT) : s));
  const verdictCard: AdaptiveVerdictCard = { ...card, ...top, ...key, caveat: null, recommendedNextSteps: steps };
  // The contested note is restated from the joined row only; the caveat is model-written and withheld.
  if (card.topConsensus !== NO_CONSENSUS_IDENTIFIED && !top.topConsensusContested) delete verdictCard.topConsensusContested;
  delete verdictCard.caveatSource;
  return { verdictCard, panelVerdict, verdict: { topHeading, keyHeading, noKeyText: NO_RECORDED_OPPOSING_POSITIONS, topIsClaim } };
}

/** Model-written claim text inside computed text: quoted, internal double quotes softened (same boundary as quoteClaim). */
function quoteText(text: string): string {
  return `“${text.replace(/"/g, "'").replace(/“/g, "‘").replace(/”/g, "’").replace(/\s+/g, " ").trim()}”`;
}

/**
 * The read-time view for a consumer holding the stored rows. Convenience over presentPositionSafeReport for the
 * consumers that receive a whole envelope (exports): roster = the envelope's dispatched slots.
 */
export function positionSafeFromEnvelope<R extends AdaptiveSynthesisReport | null | undefined>(report: R, rows: unknown, roster: readonly string[], provenance?: readonly RunModelProvenanceFacts[] | null): R {
  return presentPositionSafeReport(report, { rows: Array.isArray(rows) ? rows : null, roster, provenance });
}

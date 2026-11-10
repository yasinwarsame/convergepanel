/**
 * Render-time model independence of an adaptive report's top verdict claim (owner ruling on historical adaptive
 * reports, review of 1ee4982).
 *
 * A report computed before the independent-voice rule (orchestrate.ts `excludeRepeatedSubstitutes`) counted every slot
 * a substitute model answered as its own supporter: ChatGPT and Claude both answered by DeepSeek read "Top consensus —
 * agreed by 2 models". Stored values are never recomputed or rewritten; this module only decides, from the run's own
 * per-slot rows (RunModelProvenanceFacts: slot id, `substituted`, provider), how the stored top claim may be HEADED and
 * DESCRIBED:
 *  - "independent": every slot considered is its own executing model — the report renders exactly as before;
 *  - "repeated_substitute": two or more of those slots were answered by one substitute model — never an unqualified
 *    "Top consensus" / "agreed by N"; the executing models are named ("DeepSeek (substituting ChatGPT, Claude)");
 *  - "unverified": the executing identity of a slot considered cannot be verified under the shared corrected D-4 gate
 *    (lib/panel/executionIdentity.ts `executionIdentityVerified`: no row, no recorded status, or an answered row
 *    without a recorded provider — the pre-6.2a / S3mn records; C-a review F-1) — model independence is stated as
 *    unverified; nothing is invented and no provider history is reconstructed;
 *  - "placeholder": a supporting slot's stored text is a listed D-5 placeholder (INVALID_MOCK, the J02 fact), which is
 *    not a model response — it is never counted as an independent model, and the stored support count is never
 *    presented as "agreed by N models" (C-a review F-2); the remaining slots are each their own executing model.
 * Stored placeholder slots are excluded from the slots considered in both scopes (they are not model responses) and
 * their presence qualifies the statement in both scopes — the shared rule never presents such a run as a clean
 * independent run (`runExecutionIdentity(...).qualified`), and a surface not handed the stored rows judges the top
 * claim by the run, where the stored count would otherwise surface unqualified.
 * The slots considered are the top claim's supporting cells when the stored rows join it ("supporters"), otherwise
 * every slot the run records ("run"). Without the run's rows at all (`provenance` null — a surface not handed the
 * record, RunModelProvenanceContext's contract) nothing is inferred and the report renders as before.
 *
 * Pure, client-safe; imports no computation module (it is read by positionPresentation.ts). The identity rule is
 * imported from lib/panel/executionIdentity.ts (presentation only), never re-implemented here.
 */

import { executionIdentityVerified, identityRowFromFacts, identityRowRecordedFailure, placeholderClass } from "@/lib/panel/executionIdentity";
import { groupSlotsByExecutingVoice } from "@/lib/panel/executingVoiceLabel";
import type { RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import { NO_CONSENSUS_IDENTIFIED, quoteClaim } from "./agreementNarrative";
import { VERDICT_NEXT_STEPS } from "./config";

export type AdaptiveTopIndependence =
  | { kind: "independent" }
  | { kind: "repeated_substitute"; scope: "supporters" | "run"; voices: string[]; repeated: string[] }
  /**
   * `basis` (Order 30) says WHY when it is known: "no_responses" — no considered slot returned a successful model
   * response (every considered slot recorded a failed call); "failed_supporters" — a stored claim names slots that
   * recorded a failed call among its supporters, so its stored count is not a count of answering models. Absent: the
   * execution identity of a considered slot is not recorded.
   */
  | { kind: "unverified"; scope: "supporters" | "run"; basis?: UnverifiedBasis }
  /** F-2: `placeholders` are the excluded stored-placeholder slot ids; `voices` the remaining slots' executing models (each once). */
  | { kind: "placeholder"; scope: "supporters" | "run"; voices: string[]; placeholders: string[] };

export type UnverifiedBasis = "no_responses" | "failed_supporters";

const INDEPENDENT: AdaptiveTopIndependence = Object.freeze({ kind: "independent" as const });

/**
 * Order 30 A1 (owner standing attribution default): the ONE wording every surface states when no slot returned a
 * successful model response — no agreement, consensus or support count is claimed. Listed in the vocabulary manifest.
 */
export const NO_SUCCESSFUL_MODEL_RESPONSES = "No successful model responses. Consensus unavailable. Model independence unverified.";
/** Order 30 A2: a stored claim naming slots that recorded a failed call among its supporters — no support count stated. */
export const FAILED_SUPPORTERS_CLAUSE = "panel slots recorded as supporting it returned no successful model response, so no support count is stated";

const basisOf = (t: AdaptiveTopIndependence): UnverifiedBasis | undefined => (t.kind === "unverified" ? t.basis : undefined);
/** The run-scope judgement of an export whose every slot recorded a failed call (exportPositionView.ts, Order 30 A1). */
/** The summary-level judgement of an export holding a stored row that names failed slots among its positioned slots (Order 30 A2). */
export const FAILED_SUPPORTERS_RUN: Extract<AdaptiveTopIndependence, { kind: "unverified" }> = Object.freeze({ kind: "unverified" as const, scope: "run" as const, basis: "failed_supporters" as const });
export const NO_RESPONSES_RUN: Extract<AdaptiveTopIndependence, { kind: "unverified" }> = Object.freeze({ kind: "unverified" as const, scope: "run" as const, basis: "no_responses" as const });

/** Heading in place of "Top consensus" / "Top majority-supported claim" / "Models agree" (repeated substitute model). */
export const ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING = "Top finding (repeated substitute model; not an independent consensus)";
/** Heading in place of "Top consensus" / "Top majority-supported claim" / "Models agree" (execution identity not recorded). */
export const ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING = "Top finding (model independence unverified; not confirmed as a consensus)";
/** Heading in place of "Top consensus" / "Top majority-supported claim" / "Models agree" (a supporting slot held stored placeholder text). */
export const ADAPTIVE_PLACEHOLDER_TOP_HEADING = "Top finding (stored placeholder text among the supporting slots; not an independent consensus)";
/** The same heading when the judgement is run-scope (every slot the run records, no joined supporters — Order 29 m-2). */
export const ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING = "Top finding (stored placeholder text among the slots of this run; not an independent consensus)";

/** "1 panel slot held stored placeholder text (not a model response)" — the D-5 clause every placeholder statement carries. */
export function placeholderSlotsClause(n: number): string {
  return `${slotsText(n)} held stored placeholder text (not a model response)`;
}

/** The supporting slot ids (agrees / partial cells) of a stored aligned row, or null when it is not a readable row. */
export function supportingSlotsOfRow(row: unknown): string[] | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const cells = (row as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return null;
  const out: string[] = [];
  for (const c of cells) {
    if (!c || typeof c !== "object") continue;
    const { modelId, stance } = c as { modelId?: unknown; stance?: unknown };
    if (typeof modelId === "string" && modelId.trim() && (stance === "agrees" || stance === "partial")) out.push(modelId.trim());
  }
  return out;
}

const factsFor = (provenance: readonly RunModelProvenanceFacts[], slot: string) => provenance.find((f) => f && typeof f.modelId === "string" && f.modelId.trim() === slot);

/** D-5: a slot whose facts carry the J02 placeholder class is not a model response (the shared oracle, read through the facts adapter). */
function isPlaceholderSlot(provenance: readonly RunModelProvenanceFacts[], slot: string): boolean {
  return placeholderClass(identityRowFromFacts(factsFor(provenance, slot))) === "INVALID_MOCK";
}

/** A slot whose facts record a failed call (failed / error / timeout / refused / rate_limited): a known fact, never a voice. */
function isRecordedFailureSlot(provenance: readonly RunModelProvenanceFacts[], slot: string): boolean {
  return identityRowRecordedFailure(identityRowFromFacts(factsFor(provenance, slot)));
}

/**
 * The slots of a list that are model responses — stored placeholder slots and slots recorded as failed removed — and
 * the removed placeholder slots. A recorded failure is excluded from the voices only (Order 29 A2); a slot with no
 * recorded status stays in and fails the shared gate.
 */
function respondingSlots(slots: readonly string[], provenance: readonly RunModelProvenanceFacts[]): { responding: string[]; placeholders: string[] } {
  const placeholders = slots.filter((s) => isPlaceholderSlot(provenance, s));
  return { responding: slots.filter((s) => !placeholders.includes(s) && !isRecordedFailureSlot(provenance, s)), placeholders };
}

export function adaptiveTopIndependence(
  supporters: readonly string[] | null,
  provenance: readonly RunModelProvenanceFacts[] | null | undefined
): AdaptiveTopIndependence {
  if (!Array.isArray(provenance)) return INDEPENDENT;
  const scope = supporters ? "supporters" : "run";
  const source = supporters ?? provenance.map((f) => (f && typeof f.modelId === "string" ? f.modelId : ""));
  const considered = Array.from(new Set(source.map((s) => String(s).trim()).filter((s) => s.length > 0)));
  if (considered.length === 0) return scope === "run" && provenance.length > 0 ? { kind: "unverified", scope } : INDEPENDENT;
  if (scope === "run" && provenance.some((f) => !f || typeof f.modelId !== "string" || !f.modelId.trim())) return { kind: "unverified", scope };
  // F-2 (D-5): a stored placeholder slot is not a model response — never a considered slot, never an executing model.
  // A2: a slot recorded as failed is a known fact, shown as failed and never a voice.
  // Order 30 A2: a stored claim (an explicit slot list) that names a slot recorded as a failed call among the slots
  // that took its position is an inconsistent record — its stored count is not a count of answering models. It is never
  // presented with a support count: unverified, the no-claim family, with the reason. No considered slot answered
  // (every non-placeholder considered slot failed) → "no_responses" (NO_SUCCESSFUL_MODEL_RESPONSES).
  if (scope === "supporters") {
    const failed = considered.filter((s) => isRecordedFailureSlot(provenance, s));
    if (failed.length > 0) {
      const others = considered.filter((s) => !failed.includes(s) && !isPlaceholderSlot(provenance, s));
      return { kind: "unverified", scope, basis: others.length === 0 ? "no_responses" : "failed_supporters" };
    }
  }
  const { responding: slots, placeholders } = respondingSlots(considered, provenance);
  if (slots.length === 0) {
    if (placeholders.length > 0) return { kind: "placeholder", scope, voices: [], placeholders };
    // Run scope only (a supporters list with a failed slot returned above): every slot the run records is a recorded
    // failure — a run with nothing to judge and no agreement to qualify: it renders exactly as before (owner decision,
    // Order 29 option (b): the 2c17feee oracle of the all-failed panel holds). The shared gate itself still fails for
    // that run (runExecutionIdentity → UV); an export of such a run that carries a stored synthesis states
    // NO_SUCCESSFUL_MODEL_RESPONSES instead (exportPositionView.ts, NO_RESPONSES_RUN, Order 30 A1).
    return INDEPENDENT;
  }
  // F-1: the shared corrected D-4 gate over the considered slots' rows (a slot with no row, no recorded status, or an
  // answered row without a recorded provider fails it — nothing is inferred, no provider history is reconstructed).
  const rows = slots.map((s) => factsFor(provenance, s));
  if (rows.some((f) => !f) || !executionIdentityVerified(rows.map((f) => identityRowFromFacts(f)))) return { kind: "unverified", scope };
  const groups = groupSlotsByExecutingVoice(slots, provenance);
  if (groups.length >= slots.length) return placeholders.length > 0 ? { kind: "placeholder", scope, voices: groups.map((g) => g.label), placeholders } : INDEPENDENT;
  return { kind: "repeated_substitute", scope, voices: groups.map((g) => g.label), repeated: groups.filter((g) => g.slotIds.length > 1).map((g) => g.label) };
}

export function adaptiveTopHeading(t: AdaptiveTopIndependence): string | null {
  if (t.kind === "repeated_substitute") return ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING;
  if (t.kind === "unverified") return ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING;
  if (t.kind === "placeholder") return t.scope === "run" ? ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING : ADAPTIVE_PLACEHOLDER_TOP_HEADING;
  return null;
}

const slotsText = (n: number) => `${n} panel slot${n === 1 ? "" : "s"}`;

/**
 * The sentence shown in place of "agreed by N models" / "supported … by N panel slots". `storedCount` is the stored
 * `verdictCard.consensusModelCount`, stated as recorded (never recomputed); 0 / absent omits it. Null when independent.
 */
export function adaptiveTopIndependenceStatement(t: AdaptiveTopIndependence, storedCount: number | null | undefined): string | null {
  const recorded = typeof storedCount === "number" && storedCount > 0 ? `Recorded as supported by ${slotsText(storedCount)}` : null;
  if (t.kind === "repeated_substitute") {
    if (t.scope === "supporters") {
      const m = t.voices.length;
      return `${recorded ? `${recorded}, answered by` : "Supporting slots answered by"} ${m} independent model${m === 1 ? "" : "s"}: ${t.voices.join("; ")}. A substitute model that answered several slots counts once.`;
    }
    return `${recorded ? `${recorded}. ` : ""}In this run ${t.repeated.join("; ")} answered several slots, so this is not presented as an independent consensus.`;
  }
  if (t.kind === "unverified") {
    if (t.basis === "no_responses") return NO_SUCCESSFUL_MODEL_RESPONSES;
    if (t.basis === "failed_supporters") return `Model independence unverified: ${FAILED_SUPPORTERS_CLAUSE}.`;
    return `Model independence unverified: ${recorded ? `${recorded.charAt(0).toLowerCase()}${recorded.slice(1)}, but which` : "which"} models answered ${t.scope === "supporters" ? "the supporting slots" : "this run's slots"} is not recorded.`;
  }
  if (t.kind === "placeholder") {
    const m = t.voices.length;
    const p = t.placeholders.length;
    const answeredBy = recorded ? `${recorded}, answered by` : t.scope === "run" ? "The slots of this run were answered by" : "Supporting slots answered by";
    return `${answeredBy} ${m} independent model${m === 1 ? "" : "s"}${m > 0 ? `: ${t.voices.join("; ")}` : ""}. ${placeholderSlotsClause(p)} and ${p === 1 ? "is" : "are"} not counted.`;
  }
  return null;
}

/**
 * An UNMARKED report's top claim (a marked report carries it as PositionView.verdict.topIndependence): its supporting
 * slots from the one stored consensus / majority row whose claimText equals the card's top claim exactly (two rows with
 * that text → not joined), else every slot the run records. Null when independent, when the card names no consensus,
 * or without the run's rows.
 */
export function unmarkedTopIndependence(
  verdictCard: unknown,
  rows: readonly unknown[] | null | undefined,
  provenance: readonly RunModelProvenanceFacts[] | null | undefined
): Exclude<AdaptiveTopIndependence, { kind: "independent" }> | null {
  if (!verdictCard || typeof verdictCard !== "object") return null;
  const top = (verdictCard as { topConsensus?: unknown }).topConsensus;
  if (typeof top !== "string" || top === NO_CONSENSUS_IDENTIFIED) return null;
  let supporters: string[] | null = null;
  if (Array.isArray(rows)) {
    const same = rows.filter((r) => !!r && typeof r === "object" && (r as { claimText?: unknown }).claimText === top);
    const status = same.length === 1 ? String((same[0] as { status?: unknown }).status) : "";
    if (status === "consensus" || status === "majority") supporters = supportingSlotsOfRow(same[0]);
  }
  const t = adaptiveTopIndependence(supporters, provenance);
  return t.kind === "independent" ? null : t;
}

// ─── Every agreement statement of a historical report (owner order C, review of cf74a52) ────────────────────────────
//
// The top heading alone is not enough: the same report states agreement in its Unified Answer claims ("Panel result:
// consensus: all 5 dispatched models support it — Supported by: ChatGPT, Claude, …"), its "Where models agree" entries,
// the verdict card's result line, the panel statement and every share / memo / export built from them. Each such
// statement whose stored row's supporting slots are not independent executing models is re-worded at render time from
// the run's per-slot rows — executing-model counts, the executing models named — and the stored report is never
// changed. Rows whose supporters are independent, and every report whose run holds no repeated substitute model or
// unrecorded execution identity, render exactly as before (the same object is returned).

export type QualifiedIndependence = Exclude<AdaptiveTopIndependence, { kind: "independent" }>;

type AgreementStatus = "consensus" | "majority";
const isAgreementStatus = (s: unknown): s is AgreementStatus => s === "consensus" || s === "majority";

/** "consensus" / "majority support" — the stored status, as recorded. */
const RECORDED_STATUS_WORD: Readonly<Record<AgreementStatus, string>> = { consensus: "consensus", majority: "majority support" };
/** "Consensus" / "Majority support" — the row headings positionPresentation uses for these statuses. */
const STATUS_HEADING_WORD = { consensus: "Consensus", majority: "Majority support" } as const satisfies Record<AgreementStatus, string>;
const NOT_INDEPENDENT_WORD = { consensus: "consensus", majority: "majority" } as const satisfies Record<AgreementStatus, string>;

/** The label of the line, or heading clause, that states model independence. */
export const MODEL_INDEPENDENCE_QUALIFIER_LABEL = "Model independence";

/**
 * A stored claim row's model independence: its supporting (agrees / partial) slots judged from the run's per-slot rows.
 * Null when the supporters are independent executing models, when the row is not a consensus / majority row, or without
 * the run's rows (nothing inferred).
 */
export function rowSupportIndependence(row: unknown, provenance: readonly RunModelProvenanceFacts[] | null | undefined): QualifiedIndependence | null {
  if (!Array.isArray(provenance) || !row || typeof row !== "object" || Array.isArray(row)) return null;
  if (!isAgreementStatus((row as { status?: unknown }).status)) return null;
  const supporters = supportingSlotsOfRow(row);
  if (!supporters || supporters.length === 0) return null;
  const t = adaptiveTopIndependence(supporters, provenance);
  return t.kind === "independent" ? null : t;
}

const unique = (ids: readonly string[]) => Array.from(new Set(ids.map((s) => s.trim()).filter((s) => s.length > 0)));

function disputingSlots(row: unknown): number {
  const cells = (row as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return 0;
  return unique(cells.filter((c) => !!c && typeof c === "object" && (c as { stance?: unknown }).stance === "disputes").map((c) => String((c as { modelId?: unknown }).modelId ?? ""))).length;
}

/**
 * The computed result of a consensus / majority row whose supporting slots are not independent executing models, in
 * place of "consensus: all 5 dispatched models support it": the stored status as recorded, the slot count, and how many
 * independent executing models answered those slots, named.
 */
export function qualifiedRowResult(row: unknown, t: QualifiedIndependence): string {
  const status = (row as { status?: unknown }).status as AgreementStatus;
  const s = unique(supportingSlotsOfRow(row) ?? []).length;
  const d = disputingSlots(row);
  const disputes = d > 0 ? `; ${slotsText(d)} ${d === 1 ? "disputes" : "dispute"} it` : "";
  if (t.kind === "unverified") {
    if (t.basis === "no_responses") return NO_SUCCESSFUL_MODEL_RESPONSES;
    if (t.basis === "failed_supporters") return `recorded as ${RECORDED_STATUS_WORD[status]}; model independence unverified — ${FAILED_SUPPORTERS_CLAUSE}`;
    return `recorded as ${RECORDED_STATUS_WORD[status]} of ${slotsText(s)}${disputes}; model independence unverified — which models answered the supporting slots is not recorded`;
  }
  const m = t.voices.length;
  if (t.kind === "placeholder") {
    const held = placeholderSlotsClause(t.placeholders.length);
    if (m === 0) return `not an independent ${NOT_INDEPENDENT_WORD[status]}: ${held} — no model response supports it${disputes}`;
    if (m === 1) return `not an independent ${NOT_INDEPENDENT_WORD[status]}: ${held}; the remaining panel slot was answered by one model, ${t.voices[0]}${disputes}`;
    return `recorded as ${RECORDED_STATUS_WORD[status]} of ${slotsText(s)}${disputes}; ${held}; the remaining ${slotsText(m)} were each answered by their own model (${t.voices.join("; ")})`;
  }
  if (m < 2) return `not an independent ${NOT_INDEPENDENT_WORD[status]}: the ${slotsText(s)} supporting it were all answered by one model, ${t.voices[0] ?? SUBSTITUTE_MODEL_FALLBACK}${disputes}`;
  return `recorded as ${RECORDED_STATUS_WORD[status]} of ${slotsText(s)}${disputes}; those slots were answered by ${m} independent models (${t.voices.join("; ")}) — a substitute model that answered several slots counts once`;
}

const SUBSTITUTE_MODEL_FALLBACK = "a substitute model";

// ─── Every claim row, every side (c16: review of 48f3739, MINOR-2 / R13) ─────────────────────────────────────────────
//
// A row's slot counts are model counts only when every slot that took a position on it (supporting AND disputing) is
// its own recorded executing model. rowSupportIndependence judges the supporting side of a consensus / majority row;
// rowIndependence judges any claim row (split, limited coverage and single-source rows too) over both sides, and says
// when one executing model answered slots on both sides (a "disagreement" of one model with itself).

/** Every stored claim status a row statement may carry, as recorded. */
const ANY_STATUS_WORD: Readonly<Record<string, string>> = { consensus: "consensus", majority: "majority support", split: "split", limited_coverage: "limited coverage", single_source: "single source" };

/** The disputing slot ids of a stored aligned row (unique). */
export function disputingSlotsOfRow(row: unknown): string[] {
  const cells = row && typeof row === "object" ? (row as { cells?: unknown }).cells : null;
  if (!Array.isArray(cells)) return [];
  return unique(cells.filter((c) => !!c && typeof c === "object" && (c as { stance?: unknown }).stance === "disputes").map((c) => String((c as { modelId?: unknown }).modelId ?? "")));
}

/** One claim row's model independence, judged over every slot that took a position on it. */
export interface RowIndependence {
  /** Supporting and disputing slots together. */
  t: QualifiedIndependence;
  /** The supporting side alone (consensus / majority headings read this). */
  support: AdaptiveTopIndependence;
  dispute: AdaptiveTopIndependence;
  supportSlots: string[];
  disputeSlots: string[];
  /** The executing models of each side, each once. */
  supportVoices: string[];
  disputeVoices: string[];
  /** Executing models that answered slots on both sides (labelled over both sides' slots). */
  bothSides: string[];
}

/**
 * Null when every slot that took a position on the row is its own recorded executing model, when the row is not a
 * claim row with a recorded status, or without the run's rows (nothing inferred).
 */
export function rowIndependence(row: unknown, provenance: readonly RunModelProvenanceFacts[] | null | undefined): RowIndependence | null {
  if (!Array.isArray(provenance) || !row || typeof row !== "object" || Array.isArray(row)) return null;
  const status = (row as { status?: unknown }).status;
  if (typeof status !== "string" || !Object.prototype.hasOwnProperty.call(ANY_STATUS_WORD, status)) return null;
  const supportSlots = unique(supportingSlotsOfRow(row) ?? []);
  const disputeSlots = disputingSlotsOfRow(row);
  const participants = unique([...supportSlots, ...disputeSlots]);
  if (participants.length === 0) return null;
  const t = adaptiveTopIndependence(participants, provenance);
  if (t.kind === "independent") return null;
  // F-2: stored placeholder slots are not executing models — they are no side's voice and never "on both sides".
  const responding = (slots: readonly string[]) => respondingSlots(slots, provenance).responding;
  const groups = groupSlotsByExecutingVoice(responding(participants), provenance);
  const bothSides = groups.filter((g) => g.slotIds.some((s) => supportSlots.includes(s)) && g.slotIds.some((s) => disputeSlots.includes(s))).map((g) => g.label);
  return {
    t,
    support: supportSlots.length ? adaptiveTopIndependence(supportSlots, provenance) : INDEPENDENT,
    dispute: disputeSlots.length ? adaptiveTopIndependence(disputeSlots, provenance) : INDEPENDENT,
    supportSlots,
    disputeSlots,
    supportVoices: groupSlotsByExecutingVoice(responding(supportSlots), provenance).map((g) => g.label),
    disputeVoices: groupSlotsByExecutingVoice(responding(disputeSlots), provenance).map((g) => g.label),
    bothSides: t.kind === "unverified" ? [] : bothSides,
  };
}

/** One side of a row ("3 panel slots support it, answered by 2 independent models (…)"). */
function sideClause(n: number, verb: "support" | "dispute", side: AdaptiveTopIndependence, voices: readonly string[]): string {
  const counted = `${slotsText(n)} ${n === 1 ? `${verb}s` : verb} it`;
  if (side.kind === "unverified" && side.basis === "no_responses") return `no successful model response ${verb}s it`;
  if (side.kind === "unverified" && side.basis === "failed_supporters") return `panel slots that returned no successful model response are recorded as ${verb === "support" ? "supporting" : "disputing"} it (model independence unverified; no count stated)`;
  if (side.kind === "unverified") return `${counted} (model independence unverified — which models answered ${n === 1 ? "it" : "them"} is not recorded)`;
  if (side.kind === "placeholder") {
    const m = voices.length;
    const rest = m === 0 ? "" : m === 1 ? `; the remaining panel slot was answered by one model, ${voices[0]}` : `; the remaining ${slotsText(m)} were each answered by their own model (${voices.join("; ")})`;
    return `${counted}; ${placeholderSlotsClause(side.placeholders.length)}${rest}`;
  }
  if (voices.length === 1) return n === 1 ? `${counted} (${voices[0]})` : `${counted}, all answered by one model, ${voices[0]}`;
  if (voices.length < n) return `${counted}, answered by ${voices.length} independent models (${voices.join("; ")})`;
  return `${counted}, each answered by its own model (${voices.join("; ")})`;
}

/**
 * The computed result of ANY claim row whose positioned slots are not all independent executing models: the stored
 * status as recorded, each side's slot count and its executing models, and the executing models that answered slots on
 * both sides. A consensus / majority row whose disputing side needs nothing stated keeps qualifiedRowResult's wording.
 */
export function qualifiedRowText(row: unknown, ri: RowIndependence): string {
  const status = String((row as { status?: unknown }).status);
  const disputeSideClean = ri.disputeSlots.length === 0 || (ri.dispute.kind === "independent" && ri.bothSides.length === 0);
  if (isAgreementStatus(status) && ri.support.kind !== "independent" && disputeSideClean) return qualifiedRowResult(row, ri.support);
  const parts = [
    ri.supportSlots.length ? sideClause(ri.supportSlots.length, "support", ri.support, ri.supportVoices) : "no panel slot supports it",
    ...(ri.disputeSlots.length ? [sideClause(ri.disputeSlots.length, "dispute", ri.dispute, ri.disputeVoices)] : []),
    ...(ri.bothSides.length && ri.supportSlots.length && ri.disputeSlots.length ? [`${ri.bothSides.join("; ")} answered slots on both sides, so this is not a disagreement between independent models`] : []),
  ];
  return `recorded as ${ANY_STATUS_WORD[status]}: ${parts.join("; ")}`;
}

/** The heading of such a row: a qualified consensus / majority heading, else the status label counted by panel slot. */
export function qualifiedRowHeading<B extends string>(status: unknown, ri: RowIndependence, baseLabel: B): QualifiedStatusHeading | `${B} (counted by panel slot)` {
  if (ri.support.kind !== "independent") {
    const h = qualifiedStatusHeading(status, ri.support);
    if (h) return h;
  }
  return `${baseLabel} (counted by panel slot)` as `${B} (counted by panel slot)`;
}

/** Who supports / disputes such a row, each executing model once; null for a side whose execution is not recorded. */
export function qualifiedSideVoices(ri: RowIndependence, side: "support" | "dispute"): string[] | null {
  const t = side === "support" ? ri.support : ri.dispute;
  const voices = side === "support" ? ri.supportVoices : ri.disputeVoices;
  return t.kind === "unverified" || voices.length === 0 ? null : voices;
}

/** A stored count note ("all 4 models that listed this claim mark it contested") in a run whose slots are not independent. */
export const COUNTED_BY_PANEL_SLOT = "(counted by panel slot)";

/** The run's slots as a whole: null when every slot is its own recorded executing model, or without the run's rows. */
export function runIndependence(provenance: readonly RunModelProvenanceFacts[] | null | undefined): QualifiedIndependence | null {
  if (!Array.isArray(provenance)) return null;
  // J02 (D-5): a slot whose stored text is a listed placeholder is not a model response, so it is never a run-scope
  // voice; its presence qualifies the run (kind "placeholder"), as the shared rule never presents such a run as IND.
  const t = adaptiveTopIndependence(null, provenance);
  return t.kind === "independent" ? null : t;
}

/**
 * The run's independence as a surface shows it: the qualified view's verdict when the surface holds that view (never
 * re-judged), else the run's own rows. Null — the surface renders as before — for an independent run or without rows.
 */
export function shownRunIndependence(report: unknown, provenance: readonly RunModelProvenanceFacts[] | null | undefined): QualifiedIndependence | null {
  const q = independenceQualification(report);
  return q ? q.run : runIndependence(provenance);
}

// ─── Run-level wording shared by the summary bar, banner, lists, map and exports (c16) ───────────────────────────────

/** A slot-counted list figure in a run whose slots are not independent ("Consensus claims (counted by panel slot)"). */
export function slotCountedLabel(label: string): string {
  return `${label} ${COUNTED_BY_PANEL_SLOT}`;
}

/** The summary-bar field of a schema-derived level in a run whose slots are not independent (never "Strong consensus"). */
export const SLOT_AGREEMENT_FIELD = "Agreement by panel slot";
export const SLOT_AGREEMENT_WORD: Readonly<Record<"strong" | "moderate" | "weak" | "split" | "unscored", string>> = {
  strong: "High (panel slots, not independent models)",
  moderate: "Moderate (panel slots, not independent models)",
  weak: "Low (panel slots, not independent models)",
  split: "Split (panel slots)",
  unscored: "Not scored",
};

/** The diagnostics' homogeneity badge, in place of "Unusually uniform agreement", for a run whose slots are not independent. */
export function uniformityBadge(run: QualifiedIndependence): { label: string; title: string } {
  if (run.kind === "unverified") {
    return { label: "Unusually uniform responses (model independence unverified)", title: "Which models answered this run's slots is not recorded, so uniform responses are not shown as agreement between independent models." };
  }
  const label = "Unusually uniform responses across panel slots (not independent agreement)";
  if (run.kind === "placeholder") {
    return { label, title: `In this run ${placeholderSlotsClause(run.placeholders.length)}, so uniform responses across the remaining slots are not shown as agreement between independent models.` };
  }
  return { label, title: `In this run ${run.repeated.join("; ")} answered several slots, so uniform responses across them are not agreement between independent models.` };
}

/** "(raised by 3 models)" for an item whose raising slots are not independent executing models. */
export function raisedByText(slots: readonly string[], provenance: readonly RunModelProvenanceFacts[] | null | undefined): string | null {
  const t = adaptiveTopIndependence(unique(slots), provenance);
  if (t.kind === "independent") return null;
  const n = unique(slots).length;
  if (t.kind === "unverified" && t.basis) return "(raised by panel slots that include slots with no successful model response; model independence unverified)";
  if (t.kind === "unverified") return `(raised by ${slotsText(n)}; model independence unverified)`;
  return `(raised by ${slotsText(n)}, answered by ${t.voices.length} independent model${t.voices.length === 1 ? "" : "s"}: ${t.voices.join("; ")})`;
}

/**
 * An agreement-map row's count line ("2 of 5 agree · 1 dispute") in a run whose slots are not independent: counted as
 * panel slots, and — when the row's own positioned slots are not independent (`ri`) — with their independent models.
 */
export function slotAgreementLabel(agree: number, dispute: number, silent: number, total: number, ri: RowIndependence | null): string {
  const parts = [`${agree} of ${slotsText(total)} agree`];
  if (dispute > 0) parts.push(`${dispute} dispute${dispute === 1 ? "s" : ""}`);
  if (silent > 0) parts.push(`${silent} silent`);
  if (!ri) return parts.join(" · ");
  if (ri.t.kind === "unverified") parts.push(ri.t.basis ? "model independence unverified; includes panel slots with no successful model response" : "model independence unverified");
  else {
    const m = ri.t.voices.length;
    parts.push(`${m} independent model${m === 1 ? "" : "s"}${ri.bothSides.length && agree > 0 && dispute > 0 ? ` (${ri.bothSides.join("; ")} on both sides)` : ""}`);
  }
  return parts.join(" · ");
}

/**
 * The stored panel verdict ("5/5 models converge on “…”; certainty 100%; gate: pass.") when its top claim is not
 * supported by independent executing models: the claim with its computed result, then the stored certainty and gate.
 * A verdict in any other format is followed by what it counts. Never recomputed.
 */
export function qualifiedPanelVerdict(stored: string, result: string, joined: boolean, run: QualifiedIndependence | null): string {
  if (result === NO_SUCCESSFUL_MODEL_RESPONSES) return NO_SUCCESSFUL_MODEL_RESPONSES;
  const m = /^(\d+)\/(\d+) models converge on ([\s\S]+?); (certainty [\s\S]*)$/.exec(stored);
  if (m && joined) return `Top finding ${m[3]} — ${result}; ${m[4]}`;
  if (m) return `${m[1]}/${m[2]} panel slots converge on ${m[3]} (${result}); ${m[4]}`;
  return run ? `${stored} (${runScopeQualifier(run)})` : stored;
}

/** The stored pass next step names "the top consensus claim": a qualified top is not one. */
export const QUALIFIED_TOP_NEXT_STEP = "Use this synthesis as a starting point — spot-check the top finding against one primary source before acting on it.";
export const STORED_TOP_CONSENSUS_NEXT_STEP = VERDICT_NEXT_STEPS.pass[0];

/** The heading of a consensus / majority row whose supporting slots are not independent executing models. */
export type QualifiedStatusHeading =
  | typeof NO_RESPONSES_STATUS_HEADING
  | `${"Consensus" | "Majority support"} (model independence unverified)`
  | `${"Consensus" | "Majority support"} (${number} independent models)`
  | `Not an independent ${"consensus" | "majority"}`;

/** The heading of a consensus / majority row none of whose positioned slots returned a successful model response. */
export const NO_RESPONSES_STATUS_HEADING = "No successful model responses";

/** The row heading ("Consensus" / "Majority support") of such a row, qualified. */
export function qualifiedStatusHeading(status: unknown, t: QualifiedIndependence): QualifiedStatusHeading | null {
  if (!isAgreementStatus(status)) return null;
  if (t.kind === "unverified" && t.basis === "no_responses") return NO_RESPONSES_STATUS_HEADING;
  if (t.kind === "unverified") return `${STATUS_HEADING_WORD[status]} (model independence unverified)`;
  return t.voices.length < 2 ? `Not an independent ${NOT_INDEPENDENT_WORD[status]}` : `${STATUS_HEADING_WORD[status]} (${t.voices.length} independent models)`;
}

/** Who supports such a row: the executing models, each once ("DeepSeek (substituting ChatGPT, Claude); Grok"). */
export function qualifiedSupporters(t: QualifiedIndependence): string | null {
  return (t.kind === "repeated_substitute" || t.kind === "placeholder") && t.voices.length > 0 ? t.voices.join("; ") : null;
}

/**
 * A stored agreement statement whose row cannot be joined (no rows held, or no unique row with that text) in a run whose
 * slots are not all independent executing models: the stored text, then what it counts.
 */
export function runScopeQualifier(run: QualifiedIndependence): string {
  if (basisOf(run) === "no_responses") return NO_SUCCESSFUL_MODEL_RESPONSES;
  if (run.kind === "unverified") return "counted by panel slot; model independence unverified — which models answered this run's slots is not recorded";
  if (run.kind === "placeholder") return `counted by panel slot; ${placeholderSlotsClause(run.placeholders.length)}, so this is not a count of independent models`;
  return `counted by panel slot; in this run ${run.repeated.join("; ")} answered several slots, so this is not a count of independent models`;
}

/** A legacy "Where models agree" line (no stored status) when the rows are not held, in a run not all independent. */
export function legacyRunScopeQualifier(run: QualifiedIndependence): string {
  if (basisOf(run) === "no_responses") return NO_SUCCESSFUL_MODEL_RESPONSES;
  if (run.kind === "unverified") return "not confirmed as agreement between independent models: which models answered this run's slots is not recorded";
  if (run.kind === "placeholder") return `not confirmed as agreement between independent models: ${placeholderSlotsClause(run.placeholders.length)}`;
  return `not confirmed as agreement between independent models: in this run ${run.repeated.join("; ")} answered several slots`;
}

/** The note that follows a panel-level count ("Of 2 scored claims across 5 dispatched models: consensus on 2."). */
export function runIndependenceNote(run: QualifiedIndependence): string {
  if (basisOf(run) === "no_responses") return NO_SUCCESSFUL_MODEL_RESPONSES;
  if (run.kind === "unverified") return "These counts are of panel slots: which models answered this run's slots is not recorded (model independence unverified).";
  if (run.kind === "placeholder") return `These counts are of panel slots: ${placeholderSlotsClause(run.placeholders.length)}, so they are not counts of independent models.`;
  return `These counts are of panel slots: in this run ${run.repeated.join("; ")} answered several slots, so they are not counts of independent models.`;
}

/** Follows a legacy report's stored answer string, which names the slots that support each claim. */
export function answerIndependenceNote(run: QualifiedIndependence): string {
  if (basisOf(run) === "no_responses") return NO_SUCCESSFUL_MODEL_RESPONSES;
  if (run.kind === "unverified") return "The models named and counted here are panel slots: which models answered them is not recorded (model independence unverified).";
  if (run.kind === "placeholder") return `The models named and counted here are panel slots: ${placeholderSlotsClause(run.placeholders.length)}, so they are not all independent models.`;
  return `The models named and counted here are panel slots: in this run ${run.repeated.join("; ")} answered several slots, so they are not all independent models.`;
}

/**
 * The panel as LinkedIn / X introduce it, in place of "a multi-model AI panel", for a run with fewer than two independent
 * executing models or with unrecorded execution identity; null otherwise (two or more independent models are a
 * multi-model panel — the post as before).
 */
export function sharePanelPhrase(run: QualifiedIndependence | null): string | null {
  if (!run) return null;
  if (run.kind === "unverified") return "an AI panel (model independence unverified: which models answered is not recorded)";
  if (run.kind === "placeholder") return run.voices.length < 2 ? "an AI panel with fewer than two independent models once stored placeholder text (not a model response) is set aside" : null;
  return run.voices.length < 2 ? `an AI panel whose responding slots were all answered by one model, ${run.voices[0] ?? SUBSTITUTE_MODEL_FALLBACK}` : null;
}

/**
 * A row result in X's length budget, for a run whose slots are not independent executing models: the stored status
 * word, then what the count is of — never a slot count presented as models, never cut mid-qualification.
 */
export function shortRunCountedResult(storedResult: string, run: QualifiedIndependence): string {
  const status = /^([a-z][a-z ]*):/i.exec(storedResult)?.[1] ?? "recorded";
  const what =
    run.kind === "unverified"
      ? "model independence unverified"
      : run.kind === "placeholder"
        ? `${run.voices.length} independent model${run.voices.length === 1 ? "" : "s"}; stored placeholder text set aside`
        : run.voices.length < 2
          ? "one model answered every slot"
          : `${run.voices.length} independent models`;
  return `${status} (counted by panel slot; ${what})`;
}

/** sharePanelPhrase in X's length budget. */
export function shortSharePanelPhrase(run: QualifiedIndependence | null): string | null {
  if (!run) return null;
  if (run.kind === "unverified") return "an AI panel (model independence unverified)";
  if (run.kind === "placeholder") return run.voices.length < 2 ? "an AI panel (stored placeholder text set aside)" : null;
  return run.voices.length < 2 ? "an AI panel (one model answered every slot)" : null;
}

/** "Where models agree", when an entry under it is not an agreement between independent executing models. */
export const AGREE_HEADING_ONE_EXECUTING_MODEL = "Points repeated across panel slots (not agreement between independent models)";
export const AGREE_HEADING_REPEATED_SUBSTITUTE = "Where models agree (a substitute model that answered several slots is counted once)";
export const AGREE_HEADING_UNVERIFIED = "Where models agree (model independence unverified)";
export const AGREE_HEADING_PLACEHOLDER = "Where models agree (a slot holding stored placeholder text is not counted)";

/**
 * The qualified top heading (N1): with two or more independent executing models among the supporters the stored
 * consensus / majority is still stated, with the independent-model count; one executing model, or a run-scope judgement,
 * is never headed as a consensus.
 */
export function qualifiedTopHeading(t: QualifiedIndependence, status: unknown): string {
  const lead = status === "consensus" ? "Top consensus" : "Top majority-supported claim";
  if (t.kind === "repeated_substitute" && t.scope === "supporters" && t.voices.length >= 2 && isAgreementStatus(status)) {
    return `${lead} (${t.voices.length} independent models; a substitute model that answered several slots counted once)`;
  }
  if (t.kind === "placeholder" && t.scope === "supporters" && t.voices.length >= 2 && isAgreementStatus(status)) {
    return `${lead} (${t.voices.length} independent models; stored placeholder text set aside)`;
  }
  return adaptiveTopHeading(t)!;
}

/** What the independence-qualified view of an UNMARKED report carries for the surfaces that head or describe it. */
export interface IndependenceQualification {
  /** The run's slots as a whole (every slot the run records). */
  run: QualifiedIndependence | null;
  /** The top claim: its joined row's supporters, else the run. Null when independent / no consensus named. */
  top: QualifiedIndependence | null;
  /** The joined top row's stored status (consensus / majority), when joined. */
  topStatus: string | null;
  /** True when verdictCard.topConsensusAgreement was re-worded (the card's result line already states independence). */
  topResultQualified: boolean;
  /** The "Where models agree" heading when an entry under it is qualified; null otherwise. */
  agreeHeading: string | null;
  /** A legacy report's stored "Where models agree" line → the independence statement shown with it. */
  legacyAgree: ReadonlyMap<string, string>;
}

const QUALIFICATION = Symbol.for("convergepanel.independenceQualification");

/** The qualification an independence-qualified view carries; null for any other report (rendered as before). */
export function independenceQualification(report: unknown): IndependenceQualification | null {
  if (!report || typeof report !== "object") return null;
  return ((report as Record<symbol, unknown>)[QUALIFICATION] as IndependenceQualification | undefined) ?? null;
}

/** A stored row whose claimText equals `claim` exactly, when exactly one row has that text and its status is one of `statuses`. */
function joinRow(rows: readonly unknown[] | null, claim: unknown, statuses: readonly string[]): unknown | null {
  if (!rows || typeof claim !== "string") return null;
  const same = rows.filter((r) => !!r && typeof r === "object" && (r as { claimText?: unknown }).claimText === claim);
  return same.length === 1 && statuses.includes(String((same[0] as { status?: unknown }).status)) ? same[0] : null;
}

/** A legacy "Where models agree" line: the quoted claim (synthesisReport.ts), or its bare text. */
function joinLegacyAgreeLine(rows: readonly unknown[] | null, line: string): unknown | null {
  if (!rows) return null;
  const matches = rows.filter((r) => {
    const text = r && typeof r === "object" ? (r as { claimText?: unknown }).claimText : undefined;
    return typeof text === "string" && (line === text || line === quoteClaim(text) || line.startsWith(`${quoteClaim(text)} `));
  });
  return matches.length === 1 && isAgreementStatus((matches[0] as { status?: unknown }).status) ? matches[0] : null;
}

const AGREEMENT_STATUSES = ["consensus", "majority"] as const;
const SPLIT_STATUSES = ["split"] as const;

/** One stored statement: its joined row's independence, or (unjoined) the run's. */
type Statement = { row: unknown; ri: RowIndependence; t: QualifiedIndependence } | { row: null; ri: null; t: QualifiedIndependence } | null;

/**
 * The independence-qualified view of an UNMARKED adaptive report (a marked report is qualified inside its position view,
 * positionPresentation.rowView). Returns the stored report itself — the same object — when nothing it states needs
 * qualifying or when the run's per-slot rows are not held; otherwise a copy whose statements are re-worded (never the
 * stored object; nothing is recomputed: statuses, counts and claim text are read as stored).
 *
 * Every row statement is judged (c16): consensus / majority claims, the fail gate's split answers, the caution answer's
 * load-bearing splits, "Where models disagree", the verdict card's top and key results and the stored panel verdict —
 * a joined row by every slot that took a position on it, an unjoined statement by the run.
 */
export function presentIndependenceQualifiedReport<R extends AdaptiveSynthesisReportLike | null | undefined>(
  report: R,
  input: { rows: readonly unknown[] | null | undefined; provenance?: readonly RunModelProvenanceFacts[] | null; noSuccessfulResponses?: boolean }
): R {
  if (!report || typeof report !== "object" || independenceQualification(report)) return report;
  const provenance = input.provenance;
  if (!Array.isArray(provenance)) return report;
  const rows = Array.isArray(input.rows) ? input.rows : null;
  // Order 30 A1: an export whose every slot recorded a failed call judges the run as NO_RESPONSES_RUN (exports only;
  // exportPositionView.ts decides it from the frozen outcomes). Every other caller: the run's own rows, as before.
  const run = input.noSuccessfulResponses === true ? NO_RESPONSES_RUN : runIndependence(provenance);
  const src = report as AdaptiveSynthesisReportLike;

  // One stored statement (a claim's text): its joined row's qualification, else — when the run itself is not
  // independent — the run's (the row cannot prove its slots independent). Null: shown as stored.
  const statementFor = (claim: unknown, statuses: readonly string[]): Statement => {
    const row = joinRow(rows, claim, statuses);
    if (row) {
      const ri = rowIndependence(row, provenance);
      return ri ? { row, ri, t: ri.t } : null;
    }
    return run ? { row: null, ri: null, t: run } : null;
  };
  // No successful model response (Order 30 A1): the stored statement is not repeated — the shared wording replaces it.
  const qualifiedText = (stored: string, st: NonNullable<Statement>) =>
    st.row ? qualifiedRowText(st.row, st.ri!) : basisOf(st.t) === "no_responses" ? NO_SUCCESSFUL_MODEL_RESPONSES : `${stored} (${runScopeQualifier(st.t)})`;
  const qualifiedNames = (stored: unknown, st: NonNullable<Statement>, side: "support" | "dispute") => {
    if (typeof stored !== "string") return {};
    const basis = basisOf(st.row ? (side === "support" ? st.ri!.support : st.ri!.dispute) : st.t) ?? basisOf(st.t);
    if (basis === "no_responses") return { [side === "support" ? "supporters" : "disputers"]: NO_RESPONSES_NAMES };
    if (basis === "failed_supporters") return { [side === "support" ? "supporters" : "disputers"]: `${stored} (panel slots; includes slots with no successful model response)` };
    const named = st.row ? qualifiedSideVoices(st.ri!, side) : null;
    return { [side === "support" ? "supporters" : "disputers"]: named ? named.join("; ") : `${stored} (panel slots)` };
  };
  const qualifiedContested = (c: any) => (typeof c?.contested === "string" && c.contested ? { contested: `${c.contested} ${COUNTED_BY_PANEL_SLOT}` } : {});
  let anyAgreeQualified = false;
  let anyQualified = false;
  const qualifiedKinds: QualifiedIndependence[] = [];
  const mark = (st: NonNullable<Statement>) => {
    anyQualified = true;
    qualifiedKinds.push(st.t);
  };
  /** A stored { claim, result, contested?, supporters?, disputers? } entry, qualified when its statement needs it. */
  const entry = (c: any, statuses: readonly string[], onQualified?: () => void) => {
    if (!c || typeof c !== "object" || typeof c.result !== "string") return c;
    const st = statementFor(c.claim, statuses);
    if (!st) return c;
    mark(st);
    onQualified?.();
    return { ...c, result: qualifiedText(c.result, st), ...qualifiedContested(c), ...qualifiedNames(c.supporters, st, "support"), ...qualifiedNames(c.disputers, st, "dispute") };
  };

  const p = src.presentation && typeof src.presentation === "object" ? src.presentation : null;
  let presentation = p;
  if (p) {
    const answer = p.answer && typeof p.answer === "object" && Array.isArray(p.answer.claims) ? p.answer : null;
    // The fail gate's answer lists the split claims; every other gate's lists consensus / majority claims (R13).
    const answerStatuses = src.gate === "fail" ? SPLIT_STATUSES : AGREEMENT_STATUSES;
    const answerClaims = answer ? answer.claims.map((c: any) => entry(c, answerStatuses)) : null;
    const agree = Array.isArray(p.agree) ? p.agree.map((c: any) => entry(c, AGREEMENT_STATUSES, () => (anyAgreeQualified = true))) : null;
    const disagree = Array.isArray(p.disagree) ? p.disagree.map((c: any) => entry(c, SPLIT_STATUSES)) : null;
    const gate = p.verificationGate && typeof p.verificationGate === "object" ? p.verificationGate : null;
    const unresolved = gate && Array.isArray(gate.unresolvedLoadBearing) ? gate.unresolvedLoadBearing.map((c: any) => entry(c, SPLIT_STATUSES)) : null;
    if (anyQualified) {
      presentation = {
        ...p,
        ...(answer ? { answer: { ...answer, claims: answerClaims } } : {}),
        ...(agree ? { agree } : {}),
        ...(disagree ? { disagree } : {}),
        ...(unresolved ? { verificationGate: { ...gate, unresolvedLoadBearing: unresolved } } : {}),
      };
    }
  }

  // A legacy report (no presentation): its "Where models agree" lines carry no status — each joined line is followed by
  // its independence statement (shareBuilders / reportPresentation, after the near-duplicate merge).
  const legacyAgree = new Map<string, string>();
  if (!p && Array.isArray(src.whereModelsAgree)) {
    for (const line of src.whereModelsAgree) {
      if (typeof line !== "string") continue;
      const row = joinLegacyAgreeLine(rows, line);
      const ri = row ? rowIndependence(row, provenance) : null;
      const t = ri ? ri.t : rows ? null : run;
      if (!t) continue;
      legacyAgree.set(line, ri ? qualifiedRowText(row, ri) : legacyRunScopeQualifier(t));
      qualifiedKinds.push(t);
      anyQualified = true;
      anyAgreeQualified = true;
    }
  }

  // The verdict card's top claim and key disagreement, and the stored panel verdict that names the top claim.
  const card = src.verdictCard && typeof src.verdictCard === "object" ? src.verdictCard : null;
  let verdictCard = card;
  let panelVerdict: unknown = src.panelVerdict;
  let top: QualifiedIndependence | null = null;
  let topStatus: string | null = null;
  let topResultQualified = false;
  if (card && typeof card.topConsensus === "string" && card.topConsensus !== NO_CONSENSUS_IDENTIFIED) {
    const st = statementFor(card.topConsensus, AGREEMENT_STATUSES);
    if (st) {
      // The heading reads the supporting side (a genuine independent majority keeps its heading).
      top = st.row ? (st.ri!.support.kind === "independent" ? null : st.ri!.support) : st.t;
      topStatus = st.row ? String((st.row as { status?: unknown }).status) : null;
      mark(st);
      const next: Record<string, unknown> = { ...qualifiedContested({ contested: card.topConsensusContested }) };
      if (typeof next.contested === "string") {
        next.topConsensusContested = next.contested;
      }
      delete next.contested;
      if (typeof card.topConsensusAgreement === "string" && card.topConsensusAgreement) {
        next.topConsensusAgreement = qualifiedText(card.topConsensusAgreement, st);
        topResultQualified = true;
      }
      // N1: the stored pass step names "the top consensus claim"; a top whose support is not independent is not one.
      if (top && Array.isArray(card.recommendedNextSteps)) next.recommendedNextSteps = card.recommendedNextSteps.map((s: unknown) => (s === STORED_TOP_CONSENSUS_NEXT_STEP ? QUALIFIED_TOP_NEXT_STEP : s));
      verdictCard = { ...verdictCard, ...next };
      if (typeof src.panelVerdict === "string") {
        panelVerdict = qualifiedPanelVerdict(src.panelVerdict, st.row ? qualifiedRowText(st.row, st.ri!) : runScopeQualifier(st.t), !!st.row, st.t);
      }
    }
  }
  if (card && typeof card.keyDisagreement === "string" && card.keyDisagreement && typeof card.keyDisagreementAgreement === "string" && card.keyDisagreementAgreement) {
    const st = statementFor(card.keyDisagreement, SPLIT_STATUSES);
    if (st) {
      mark(st);
      verdictCard = { ...verdictCard, keyDisagreementAgreement: qualifiedText(card.keyDisagreementAgreement, st) };
    }
  }

  // Every statement stands (independent slots) in a run that still holds a repeated substitute model or an
  // unrecorded execution identity: the view is returned with that verdict attached, so a surface handed it without the
  // rows (the governance card) never re-judges the top claim by the run's slots. Its text is the stored text, except
  // that a run with fewer than two independent executing models (or unrecorded execution) is never introduced as a
  // "multi-model" panel (LinkedIn / X). A run whose slots are all independent: the stored object itself.
  if (!anyQualified && !run) return report;
  if (!anyQualified) {
    const out = { ...src } as Record<string | symbol, unknown>;
    Object.defineProperty(out, QUALIFICATION, { value: Object.freeze({ run, top: null, topStatus: null, topResultQualified: false, agreeHeading: null, legacyAgree: new Map() }), enumerable: false });
    return out as unknown as R;
  }

  // The panel-level count (presentation.panelAgreement, and the certainty line that repeats it), and a legacy report's
  // stored answer string (it names the slots that "support" each claim): followed by what the counts are of.
  const noteT = run ?? qualifiedKinds[0];
  const note = runIndependenceNote(noteT);
  const counted = (text: unknown) => typeof text === "string" && /across \d+ dispatched models?: /.test(text);
  if (presentation && typeof presentation.panelAgreement === "string" && presentation.panelAgreement) {
    presentation = { ...presentation, panelAgreement: `${presentation.panelAgreement} ${note}` };
  }
  const out: Record<string | symbol, unknown> = {
    ...src,
    ...(presentation !== p ? { presentation } : {}),
    ...(verdictCard !== card ? { verdictCard } : {}),
    ...(panelVerdict !== src.panelVerdict ? { panelVerdict } : {}),
    ...(counted(src.certaintyAssessment) ? { certaintyAssessment: `${src.certaintyAssessment} ${note}` } : {}),
    ...(!p && typeof src.unifiedAnswer === "string" && src.unifiedAnswer
      ? { unifiedAnswer: basisOf(noteT) === "no_responses" ? NO_SUCCESSFUL_MODEL_RESPONSES : `${src.unifiedAnswer} ${MODEL_INDEPENDENCE_QUALIFIER_LABEL}: ${answerIndependenceNote(noteT)}` }
      : {}),
    // A legacy report whose narrative fell back stores the same answer string as its executive summary.
    ...(!p && typeof src.executiveSummary === "string" && src.executiveSummary && src.executiveSummary === src.unifiedAnswer ? { executiveSummary: basisOf(noteT) === "no_responses" ? NO_SUCCESSFUL_MODEL_RESPONSES : `${src.executiveSummary} ${MODEL_INDEPENDENCE_QUALIFIER_LABEL}: ${answerIndependenceNote(noteT)}` } : {}),
  };
  const headingT = run ?? qualifiedKinds[0];
  const agreeHeading = !anyAgreeQualified
    ? null
    : headingT.kind === "unverified"
      ? AGREE_HEADING_UNVERIFIED
      : headingT.kind === "placeholder"
        ? AGREE_HEADING_PLACEHOLDER
        : headingT.voices.length < 2
          ? AGREE_HEADING_ONE_EXECUTING_MODEL
          : AGREE_HEADING_REPEATED_SUBSTITUTE;
  const qualification: IndependenceQualification = Object.freeze({ run, top, topStatus, topResultQualified, agreeHeading, legacyAgree });
  Object.defineProperty(out, QUALIFICATION, { value: qualification, enumerable: false });
  return out as unknown as R;
}

/** Who supports / disputes a statement none of whose slots returned a successful model response. */
export const NO_RESPONSES_NAMES = "none (no successful model responses)";

/** The structural slice of a stored report this view reads (types.ts AdaptiveSynthesisReport; kept loose: data is untrusted). */
type AdaptiveSynthesisReportLike = {
  presentation?: any;
  panelVerdict?: unknown;
  verdictCard?: any;
  whereModelsAgree?: unknown;
  unifiedAnswer?: unknown;
  executiveSummary?: unknown;
  certaintyAssessment?: unknown;
  gate?: unknown;
};

/**
 * How the verdict card / primary strip head and describe the top claim when its supporting slots are not independent
 * executing models; null when they are (rendered as before). `positions` is a marked report's PositionView.verdict
 * (its heading and independence come from its rows); an unmarked report reads its independence-qualified view, else —
 * a report handed to the card without that view — judges the card from `rows` and `provenance` directly. The separate
 * statement is shown only when the card's own result line does not already state independence.
 */
export function topIndependencePresentation(
  report: { verdictCard?: any } | null | undefined,
  positions: { topHeading: string; topIndependence?: QualifiedIndependence } | null,
  rows: readonly unknown[] | null | undefined,
  provenance: readonly RunModelProvenanceFacts[] | null | undefined
): { t: QualifiedIndependence; heading: string; statement: string | null } | null {
  const card = report?.verdictCard;
  if (!card) return null;
  if (positions) {
    const t = positions.topIndependence;
    if (!t) return null;
    return { t, heading: positions.topHeading, statement: card.topConsensusAgreement ? null : adaptiveTopIndependenceStatement(t, card.consensusModelCount) };
  }
  const q = independenceQualification(report);
  const t = q ? q.top : unmarkedTopIndependence(card, rows ?? null, provenance);
  if (!t) return null;
  return { t, heading: qualifiedTopHeading(t, q?.topStatus), statement: q?.topResultQualified ? null : adaptiveTopIndependenceStatement(t, card.consensusModelCount) };
}

/** A row's supporting slots as their executing models, each once ("DeepSeek (substituting ChatGPT, Claude)", "Grok"). */
export function groupedSupportingVoices(row: unknown, provenance: readonly RunModelProvenanceFacts[] | null | undefined): string[] {
  return groupSlotsByExecutingVoice(supportingSlotsOfRow(row) ?? [], provenance ?? null).map((g) => g.label);
}

/**
 * A marked report's position view (positionPresentation.ts, whose rows are qualified by rowView) carries the run's own
 * independence for the surfaces that introduce the panel (LinkedIn / X). Nothing for an independent run or without rows.
 */
export function attachRunIndependence(view: object, provenance: readonly RunModelProvenanceFacts[] | null | undefined): void {
  if (!Array.isArray(provenance) || independenceQualification(view)) return;
  const t = adaptiveTopIndependence(null, provenance);
  if (t.kind === "independent") return;
  const qualification: IndependenceQualification = Object.freeze({ run: t, top: null, topStatus: null, topResultQualified: false, agreeHeading: null, legacyAgree: new Map() });
  Object.defineProperty(view, QUALIFICATION, { value: qualification, enumerable: false });
}

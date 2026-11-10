/**
 * Execution identity of a run's rows, for PRESENTATION only (connector track C-a; inventory v3.4 §0.1c / §0.1d,
 * owner rulings D-4 and O3). The one shared gate (`executionIdentityVerified`, plan §1.4 G-3) and the one closed
 * placeholder-literal list (the D-5 module, register I-7). C-b / C-c import these; nothing re-implements them.
 *
 * A count K of INDEPENDENT executing models is shown only when the rows record who executed every usable row:
 *  1. every row is an object with a non-empty string `modelId` and a string `status` (`rowsRecordExecutionIdentity`);
 *  2. every usable row (status ok / substituted, non-empty text when the row carries text) records a provider: a
 *     token that normalizes (trim + lowercase) to a registered canonical provider (lib/panel/providerRegistry.ts,
 *     Order 33 ruling B) — "unknown", "n/a", "none", empty, unregistered strings record none. For an `ok` row that
 *     is the runtime provider Step 6.2a writes (research) or the claim dispatch stamps (Order 33); for a substituted
 *     row it is the substitute's provider.
 *  3. no row holds text whose validity cannot be established (VALIDITY_UNKNOWN, D-5);
 *  4. at least one usable row exists (K = 0 is never presented as a verified independent run; Order 29);
 *  5. every row's status is an exact recorded status literal of the ONE shared map (lib/panel/persistedStatusOutcome.ts):
 *     an unrecognized status is unknown and fails the gate closed — never read as a known failure (Order 30 A3).
 * When the gate holds, K is the number of distinct `executingModelKey`s over the usable rows. It never calls
 * `resolveExecutingModelKeys` (with the gate holding there is no unrecorded substitute to merge, so no inference path
 * exists), and it is never computed from requested slots, `selectedModels` or dispatched rows.
 * When the gate fails: "model independence unverified", no K, no other derived number.
 *
 * Stored-placeholder rows (INVALID_MOCK, the exact D-5 literals) are not model responses: they are excluded from K and
 * from the answered-slot count M here. That is a presentation statement only. Nothing in this module feeds a decision
 * (gate status, certainty, routing, consensus score, synthesis admission): those keep their 35933c8 inputs (Option C).
 *
 * The adaptive verdict surfaces (lib/adaptiveSchema/verdictIndependence.ts) judge the same gate over per-slot
 * RunModelProvenanceFacts (C-a review F-1): `identityRowFromFacts` is the one adapter from a facts row to the row shape
 * the gate reads, and the J02 fact (`invalidProviderOutput`) is read back by `placeholderClass` as the recorded
 * INVALID_MOCK class (a facts row carries no text). No second copy of the rule exists.
 *
 * Pure, client-safe, never throws, never mutates its input.
 */

import { isRecordedAnswerStatus, isRecordedFailureStatus, recordedSlotOutcome } from "./persistedStatusOutcome";
import { executingModelKey, rowsRecordExecutionIdentity } from "./independentVoices";
import type { RunModelProvenanceFacts } from "./runModelIdentity";
import { canonicalProvider } from "./providerRegistry";

// ─── D-5: the closed placeholder-literal list (the only copy in the tree) ─────────────────────────────────────────

/**
 * The exact texts the ChatGPT / Claude connectors returned, with `status: "ok"`, when their API key was not configured
 * (removed in b1a680e: a missing key now fails closed). Keyed by slot id. Closed list: a near miss is not a placeholder.
 */
export const STORED_PLACEHOLDER_LITERALS: Readonly<Record<"chatgpt" | "claude", string>> = Object.freeze({
  chatgpt: "Mock response from chatgpt (no API key configured)",
  claude: "Mock response from claude (no API key configured)",
});

/** Loose marker for text whose validity cannot be established (it mentions a mock response but is not a listed literal). */
const VALIDITY_UNKNOWN_MARKER = /mock response/i;

export type PlaceholderClass = "INVALID_MOCK" | "VALIDITY_UNKNOWN";

/** Per-slot notice for an INVALID_MOCK row. */
export const INVALID_PROVIDER_OUTPUT_NOTICE = "Not a model response: this slot had no API key configured (stored placeholder text).";
/** Per-slot notice for a VALIDITY_UNKNOWN row. */
export const VALIDITY_UNKNOWN_NOTICE = "Validity of this response could not be established.";

/** A row as any surface holds it: a live / saved result row, or a persisted perModel row. */
export type IdentityRow = {
  modelId?: unknown;
  status?: unknown;
  provider?: unknown;
  rawTextFull?: unknown;
  rawTextTruncated?: unknown;
  rawText?: unknown;
  text?: unknown;
  /** J02: the recorded INVALID_MOCK class of a provenance-facts row (`withPlaceholderFact`); only `true` means anything. */
  invalidProviderOutput?: unknown;
  /** The recorded VALIDITY_UNKNOWN class of a provenance-facts row (`withPlaceholderFact`); only `true` means anything. */
  validityUnknown?: unknown;
};

const TEXT_KEYS = ["rawTextFull", "rawTextTruncated", "rawText", "text"] as const;

/** Whether the row carries any text field at all (persisted perModel rows and result rows do; provenance facts do not). */
function carriesText(row: IdentityRow): boolean {
  return TEXT_KEYS.some((k) => k in row);
}

/** The first non-empty of rawTextFull | rawTextTruncated | rawText | text. */
export function identityRowText(row: IdentityRow): string {
  for (const k of TEXT_KEYS) {
    const v = row[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

/**
 * The D-5 class of a row (exact oracle, inventory v2 §0.5):
 *  - INVALID_MOCK ⇔ status ok ∧ modelId ∈ {chatgpt, claude} ∧ text.trim() is exactly that slot's listed literal;
 *  - VALIDITY_UNKNOWN ⇔ not INVALID_MOCK ∧ the text mentions "mock response" (any case);
 *  - otherwise null.
 * A row that carries the J02 fact (`invalidProviderOutput: true`) or the `validityUnknown: true` fact — both written by
 * `withPlaceholderFact` from this same oracle — has that class: a provenance-facts row holds no text, so the fact is its
 * recorded class.
 */
export function placeholderClass(row: IdentityRow | null | undefined): PlaceholderClass | null {
  if (!row || typeof row !== "object") return null;
  if (row.invalidProviderOutput === true) return "INVALID_MOCK";
  if (row.validityUnknown === true) return "VALIDITY_UNKNOWN";
  const text = identityRowText(row);
  if (!text) return null;
  const slot = typeof row.modelId === "string" ? row.modelId.trim().toLowerCase() : "";
  const literal = slot === "chatgpt" || slot === "claude" ? STORED_PLACEHOLDER_LITERALS[slot] : null;
  if (literal && row.status === "ok" && text.trim() === literal) return "INVALID_MOCK";
  return VALIDITY_UNKNOWN_MARKER.test(text) ? "VALIDITY_UNKNOWN" : null;
}

/**
 * J02: the facts of a slot whose stored text is a listed placeholder gain `invalidProviderOutput: true` (the per-slot
 * card says so; run-scope independence excludes the slot). Every other slot's facts are returned unchanged (same object).
 */
export function withPlaceholderFact(facts: RunModelProvenanceFacts, row: IdentityRow): RunModelProvenanceFacts {
  const cls = placeholderClass(row);
  if (cls === "INVALID_MOCK") return { ...facts, invalidProviderOutput: true };
  if (cls === "VALIDITY_UNKNOWN") return { ...facts, validityUnknown: true };
  return facts;
}

/**
 * A per-slot provenance-facts row (`RunModelProvenanceFacts`) as the gate reads it. Only the recorded `status` is
 * read, as recorded (a failed / timed-out slot is not a usable row and needs no provider, exactly as on the result
 * rows; an export entry's status is its RECORDED outcome, runModelProvenanceFromExport). A facts row without a status
 * — a version-1 frozen export entry, a statusless row — has no recorded status and the gate fails: `substituted` is
 * never read as a status (Order 29 A2 removed that inference — a frozen `substituted: false` also covered failed
 * slots). `provider` and the D-5 facts (`invalidProviderOutput`, `validityUnknown`) pass through; nothing is inferred
 * or completed.
 */
export function identityRowFromFacts(facts: RunModelProvenanceFacts | null | undefined): IdentityRow {
  if (!facts || typeof facts !== "object") return {};
  const status = typeof facts.status === "string" && facts.status.length > 0 ? facts.status : undefined;
  return {
    modelId: facts.modelId,
    ...(status !== undefined ? { status } : {}),
    ...(facts.provider !== undefined ? { provider: facts.provider } : {}),
    ...(facts.invalidProviderOutput === true ? { invalidProviderOutput: true } : {}),
    ...(facts.validityUnknown === true ? { validityUnknown: true } : {}),
  };
}

// ─── The corrected D-4 gate ──────────────────────────────────────────────────────────────────────────────────────

/** Order 33 (ruling B): a provider is recorded only when it normalizes to the ONE canonical registry. */
function recordedProvider(provider: unknown): boolean {
  return canonicalProvider(provider) !== null;
}

/** A row that answered: status ok / substituted and, when the row carries text, non-empty text. */
function isUsable(row: IdentityRow): boolean {
  if (!isRecordedAnswerStatus(row.status)) return false;
  return carriesText(row) ? identityRowText(row).trim().length > 0 : true;
}

/**
 * A row whose RECORDED status is a failure (failed / error / timeout / refused / rate_limited): a known fact, never a
 * vote. Exact match through the ONE shared status map (lib/panel/persistedStatusOutcome.ts, Order 30 A3): an
 * unrecognized status ("OK ", "Ok", "", "toString", "__proto__", …) is UNKNOWN — never a known failure — and fails the
 * gate closed (`identityRowStatusUnknown`).
 */
export function identityRowRecordedFailure(row: IdentityRow | null | undefined): boolean {
  if (!row || typeof row !== "object") return false;
  return isRecordedFailureStatus(row.status);
}

/** A row whose status is not one of the exact recorded status literals (missing, non-string, crafted): unknown. */
export function identityRowStatusUnknown(row: IdentityRow | null | undefined): boolean {
  if (!row || typeof row !== "object") return true;
  return recordedSlotOutcome(row.status) === null;
}

/**
 * The corrected D-4 gate (inventory v3.3 §0.1c, `executionIdentityVerified(rows)`): `rowsRecordExecutionIdentity` AND
 * every usable row records a provider AND no row is VALIDITY_UNKNOWN AND at least one row answered AND every row's
 * status is an exact recorded status literal (the shared map; an unknown status fails closed, Order 30 A3). INVALID_MOCK rows
 * are not usable rows here (they are not model responses), so they need no provider and do not count as an answer.
 * No rows → false. No answered row (every slot failed, or held only placeholder text) → false: with K = 0 there is no
 * independent model to present, so nothing is ever rendered as a verified independent run (Order 29, finding
 * "K=0 → IND").
 */
export function executionIdentityVerified(rows: readonly unknown[] | null | undefined): boolean {
  if (!rowsRecordExecutionIdentity(rows)) return false;
  let answered = 0;
  for (const raw of rows as readonly IdentityRow[]) {
    // Order 30 A3: a status that is not an exact recorded literal is unknown — the gate fails closed.
    if (identityRowStatusUnknown(raw)) return false;
    const cls = placeholderClass(raw);
    if (cls === "VALIDITY_UNKNOWN") return false;
    if (cls === "INVALID_MOCK") continue;
    if (!isUsable(raw)) continue;
    if (!recordedProvider(raw.provider)) return false;
    answered += 1;
  }
  return answered > 0;
}

/**
 * The run's independence as presented:
 *  - IND: every answered slot is its own executing model (K === M) and no stored placeholder → surfaces render as
 *    before (byte-identical);
 *  - PC: at least two independent executing models, fewer than answered slots;
 *  - FC: one executing model answered two or more slots;
 *  - UV: the gate fails (no K).
 * `mock` is true when a stored placeholder row was excluded (INVALID_MOCK): the run is then never presented as IND.
 */
export type RunIndependenceKind = "IND" | "PC" | "FC" | "UV";

export type RunExecutionIdentity = {
  kind: RunIndependenceKind;
  verified: boolean;
  /** Independent executing models over the answered slots; null unless verified. */
  independentModels: number | null;
  /** Answered panel slots (usable rows, stored placeholders excluded). */
  answeredSlots: number;
  /** Every panel slot the rows record (the roster, as recorded). */
  panelSlots: number;
  /** INVALID_MOCK slot ids, in row order. */
  placeholderSlots: string[];
  /** Answered slot id → its executing-model key (verified runs only; empty otherwise). Never merged / inferred. */
  slotKeys: Readonly<Record<string, string>>;
  /** True when the run is presented with a qualifier (anything but a clean IND). */
  qualified: boolean;
};

const UNVERIFIED_IDENTITY = (panelSlots: number, answeredSlots: number, placeholderSlots: string[]): RunExecutionIdentity => ({
  kind: "UV",
  verified: false,
  independentModels: null,
  answeredSlots,
  panelSlots,
  placeholderSlots,
  slotKeys: {},
  qualified: true,
});

export function runExecutionIdentity(rows: readonly unknown[] | null | undefined): RunExecutionIdentity {
  const list = Array.isArray(rows) ? (rows as readonly unknown[]) : [];
  const placeholderSlots: string[] = [];
  const answered: IdentityRow[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as IdentityRow;
    if (placeholderClass(row) === "INVALID_MOCK") {
      placeholderSlots.push(String(row.modelId).trim());
      continue;
    }
    if (isUsable(row)) answered.push(row);
  }
  if (!executionIdentityVerified(list)) return UNVERIFIED_IDENTITY(list.length, answered.length, placeholderSlots);
  const slotKeys: Record<string, string> = {};
  for (const r of answered) slotKeys[String(r.modelId).trim()] = executingModelKey({ modelId: String(r.modelId), status: String(r.status), provider: r.provider });
  const k = new Set(Object.values(slotKeys)).size;
  const m = answered.length;
  const kind: RunIndependenceKind = k === m ? "IND" : k <= 1 ? "FC" : "PC";
  return {
    kind,
    verified: true,
    independentModels: k,
    answeredSlots: m,
    panelSlots: list.length,
    placeholderSlots,
    slotKeys,
    qualified: kind !== "IND" || placeholderSlots.length > 0,
  };
}

/** True when a surface must keep its 35933c8 / b894828 rendering (a verified, independent run without placeholders). */
export function rendersAsIndependent(identity: RunExecutionIdentity | null | undefined): boolean {
  return !identity || !identity.qualified;
}

// ─── Wording (owner ruling O3 (a) and the C-a row corrections) ──────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "K independent executing models answered M panel slots" / "model independence unverified". */
export function runSlotStatement(identity: RunExecutionIdentity): string {
  if (!identity.verified || identity.independentModels === null) return "model independence unverified";
  return `${plural(identity.independentModels, "independent executing model", "independent executing models")} answered ${plural(identity.answeredSlots, "panel slot", "panel slots")}`;
}

/** O3 (a): the label above one model-written block group, shown only when the run is FC / PC / UV / MOCK. */
export function modelWrittenBlockLabel(identity: RunExecutionIdentity): string {
  const lead = "Model-written text saved with this run. Statements in it about agreement between models are not verified: ";
  if (!identity.verified || identity.independentModels === null) return `${lead}model independence unverified.`;
  return `${lead}${plural(identity.independentModels, "independent model", "independent models")} answered ${plural(identity.answeredSlots, "panel slot", "panel slots")}.`;
}

/** O3 (a), X short form: one line, never truncated. */
export function modelWrittenShortLabel(identity: RunExecutionIdentity): string {
  if (!identity.verified || identity.independentModels === null) return "Model-written; model independence unverified.";
  return `Model-written; ${identity.independentModels} independent model${identity.independentModels === 1 ? "" : "s"}, ${identity.answeredSlots} slot${identity.answeredSlots === 1 ? "" : "s"}.`;
}

/** E22: the Key Findings section label (model-written findings, confidence assigned by the synthesis model). */
export const MODEL_WRITTEN_FINDINGS_LABEL = "Model-written findings; confidence levels are assigned by the synthesis model.";

/** E14: the memo's confidence assessment is the saved synthesis's own text. */
export const MODEL_WRITTEN_ASSESSMENT_LABEL = "Model-written assessment (not verified).";

/** A12: one computed note above the adaptive trust table. */
export function trustFiguresNote(identity: RunExecutionIdentity): string {
  if (!identity.verified || identity.independentModels === null) return "Trust figures are per panel slot: model independence unverified.";
  return `Trust figures are per panel slot: ${plural(identity.independentModels, "independent executing model", "independent executing models")} answered ${plural(identity.answeredSlots, "slot", "slots")}.`;
}

/** B01: a milestone-2 coverage count, stated as panel slots ("3 of 5 panel slots covered this (1 independent model)"). */
export type SlotCoverageMode = "covered" | "agreed" | "assessed" | "converged";
const SLOT_COVERAGE_VERB: Record<SlotCoverageMode, string> = { covered: "covered this", agreed: "agreed", assessed: "assessed this", converged: "converged on this" };

export function slotCoverageText(covered: number, total: number, mode: SlotCoverageMode, identity: RunExecutionIdentity): string {
  const k = identity.verified && identity.independentModels !== null ? plural(identity.independentModels, "independent model", "independent models") : "model independence unverified";
  return `${covered} of ${plural(total, "panel slot", "panel slots")} ${SLOT_COVERAGE_VERB[mode]} (${k})`;
}

/** The parenthesised run qualifier used after a slot count: "(2 independent models)" / "(model independence unverified)". */
export function independentModelsQualifier(identity: RunExecutionIdentity): string {
  return identity.verified && identity.independentModels !== null
    ? `(${plural(identity.independentModels, "independent model", "independent models")})`
    : "(model independence unverified)";
}

/** Suffix for agreement / dispute labels of a UV run ("Strong consensus (model independence unverified)"). */
export const INDEPENDENCE_UNVERIFIED_SUFFIX = "(model independence unverified)";

/** FC / same-model sides: a recorded difference, never a split between models. */
export const RECORDED_DIFFERENCE_WORD = "recorded difference";

/** B02 / B05 / B08: a dispute or contest label of a qualified run is stated across panel slots. */
export const ACROSS_PANEL_SLOTS = "across panel slots";

/** B03 (FC): a consensus / split cell over one executing model. */
export const ONE_EXECUTING_MODEL_VALUES = "recorded values (one executing model)";

/** B03 (PC / UV): a split cell is a difference across panel slots, not between independent models. */
export const VALUES_DIFFER_ACROSS_SLOTS = "Values differ across panel slots";

/** B05 / B08: the coverage note of a qualified run (in place of "how many models converged on each point"). */
export function slotCoverageNote(identity: RunExecutionIdentity): string {
  return `Coverage badges above count panel slots (${runSlotStatement(identity)}); they are not counts of independent models.`;
}

/** B08 (FC): the disagreement section of a run one executing model answered. */
export const RECORDED_DIFFERENCES_ONE_MODEL_HEADING = "Recorded differences (one executing model answered every slot)";

/** B10: the homogeneity caveat of a qualified run (the stored message is shown verbatim for an independent run only). */
export function uniformResponsesNote(identity: RunExecutionIdentity): string {
  return `Unusually uniform responses across panel slots, not independent agreement: ${runSlotStatement(identity)}.`;
}

/** B11: "Citations: N of M panel slots cite a source (K independent models)". */
export function slotCitationText(withSources: number, total: number, identity: RunExecutionIdentity): string {
  return `Citations: ${withSources} of ${total} panel slot${total === 1 ? "" : "s"} cite a source ${independentModelsQualifier(identity)}`;
}

/** A27: the run-level qualifier under "Where the models land" (heading unchanged). */
export function consensusMapQualifier(identity: RunExecutionIdentity): string {
  return identity.verified && identity.independentModels !== null
    ? `${runSlotStatement(identity).replace(/^./, (c) => c.toUpperCase())}.`
    : "Columns are panel slots: model independence unverified.";
}

/** A13: how many OTHER answered slots the same executing model answered (0 when unique, or when the run is unverified). */
export function otherSlotsAnsweredBySameModel(identity: RunExecutionIdentity, slotId: string): number {
  const key = identity.slotKeys[String(slotId).trim()];
  if (!identity.verified || !key) return 0;
  return Object.entries(identity.slotKeys).filter(([id, k]) => k === key && id !== String(slotId).trim()).length;
}

/** A13: "(also answered 3 other slots)". */
export function alsoAnsweredText(n: number): string {
  return `(also answered ${n} other slot${n === 1 ? "" : "s"})`;
}

/** A13 (UV): the list's alignment figures are per panel slot. */
export const SLOT_ALIGNMENT_UNVERIFIED_NOTE = "Alignment figures are per panel slot: model independence unverified.";

/** E04 / E05 (PC or stored placeholders): what the saved synthesis's score was computed over. */
export function slotScoreStatement(identity: RunExecutionIdentity): string {
  return `Score computed over ${plural(identity.answeredSlots, "answering slot", "answering slots")} by the saved synthesis; ${plural(identity.independentModels ?? 0, "independent executing model", "independent executing models")}.`;
}

/** E20: stored placeholder rows excluded, fewer than two independent models responded → no consensus score is shown. */
export const PLACEHOLDER_INSUFFICIENT_SCORE_TEXT =
  "No consensus score: fewer than two independent models responded once stored placeholder text (not a model response) is set aside.";

/** E21 (PC): the number of independent executing models among a finding's supporting slots (no inference). */
export function independentModelsAmong(identity: RunExecutionIdentity, slotIds: readonly string[]): number {
  return new Set(slotIds.map((id) => identity.slotKeys[String(id).trim()]).filter((k): k is string => typeof k === "string")).size;
}

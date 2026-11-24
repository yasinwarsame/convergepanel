/**
 * Item 7A — structured-output degradation disclosure. The ONE place that decides what a report or export says about
 * how many selected models produced usable structured output, and which did not.
 *
 * Source of truth: the run's persisted `CommonResponseMeta` only.
 * - Counts: `totalModels` (selected), `successfulModels` (provider calls that completed), `modelsWithUsableOutput`
 *   (usable structured output). A completed provider call is never counted as a usable result.
 * - `structuredOutput`: the per-slot record (written since Item 7A, only when a slot was not complete).
 *
 * Material shortening rule (owner-approved, Item 7A). A slot's shortening — items discarded as invalid, whole items cut
 * by an item cap, or text trimmed to a word cap — is MATERIAL when it affects:
 *   - a decision-critical field of the run's schema (DECISION_CRITICAL_FIELDS, an explicit per-schema mapping), or
 *   - two or more distinct fields.
 * An isolated shortening of one non-critical field is still disclosed, but only in details, without the prominent
 * notice. Always prominent: a model with no usable output, a field that was not recovered at all, a shortfall whose
 * models were not recorded, and any schema without a mapping (importance is never guessed).
 *
 * Fail closed: a missing or malformed per-slot record never becomes a guess. When the counts show a shortfall but no
 * valid per-slot record exists (every run before Item 7A), the disclosure says the affected models were not recorded.
 * A run with no shortfall and no record shows nothing.
 *
 * Item 7B: a slot may carry an optional `cause` (StructuredOutputCause). The reader accepts it only when it is one of
 * the closed values and consistent with the slot (none on a complete slot; "provider_failure" only on a failed call;
 * "output_budget_exhausted" and "validation_failure" only on a completed call); anything else rejects the whole record.
 * Only "output_budget_exhausted" adds wording ("the response reached the provider's output-token limit"): the other
 * causes are already stated by the state itself or are not established. Records without a cause read exactly as before.
 *
 * Pure and client-safe: no I/O, no logging, never throws. Field keys and counts only; never model content.
 */
import { STRUCTURED_OUTPUT_CAUSES } from "./types";
import type { CommonResponseMeta, StructuredOutputCause, StructuredOutputRecordV1, StructuredOutputSlotV1 } from "./types";

export interface StructuredOutputDisclosureModel {
  modelId: string;
  /** "unavailable" = no usable structured output; "partial" = some fields or items not recovered, or shortened by a cap. */
  state: "unavailable" | "partial";
  /** Whether the provider call completed (kept separate from usability). */
  providerCall: "completed" | "failed";
  fieldsNotRecovered: number;
  itemsDiscarded: number;
  itemsOverLimit: number;
  /** Fields whose text was trimmed to a word cap (shortened fields with no item cut by an item cap). */
  textShortenedFields: number;
  /** Distinct schema fields affected in any way. */
  affectedFields: number;
  /** At least one affected field is in the schema's decision-critical mapping. */
  decisionCriticalAffected: boolean;
  /** Prominent (true) or details-only (false) under the material rule. */
  material: boolean;
  /** Item 7B: why the slot was not complete, when the run recorded it. */
  cause?: StructuredOutputCause;
}

export interface StructuredOutputDisclosure {
  selected: number;
  /** Provider calls that completed; null when the run did not record the count. */
  completedCalls: number | null;
  usable: number;
  /** e.g. "5 models selected · 4 usable structured results". */
  headline: string;
  /** e.g. "5 of 5 provider calls completed." — null when the count was not recorded. */
  callsLine: string | null;
  /** Per affected slot, in slot order; null when the run did not record per-slot detail. */
  affected: StructuredOutputDisclosureModel[] | null;
  /**
   * True: show the prominent notice (a model unavailable, a field lost, a material shortening, or a shortfall whose
   * models were not recorded). False: every affected model has only an isolated non-critical shortening — disclose in
   * details only.
   */
  prominent: boolean;
}

/**
 * Item 7A: the decision-critical fields of each of the 9 Milestone-2 schemas — the fields that carry the run's
 * recommendation, conclusion, risks, next steps, uncertainty or supporting evidence. Explicit and deterministic; every
 * key is checked against SCHEMA_REGISTRY by item7aStructuredOutputDisclosure.spec.tsx. A schema missing from this map
 * makes every shortening material.
 */
export const DECISION_CRITICAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // conclusion: the ranked items themselves.
  ranked_enumeration: ["items"],
  // evidence: cells; conclusion: directConclusion; risks: tradeoffs; recommendations: bestUseRecommendations; uncertainty.
  comparison_matrix: ["cells", "directConclusion", "tradeoffs", "bestUseRecommendations", "uncertainties"],
  // conclusion: directAnswer, keyPoints (the points a reader should retain); risk of misunderstanding:
  // commonMisconceptions; evidence: sources. Not critical (elaboration): term, explanation, example, analogyText,
  // analogyLimits, distinctions, processSteps, advancedDetail, relatedConcepts.
  definition_explanation: ["directAnswer", "keyPoints", "commonMisconceptions", "sources"],
  // conclusion: directAnswer, directCauses; uncertainty: alternativeExplanations, confounders, disputedInterpretations,
  // unknowns; next steps: testsOrEvidenceNeeded; evidence: sources. Not critical (elaboration of the stated causes):
  // contributingFactors, triggers, amplifiers, causalLinks.
  causal_explanation: [
    "directAnswer",
    "directCauses",
    "alternativeExplanations",
    "confounders",
    "disputedInterpretations",
    "unknowns",
    "testsOrEvidenceNeeded",
    "sources",
  ],
  // conclusion: the checklist items; limitations: notes (stated caveats). Not critical: summary (framing only).
  checklist_taxonomy: ["items", "notes"],
  // conclusion: executiveSummary; evidence: findings, sources; uncertainty: disagreements, evidenceGaps, openQuestions;
  // scope: researchBoundaries; next steps: recommendedNextSteps.
  deep_research: ["executiveSummary", "findings", "disagreements", "evidenceGaps", "openQuestions", "researchBoundaries", "recommendedNextSteps", "sources"],
  // conclusion: overallAssessment; evidence: dimensions, strengths, sources; risks: redFlags; uncertainty:
  // applicabilityCaveats; next steps: recommendedChecks.
  evidence_review: ["overallAssessment", "dimensions", "redFlags", "strengths", "applicabilityCaveats", "recommendedChecks", "sources"],
  // conclusion: summary and every bias finding (omitted dimensions, shared assumptions, missing stakeholders,
  // geographic, source-concentration and evidence-type concerns); next steps: followUpQuestions; evidence: sources.
  bias_blindspot_audit: [
    "summary",
    "omittedDimensions",
    "sharedAssumptions",
    "missingStakeholders",
    "geographicBiases",
    "sourceConcentrationConcerns",
    "evidenceTypeConcerns",
    "followUpQuestions",
    "sources",
  ],
  // the decision's basis: options, criteria, userProvidedCriteria, assumptions; recommendation: action, option,
  // rationale, caveats; evidence: assessments, sources; risks; uncertainty: uncertainties, sensitivityFindings; next
  // steps: reversibleNextStep. Not critical: decisionQuestion (restates the question).
  decision_support: [
    "options",
    "criteria",
    "userProvidedCriteria",
    "assessments",
    "recommendationAction",
    "recommendedOption",
    "recommendationRationale",
    "recommendationCaveats",
    "assumptions",
    "uncertainties",
    "risks",
    "sensitivityFindings",
    "reversibleNextStep",
    "sources",
  ],
};

const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0) && new Set(v).size === v.length;

function readCounts(v: unknown): Record<string, number> | undefined | null {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([k, n]) => k.length > 0 && isNonNegInt(n) && n > 0)) return null;
  return Object.fromEntries(entries) as Record<string, number>;
}

function readSlot(raw: unknown): StructuredOutputSlotV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.modelId !== "string" || o.modelId.length === 0) return null;
  if (o.call !== "completed" && o.call !== "failed") return null;
  if (o.result !== "complete" && o.result !== "partial" && o.result !== "unavailable") return null;
  if (o.invalidFields !== undefined && !isStringArray(o.invalidFields)) return null;
  if (o.shortenedFields !== undefined && !isStringArray(o.shortenedFields)) return null;
  const droppedItems = readCounts(o.droppedItems);
  const itemsOverLimit = readCounts(o.itemsOverLimit);
  if (droppedItems === null || itemsOverLimit === null) return null;
  // Fail closed: "partial" must carry the evidence it claims; "complete" and "unavailable" carry none.
  const hasEvidence = o.invalidFields !== undefined || o.shortenedFields !== undefined || !!droppedItems || !!itemsOverLimit;
  if ((o.result === "partial") !== hasEvidence) return null;
  // Item 7B: an optional cause must be a known value and agree with the slot it explains.
  if (o.cause !== undefined) {
    if (typeof o.cause !== "string" || !(STRUCTURED_OUTPUT_CAUSES as readonly string[]).includes(o.cause)) return null;
    if (o.result === "complete") return null;
    if (o.cause === "provider_failure" && o.call !== "failed") return null;
    if ((o.cause === "output_budget_exhausted" || o.cause === "validation_failure") && o.call !== "completed") return null;
  }
  return {
    modelId: o.modelId as StructuredOutputSlotV1["modelId"],
    call: o.call,
    result: o.result,
    ...(o.invalidFields ? { invalidFields: o.invalidFields as string[] } : {}),
    ...(droppedItems ? { droppedItems } : {}),
    ...(itemsOverLimit ? { itemsOverLimit } : {}),
    ...(o.shortenedFields ? { shortenedFields: o.shortenedFields as string[] } : {}),
    ...(o.cause !== undefined ? { cause: o.cause as StructuredOutputCause } : {}),
  };
}

/** The persisted per-slot record, or null when absent or not exactly valid for this run's counts. */
export function readStructuredOutputRecord(meta: Partial<CommonResponseMeta> | null | undefined): StructuredOutputRecordV1 | null {
  const raw = (meta as { structuredOutput?: unknown } | null | undefined)?.structuredOutput;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.slots)) return null;
  const slots: StructuredOutputSlotV1[] = [];
  for (const s of o.slots) {
    const slot = readSlot(s);
    if (!slot) return null;
    slots.push(slot);
  }
  const total = meta?.totalModels;
  const usable = meta?.modelsWithUsableOutput;
  const successful = meta?.successfulModels;
  if (!isNonNegInt(total) || slots.length !== total) return null;
  if (!isNonNegInt(usable) || slots.filter((s) => s.result !== "unavailable").length !== usable) return null;
  if (successful !== undefined && (!isNonNegInt(successful) || slots.filter((s) => s.call === "completed").length !== successful)) return null;
  return { version: 1, slots };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sum = (c?: Record<string, number>) => Object.values(c ?? {}).reduce((a, b) => a + b, 0);

function describeSlot(s: StructuredOutputSlotV1, schemaId: unknown): StructuredOutputDisclosureModel {
  const base = { modelId: s.modelId, providerCall: s.call, ...(s.cause ? { cause: s.cause } : {}) };
  if (s.result === "unavailable") {
    return { ...base, state: "unavailable", fieldsNotRecovered: 0, itemsDiscarded: 0, itemsOverLimit: 0, textShortenedFields: 0, affectedFields: 0, decisionCriticalAffected: false, material: true };
  }
  const invalid = s.invalidFields ?? [];
  const cut = Object.keys(s.itemsOverLimit ?? {});
  const affected = new Set([...invalid, ...Object.keys(s.droppedItems ?? {}), ...cut, ...(s.shortenedFields ?? [])]);
  const critical = typeof schemaId === "string" && Object.prototype.hasOwnProperty.call(DECISION_CRITICAL_FIELDS, schemaId) ? DECISION_CRITICAL_FIELDS[schemaId] : null;
  const decisionCriticalAffected = critical !== null && [...affected].some((k) => critical.includes(k));
  return {
    ...base,
    state: "partial",
    fieldsNotRecovered: invalid.length,
    itemsDiscarded: sum(s.droppedItems),
    itemsOverLimit: sum(s.itemsOverLimit),
    textShortenedFields: (s.shortenedFields ?? []).filter((k) => !cut.includes(k)).length,
    affectedFields: affected.size,
    decisionCriticalAffected,
    material: critical === null || invalid.length > 0 || decisionCriticalAffected || affected.size >= 2,
  };
}

/**
 * The disclosure for a run, or null when there is nothing to disclose (every selected model produced complete
 * structured output, or the run predates the counts).
 */
export function deriveStructuredOutputDisclosure(meta: Partial<CommonResponseMeta> | null | undefined): StructuredOutputDisclosure | null {
  const selected = meta?.totalModels;
  const usable = meta?.modelsWithUsableOutput;
  if (!isNonNegInt(selected) || !isNonNegInt(usable) || selected === 0 || usable > selected) return null;
  const record = readStructuredOutputRecord(meta);
  if (usable === selected && !record) return null;
  const affected: StructuredOutputDisclosureModel[] | null = record
    ? record.slots.filter((s) => s.result !== "complete").map((s) => describeSlot(s, meta?.schemaId))
    : null;
  if (affected && affected.length === 0) return null;
  const successful = meta?.successfulModels;
  const completedCalls = isNonNegInt(successful) && successful <= selected ? successful : null;
  return {
    selected,
    completedCalls,
    usable,
    headline: `${plural(selected, "model", "models")} selected · ${plural(usable, "usable structured result", "usable structured results")}`,
    callsLine: completedCalls === null ? null : `${completedCalls} of ${selected} provider ${selected === 1 ? "call" : "calls"} completed.`,
    affected,
    prominent: affected === null || affected.some((m) => m.material),
  };
}

/** What happened to one affected model, without its name (the caller shows the name). */
export function describeAffectedState(m: StructuredOutputDisclosureModel): string {
  // Item 7B: stated only when the provider itself reported it (never inferred from malformed output).
  const budget = m.cause === "output_budget_exhausted" ? `; ${STRUCTURED_OUTPUT_BUDGET_CAUSE_TEXT}` : "";
  if (m.state === "unavailable") {
    return (m.providerCall === "failed"
      ? "unavailable: the provider call did not complete"
      : "unavailable: the provider call completed but returned no usable structured output") + budget;
  }
  const parts: string[] = [];
  if (m.fieldsNotRecovered > 0) parts.push(`${plural(m.fieldsNotRecovered, "field", "fields")} not recovered`);
  if (m.itemsDiscarded > 0) parts.push(`${plural(m.itemsDiscarded, "item", "items")} discarded as invalid`);
  if (m.itemsOverLimit > 0) parts.push(`${plural(m.itemsOverLimit, "item", "items")} beyond field limits not included`);
  if (m.textShortenedFields > 0) parts.push(`text shortened to the word limit in ${plural(m.textShortenedFields, "field", "fields")}`);
  return `partially used: ${parts.join("; ")}${budget}`;
}

/** Item 7B: the wording for a recorded "output_budget_exhausted" cause. */
export const STRUCTURED_OUTPUT_BUDGET_CAUSE_TEXT = "the response reached the provider's output-token limit";

/** Shown when the counts show a shortfall but the run did not record which models were affected. */
export const STRUCTURED_OUTPUT_DETAIL_NOT_RECORDED = "Which models were affected was not recorded for this run.";

/** The JSON export's derived disclosure (Item 7A): counts, affected models by id, and the rendered lines. */
export interface DerivedStructuredOutputDisclosure {
  derivedAtExport: true;
  selected: number;
  completedCalls: number | null;
  usable: number;
  affected: StructuredOutputDisclosureModel[] | null;
  prominent: boolean;
  lines: string[];
}

/**
 * The disclosure an EXPORT renders: only for a run that carries a valid per-slot record (every run created since
 * Item 7A). A run without one — every stored historical export — renders exactly as before, so a re-rendered historical
 * export still reproduces its stored file hash. (The live report still shows such a run's counts.)
 */
export function deriveRecordedStructuredOutputDisclosure(meta: unknown): StructuredOutputDisclosure | null {
  const m = meta && typeof meta === "object" ? (meta as Partial<CommonResponseMeta>) : null;
  return readStructuredOutputRecord(m) ? deriveStructuredOutputDisclosure(m) : null;
}

export function deriveStructuredOutputExportDisclosure(meta: unknown, nameOf: (modelId: string) => string): DerivedStructuredOutputDisclosure | null {
  const d = deriveRecordedStructuredOutputDisclosure(meta);
  if (!d) return null;
  return { derivedAtExport: true, selected: d.selected, completedCalls: d.completedCalls, usable: d.usable, affected: d.affected, prominent: d.prominent, lines: structuredOutputDisclosureLines(d, nameOf) };
}

/** Section heading used by every export format. */
export const STRUCTURED_OUTPUT_SECTION_HEADING = "Structured output completeness";

/**
 * The plain lines every export format (PDF, DOCX, JSON) renders for a disclosure, using the caller's model names.
 * Same wording and order as the live report notice. Each affected line reads "<name> — <state>." so a name that itself
 * carries a qualifier ("Gemini · model not recorded") stays separate from the state.
 */
export function structuredOutputDisclosureLines(d: StructuredOutputDisclosure, nameOf: (modelId: string) => string): string[] {
  return [
    d.headline,
    ...(d.callsLine ? [d.callsLine] : []),
    ...(d.affected === null ? [STRUCTURED_OUTPUT_DETAIL_NOT_RECORDED] : d.affected.map((m) => `${nameOf(m.modelId)} — ${describeAffectedState(m)}${m.material ? "" : " (not decision-critical)"}.`)),
  ];
}

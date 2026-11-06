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
 *  - "unverified": a slot considered has no recorded execution identity (no row, or a row without a recorded status)
 *    — model independence is stated as unverified; nothing is invented.
 * The slots considered are the top claim's supporting cells when the stored rows join it ("supporters"), otherwise
 * every slot the run records ("run"). Without the run's rows at all (`provenance` null — a surface not handed the
 * record, RunModelProvenanceContext's contract) nothing is inferred and the report renders as before.
 *
 * Pure, client-safe; imports no computation module (it is read by positionPresentation.ts).
 */

import { groupSlotsByExecutingVoice } from "@/lib/panel/executingVoiceLabel";
import type { RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import { NO_CONSENSUS_IDENTIFIED, quoteClaim } from "./agreementNarrative";

export type AdaptiveTopIndependence =
  | { kind: "independent" }
  | { kind: "repeated_substitute"; scope: "supporters" | "run"; voices: string[]; repeated: string[] }
  | { kind: "unverified"; scope: "supporters" | "run" };

const INDEPENDENT: AdaptiveTopIndependence = Object.freeze({ kind: "independent" as const });

/** Heading in place of "Top consensus" / "Top majority-supported claim" / "Models agree" (repeated substitute model). */
export const ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING = "Top finding (repeated substitute model; not an independent consensus)";
/** Heading in place of "Top consensus" / "Top majority-supported claim" / "Models agree" (execution identity not recorded). */
export const ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING = "Top finding (model independence unverified; not confirmed as a consensus)";

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

export function adaptiveTopIndependence(
  supporters: readonly string[] | null,
  provenance: readonly RunModelProvenanceFacts[] | null | undefined
): AdaptiveTopIndependence {
  if (!Array.isArray(provenance)) return INDEPENDENT;
  const scope = supporters ? "supporters" : "run";
  const source = supporters ?? provenance.map((f) => (f && typeof f.modelId === "string" ? f.modelId : ""));
  const slots = Array.from(new Set(source.map((s) => String(s).trim()).filter((s) => s.length > 0)));
  if (slots.length === 0) return scope === "run" && provenance.length > 0 ? { kind: "unverified", scope } : INDEPENDENT;
  const factsOf = (slot: string) => provenance.find((f) => f && typeof f.modelId === "string" && f.modelId.trim() === slot);
  if (slots.some((s) => typeof factsOf(s)?.substituted !== "boolean")) return { kind: "unverified", scope };
  if (scope === "run" && provenance.some((f) => !f || typeof f.modelId !== "string" || !f.modelId.trim())) return { kind: "unverified", scope };
  const groups = groupSlotsByExecutingVoice(slots, provenance);
  if (groups.length >= slots.length) return INDEPENDENT;
  return { kind: "repeated_substitute", scope, voices: groups.map((g) => g.label), repeated: groups.filter((g) => g.slotIds.length > 1).map((g) => g.label) };
}

export function adaptiveTopHeading(t: AdaptiveTopIndependence): string | null {
  if (t.kind === "repeated_substitute") return ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING;
  if (t.kind === "unverified") return ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING;
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
    return `Model independence unverified: ${recorded ? `${recorded.charAt(0).toLowerCase()}${recorded.slice(1)}, but which` : "which"} models answered ${t.scope === "supporters" ? "the supporting slots" : "this run's slots"} is not recorded.`;
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
    return `recorded as ${RECORDED_STATUS_WORD[status]} of ${slotsText(s)}${disputes}; model independence unverified — which models answered the supporting slots is not recorded`;
  }
  const m = t.voices.length;
  if (m < 2) return `not an independent ${NOT_INDEPENDENT_WORD[status]}: the ${slotsText(s)} supporting it were all answered by one model, ${t.voices[0] ?? SUBSTITUTE_MODEL_FALLBACK}${disputes}`;
  return `recorded as ${RECORDED_STATUS_WORD[status]} of ${slotsText(s)}${disputes}; those slots were answered by ${m} independent models (${t.voices.join("; ")}) — a substitute model that answered several slots counts once`;
}

const SUBSTITUTE_MODEL_FALLBACK = "a substitute model";

/** The heading of a consensus / majority row whose supporting slots are not independent executing models. */
export type QualifiedStatusHeading =
  | `${"Consensus" | "Majority support"} (model independence unverified)`
  | `${"Consensus" | "Majority support"} (${number} independent models)`
  | `Not an independent ${"consensus" | "majority"}`;

/** The row heading ("Consensus" / "Majority support") of such a row, qualified. */
export function qualifiedStatusHeading(status: unknown, t: QualifiedIndependence): QualifiedStatusHeading | null {
  if (!isAgreementStatus(status)) return null;
  if (t.kind === "unverified") return `${STATUS_HEADING_WORD[status]} (model independence unverified)`;
  return t.voices.length < 2 ? `Not an independent ${NOT_INDEPENDENT_WORD[status]}` : `${STATUS_HEADING_WORD[status]} (${t.voices.length} independent models)`;
}

/** Who supports such a row: the executing models, each once ("DeepSeek (substituting ChatGPT, Claude); Grok"). */
export function qualifiedSupporters(t: QualifiedIndependence): string | null {
  return t.kind === "repeated_substitute" && t.voices.length > 0 ? t.voices.join("; ") : null;
}

/**
 * A stored agreement statement whose row cannot be joined (no rows held, or no unique row with that text) in a run whose
 * slots are not all independent executing models: the stored text, then what it counts.
 */
export function runScopeQualifier(run: QualifiedIndependence): string {
  return run.kind === "unverified"
    ? "counted by panel slot; model independence unverified — which models answered this run's slots is not recorded"
    : `counted by panel slot; in this run ${run.repeated.join("; ")} answered several slots, so this is not a count of independent models`;
}

/** A legacy "Where models agree" line (no stored status) when the rows are not held, in a run not all independent. */
export function legacyRunScopeQualifier(run: QualifiedIndependence): string {
  return run.kind === "unverified"
    ? "not confirmed as agreement between independent models: which models answered this run's slots is not recorded"
    : `not confirmed as agreement between independent models: in this run ${run.repeated.join("; ")} answered several slots`;
}

/** The note that follows a panel-level count ("Of 2 scored claims across 5 dispatched models: consensus on 2."). */
export function runIndependenceNote(run: QualifiedIndependence): string {
  return run.kind === "unverified"
    ? "These counts are of panel slots: which models answered this run's slots is not recorded (model independence unverified)."
    : `These counts are of panel slots: in this run ${run.repeated.join("; ")} answered several slots, so they are not counts of independent models.`;
}

/** Follows a legacy report's stored answer string, which names the slots that support each claim. */
export function answerIndependenceNote(run: QualifiedIndependence): string {
  return run.kind === "unverified"
    ? "The models named here are panel slots: which models answered them is not recorded (model independence unverified)."
    : `The models named here are panel slots: in this run ${run.repeated.join("; ")} answered several slots, so they are not all independent models.`;
}

/**
 * The panel as LinkedIn / X introduce it, in place of "a multi-model AI panel", for a run with fewer than two independent
 * executing models or with unrecorded execution identity; null otherwise (two or more independent models are a
 * multi-model panel — the post as before).
 */
export function sharePanelPhrase(run: QualifiedIndependence | null): string | null {
  if (!run) return null;
  if (run.kind === "unverified") return "an AI panel (model independence unverified: which models answered is not recorded)";
  return run.voices.length < 2 ? `an AI panel whose responding slots were all answered by one model, ${run.voices[0] ?? SUBSTITUTE_MODEL_FALLBACK}` : null;
}

/** sharePanelPhrase in X's length budget. */
export function shortSharePanelPhrase(run: QualifiedIndependence | null): string | null {
  if (!run) return null;
  if (run.kind === "unverified") return "an AI panel (model independence unverified)";
  return run.voices.length < 2 ? "an AI panel (one model answered every slot)" : null;
}

/** "Where models agree", when an entry under it is not an agreement between independent executing models. */
export const AGREE_HEADING_ONE_EXECUTING_MODEL = "Points repeated across panel slots (not agreement between independent models)";
export const AGREE_HEADING_REPEATED_SUBSTITUTE = "Where models agree (a substitute model that answered several slots is counted once)";
export const AGREE_HEADING_UNVERIFIED = "Where models agree (model independence unverified)";

/**
 * The qualified top heading (N1): with two or more independent executing models among the supporters the stored
 * consensus / majority is still stated, with the independent-model count; one executing model, or a run-scope judgement,
 * is never headed as a consensus.
 */
export function qualifiedTopHeading(t: QualifiedIndependence, status: unknown): string {
  if (t.kind === "repeated_substitute" && t.scope === "supporters" && t.voices.length >= 2 && isAgreementStatus(status)) {
    return `${status === "consensus" ? "Top consensus" : "Top majority-supported claim"} (${t.voices.length} independent models; a substitute model that answered several slots counted once)`;
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

/** A stored row whose claimText equals `claim` exactly, when exactly one row has that text and it is consensus / majority. */
function joinAgreementRow(rows: readonly unknown[] | null, claim: unknown): unknown | null {
  if (!rows || typeof claim !== "string") return null;
  const same = rows.filter((r) => !!r && typeof r === "object" && (r as { claimText?: unknown }).claimText === claim);
  return same.length === 1 && isAgreementStatus((same[0] as { status?: unknown }).status) ? same[0] : null;
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

type Statement = { row: unknown; t: QualifiedIndependence } | { row: null; t: QualifiedIndependence } | null;

/**
 * The independence-qualified view of an UNMARKED adaptive report (a marked report is qualified inside its position view,
 * positionPresentation.rowView). Returns the stored report itself — the same object — when nothing it states needs
 * qualifying or when the run's per-slot rows are not held; otherwise a copy whose agreement statements are re-worded
 * (never the stored object; nothing is recomputed: statuses, counts and claim text are read as stored).
 */
export function presentIndependenceQualifiedReport<R extends AdaptiveSynthesisReportLike | null | undefined>(
  report: R,
  input: { rows: readonly unknown[] | null | undefined; provenance?: readonly RunModelProvenanceFacts[] | null }
): R {
  if (!report || typeof report !== "object" || independenceQualification(report)) return report;
  const provenance = input.provenance;
  if (!Array.isArray(provenance)) return report;
  const rows = Array.isArray(input.rows) ? input.rows : null;
  const runT = adaptiveTopIndependence(null, provenance);
  const run = runT.kind === "independent" ? null : runT;
  const src = report as AdaptiveSynthesisReportLike;

  // One stored agreement statement (a claim's text): its joined row's qualification, else — when the run itself is not
  // independent — the run's (the row cannot prove its supporters independent). Null: shown as stored.
  const statementFor = (claim: unknown): Statement => {
    const row = joinAgreementRow(rows, claim);
    if (row) {
      const t = rowSupportIndependence(row, provenance);
      return t ? { row, t } : null;
    }
    return run ? { row: null, t: run } : null;
  };
  const qualifiedText = (stored: string, st: NonNullable<Statement>) => (st.row ? qualifiedRowResult(st.row, st.t) : `${stored} (${runScopeQualifier(st.t)})`);
  let anyAgreeQualified = false;
  let anyQualified = false;
  const qualifiedKinds: QualifiedIndependence[] = [];
  const mark = (st: NonNullable<Statement>) => {
    anyQualified = true;
    qualifiedKinds.push(st.t);
  };

  const p = src.presentation && typeof src.presentation === "object" ? src.presentation : null;
  let presentation = p;
  if (p) {
    const answer = p.answer && typeof p.answer === "object" && Array.isArray(p.answer.claims) ? p.answer : null;
    const isAgreementAnswer = src.gate !== "fail";
    const answerClaims = answer
      ? answer.claims.map((c: any) => {
          if (!isAgreementAnswer || !c || typeof c !== "object" || typeof c.result !== "string") return c;
          const st = statementFor(c.claim);
          if (!st) return c;
          mark(st);
          const supporters = st.row ? qualifiedSupporters(st.t) : null;
          return {
            ...c,
            result: qualifiedText(c.result, st),
            ...(typeof c.supporters === "string" ? { supporters: supporters ?? `${c.supporters} (panel slots)` } : supporters ? { supporters } : {}),
          };
        })
      : null;
    const agree = Array.isArray(p.agree)
      ? p.agree.map((c: any) => {
          if (!c || typeof c !== "object" || typeof c.result !== "string") return c;
          const st = statementFor(c.claim);
          if (!st) return c;
          mark(st);
          anyAgreeQualified = true;
          return { ...c, result: qualifiedText(c.result, st) };
        })
      : null;
    if (anyQualified) {
      presentation = {
        ...p,
        ...(answer ? { answer: { ...answer, claims: answerClaims } } : {}),
        ...(agree ? { agree } : {}),
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
      const t = row ? rowSupportIndependence(row, provenance) : rows ? null : run;
      if (!t) continue;
      legacyAgree.set(line, row ? qualifiedRowResult(row, t) : legacyRunScopeQualifier(t));
      qualifiedKinds.push(t);
      anyQualified = true;
      anyAgreeQualified = true;
    }
  }

  // The verdict card's top claim.
  const card = src.verdictCard && typeof src.verdictCard === "object" ? src.verdictCard : null;
  let verdictCard = card;
  let top: QualifiedIndependence | null = null;
  let topStatus: string | null = null;
  let topResultQualified = false;
  if (card && typeof card.topConsensus === "string" && card.topConsensus !== NO_CONSENSUS_IDENTIFIED) {
    const st = statementFor(card.topConsensus);
    if (st) {
      top = st.t;
      topStatus = st.row ? String((st.row as { status?: unknown }).status) : null;
      mark(st);
      if (typeof card.topConsensusAgreement === "string" && card.topConsensusAgreement) {
        verdictCard = { ...card, topConsensusAgreement: qualifiedText(card.topConsensusAgreement, st) };
        topResultQualified = true;
      }
    }
  }

  // Every statement stands (independent supporters) in a run that still holds a repeated substitute model or an
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
    ...(counted(src.certaintyAssessment) ? { certaintyAssessment: `${src.certaintyAssessment} ${note}` } : {}),
    ...(!p && typeof src.unifiedAnswer === "string" && src.unifiedAnswer ? { unifiedAnswer: `${src.unifiedAnswer} ${MODEL_INDEPENDENCE_QUALIFIER_LABEL}: ${answerIndependenceNote(noteT)}` } : {}),
  };
  const headingT = run ?? qualifiedKinds[0];
  const agreeHeading = !anyAgreeQualified
    ? null
    : headingT.kind === "unverified"
      ? AGREE_HEADING_UNVERIFIED
      : headingT.voices.length < 2
        ? AGREE_HEADING_ONE_EXECUTING_MODEL
        : AGREE_HEADING_REPEATED_SUBSTITUTE;
  const qualification: IndependenceQualification = Object.freeze({ run, top, topStatus, topResultQualified, agreeHeading, legacyAgree });
  Object.defineProperty(out, QUALIFICATION, { value: qualification, enumerable: false });
  return out as unknown as R;
}

/** The structural slice of a stored report this view reads (types.ts AdaptiveSynthesisReport; kept loose: data is untrusted). */
type AdaptiveSynthesisReportLike = {
  presentation?: any;
  verdictCard?: any;
  whereModelsAgree?: unknown;
  unifiedAnswer?: unknown;
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

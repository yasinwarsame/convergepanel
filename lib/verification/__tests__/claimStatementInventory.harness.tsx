/**
 * Shared harness of the closed-world claim sentence inventory (doc 14 PR-1 R4). Not a spec: the spec files
 * claimStatementInventory*.spec.tsx run it over the full space, split across files so Jest runs them in parallel.
 */
/**
 * Doc 14 PR-1, R4 (owner ruling 2026-11-18): EVERY customer-visible explanatory sentence on a claim surface needs the
 * identities behind it. A claim of agreement, alignment, corroboration or disagreement must rest on the actual DISTINCT
 * executed models it needs; one substitute that answered several slots is not several confirmations. Otherwise the
 * surface uses slot-response wording.
 *
 * CLOSED-WORLD SENTENCE INVENTORY (replaces R3's fixed banned-phrase list, which is why R3 missed the memo's
 * "largely supported" sentence). Every text unit each surface emits — banner, rendered result view, audit trail,
 * copied verdict, memo (the claim's exported explanatory content), Team list row — must match EXACTLY ONE template
 * below, or the test fails (new wording fails closed). Each template carries the semantic claim it makes; the claim is
 * checked against an INDEPENDENT expected outcome computed here from the raw mix (per-slot outcome + the provider each
 * slot recorded) with this file's own rules. No tally / provider-registry / identity helper is imported.
 *
 * Oracle rules:
 *   - a provider is RELIABLE when it is one of the six registered tokens (literal list below);
 *   - the shared gate, re-derived: verified iff every usable slot records a reliable provider; K = distinct keys
 *     (own slot → "slot:<id>", substituted slot → "substitute:<provider>"); independent iff verified and K ≥ 2;
 *   - MODELS IDENTIFIED: independent and the distinct reliable providers are exactly K;
 *   - ONE MODEL PER SLOT: models identified and providers = usable slots;
 *   - a MAJORITY of models for a verdict set: models identified, every identified provider answered all its slots with
 *     one verdict, ≥ 2 providers gave a verdict in the set, and they are more than half of the providers;
 *   - CROSS-MODEL DISAGREEMENT: a supporting and an inaccurate answer from two DIFFERENT reliable providers.
 *   - R4 owner rulings (this round) — PER-ROW IDENTITY: a row is named by its slot family only when it is not substituted
 *     and records the family's own provider (or records no provider at all: substitution was always flagged); a
 *     substituted row is "<Provider> (substituting <Family>)" ("Substitute model …" without a reliable provider); an own
 *     slot recording ANOTHER provider (no flag) is "<Family> slot (executing model not identified)" (MINOR-3);
 *   - PAIR MULTIPLICITY: under a between-models heading each unordered pair of distinct executing providers appears ONCE,
 *     named by the two executing models;
 *   - NUMERIC QUALIFIER: a presented consensus score / confidence / support ratio of an independent record carries the
 *     "computed over panel slot responses, not independent corroboration" qualifier EXACTLY when the answering slots are
 *     not one distinct identified model each (required where the surface shows the number; forbidden otherwise);
 *   - GOVERNANCE QUEUE ("gov", the real GET route → GovernanceDashboard expanded row) and PERSONAL HISTORY ("history",
 *     the real server row builder → the history suffix) are surfaces of this inventory with the same oracle.
 * Historical records: besides the verdict the write path computes, mixes of ≤ 4 slots are also stored with each other
 * verdict label (records written by older scoring) — the label is never re-scored, but every sentence must still be true.
 * Synthetic data only.
 */


import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ClaimVerificationResultView, {
  ClaimVerificationAuditTrailDetails,
  claimVerdictBanner,
  buildClaimVerdictClipboardText,
} from "@/components/verification/ClaimVerificationResultView";
export { claimVerdictBanner };
import * as ViewModule from "@/components/verification/ClaimVerificationResultView";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { computeClaimVerdict } from "@/lib/verification/claimVerdict";
import { buildClaimVerificationAuditBundle } from "@/lib/verification/auditBundle";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import { toTeamClaimVerificationSummary } from "@/lib/workspaces/teamClaimVerificationSummary";
import { TeamClaimListRow } from "@/components/workspace/claims/TeamClaimListRow";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import type { ModelVerdict } from "@/lib/verification/parseVerificationJson";
import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";
import { claimHistoryConsensusSuffix } from "@/lib/verification/claimConsensusPresentation";
import { storedVerificationConsensusIndependence } from "@/lib/panel/storedVerificationIndependence";
import { consensusScoreWithheldReason } from "@/lib/panel/independentVoices";

/**
 * The Personal history row's score fields exactly as the server builds them (app/api/user/panel-history/route.ts): the
 * shared builder when the module exports one (R4), else the route's inline wiring as of the R4 review head.
 */
function historyScoreFields(doc: Record<string, unknown>): Record<string, unknown> {
  let mod: { storedClaimHistoryScoreFields?: (d: Record<string, unknown>) => Record<string, unknown> } = {};
  try {
    mod = require("@/lib/verification/claimStatementBasisSources");
  } catch {
    mod = {};
  }
  if (mod.storedClaimHistoryScoreFields) return mod.storedClaimHistoryScoreFields(doc);
  const modelIndependence = storedVerificationConsensusIndependence(doc);
  const withheld = consensusScoreWithheldReason(modelIndependence);
  return { consensusScore: withheld ? null : typeof doc.consensusScore === "number" ? doc.consensusScore : 0, ...(withheld ? { consensusWithheld: withheld } : {}), modelIndependence };
}

// ─── The oracle's own rules (no production helper) ─────────────────────────────────────────────────────────────────
const RELIABLE = new Set(["openai", "anthropic", "xai", "perplexity", "google", "deepseek"]);
const SLOTS = ["chatgpt", "claude", "gemini", "grok", "perplexity"];
const DISPLAY: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", xai: "XAI", perplexity: "Perplexity", deepseek: "DeepSeek" };
const FAMILY: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", grok: "Grok", perplexity: "Perplexity" };
const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", gemini: "google", grok: "xai", perplexity: "perplexity" };
export type Outcome = "A" | "P" | "I" | "U" | "PE" | "F";
const OUTCOMES: Outcome[] = ["A", "P", "I", "U", "PE", "F"];
const USABLE: ReadonlySet<Outcome> = new Set(["A", "P", "I", "U"]);
const VERDICT: Record<string, ModelVerdict> = { A: "accurate", P: "partially_accurate", I: "inaccurate", U: "unverifiable" };
const AGG = ["confirmed", "disputed", "partially_true", "unverifiable"] as const;
type Agg = (typeof AGG)[number];
const AGG_LABEL: Record<Agg, string> = { confirmed: "Confirmed", disputed: "Disputed", partially_true: "Partially true", unverifiable: "Unverifiable" };
const MEMO_AGG_LABEL: Record<Agg, string> = { confirmed: "Confirmed", disputed: "Disputed", partially_true: "Partially True", unverifiable: "Unverifiable" };

type SlotRecord = { sub: boolean; provider?: string };
export type Mode = { name: string; slot: (i: number) => SlotRecord };
const own = (i: number): SlotRecord => ({ sub: false, provider: OWN[SLOTS[i]] });
const ds = (i: number): SlotRecord => ({ sub: true, provider: "deepseek" });
export const MODES: Mode[] = [
  { name: "own", slot: own },
  { name: "ds:1", slot: (i) => (i === 0 ? ds(i) : own(i)) },
  { name: "ds:1-2", slot: (i) => (i <= 1 ? ds(i) : own(i)) },
  { name: "ds:1-3", slot: (i) => (i <= 2 ? ds(i) : own(i)) },
  { name: "ds:1-4", slot: (i) => (i <= 3 ? ds(i) : own(i)) },
  { name: "ds:slots2+4", slot: (i) => (i === 1 || i === 3 ? ds(i) : own(i)) },
  { name: "two-substitute-providers", slot: (i) => (i === 0 ? ds(i) : i === 1 ? { sub: true, provider: "perplexity" } : own(i)) },
  { name: "substitute-without-provider", slot: (i) => (i === 0 ? { sub: true } : own(i)) },
  { name: "provider-unknown", slot: (i) => (i === 0 ? { sub: false, provider: "unknown" } : own(i)) },
  { name: "own-slot-records-other-provider", slot: (i) => (i === 0 ? { sub: false, provider: "anthropic" } : own(i)) },
  { name: "non-ds-substitute-matches-own", slot: (i) => (i === 0 ? { sub: true, provider: "xai" } : own(i)) },
  // R4 MINOR-3: an own slot recording a provider no other slot records, without the substituted flag.
  { name: "own-slot-records-unflagged-deepseek", slot: (i) => (i === 0 ? { sub: false, provider: "deepseek" } : own(i)) },
  { name: "all-substituted", slot: ds },
  { name: "historic", slot: () => ({ sub: false }) },
];

type Oracle = ReturnType<typeof oracle>;
function oracle(outs: Outcome[], mode: Mode, verdict: Agg) {
  const usable = outs.map((o, i) => ({ o, i, rec: mode.slot(i) })).filter((x) => USABLE.has(x.o));
  const rel = (r: SlotRecord) => (r.provider !== undefined && RELIABLE.has(r.provider) ? r.provider : null);
  const reliable = usable.length > 0 && usable.every((x) => rel(x.rec) !== null);
  const gateKeys = new Set(usable.map((x) => (x.rec.sub ? `substitute:${x.rec.provider}` : `slot:${SLOTS[x.i]}`)));
  const K = gateKeys.size;
  const independence: "independent" | "insufficient" | "unverified" = !reliable ? "unverified" : K >= 2 ? "independent" : "insufficient";
  const byProvider = new Map<string, Set<Outcome>>();
  for (const x of usable) {
    const p = rel(x.rec);
    if (p) byProvider.set(p, new Set([...(byProvider.get(p) ?? []), x.o]));
  }
  const providers = byProvider.size;
  const consistent = reliable && [...byProvider.values()].every((s) => s.size === 1);
  const provWith = (set: Outcome[]) => new Set(usable.filter((x) => set.includes(x.o) && rel(x.rec)).map((x) => rel(x.rec) as string));
  const pA = provWith(["A"]);
  const pS = provWith(["A", "P"]);
  const pI = provWith(["I"]);
  const pU = provWith(["U"]);
  const modelsIdentified = independence === "independent" && providers === K;
  const oneModelPerSlot = modelsIdentified && providers === usable.length;
  const majority = (n: number) => modelsIdentified && consistent && n >= 2 && 2 * n > providers;
  const count = (k: Outcome) => outs.filter((x) => x === k).length;
  const subUsable = usable.filter((x) => x.rec.sub).length;
  // Per-row identity (R4): the name each slot's row may carry.
  const rowLabel = (i: number): string => {
    const fam = FAMILY[SLOTS[i]];
    if (!USABLE.has(outs[i])) return fam;
    const rec = mode.slot(i);
    if (rec.sub) return `${rec.provider !== undefined && RELIABLE.has(rec.provider) ? DISPLAY[rec.provider] : "Substitute model"} (substituting ${fam})`;
    if (rec.provider === undefined || rec.provider === "unknown" || rec.provider === OWN[SLOTS[i]]) return fam;
    return `${fam} slot (executing model not identified)`;
  };
  const ownModel = (x: (typeof usable)[number]) => !x.rec.sub && x.rec.provider === OWN[SLOTS[x.i]];
  const providerLabel = (p: string): string => {
    const mine = usable.filter((x) => rel(x.rec) === p);
    const subs = mine.filter((x) => x.rec.sub).map((x) => FAMILY[SLOTS[x.i]]);
    const parts = [...mine.filter((x) => !x.rec.sub).map((x) => rowLabel(x.i)), ...(subs.length ? [`${DISPLAY[p]} (substituting ${subs.join(", ")})`] : [])];
    return parts.join(" / ");
  };
  return {
    outs,
    mode: mode.name,
    verdict,
    slots: outs.length,
    usable: usable.length,
    A: count("A"),
    P: count("P"),
    I: count("I"),
    U: count("U"),
    PE: count("PE"),
    F: count("F"),
    subUsable,
    reliable,
    K,
    independence,
    providers,
    providersKnown: usable.every((x) => rel(x.rec) !== null) ? providers : null,
    providersA: pA.size,
    modelsIdentified,
    oneModelPerSlot,
    /** One identified model per slot, each its OWN model (slot family names are then the executing models), every slot answered. */
    namedModels: oneModelPerSlot && subUsable === 0 && usable.length === outs.length && usable.every(ownModel),
    /** Every answering slot its own identified model (the governance queue keeps its slot-counted lines only then). */
    namedOwn: oneModelPerSlot && usable.every(ownModel),
    consistent,
    /** R4: a presented score / confidence / support ratio carries the slot-response qualifier. */
    scoreQualified: independence === "independent" && !oneModelPerSlot,
    rowLabel,
    providerLabel,
    /** Distinct identified providers with each verdict (consistent records). */
    providersWith: (k: Outcome) => [...byProvider].filter(([, set]) => set.has(k)).map(([p]) => p),
    providerOrder: [...byProvider.keys()],
    supportMajority: majority(pA.size),
    partialMajority: majority(pS.size),
    unverifiableMajority: majority(pU.size),
    cross: reliable && [...pS].some((s) => [...pI].some((i) => i !== s)),
    providerOfSlot: (id: string) => {
      const x = usable.find((u) => SLOTS[u.i] === id);
      return x ? rel(x.rec) : null;
    },
    usableSlotIds: usable.map((x) => SLOTS[x.i]),
  };
}

// ─── Records ───────────────────────────────────────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
const DISJOINT = ["Completion happened eighteen eighty-nine", "Gustave engineering bureau designed ironwork", "Visitors climbed staircases during exposition", "Radio antennas saved demolition plans", "Painters repaint every seven years"];
const SHARED_CORRECT = "The tower stands on the Champ de Mars in Paris";
function rowsFor(outs: Outcome[], mode: Mode): Row[] {
  return outs.map((o, i) => {
    const modelId = SLOTS[i];
    if (o === "F" || o === "PE") {
      const s = o === "F" ? "failed" : "parse_error";
      return { modelId, status: s, verdict: s, confidence: "low", summary: "x", correctParts: [], incorrectParts: [], unverifiableParts: [] };
    }
    const rec = mode.slot(i);
    return {
      modelId,
      status: "ok",
      verdict: VERDICT[o],
      confidence: "high",
      summary: `${modelId} ${o}`,
      correctParts: o === "A" || o === "P" ? [SHARED_CORRECT] : [],
      incorrectParts: o === "I" || o === "P" ? [DISJOINT[i]] : [],
      unverifiableParts: [],
      ...(rec.sub ? { substituted: true } : {}),
      ...(rec.provider !== undefined ? { provider: rec.provider } : {}),
    };
  });
}
function storedDoc(rows: Row[], verdict: Agg): ClaimVerificationFirestoreDoc {
  const stored = { verdict, consensusScore: 70, confidenceLabel: "High" as const, evidenceQuality: "mixed" as const };
  const auditBundle = buildClaimVerificationAuditBundle({ claimLength: 5, modelEvidence: rows as never, ...stored });
  return { userId: "u", claim: "Synthetic.", type: "claim_verification", ...stored, supportRatio: 0, modelResults: rows, auditBundle, selectedModels: rows.map((r) => r.modelId), timestamp: { seconds: 1, nanoseconds: 0 } } as unknown as ClaimVerificationFirestoreDoc;
}

export type Case = { o: Oracle; doc: ClaimVerificationFirestoreDoc; payload: ClaimVerificationClientPayload };
function* mixes(sizes: readonly number[]): Generator<{ outs: Outcome[]; mode: Mode }> {
  for (const n of sizes) {
    const total = OUTCOMES.length ** n;
    for (let k = 0; k < total; k++) {
      const outs: Outcome[] = [];
      let x = k;
      for (let j = 0; j < n; j++) {
        outs.push(OUTCOMES[x % OUTCOMES.length]);
        x = Math.floor(x / OUTCOMES.length);
      }
      const seen = new Set<string>();
      for (const mode of MODES) {
        const key = outs.map((o, i) => (USABLE.has(o) ? JSON.stringify(mode.slot(i)) : "-")).join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        yield { outs, mode };
      }
    }
  }
}
export function buildCase(outs: Outcome[], mode: Mode, verdict?: Agg): Case {
  const rows = rowsFor(outs, mode);
  const computed = computeClaimVerdict(rows.map((r) => ({ status: r.status as "ok", verdict: r.status === "ok" ? (r.verdict as ModelVerdict) : undefined })));
  const v = verdict ?? computed;
  const doc = storedDoc(rows, v);
  return { o: oracle(outs, mode, v), doc, payload: mapStoredVerificationToClientPayload(doc, "v") };
}

/**
 * The memo input exactly as the Personal wrapper builds it (components/ClaimVerificationResult.tsx handleExportMemo):
 * the production builder when the view module exports one, else the wrapper's inline wiring as of the R3 head.
 */
export function memoFor(payload: ClaimVerificationClientPayload): string {
  const builder = (ViewModule as unknown as { claimMemoInput?: (d: ClaimVerificationClientPayload) => Parameters<typeof generateVerificationMemo>[0] }).claimMemoInput;
  if (builder) return generateVerificationMemo(builder(payload));
  const view = ViewModule.claimViewIndependence(payload);
  const exec = view.independence === "independent" && view.identity.verified && view.identity.independentModels !== null ? { independentModels: view.identity.independentModels, answeredSlots: view.identity.answeredSlots } : undefined;
  return generateVerificationMemo({
    type: "claim",
    claim: payload.claim,
    verdict: payload.verdict,
    consensusScore: payload.consensusScore,
    confidenceLabel: payload.confidenceLabel,
    evidenceQuality: typeof payload.evidenceQuality === "string" ? payload.evidenceQuality : "mixed",
    modelEvidence: payload.modelEvidence.map((m) => ({ modelId: m.modelId, status: m.status, verdict: m.verdict, confidence: m.confidence, summary: m.summary, correctParts: m.correctParts, incorrectParts: m.incorrectParts, unverifiableParts: m.unverifiableParts })),
    agreementPoints: payload.whereModelsAgree,
    disagreementPoints: payload.whereModelsDisagree.map((d) => d.point),
    verificationId: payload.verificationId ?? "",
    claimModelIndependence: view.independence,
    ...(exec ? { claimExecution: exec } : {}),
    claimCrossModel: (ViewModule as unknown as { claimMemoCrossModel: (d: unknown) => never }).claimMemoCrossModel(payload),
  });
}

// ─── Inventory ─────────────────────────────────────────────────────────────────────────────────────────────────────
export type Surface = "banner" | "view" | "clip" | "memo" | "team" | "history" | "gov";
type Ctx = { section: string; rows: Record<string, number>; pairs: Set<string>; lastPair: [string, string] | null };
type Template = {
  id: string;
  surfaces: Surface[];
  re: RegExp;
  /** The semantic claim; returns a violation or null. */
  check?: (m: RegExpExecArray, o: Oracle, ctx: Ctx) => string | null;
  /** Applies only in this context (a label that is a heading's value). */
  when?: (ctx: Ctx) => boolean;
  /** Sets the section for the following units (headings). */
  section?: string;
  /** Not reachable from the write path's mixes (kept so the inventory is the complete list a surface can emit). */
  unreachable?: true;
  /** R4: the unit MUST appear on this surface for this case (a required disclosure, e.g. the score qualifier). */
  required?: (o: Oracle) => boolean;
};

const QUALIFIER = "computed over panel slot responses, not independent corroboration";
const LABEL_NAME = String.raw`(?:ChatGPT|Claude|Gemini|Grok|Perplexity)(?: slot \(executing model not identified\))?|(?:DeepSeek|OpenAI|Anthropic|Google|XAI|Perplexity|Substitute model) \(substituting (?:ChatGPT|Claude|Gemini|Grok|Perplexity)\)`;
/** The next row name in a per-row list (`key` counts the rows of that list, in slot order). */
const rowNameOk = (name: string, o: Oracle, ctx: Ctx, key: string, usableOnly = false) => {
  const i = ctx.rows[key] ?? 0;
  ctx.rows[key] = i + 1;
  const slot = usableOnly ? SLOTS.indexOf(o.usableSlotIds[i % Math.max(1, o.usableSlotIds.length)]) : i % o.slots;
  const want = o.rowLabel(slot);
  return need(name === want, `row ${slot} named '${name}', executing identity is '${want}'`);
};
/** A between-models conflict pair: two different identified providers, each pair of providers listed once. */
const modelsPairCheck = (a: string, b: string, o: Oracle, ctx: Ctx) => {
  const v = pairCheck(a, b, o);
  if (v) return v;
  const pa = o.providerOfSlot(a) as string;
  const pb = o.providerOfSlot(b) as string;
  const key = [pa, pb].sort().join("|");
  ctx.lastPair = [pa, pb];
  if (ctx.pairs.has(key)) return `pair ${a}/${b} repeats the executing-model pair ${key} (one model's observation multiplied)`;
  ctx.pairs.add(key);
  return null;
};
/** A pair listed as a difference between SLOT responses must not be a pair of two different identified models. */
const slotPairCheck = (a: string, b: string, o: Oracle) => {
  const pa = o.providerOfSlot(a);
  const pb = o.providerOfSlot(b);
  return need(!(o.reliable && pa && pb && pa !== pb), `pair ${a}/${b} of two identified models (${pa}/${pb}) filed as a slot difference`);
};
/**
 * R5 (MINOR-4): a between-models pair printed with its SLOT ids is truthful only when each slot id's family is the
 * executing model of that slot's provider (an own model answering only its own slot). Otherwise the ids name a model
 * that did not run, and the pair must be named by its executing models.
 */
const slotIdsTruthful = (a: string, b: string, o: Oracle) => {
  const pa = o.providerOfSlot(a);
  const pb = o.providerOfSlot(b);
  return need(!!pa && !!pb && o.providerLabel(pa) === FAMILY[a] && o.providerLabel(pb) === FAMILY[b], `pair (${a}) vs (${b}) named by slot ids, executing models '${pa ? o.providerLabel(pa) : "?"}' / '${pb ? o.providerLabel(pb) : "?"}'`);
};
/** R5 (MINOR-4): a between-models pair named by its executing models — two distinct providers, listed once. */
const namedPairCheck = (la: string, lb: string, o: Oracle, ctx: Ctx) => {
  const pa = o.providerOrder.find((p) => o.providerLabel(p) === la);
  const pb = o.providerOrder.find((p) => o.providerLabel(p) === lb);
  if (!pa || !pb || pa === pb) return `pair '${la}' vs '${lb}' is not two distinct executing models`;
  const families = new Set(Object.values(FAMILY));
  if (families.has(la) && families.has(lb)) return `pair '${la}' vs '${lb}' re-worded although the slot ids name the executing models`;
  const key = [pa, pb].sort().join("|");
  ctx.lastPair = [pa, pb];
  if (ctx.pairs.has(key)) return `pair '${la}' vs '${lb}' repeats the executing-model pair ${key}`;
  ctx.pairs.add(key);
  return null;
};
const NAMED_PAIR = String.raw`Conflicting assessments: ([A-Z].*?) vs ([A-Z].*)`;
const pairLabels = (o: Oracle, ctx: Ctx) => (ctx.lastPair ? ctx.lastPair.map((p) => o.providerLabel(p)).join(", ") : "<no pair>");

const fmtCounts = (o: Oracle) => (["A", "P", "I", "U"] as const).filter((k) => o[k] > 0).map((k) => `${o[k]} ${{ A: "accurate", P: "partially accurate", I: "inaccurate", U: "unverifiable" }[k]}`).join(", ");
const split = (o: Oracle) => o.A + o.P > 0 && o.I > 0;
const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function expectedSlotNote(o: Oracle): string | null {
  const parts: string[] = [];
  if (o.usable < o.slots) parts.push(`${o.usable} of ${pl(o.slots, "slot", "slots")} answered`);
  if (o.F > 0) parts.push(`${o.F} failed`);
  if (o.PE > 0) parts.push(`${o.PE} malformed (no recognized verdict)`);
  if (o.subUsable > 0) parts.push(`${o.subUsable} answered by a substitute model`);
  if (o.providersKnown !== null && o.providersKnown < o.usable) parts.push(pl(o.providersKnown, "distinct executing provider", "distinct executing providers"));
  return parts.length ? parts.join("; ") : null;
}
const noteOk = (got: string | undefined, o: Oracle) => ((got ?? null) === expectedSlotNote(o) ? null : `slot note '${got}' ≠ '${expectedSlotNote(o)}'`);
const need = (cond: boolean, what: string) => (cond ? null : what);
const all = (...xs: Array<string | null>) => xs.find((x) => x !== null) ?? null;
const NOTE = String.raw`These counts are of panel slot responses, not of agreeing models(?: \((.+)\))?\.`;
const LABEL_RE = "(Confirmed|Disputed|Partially true|Unverifiable)";
const verdictIs = (label: string, o: Oracle) => need(label === AGG_LABEL[o.verdict], `label ${label} ≠ stored ${o.verdict}`);
const independenceIs = (want: Oracle["independence"], o: Oracle) => need(o.independence === want, `requires independence ${want}, oracle ${o.independence}`);
const pairCheck = (a: string, b: string, o: Oracle) => {
  const pa = o.providerOfSlot(a);
  const pb = o.providerOfSlot(b);
  return need(!!pa && !!pb && pa !== pb, `pair ${a}/${b} presented as between models without two identified models`);
};
const namesOf = (ids: string[]) => {
  const n = ids.map((id) => FAMILY[id]);
  return n.length === 1 ? n[0] : n.length === 2 ? `${n[0]} and ${n[1]}` : `${n.slice(0, -1).join(", ")}, and ${n[n.length - 1]}`;
};


const WORD: Record<string, Outcome> = { accurate: "A", "partially accurate": "P", inaccurate: "I", unverifiable: "U" };
/** Governance lines about models need distinct identified models (own named slots, or identified + consistent). */
const govModelsBasis = (o: Oracle) => all(independenceIs("independent", o), need(o.namedOwn || (o.modelsIdentified && o.consistent), "a line about models without distinct identified executing models"));
const govModelsCount = (k: number, n: number, word: string, o: Oracle, min: number) =>
  govModelsBasis(o) ?? all(need(WORD[word] !== undefined && k === o.providersWith(WORD[word]).length && n === o.providers, `${k}/${n} ${word} vs ${WORD[word] ? o.providersWith(WORD[word]).length : "?"}/${o.providers} distinct models`), need(k >= min, `k ${k} < ${min}`));

const MEMO_SPLIT_RE = /(?<=\.)\s+(?=[A-Z0-9])/;

export const T: Template[] = [
  // ── Banner (also rendered in the view) ──
  { id: "banner.models-supported", surfaces: ["banner", "view"], re: /^This claim is supported by (\d+)\/(\d+) models$/, check: (m, o) => all(need(o.supportMajority, "needs a majority of ≥ 2 distinct identified accurate models"), need(+m[1] === o.providersA && +m[2] === o.providers, `${m[1]}/${m[2]} vs ${o.providersA}/${o.providers}`)) },
  { id: "banner.majority-accurate", surfaces: ["banner", "view"], re: /^Majority agreement: accurate$/, check: (_m, o) => need(o.supportMajority, "needs a majority of ≥ 2 distinct identified accurate models") },
  { id: "banner.supported-by-answers", surfaces: ["banner", "view"], re: /^This claim is supported by (\d+) of (\d+) answers$/, check: (m, o) => all(need(+m[1] === o.A && +m[2] === o.usable, "answer counts"), need(o.A >= 1, "no accurate answer")) },
  { id: "banner.recorded-verdict-slots", surfaces: ["banner", "view"], re: new RegExp(`^Recorded verdict: ${LABEL_RE}\\. ${NOTE}$`), check: (m, o) => all(verdictIs(m[1], o), noteOk(m[2], o)) },
  { id: "banner.no-support-title", surfaces: ["banner", "view"], re: /^(\d+) of (\d+) (models?|answers?) rated this claim inaccurate(?:; (\d+) could not verify it)?$/, check: (m, o) => all(need(o.A + o.P === 0 && o.I > 0, "a no-support statement over a supporting answer"), need(+m[1] === o.I && +m[2] === o.usable && +(m[4] ?? 0) === o.U, "no-support counts"), m[3].startsWith("model") ? need(o.oneModelPerSlot, "counts in 'models' without one identified model per slot") : null) },
  { id: "banner.no-support-subtitle", surfaces: ["banner", "view"], re: new RegExp(`^No model supported the claim\\. The recorded verdict is Disputed; it does not mean the models disagreed\\.(?: ${NOTE})?$`), check: (m, o) => all(need(o.A + o.P === 0, "a supporting answer exists"), m[0].includes("These counts") ? noteOk(m[1], o) : need(o.oneModelPerSlot, "no slot note without one model per slot")) },
  { id: "banner.models-disagree", surfaces: ["banner", "view"], re: /^Models disagree on this claim$/, check: (_m, o) => need(o.cross, "needs two distinct identified models on opposite sides") },
  { id: "banner.review-per-model", surfaces: ["banner", "view"], re: /^Review per-model evidence below$/, check: (_m, o) => need(o.cross, "paired with 'Models disagree'") },
  { id: "banner.slot-responses-differ", surfaces: ["banner", "view"], re: /^Panel slot responses differ on this claim$/, check: (_m, o) => all(need(split(o), "responses do not differ across sides"), need(!o.cross, "a cross-model disagreement exists")) },
  { id: "banner.slot-responses-differ-subtitle", surfaces: ["banner", "view"], re: new RegExp(`^Recorded verdict: Disputed\\. The opposing responses did not come from two reliably identified executing models, so this is not a disagreement between models\\. ${NOTE}$`), check: (m, o) => all(need(split(o) && !o.cross, "slot-differ basis"), noteOk(m[1], o)) },
  { id: "banner.partial-title", surfaces: ["banner", "view"], re: /^Core claim may hold — details need correction$/, check: (_m, o) => need(o.A + o.P >= 1, "no supporting answer") },
  { id: "banner.partial-agreement", surfaces: ["banner", "view"], re: /^Partial agreement across models$/, check: (_m, o) => need(o.partialMajority, "needs a majority of ≥ 2 distinct identified supporting models") },
  { id: "banner.partial-support-slots", surfaces: ["banner", "view"], re: new RegExp(`^Partial support in the panel slot responses\\. ${NOTE}$`), check: (m, o) => all(need(o.A + o.P >= 1, "no supporting answer"), noteOk(m[1], o)) },
  { id: "banner.models-cannot-verify", surfaces: ["banner", "view"], re: /^Models cannot verify this claim with sufficient confidence$/, check: (_m, o) => need(o.unverifiableMajority, "needs a majority of ≥ 2 distinct identified unverifiable models") },
  { id: "banner.majority-unverifiable", surfaces: ["banner", "view"], re: /^Majority of models: unverifiable$/, check: (_m, o) => need(o.unverifiableMajority, "needs a majority of ≥ 2 distinct identified unverifiable models") },
  { id: "banner.unverifiable-answers", surfaces: ["banner", "view"], re: /^(\d+) of (\d+) answers rated this claim unverifiable$/, check: (m, o) => all(need(+m[1] === o.U && +m[2] === o.usable, "counts"), need(o.U >= 1, "no unverifiable answer")) },
  { id: "banner.recorded-verdict-title", surfaces: ["banner", "view"], re: new RegExp(`^Recorded verdict: ${LABEL_RE}$`), check: (m, o) => verdictIs(m[1], o) },
  { id: "banner.slot-responses-counts", surfaces: ["banner", "view"], re: new RegExp(`^Panel slot responses: (.+)\\. ${NOTE}$`), check: (m, o) => all(need(m[1] === fmtCounts(o), `counts '${m[1]}' ≠ '${fmtCounts(o)}'`), noteOk(m[2], o)) },
  { id: "banner.single-model-title", surfaces: ["banner", "view"], re: new RegExp(`^${LABEL_RE} — One independent model's assessment — not agreement between models$`), check: (m, o) => all(verdictIs(m[1], o), independenceIs("insufficient", o)) },
  { id: "banner.unverified-title", surfaces: ["banner", "view"], re: new RegExp(`^${LABEL_RE} — Independent-model coverage unverified$`), check: (m, o) => all(verdictIs(m[1], o), need(o.independence !== "insufficient", "an insufficient record labelled unverified")) },
  { id: "banner.single-model-subtitle", surfaces: ["banner", "view"], re: /^Fewer than two independent models answered \(slots answered by the same substitute model count as one\), so this is not a consensus\.$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "banner.unverified-subtitle", surfaces: ["banner", "view"], re: /^Which models executed could not be established, so this verdict is not presented as agreement between models\.$/, check: (_m, o) => need(o.independence !== "insufficient", "insufficient record") },

  // ── Rendered view: header, consensus card, digest, evidence, disclaimer ──
  { id: "view.header-disclaimer", surfaces: ["view"], re: /^(ℹ️|ConvergePanel is an AI-assisted verification tool, not a forensic service\. Results inform judgment —\s+they don't replace it\.|Terms|Terms of Service|Disclaimer)$/ },
  { id: "view.static-labels", surfaces: ["view"], re: /^(Consensus|Consensus score|Evidence quality|Support ratio|Claim|Agreement & disagreement|Per-model evidence|▼|0%|mixed|High|Synthetic\.|70)$/ },
  { id: "view.score-basis", surfaces: ["view"], re: new RegExp(`^Score, confidence and support ratio are ${QUALIFIER}\\.$`), check: (_m, o) => need(o.scoreQualified, "qualifier on a score whose slots are each a distinct identified model"), required: (o) => o.scoreQualified },
  { id: "view.confidence", surfaces: ["view"], re: /^Confidence$/ },
  { id: "view.confidence-split", surfaces: ["view"], re: /^\(verdicts split: (.+)\)$/, check: (m, o) => all(need(split(o), "not split"), need(m[1] === fmtCounts(o), "split counts")) },
  { id: "view.verdict-counts", surfaces: ["view"], re: /^((?:\d+ (?:accurate|partially accurate|inaccurate|unverifiable)(?:, )?)+)$/, check: (m, o) => need(m[1] === fmtCounts(o), `counts '${m[1]}'`) },
  { id: "view.model-verdicts-label", surfaces: ["view"], re: /^Model verdicts$/, check: (_m, o) => need(o.oneModelPerSlot, "'Model verdicts' without one identified model per slot") },
  { id: "view.slot-verdicts-label", surfaces: ["view"], re: /^Panel slot verdicts$/ },
  { id: "view.slot-tally-note", surfaces: ["view"], re: /^((?:\d+ of \d+ slots? answered|\d+ failed|\d+ malformed \(no recognized verdict\)|\d+ answered by a substitute model|\d+ distinct executing providers?)(?:; )?)+$/, check: (m, o) => noteOk(m[0], o) },
  { id: "view.withheld-insufficient", surfaces: ["view", "team"], re: /^No consensus score \(fewer than two independent models\)$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "view.withheld-unverified", surfaces: ["view", "team"], re: /^Consensus score withheld \(model independence not recorded\)$/, check: (_m, o) => independenceIs("unverified", o) },
  { id: "view.qualifier-insufficient", surfaces: ["view"], re: /^One independent model's assessment — not agreement between models$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "view.qualifier-unverified", surfaces: ["view"], re: /^Independent-model coverage unverified$/, check: (_m, o) => independenceIs("unverified", o) },
  { id: "digest.where-models-agree", surfaces: ["view"], re: /^Where models agree$/, section: "agree", check: (_m, o) => need(o.oneModelPerSlot, "'Where models agree' without one identified model per slot") },
  { id: "digest.repeated-heading", surfaces: ["view"], re: /^Points repeated across responses \(not agreement between independent models\)$/, section: "repeated" },
  { id: "digest.where-models-disagree", surfaces: ["view"], re: /^Where models disagree$/, section: "disagree_models", check: (_m, o) => need(o.independence === "independent", "not independent") },
  { id: "digest.differ-heading", surfaces: ["view"], re: /^Points that differ across responses \(not a disagreement between independent models\)$/, section: "disagree_slots" },
  { id: "content.agreement-point", surfaces: ["view"], re: new RegExp(`^${SHARED_CORRECT}$`) },
  { id: "content.conflict-point", surfaces: ["view"], re: /^Conflicting assessments: \((\w+)\) vs \((\w+)\)$/, check: (m, o, ctx) => { ctx.lastPair = null; return ctx.section === "disagree_models" ? modelsPairCheck(m[1], m[2], o, ctx) ?? slotIdsTruthful(m[1], m[2], o) : ctx.section === "disagree_slots" ? slotPairCheck(m[1], m[2], o) : null; } },
  { id: "content.conflict-named", surfaces: ["view"], re: new RegExp(`^${NAMED_PAIR}$`), check: (m, o, ctx) => (ctx.section === "disagree_models" ? namedPairCheck(m[1], m[2], o, ctx) : `named pair outside the between-models list (${ctx.section})`) },
  // Between models the pair is named by its two EXECUTING models (R4); between slots by the two slot ids.
  { id: "content.conflict-models", surfaces: ["view"], re: /^— (.+)$/, check: (m, o, ctx) => (ctx.section === "disagree_models" ? need(m[1] === pairLabels(o, ctx), `pair named '${m[1]}', executing models '${pairLabels(o, ctx)}'`) : need(/^\w+, \w+$/.test(m[1]), "slot pair")) },
  // Shown only for a record with no rows, or rows that yield no sentence — not reachable from these mixes.
  { id: "view.no-agreement-phrases", surfaces: ["view"], re: /^No strong cross-model agreement phrases detected automatically\.$/, unreachable: true },
  { id: "fallback.could-not-verify", surfaces: ["view"], re: /^(\d+) of (\d+) (models?|panel slots?) could not verify this claim\.$/, check: (m, o) => all(need(+m[1] === o.U, `'could not verify' ${m[1]} ≠ ${o.U} unverifiable answers`), need(+m[2] === o.slots, "total"), m[3].startsWith("model") ? need(o.namedModels, "model units") : null) },
  { id: "fallback.no-usable-verdict", surfaces: ["view"], re: /^(\d+) of (\d+) (models?|panel slots?) returned no usable verdict\.$/, check: (m, o) => all(need(+m[1] === o.PE + o.F && +m[2] === o.slots, "counts"), m[3].startsWith("model") ? need(o.namedModels, "model units") : null) },
  {
    id: "fallback.rated-it",
    surfaces: ["view"],
    re: /^(\d+) (models?|panel slots?) \((.+)\) rated it as (accurate|partially accurate|inaccurate)\.$/,
    check: (m, o) => {
      const k: Outcome = m[4] === "accurate" ? "A" : m[4] === "inaccurate" ? "I" : "P";
      const ids = o.outs.map((x, i) => (x === k ? SLOTS[i] : null)).filter((x): x is string => x !== null);
      return all(need(+m[1] === ids.length && m[3] === namesOf(ids), "group"), m[2].startsWith("model") ? need(o.namedModels, `'${m[1]} model(s) (${m[3]})' without one identified own model per slot`) : null);
    },
  },
  {
    id: "fallback.slot-counts-note",
    surfaces: ["view"],
    re: /^These counts are of panel slots \((.+)\), not of agreeing models\.$/,
    check: (m, o) => {
      const s = m[1];
      if (s === "model independence unverified") return independenceIs("unverified", o);
      if (s === "fewer than two independent models answered") return need(o.independence !== "independent", "independent");
      if (s === "the recorded providers do not establish how many independent models answered") return null;
      const k = /^(\d+) independent executing models? answered (\d+) panel slots?$/.exec(s);
      if (!k) return `unknown statement '${s}'`;
      return need(o.reliable && +k[1] === o.K && +k[1] === o.providers && +k[2] === o.usable, `'${s}' vs K=${o.K} providers=${o.providers}`);
    },
  },
  { id: "content.row-name", surfaces: ["view"], re: new RegExp(`^(${LABEL_NAME})$`), check: (m, o, ctx) => rowNameOk(m[1], o, ctx, "view") },
  { id: "content.row-verdict", surfaces: ["view"], when: (ctx) => ctx.section !== "audit_verdict", re: /^(Accurate|Partially accurate|Inaccurate|Unverifiable|Parse error|Failed)$/ },
  { id: "content.row-status", surfaces: ["view"], re: /^\((parse_error|failed)\)$/ },
  { id: "view.disclaimer-body", surfaces: ["view"], re: /^Claim verification results are generated by AI language models and reflect their training data\s+and reasoning capabilities at the time of the query\. Results do not constitute fact-checking by human\s+experts, journalistic verification, or legal determination of truth\. AI models may hallucinate, reason\s+incorrectly, or lack access to current information\.$/ },
  { id: "view.disclaimer-use", surfaces: ["view"], re: /^Do not use these results as the sole basis for publishing claims, making business decisions, or taking\s+legal action\. Always verify important claims through authoritative primary sources\.$/ },
  // Audit trail
  { id: "audit.labels", surfaces: ["view"], re: /^(Audit trail|Run ID|v|Timestamp|Evidence|"Synthetic\."|70\/100|✓|✗|—)$/ },
  { id: "audit.verdict-heading", surfaces: ["view"], re: /^Verdict$/, section: "audit_verdict" },
  { id: "audit.verdict-label", surfaces: ["view"], re: new RegExp(`^${LABEL_RE}$`), when: (ctx) => ctx.section === "audit_verdict", section: "audit", check: (m, o) => verdictIs(m[1], o) },
  { id: "audit.timestamp", surfaces: ["view"], re: /^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}\s?(AM|PM)$/ },
  { id: "audit.models-count", surfaces: ["view"], re: /^Models \((\d+)\)$/, check: (m, o) => all(need(o.namedModels, "'Models (n)' over slots that are not each an identified own model"), need(+m[1] === o.slots, "n")) },
  { id: "audit.slots-count", surfaces: ["view"], re: /^Panel slots \((\d+)\)$/, check: (m, o) => need(+m[1] === o.slots, "n") },

  // ── Copied verdict ──
  { id: "clip.header", surfaces: ["clip"], re: /^(ConvergePanel — Claim result|Claim: Synthetic\.|Per model:|)$/ },
  { id: "clip.aggregate", surfaces: ["clip"], re: /^Aggregate verdict: (confirmed|disputed|partially_true|unverifiable)$/, check: (m, o) => need(m[1] === o.verdict, "verdict") },
  { id: "clip.aggregate-no-support", surfaces: ["clip"], re: /^Aggregate verdict: disputed \(No answer supported the claim: (\d+) of (\d+) rated it inaccurate(?: and (\d+) could not verify it)?\.\)$/, check: (m, o) => all(need(o.verdict === "disputed" && o.A + o.P === 0 && o.I > 0, "no-support basis"), need(+m[1] === o.I && +m[2] === o.usable && +(m[3] ?? 0) === o.U, "counts")) },
  { id: "clip.consensus", surfaces: ["clip"], re: new RegExp(`^Consensus score: 70 \\(High confidence(?:; verdicts split: ([^;]+))?(; ${QUALIFIER})?\\)$`), check: (m, o) => all(independenceIs("independent", o), m[1] !== undefined ? need(split(o) && m[1] === fmtCounts(o), "split") : need(!split(o), "split not shown"), need(!!m[2] === o.scoreQualified, `score qualifier ${!!m[2]} ≠ ${o.scoreQualified}`)) },
  { id: "clip.panel-slots", surfaces: ["clip"], re: /^Panel slots: (.+)$/, check: (m, o) => noteOk(m[1], o) },
  { id: "clip.basis-insufficient", surfaces: ["clip"], re: /^Verdict basis: One independent model's assessment — not agreement between models$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "clip.basis-unverified", surfaces: ["clip"], re: /^Verdict basis: Independent-model coverage unverified$/, check: (_m, o) => independenceIs("unverified", o) },
  { id: "clip.consensus-insufficient", surfaces: ["clip"], re: /^Consensus score: No consensus score \(fewer than two independent models\)$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "clip.consensus-unverified", surfaces: ["clip"], re: /^Consensus score: Consensus score withheld \(model independence not recorded\)$/, check: (_m, o) => independenceIs("unverified", o) },
  { id: "clip.per-model", surfaces: ["clip"], re: new RegExp(`^- (${LABEL_NAME}): (Accurate|Partially accurate|Inaccurate|Unverifiable|Parse error|Failed) — (\\w+ [APIU]|x)$`), check: (m, o, ctx) => rowNameOk(m[1], o, ctx, "clip") },
  { id: "clip.where-models-agree", surfaces: ["clip"], re: /^Where models agree:$/, section: "agree", check: (_m, o) => need(o.oneModelPerSlot, "'Where models agree' without one identified model per slot") },
  { id: "clip.repeated", surfaces: ["clip"], re: /^Points repeated across responses \(not agreement between independent models\):$/, section: "repeated" },
  { id: "clip.where-models-disagree", surfaces: ["clip"], re: /^Where models disagree:$/, section: "disagree_models", check: (_m, o) => independenceIs("independent", o) },
  { id: "clip.differ", surfaces: ["clip"], re: /^Points that differ across responses \(not a disagreement between independent models\):$/, section: "disagree_slots" },
  { id: "clip.agreement-point", surfaces: ["clip"], re: new RegExp(`^• ${SHARED_CORRECT}$`) },
  { id: "clip.conflict-named", surfaces: ["clip"], re: new RegExp(`^• ${NAMED_PAIR}$`), check: (m, o, ctx) => (ctx.section === "disagree_models" ? namedPairCheck(m[1], m[2], o, ctx) : `named pair outside the between-models list (${ctx.section})`) },
  { id: "clip.conflict-point", surfaces: ["clip"], re: /^• Conflicting assessments: \((\w+)\) vs \((\w+)\) \[(.+)\]$/, check: (m, o, ctx) => (ctx.section === "disagree_models" ? modelsPairCheck(m[1], m[2], o, ctx) ?? slotIdsTruthful(m[1], m[2], o) ?? need(m[3] === pairLabels(o, ctx), `pair named '${m[3]}', executing models '${pairLabels(o, ctx)}'`) : all(need(m[3] === `${m[1]}, ${m[2]}`, "slot pair"), ctx.section === "disagree_slots" ? slotPairCheck(m[1], m[2], o) : null)) },
  { id: "clip.disclaimer", surfaces: ["clip"], re: /^(⚠️ DISCLAIMER: This is an AI-assisted claim verification result, not expert fact-checking,|journalistic verification, or a legal determination of truth\. AI models may hallucinate or|reason incorrectly\. Do not use as legal evidence or the sole basis for consequential|decisions\. See convergepanel\.com\/terms for full terms\.)$/ },

  // ── Memo (the claim's exported explanatory content) ──
  { id: "memo.headers", surfaces: ["memo"], re: /^(VERIFICATION MEMO|ConvergePanel Multi-Model Claim Verification|CLAIM VERIFIED|"Synthetic\."|SUMMARY|MODEL VERDICTS|METHODOLOGY|DISCLAIMER|CORRECT PARTS|IMPRECISE OR INCORRECT PARTS|Report ID: v|Source: convergepanel\.com|)$/ },
  { id: "memo.generated", surfaces: ["memo"], re: /^Generated: .+$/ },
  { id: "memo.verdict", surfaces: ["memo"], re: /^VERDICT: (Confirmed|Disputed|Partially True|Unverifiable)$/, check: (m, o) => all(need(m[1] === MEMO_AGG_LABEL[o.verdict], "label"), independenceIs("independent", o)) },
  { id: "memo.verdict-insufficient", surfaces: ["memo"], re: /^VERDICT: (Confirmed|Disputed|Partially True|Unverifiable) \(one independent model's assessment; not agreement between models\)$/, check: (m, o) => all(need(m[1] === MEMO_AGG_LABEL[o.verdict], "label"), independenceIs("insufficient", o)) },
  { id: "memo.verdict-unverified", surfaces: ["memo"], re: /^VERDICT: (Confirmed|Disputed|Partially True|Unverifiable) \(independent-model coverage unverified\)$/, check: (m, o) => all(need(m[1] === MEMO_AGG_LABEL[o.verdict], "label"), independenceIs("unverified", o)) },
  { id: "memo.consensus", surfaces: ["memo"], re: new RegExp(`^CONSENSUS SCORE: 70/100 \\(High confidence(?:; verdicts split: ([^;]+))?(; ${QUALIFIER})?\\)$`), check: (m, o) => all(independenceIs("independent", o), m[1] !== undefined ? need(split(o) && m[1] === fmtCounts(o), "split") : need(!split(o), "split not shown"), need(!!m[2] === o.scoreQualified, `score qualifier ${!!m[2]} ≠ ${o.scoreQualified}`)) },
  { id: "memo.consensus-insufficient", surfaces: ["memo"], re: /^CONSENSUS SCORE: none \(fewer than two independent models answered; slots answered by the same substitute model count as one\)$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "memo.consensus-unverified", surfaces: ["memo"], re: /^CONSENSUS SCORE: withheld \(model independence not recorded\)$/, check: (_m, o) => independenceIs("unverified", o) },
  { id: "memo.evidence", surfaces: ["memo"], re: /^EVIDENCE QUALITY: mixed$/, check: (_m, o) => independenceIs("independent", o) },
  { id: "memo.evidence-insufficient", surfaces: ["memo"], re: /^EVIDENCE QUALITY: not assessed \(fewer than two independent models responded\)$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "memo.evidence-unverified", surfaces: ["memo"], re: /^EVIDENCE QUALITY: not assessed \(model independence not recorded\)$/, check: (_m, o) => independenceIs("unverified", o) },
  // Summary sentences
  { id: "memo.lead-models", surfaces: ["memo"], re: /^(\d+) AI models evaluated this claim independently\.$/, check: (m, o) => all(need(o.oneModelPerSlot, "'N AI models evaluated independently' without one identified model per slot"), need(+m[1] === o.providers, "N")) },
  { id: "memo.lead-slots-k", surfaces: ["memo"], re: /^(\d+) panel slots answered this claim; (\d+) independent executing models wrote those answers\.$/, check: (m, o) => all(need(o.modelsIdentified, "K stated without the identified providers being exactly K"), need(+m[1] === o.usable && +m[2] === o.providers, "counts")) },
  { id: "memo.lead-slots", surfaces: ["memo"], re: /^(\d+) panel slots? answered this claim; the recorded providers do not establish how many independent models wrote those answers\.$/, check: (m, o) => need(+m[1] === o.usable, "M") },
  // Without the wrapper's gate counts (a hand-built input; not reachable from the wrapper): no number of models.
  { id: "memo.lead-recorded-slots", surfaces: ["memo"], re: /^(\d+) panel slots? recorded for this claim; which models? executed (?:it|them) is not established\.$/, unreachable: true },
  { id: "memo.confirmed-models", surfaces: ["memo"], re: /^The models largely supported the claim, with meaningful alignment on the core statement\.$/, check: (_m, o) => need(o.supportMajority, "'largely supported … meaningful alignment' without a majority of ≥ 2 distinct identified accurate models") },
  { id: "memo.disputed-models", surfaces: ["memo"], re: /^Models diverged on important aspects of this claim; treat conclusions as contested\.$/, check: (_m, o) => need(o.cross, "'Models diverged' without two distinct identified models on opposite sides") },
  { id: "memo.partial-models", surfaces: ["memo"], re: /^A majority of the independent models supported the core statement at least in part; review the per-model verdicts for imprecise or debatable details\.$/, check: (_m, o) => need(o.partialMajority, "needs a majority of ≥ 2 distinct identified supporting models") },
  { id: "memo.unverifiable-models", surfaces: ["memo"], re: /^Most of the independent models could not verify the claim with sufficient evidence\.$/, check: (_m, o) => need(o.unverifiableMajority, "needs a majority of ≥ 2 distinct identified unverifiable models") },
  { id: "memo.default-models", surfaces: ["memo"], re: /^Models evaluated this claim independently; review per-model detail below\.$/, check: (_m, o) => need(o.oneModelPerSlot, "one model per slot"), unreachable: true },
  { id: "memo.no-support", surfaces: ["memo"], re: /^No answer supported the claim: (\d+) of (\d+) rated it inaccurate(?: and (\d+) could not verify it)?\.$/, check: (m, o) => all(need(o.A + o.P === 0 && o.I > 0, "basis"), need(+m[1] === o.I && +m[2] === o.usable && +(m[3] ?? 0) === o.U, "counts")) },
  { id: "memo.no-support-note", surfaces: ["memo"], re: /^The recorded verdict label is Disputed; it does not indicate a split between models\.$/, check: (_m, o) => need(o.verdict === "disputed", "label") },
  { id: "memo.slot-differ", surfaces: ["memo"], re: /^The panel slot responses differ, but the opposing responses did not come from two reliably identified executing models; this is not a disagreement between models\.$/, check: (_m, o) => need(split(o) && !o.cross, "slot-differ basis") },
  { id: "memo.slot-differ-label", surfaces: ["memo"], re: /^The recorded verdict label is Disputed\.$/, check: (_m, o) => need(o.verdict === "disputed", "label") },
  { id: "memo.recorded-verdict", surfaces: ["memo"], re: /^Recorded verdict: (Confirmed|Disputed|Partially True|Unverifiable)\.$/, check: (m, o) => need(m[1] === MEMO_AGG_LABEL[o.verdict], "label") },
  { id: "memo.slot-counts", surfaces: ["memo"], re: /^Panel slot responses: (.+); these are counts of slot responses, not of agreeing models\.$/, check: (m, o) => need(m[1] === fmtCounts(o), `counts '${m[1]}'`) },
  { id: "memo.single-model-summary", surfaces: ["memo"], re: /^(Fewer than two independent AI models answered this claim, so there is no cross-model agreement to report\.|Treat the verdict as a single model's assessment\.)$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "memo.unverified-summary", surfaces: ["memo"], re: /^Which models executed this verification could not be established, so the verdict is not presented as agreement between models\.$/, check: (_m, o) => independenceIs("unverified", o) },
  { id: "memo.model-verdict-line", surfaces: ["memo"], re: new RegExp(`^ {2}(${LABEL_NAME}): {4}(?:(Accurate|Partially accurate|Inaccurate|Unverifiable) \\(high confidence\\)|\\((Parse error|Failed)\\))$`), check: (m, o, ctx) => rowNameOk(m[1], o, ctx, "memo") },
  { id: "memo.where-models-agree", surfaces: ["memo"], re: /^WHERE MODELS AGREE$/, section: "agree", check: (_m, o) => need(o.oneModelPerSlot, "'WHERE MODELS AGREE' without one identified model per slot") },
  { id: "memo.repeated", surfaces: ["memo"], re: /^POINTS REPEATED ACROSS RESPONSES \(NOT AGREEMENT BETWEEN INDEPENDENT MODELS\)$/, section: "repeated" },
  { id: "memo.where-models-disagree", surfaces: ["memo"], re: /^WHERE MODELS DISAGREE$/, section: "disagree_models", check: (_m, o) => independenceIs("independent", o) },
  { id: "memo.differ", surfaces: ["memo"], re: /^POINTS THAT DIFFER ACROSS RESPONSES \(NOT A DISAGREEMENT BETWEEN INDEPENDENT MODELS\)$/, section: "disagree_slots" },
  { id: "memo.content-bullet", surfaces: ["memo"], re: new RegExp(`^- (${SHARED_CORRECT}|${DISJOINT.join("|")})$`) },
  { id: "memo.conflict-named", surfaces: ["memo"], re: new RegExp(`^- ${NAMED_PAIR}$`), check: (m, o, ctx) => (ctx.section === "disagree_models" ? namedPairCheck(m[1], m[2], o, ctx) : `named pair outside the between-models list (${ctx.section})`) },
  { id: "memo.conflict-bullet", surfaces: ["memo"], re: /^- Conflicting assessments: \((\w+)\) vs \((\w+)\)(?: \[(.+)\])?$/, check: (m, o, ctx) => (ctx.section === "disagree_models" ? modelsPairCheck(m[1], m[2], o, ctx) ?? slotIdsTruthful(m[1], m[2], o) ?? need(m[3] === pairLabels(o, ctx), `pair named '${m[3]}', executing models '${pairLabels(o, ctx)}'`) : all(need(m[3] === undefined, "slot pair named as models"), ctx.section === "disagree_slots" ? slotPairCheck(m[1], m[2], o) : null)) },
  // Methodology sentences
  {
    id: "memo.method-models",
    surfaces: ["memo"],
    re: /^This claim was independently evaluated by (\d+) large language models? \((.+)\) via ConvergePanel\.$/,
    check: (m, o) => all(need(o.namedOwn && o.subUsable === 0, "'independently evaluated by N LLMs (names)' without one identified own model per answering slot"), need(+m[1] === o.providers && m[2] === o.usableSlotIds.map((id) => FAMILY[id]).join(", "), "N / names")),
  },
  { id: "memo.method-models-each", surfaces: ["memo"], re: /^(Each model received the claim with identical instructions to evaluate accuracy, identify correct and incorrect parts, and provide evidence\.|Models were not shown each other's responses\.)$/, check: (_m, o) => need(o.namedOwn && o.subUsable === 0, "models-form methodology") },
  { id: "memo.method-models-score", surfaces: ["memo"], re: /^The consensus score reflects the degree of agreement across models weighted by evidence quality\.$/, check: (_m, o) => need(o.namedOwn && o.subUsable === 0, "'agreement across models' without one identified own model per answering slot") },
  { id: "memo.method-slots-k", surfaces: ["memo"], re: /^This claim was sent to (\d+) answering panel slots \((.+)\) via ConvergePanel, written by (\d+) independent executing models \(a model that answered several slots counts once\)\.$/, check: (m, o) => all(need(o.modelsIdentified, "K stated without the identified providers being exactly K"), need(+m[1] === o.usable && +m[3] === o.providers, "counts")) },
  { id: "memo.method-slots", surfaces: ["memo"], re: /^This claim was sent to (\d+) (?:answering )?panel slots? \((.+)\) via ConvergePanel; the recorded providers do not establish how many independent models wrote those answers\.$/, check: (m, o) => need(+m[1] === o.usable, "M") },
  { id: "memo.method-slots-each", surfaces: ["memo"], re: /^(Each slot received the claim with identical instructions to evaluate accuracy, identify correct and incorrect parts, and provide evidence\.|The consensus score was computed over answering slots, so it is not a count of independent models\.)$/ },
  { id: "memo.method-insufficient", surfaces: ["memo"], re: /^(This claim was sent to a panel of large language models via ConvergePanel with identical instructions, but fewer than two independent models answered \(slots answered by the same substitute model count as one\)\.|No cross-model comparison was possible: no consensus score is reported and nothing in this memo reflects agreement between models\.)$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "memo.method-unverified", surfaces: ["memo"], re: /^(This claim was sent to a panel of large language models via ConvergePanel with identical instructions\.|Which models actually executed could not be established from the stored record, so no consensus score is reported and nothing in this memo is presented as agreement between independent models\.)$/, check: (_m, o) => independenceIs("unverified", o) },
  { id: "memo.disclaimer", surfaces: ["memo"], re: /^(This is an AI-assisted verification, not a definitive fact-check\.|Results should inform editorial judgment, not replace it\.|AI models have known limitations including training data cutoffs, potential biases, and the possibility of confident but incorrect outputs\.)$/ },

  // ── Team list row ──
  { id: "team.verdict", surfaces: ["team"], re: new RegExp(`^${LABEL_RE}$`), check: (m, o) => verdictIs(m[1], o) },
  { id: "team.static", surfaces: ["team"], re: /^(Jan 1|Dec 31|Jan 1, 1970|Dec 31, 1969|Synthetic\.|·|Mixed evidence|Unfiled)$/ },
  { id: "team.consensus", surfaces: ["team"], re: /^70\/100 consensus$/, check: (_m, o) => independenceIs("independent", o) },
  { id: "team.confidence", surfaces: ["team"], re: /^High confidence( \(verdicts split\))?$/, check: (m, o) => all(independenceIs("independent", o), need(!!m[1] === split(o), "split flag")) },
  { id: "team.answers", surfaces: ["team"], re: /^Answers: (.+)$/, check: (m, o) => need(m[1] === fmtCounts(o), "counts") },
  { id: "team.score-basis", surfaces: ["team"], re: new RegExp(`^\\(${QUALIFIER}\\)$`), check: (_m, o) => need(o.scoreQualified, "qualifier without a slot-response basis"), required: (o) => o.scoreQualified },

  // ── Governance queue (real GET route → real dashboard expanded row) ──
  { id: "gov.static", surfaces: ["gov"], re: /^(Review|CLAIM|owner-a|User ID: owner-a|Run owner|Governance reasons|r1|Full text|Synthetic\.|Claim verdict:|Model|Verdict|Confidence|high confidence|—|✓|✗|↻|\d+s ago|just now|\d+m ago|What's correct|What's incorrect or imprecise|x|\w+ [APIU])$/ },
  { id: "gov.content-part", surfaces: ["gov"], re: new RegExp(`^(${SHARED_CORRECT}|${DISJOINT.join("|")})$`) },
  { id: "gov.claim-verdict", surfaces: ["gov"], re: /^(Confirmed|Disputed|Partially True|Unverifiable)$/, when: (ctx) => ctx.section !== "gov_table", check: (m, o) => need(m[1] === MEMO_AGG_LABEL[o.verdict], "label") },
  { id: "gov.score", surfaces: ["gov"], re: new RegExp(`^70(?: \\((${QUALIFIER})\\))?$`), check: (m, o) => all(independenceIs("independent", o), need(!!m[1] === o.scoreQualified, `score qualifier ${!!m[1]} ≠ ${o.scoreQualified}`)) },
  { id: "gov.withheld-insufficient", surfaces: ["gov"], re: /^No consensus score \(fewer than two independent models\)$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "gov.withheld-unverified", surfaces: ["gov"], re: /^Consensus score withheld \(model independence not recorded\)$/, check: (_m, o) => independenceIs("unverified", o) },
  { id: "gov.table-heading", surfaces: ["gov"], re: /^Model verdicts$/, section: "gov_table" },
  { id: "gov.row-name", surfaces: ["gov"], re: new RegExp(`^(${LABEL_NAME})$`), when: (ctx) => ctx.section === "gov_table", check: (m, o, ctx) => rowNameOk(m[1], o, ctx, "gov-table") },
  { id: "gov.row-verdict", surfaces: ["gov"], re: /^(Accurate|Partially accurate|Inaccurate|Unverifiable|Parse error|Failed)$/, when: (ctx) => ctx.section === "gov_table" },
  { id: "gov.row-summary-name", surfaces: ["gov"], re: new RegExp(`^(${LABEL_NAME}):$`), check: (m, o, ctx) => rowNameOk(m[1], o, ctx, "gov-summary", true) },
  { id: "gov.note-insufficient", surfaces: ["gov"], re: /^Fewer than two independent models answered \(slots answered by the same substitute model count as one\) — no agreement or disagreement between models\.$/, section: "gov_note", check: (_m, o) => independenceIs("insufficient", o) },
  { id: "gov.note-unverified", surfaces: ["gov"], re: /^Independent-model coverage unverified — nothing here is presented as agreement or disagreement between models\.$/, section: "gov_note", check: (_m, o) => independenceIs("unverified", o) },
  {
    id: "gov.single-model",
    surfaces: ["gov"],
    re: /^One independent model's assessment \((.+)\): (.+) — not agreement between models$/,
    check: (m, o) => all(independenceIs("insufficient", o), need(o.providerOrder.length === 1 && m[1] === o.providerLabel(o.providerOrder[0]), `single model named '${m[1]}', executing '${o.providerOrder.map((p) => o.providerLabel(p))}'`)),
  },
  { id: "gov.where-agree", surfaces: ["gov"], re: /^Where models agree$/, section: "gov_agree", check: (_m, o) => all(independenceIs("independent", o), need(o.namedOwn || (o.modelsIdentified && o.consistent), "agreement between models without distinct identified models")) },
  { id: "gov.where-disagree", surfaces: ["gov"], re: /^Where models disagree$/, section: "gov_disagree", check: (_m, o) => independenceIs("independent", o) },
  { id: "gov.agree-points", surfaces: ["gov"], re: /^(\d+)\/(\d+) models rate this as (.+)$/, check: (m, o) => govModelsCount(+m[1], +m[2], m[3], o, 3) },
  { id: "gov.agree-summary", surfaces: ["gov"], re: /^(\d+)\/(\d+) models say (.+)$/, check: (m, o) => all(govModelsCount(+m[1], +m[2], m[3], o, o.namedOwn ? 1 : 2), need(o.namedOwn || 2 * +m[1] > +m[2], "a 'k/n models say' without a majority of distinct models")) },
  {
    id: "gov.rated-others-disagree",
    surfaces: ["gov"],
    re: /^(.+) rated as (accurate|partially accurate|inaccurate|unverifiable) \(others disagree\)$/,
    check: (m, o) => {
      const base = govModelsBasis(o);
      if (base) return base;
      const ps = o.providersWith(WORD[m[2]]);
      return all(need(ps.length >= 1 && ps.length <= 2 && m[1] === ps.map((p) => o.providerLabel(p)).join(", "), `'${m[1]}' ≠ executing models ${ps.map((p) => o.providerLabel(p))}`), need(ps.length < o.providers, "'others disagree' with no other model answering differently"));
    },
  },
  // The dashboard shows `dissentSummary` only when no disagreement line is rendered — and the route emits one for every
  // dissenting group (1–2 models) — so it is not reachable from these mixes; its claim is still checked if it appears.
  {
    id: "gov.dissent",
    surfaces: ["gov"],
    unreachable: true,
    re: /^Dissent: (.+)$/,
    check: (m, o) => govModelsBasis(o) ?? need(m[1].split("; ").every((e) => o.providerOrder.some((p) => e.startsWith(`${o.providerLabel(p)}: `))), `dissent names '${m[1]}' not executing models`),
  },
  {
    id: "gov.conflict",
    surfaces: ["gov"],
    re: /^Conflicting assessments: \((\w+)\) vs \((\w+)\)(?: \[(.+)\])?$/,
    check: (m, o, ctx) =>
      ctx.section === "gov_disagree"
        ? modelsPairCheck(m[1], m[2], o, ctx) ?? (m[3] !== undefined ? slotIdsTruthful(m[1], m[2], o) ?? need(m[3] === pairLabels(o, ctx), `pair named '${m[3]}', executing models '${pairLabels(o, ctx)}'`) : need(o.namedOwn, "a between-models pair of substituted / unidentified slots named only by slot ids"))
        : need(m[3] === undefined, "a qualified point named as models"),
  },
  { id: "gov.conflict-named", surfaces: ["gov"], re: new RegExp(`^${NAMED_PAIR}$`), check: (m, o, ctx) => (ctx.section === "gov_disagree" ? namedPairCheck(m[1], m[2], o, ctx) : `named pair outside the between-models list (${ctx.section})`) },
  { id: "gov.qualified-heading", surfaces: ["gov"], re: /^Recorded differences not counted as model disagreements$/, section: "gov_qualified" },
  { id: "gov.qualified-basis", surfaces: ["gov"], re: /^\((Same executing model — not a disagreement between independent models|One independent model — not a disagreement between models|Model independence unverified — not confirmed as a disagreement between models)\)$/ },
  { id: "gov.slot-responses", surfaces: ["gov"], re: new RegExp(`^Panel slot responses: (.+)\\. ${NOTE}$`), check: (m, o) => all(need(m[1] === fmtCounts(o), `counts '${m[1]}'`), noteOk(m[2], o)) },
  { id: "gov.repeated-outputs", surfaces: ["gov"], re: /^(.+) rated as (.+) — repeated outputs from one executing model$/, check: (m, o) => need(o.providerOrder.some((p) => o.providerLabel(p) === m[1]), `repeated outputs named '${m[1]}', not an executing model`) },
  { id: "gov.unverified-tally", surfaces: ["gov"], re: /^(\d+)\/(\d+) responses say (.+) — model independence unverified, not confirmed as agreement between models$/, check: (m, o) => all(independenceIs("unverified", o), need(+m[2] === o.usable, "responses n")) },

  // ── Personal history row suffix (server row builder → claimHistoryConsensusSuffix) ──
  { id: "history.score", surfaces: ["history"], re: new RegExp(`^ · 70 consensus(?: \\((${QUALIFIER})\\))?$`), check: (m, o) => all(independenceIs("independent", o), need(!!m[1] === o.scoreQualified, `score qualifier ${!!m[1]} ≠ ${o.scoreQualified}`)) },
  { id: "history.withheld-insufficient", surfaces: ["history"], re: /^ · No consensus score \(fewer than two independent models\)$/, check: (_m, o) => independenceIs("insufficient", o) },
  { id: "history.withheld-unverified", surfaces: ["history"], re: /^ · Consensus score withheld \(model independence not recorded\)$/, check: (_m, o) => independenceIs("unverified", o) },
];

// ─── Surface producers ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The text nodes of server-rendered markup (React `renderToStaticMarkup` output), read by a single forward scan — no
 * regular-expression tag stripping and no chained entity replacement (the R4 CodeQL alerts js/double-escaping,
 * js/incomplete-multi-character-sanitization and js/bad-tag-filter on the previous helpers):
 *  - a comment runs from "<!--" to the first "-->" (React's text separators "<!-- -->"); a tag from "<" to the next ">"
 *    outside a quoted attribute value; everything else is text;
 *  - each text run is entity-decoded in ONE pass (each "&…;" reference is replaced once; a decoded "&" is never read
 *    again), then trimmed; empty runs are dropped.
 * Test-only: it reads markup our own components render, it sanitizes nothing.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
export function decodeEntitiesOnce(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : whole;
  });
}
export function textNodes(html: string): string[] {
  const out: string[] = [];
  let text = "";
  const flush = () => {
    const t = decodeEntitiesOnce(text).trim();
    if (t.length > 0) out.push(t);
    text = "";
  };
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      flush();
      const close = html.indexOf("-->", i + 4);
      i = close === -1 ? html.length : close + 3;
    } else if (html[i] === "<") {
      flush();
      let quote: string | null = null;
      let j = i + 1;
      for (; j < html.length; j++) {
        const ch = html[j];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
      }
      i = j + 1;
    } else {
      const next = html.indexOf("<", i);
      const stop = next === -1 ? html.length : next;
      text += html.slice(i, stop);
      i = stop;
    }
  }
  flush();
  return out;
}

function units(surface: Surface, c: Case): string[] {
  switch (surface) {
    case "banner": {
      const b = claimVerdictBanner(c.payload);
      return [b.title, b.subtitle];
    }
    case "view": {
      const html = renderToStaticMarkup(createElement(ClaimVerificationResultView, { data: c.payload })) + renderToStaticMarkup(createElement(ClaimVerificationAuditTrailDetails, { data: c.payload }));
      // The agreement fallback paragraph is several sentences in one node.
      return textNodes(html).flatMap((t) => (/could not verify this claim\.|rated it as|returned no usable verdict\.|These counts are of panel slots \(/.test(t) ? t.split(/(?<=\.)\s+(?=[A-Z0-9])/) : [t]));
    }
    case "clip":
      return buildClaimVerdictClipboardText(c.payload).split("\n");
    case "memo":
      return memoFor(c.payload)
        .split("\n")
        .flatMap((l) => (/^ {2}\S/.test(l) || l.startsWith("- ") ? [l] : l.split(MEMO_SPLIT_RE)));
    case "team": {
      const item = toTeamClaimVerificationSummary({ verificationId: "v", data: c.doc as unknown as Record<string, unknown>, workspaceId: "w", projectId: null, project: null });
      if (!item) return ["<team summary null>"];
      // Over the wire exactly as the Team list hook receives it (JSON) and parses it (R4: the hook keeps
      // `consensusBasis`); the spec running this surface mocks the hook module's client-only imports.
      const { parseTeamClaimListPageResponse } = require("@/hooks/useTeamClaimVerificationList");
      const parsed = parseTeamClaimListPageResponse({ ok: true, status: 200, body: JSON.parse(JSON.stringify({ ok: true, scope: "all", hasMore: false, items: [item] })), address: { kind: "workspace", workspaceId: "w", scope: "all" } });
      if (!parsed.ok) return [`<team list parse failed: ${parsed.errorCode}>`];
      return textNodes(renderToStaticMarkup(createElement(TeamClaimListRow, { workspaceId: "w", item: parsed.page.items[0], showProject: true })));
    }
    case "history":
      // The real server row builder (app/api/user/panel-history/route.ts) → the real suffix (app/page.tsx).
      return [claimHistoryConsensusSuffix(historyScoreFields(c.doc as unknown as Record<string, unknown>))];
    case "gov": {
      const producer = PRODUCERS[surface];
      if (!producer) throw new Error(`no producer registered for surface ${surface}`);
      return producer(c);
    }
  }
}

/** Surfaces whose producer needs module mocks (the governance route + dashboard) register it from their own spec file. */
export const PRODUCERS: Partial<Record<Surface, (c: Case) => string[]>> = {};

export const HITS = new Map<string, number>();
export function runSurface(surface: Surface, CASES: readonly Case[]): { total: number; failing: number; sample: string[]; unmatched: Map<string, number> } {
  const templates = T.filter((t) => t.surfaces.includes(surface));
  let failing = 0;
  const sample: string[] = [];
  const unmatched = new Map<string, number>();
  for (const c of CASES) {
    const errs: string[] = [];
    const ctx: Ctx = { section: "", rows: {}, pairs: new Set(), lastPair: null };
    const hit = new Set<string>();
    for (const u of units(surface, c)) {
      const matches = templates.filter((t) => !t.when || t.when(ctx)).map((t) => ({ t, m: t.re.exec(u) })).filter((x) => x.m !== null);
      if (matches.length !== 1) {
        const key = matches.length === 0 ? `UNINVENTORIED: ${u}` : `AMBIGUOUS (${matches.map((x) => x.t.id).join(",")}): ${u}`;
        unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
        errs.push(key);
        continue;
      }
      const { t, m } = matches[0];
      HITS.set(t.id, (HITS.get(t.id) ?? 0) + 1);
      hit.add(t.id);
      if (t.section) ctx.section = t.section;
      const v = t.check?.(m as RegExpExecArray, c.o, ctx) ?? null;
      if (v) errs.push(`${t.id}: ${v} [${u}]`);
    }
    for (const t of templates) if (t.required?.(c.o) && !hit.has(t.id)) errs.push(`MISSING required ${t.id}`);
    if (errs.length) {
      failing += 1;
      if (sample.length < 12) sample.push(`${c.o.outs.join(",")} [${c.o.mode}] ${c.o.verdict}: ${errs.slice(0, 3).join(" | ")}`);
    }
  }
  return { total: CASES.length, failing, sample, unmatched };
}


/** Development knob only (the committed run is the full space): INVENTORY_MAX_SLOTS=3 for a quick local iteration. */
export const MAX_SLOTS = Number(process.env.INVENTORY_MAX_SLOTS ?? 5);

/**
 * The cases: every mix of the given slot counts under every provider mode (deduplicated), stored with the verdict the
 * write path computes; mixes of ≤ 4 slots are also stored with each other verdict label (historical records scored by
 * older rules). `shard` = [k, of] keeps the mixes whose enumeration index ≡ k (mod of) — a file split only.
 */
export function inventoryCases(sizes: readonly number[], shard: [number, number] = [0, 1]): Case[] {
  const out: Case[] = [];
  let idx = 0;
  for (const { outs, mode } of mixes(sizes.filter((n) => n <= MAX_SLOTS))) {
    if (idx++ % shard[1] !== shard[0]) continue;
    const base = buildCase(outs, mode);
    out.push(base);
    if (outs.length <= 4) for (const v of AGG) if (v !== base.o.verdict) out.push(buildCase(outs, mode, v));
  }
  return out;
}

/** Reachable templates of a surface that the run never emitted (non-vacuity). */
export function unhitTemplates(surface: Surface): string[] {
  return T.filter((t) => t.surfaces.includes(surface) && !t.unreachable && !HITS.has(t.id)).map((t) => t.id);
}

/** One `it` per surface: every unit inventoried, every semantic claim true for the oracle. */
export function expectSurfaceClean(surface: Surface, cases: readonly Case[]): void {
  const r = runSurface(surface, cases);
  const unmatched = [...r.unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  expect({ failing: r.failing, unmatched, sample: r.sample }).toEqual({ failing: 0, unmatched: [], sample: [] });
}

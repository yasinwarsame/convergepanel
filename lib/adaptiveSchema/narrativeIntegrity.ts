/**
 * Narrative integrity (D9; R1 N3, R2-1)
 *
 * The synthesis narrative is model-written. Its prompt forbids describing a
 * claim more strongly than its structured result allows, but a prompt rule is
 * advisory; this module is the deterministic backstop.
 *
 * Each sentence is read into zero or more ASSERTIONS — an agreement or
 * settledness predicate together with the scope its subject gives it — and
 * each assertion is checked against the structured row the sentence is about:
 *
 *   predicate   agreement ("agree", "converge", "consensus", "in agreement",
 *               "one voice", "prevailing view", "no disagreement", …) or
 *               settledness ("settled", "resolved", "uncontested",
 *               "undisputed", "beyond dispute", "well established", …)
 *   scope       panel (the models / the panel / an impersonal "it is …"),
 *               unanimous (all / every / each / the whole panel),
 *               majority (most / a majority), counted (N, N of M, all N),
 *               or subgroup (some / several / a few / a minority / only)
 *   negation    only a negator that directly governs the predicate counts
 *               ("do not agree", "no consensus", "lack of agreement", "failed
 *               to reach consensus"); a negator elsewhere in the sentence
 *               ("Not surprisingly, …", "Without exception …") does not
 *
 * Rules, against the row's structured status and counts (agreeing =
 * agrees|partial cells; D = dispatched panel; P = assessable positions):
 *   counted N [of M]   N ≤ agreeing, and M (if given) is D or P — the count
 *                      itself is checked, never a free pass
 *   unanimous          consensus status and agreeing = D
 *   panel              consensus status
 *   majority           consensus or majority status
 *   subgroup           always allowed (it claims no panel position)
 *   settled            not for a row that is split, ineligible, or contested
 *                      (contested.marked or contested.assessed)
 * A sentence that matches no row by content is held to the run: with no
 * consensus/majority row at all, no panel/unanimous/majority/settled
 * assertion passes; otherwise it cannot be tied to a row and passes.
 *
 * Callers fall back to deterministic text on any violation; no model is
 * re-called. Detection of the predicate itself is lexical (English, the
 * prompt's language) over a closed set of predicate classes; the acceptance
 * decision is structural. Pure and client-safe.
 */

import { AlignedClaim } from "./types";
import { isTopConsensusEligible } from "./consensusIntegrity";

export type AssertionScope =
  | { kind: "panel" }
  | { kind: "unanimous" }
  | { kind: "majority" }
  | { kind: "subgroup" }
  | { kind: "counted"; n: number; of: number | null };

export interface NarrativeAssertion {
  predicate: "agreement" | "settled";
  scope: AssertionScope;
}

// ─── Tokenisation ────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/n['’]t\b/g, " not")
    .replace(/[^a-z0-9%/-]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  both: 2, single: 1,
};

function toNumber(token: string | undefined): number | null {
  if (!token) return null;
  if (/^\d+$/.test(token)) return Number(token);
  return token in NUMBER_WORDS ? NUMBER_WORDS[token] : null;
}

// ─── Predicates (closed classes; matched on token sequences) ────────────

/** Agreement predicates (token sequences). Negative-form claims ("no disagreement") are agreement claims in their own right. */
const AGREEMENT_PREDICATES: string[][] = [
  ["agree"], ["agrees"], ["agreed"], ["agreeing"],
  ["concur"], ["concurs"], ["concurred"],
  ["converge"], ["converges"], ["converged"], ["converging"],
  ["align"], ["aligns"], ["aligned"],
  ["endorse"], ["endorses"], ["endorsed"],
  ["hold"], ["holds"], ["held"],
  ["united"], ["unite"], ["unites"],
  ["share", "the", "same", "view"], ["share", "the", "view"], ["share", "a", "view"], ["shared", "view"], ["share", "the", "same", "position"],
  ["agreement"], ["consensus"], ["accord"], ["unanimity"], ["unanimous"], ["unanimously"],
  ["one", "voice"], ["of", "one", "mind"], ["same", "conclusion"],
  ["common", "view"], ["prevailing", "view"], ["dominant", "view"], ["majority", "view"], ["shared", "position"], ["common", "position"],
  ["no", "disagreement"], ["no", "dissent"], ["without", "dissent"], ["without", "disagreement"],
];

/** Settledness predicates: the question is presented as no longer open. */
const SETTLED_PREDICATES: string[][] = [
  ["settled"], ["resolved"], ["uncontested"], ["undisputed"], ["indisputable"], ["incontrovertible"],
  ["beyond", "dispute"], ["beyond", "doubt"], ["not", "in", "dispute"], ["no", "longer", "debated"],
  ["well", "established"], ["well-established"], ["firmly", "established"], ["established", "fact"], ["conclusively"],
];

/** Longer sequences first, so "no disagreement" wins over a bare "no". */
const PREDICATES: Array<[string[], NarrativeAssertion["predicate"]]> = [
  ...AGREEMENT_PREDICATES.map((seq): [string[], NarrativeAssertion["predicate"]] => [seq, "agreement"]),
  ...SETTLED_PREDICATES.map((seq): [string[], NarrativeAssertion["predicate"]] => [seq, "settled"]),
].sort((a, b) => b[0].length - a[0].length);

function matchPredicateAt(tokens: string[], i: number): { length: number; predicate: NarrativeAssertion["predicate"] } | null {
  for (const [seq, predicate] of PREDICATES) {
    if (i + seq.length > tokens.length) continue;
    if (seq.every((t, k) => tokens[i + k] === t)) return { length: seq.length, predicate };
  }
  return null;
}

// ─── Negation scoped to the predicate ───────────────────────────────────

const NEGATORS = new Set(["not", "never", "no", "without", "lack", "lacks", "lacked", "lacking", "fail", "fails", "failed", "failing", "cannot", "neither", "nor", "little", "absence"]);
/** Tokens that may sit between a negator and the predicate it governs ("did not fully agree", "failed to reach a consensus", "lack of agreement"). */
const NEGATION_BRIDGE = new Set([
  "do", "does", "did", "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "will", "would", "could", "can", "should", "yet",
  "a", "an", "the", "any", "to", "of", "reach", "reached", "reaching", "achieve", "achieved", "find", "found", "come", "came", "arrive", "arrived", "at",
  "fully", "broadly", "clearly", "really", "quite", "entirely", "completely", "in", "full", "real", "genuine", "clear", "broad",
]);

function negated(tokens: string[], i: number): boolean {
  for (let k = i - 1, steps = 0; k >= 0 && steps < 5; k--, steps++) {
    if (NEGATORS.has(tokens[k])) return true;
    if (!NEGATION_BRIDGE.has(tokens[k])) return false;
  }
  return false;
}

// ─── Subject scope ───────────────────────────────────────────────────────

const UNANIMOUS_WORDS = new Set(["all", "every", "each", "whole", "entire", "unanimous", "unanimously", "unanimity"]);
const MAJORITY_WORDS = new Set(["most", "majority"]);
const SUBGROUP_WORDS = new Set(["some", "several", "few", "minority", "only", "certain", "individual", "other", "remaining", "either"]);
const CLAUSE_BREAK = /[,;:]|\b(?:but|while|whereas|although|though|however)\b/;

/** The scope of the subject that governs the predicate at token `i`, read from the same clause only. */
function scopeBefore(clauseTokens: string[], predicate: string[]): AssertionScope {
  const all = [...clauseTokens, ...predicate];
  // "N/M"
  for (const t of clauseTokens) {
    const slash = /^(\d+)\/(\d+)$/.exec(t);
    if (slash) return { kind: "counted", n: Number(slash[1]), of: Number(slash[2]) };
  }
  // "N of M" / "N out of M" / "all N" / "N models"
  for (let k = 0; k < clauseTokens.length; k++) {
    const n = toNumber(clauseTokens[k]);
    if (n === null) continue;
    const of = clauseTokens[k + 1] === "of" ? toNumber(clauseTokens[k + 2] === "the" ? clauseTokens[k + 3] : clauseTokens[k + 2])
      : clauseTokens[k + 1] === "out" && clauseTokens[k + 2] === "of" ? toNumber(clauseTokens[k + 3]) : null;
    if (clauseTokens[k - 1] === "all") return { kind: "counted", n, of: n }; // "all five models"
    return { kind: "counted", n, of };
  }
  if (all.some((t) => UNANIMOUS_WORDS.has(t))) return { kind: "unanimous" };
  if (clauseTokens.some((t) => MAJORITY_WORDS.has(t)) || predicate.includes("majority")) return { kind: "majority" };
  if (clauseTokens.some((t) => SUBGROUP_WORDS.has(t))) return { kind: "subgroup" };
  return { kind: "panel" };
}

/** Every non-negated agreement/settledness assertion the sentence makes. */
export function analyzeSentence(sentence: string): NarrativeAssertion[] {
  const out: NarrativeAssertion[] = [];
  for (const clause of sentence.split(CLAUSE_BREAK)) {
    const tokens = tokenize(clause ?? "");
    for (let i = 0; i < tokens.length; i++) {
      const m = matchPredicateAt(tokens, i);
      if (!m) continue;
      const seq = tokens.slice(i, i + m.length);
      // "no disagreement" / "without dissent" are agreement claims in negative form; only a negator BEFORE them negates them.
      if (!negated(tokens, i)) out.push({ predicate: m.predicate, scope: scopeBefore(tokens.slice(0, i), seq) });
      i += m.length - 1;
    }
  }
  return out;
}

// ─── Attribution ─────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "in", "on", "to", "is", "are", "was", "were", "be", "been", "for", "with", "by", "vs",
  "that", "this", "it", "its", "as", "at", "from", "than", "more", "less", "models", "model", "panel", "agree", "agrees",
  "agreed", "consensus", "majority", "most", "all", "every", "each", "claim", "claims", "about", "whether", "which",
]);

function contentTokens(text: string): Set<string> {
  return new Set(tokenize(text).filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

/** The row a sentence is about: the row whose claim's content tokens it covers best (≥ half, and ≥ 2 tokens), or null. */
export function attributeSentence(sentence: string, rows: AlignedClaim[]): AlignedClaim | null {
  const sentenceTokens = contentTokens(sentence);
  let best: AlignedClaim | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const rowTokens = contentTokens(row.claimText);
    if (rowTokens.size === 0) continue;
    let hits = 0;
    for (const t of rowTokens) if (sentenceTokens.has(t)) hits += 1;
    const score = hits / rowTokens.size;
    if (hits >= Math.min(2, rowTokens.size) && score >= 0.5 && score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

// ─── The rules ───────────────────────────────────────────────────────────

function agreeingCount(row: AlignedClaim): number {
  return row.cells.filter((c) => !!c && (c.stance === "agrees" || c.stance === "partial")).length;
}

function assessablePositions(row: AlignedClaim): number {
  return row.cells.filter((c) => !!c && c.stance !== "unclear").length;
}

function isContested(row: AlignedClaim): boolean {
  return row.status === "split" || !!row.contested?.marked || !!row.contested?.assessed;
}

/** Whether `assertion` about `row` states more than the row's structured result supports. */
export function assertionOverstates(assertion: NarrativeAssertion, row: AlignedClaim, dispatchedPanelSize: number): boolean {
  const { scope } = assertion;
  if (assertion.predicate === "settled") {
    if (!isTopConsensusEligible(row.status) || isContested(row)) return true;
    // A settledness claim is also a panel-level claim.
  }
  switch (scope.kind) {
    case "subgroup":
      return false;
    case "counted": {
      if (scope.n > agreeingCount(row)) return true;
      if (scope.of !== null && scope.of !== dispatchedPanelSize && scope.of !== assessablePositions(row)) return true;
      if (scope.of !== null && scope.n > scope.of) return true;
      return false;
    }
    case "unanimous":
      return row.status !== "consensus" || agreeingCount(row) < dispatchedPanelSize;
    case "panel":
      return row.status !== "consensus";
    case "majority":
      return !isTopConsensusEligible(row.status);
  }
}

/**
 * Held to the run when no row matches. With a consensus/majority row present the sentence cannot be tied to a
 * row and passes. With none: only subgroup assertions, and counts of at most half the dispatched panel, pass —
 * no row of such a run has more than half the panel agreeing (any such row is a majority).
 */
function unattributedOverstates(assertion: NarrativeAssertion, rows: AlignedClaim[], dispatchedPanelSize: number): boolean {
  if (rows.some((r) => isTopConsensusEligible(r.status))) return false;
  const { scope } = assertion;
  if (scope.kind === "subgroup") return false;
  if (scope.kind === "counted") return scope.n * 2 > dispatchedPanelSize || (scope.of !== null && scope.n === scope.of);
  return true;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The sentences of `text` that state more than the structured result allows.
 * `subjectRow`, when given, is the row the whole text is about (e.g. the split
 * topic a "why models disagree" sentence explains) and is used for sentences
 * that match no row by content.
 */
export function overstatingSentences(
  text: string,
  rows: AlignedClaim[],
  dispatchedPanelSize: number,
  subjectRow?: AlignedClaim
): string[] {
  const out: string[] = [];
  for (const sentence of splitSentences(text)) {
    const assertions = analyzeSentence(sentence);
    if (assertions.length === 0) continue;
    const row = attributeSentence(sentence, rows) ?? subjectRow ?? null;
    const bad = assertions.some((a) =>
      row ? assertionOverstates(a, row, dispatchedPanelSize) : unattributedOverstates(a, rows, dispatchedPanelSize)
    );
    if (bad) out.push(sentence);
  }
  return out;
}

/**
 * Whether model-written "Where models agree" sentences may be shown: every
 * sentence must be about a consensus/majority row (by content) and none of
 * its assertions may overstate that row.
 */
export function agreeLinesHonest(lines: string[], rows: AlignedClaim[], dispatchedPanelSize: number): boolean {
  return lines.every((line) => {
    const row = attributeSentence(line, rows);
    if (!row || !isTopConsensusEligible(row.status)) return false;
    return splitSentences(line).every((s) => analyzeSentence(s).every((a) => !assertionOverstates(a, row, dispatchedPanelSize)));
  });
}

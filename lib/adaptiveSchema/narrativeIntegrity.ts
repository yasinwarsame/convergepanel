/**
 * Narrative integrity (D9; R1 N3, R2-1, R3-1 — Option B)
 *
 * The panel's agreement is stated only by deterministic text rendered from
 * the structured rows (agreementNarrative.ts, verdict.ts). The synthesis
 * model's narrative is explanation around that text, so a model sentence
 * that itself characterises the panel's agreement has no place in it and is
 * removed — whatever it says, whether or not it happens to be accurate:
 *
 *   - any agreement predicate ("agree", "converge", "consensus", "one voice",
 *     "prevailing view", "no disagreement", "eye to eye", …), negated or not;
 *   - any settledness predicate ("settled", "uncontested", "well
 *     established", "beyond question", "widely accepted", …);
 *   - any unanimity or majority-view wording ("unanimous", "majority view",
 *     …);
 *   - any quantified reference to the panel ("several models", "every single
 *     model", "most of the models", "all of them", "two models", …);
 *   - in the panel-free fields (executive summary, certainty assessment,
 *     narrative sections), also any division predicate ("disagree", "split",
 *     "diverge", "contested", …) and any collective reference to the panel
 *     ("the models", "the panel", "these models").
 *
 * A "why models disagree" explanation is about a split row by construction,
 * so division words and collective references stay allowed there; agreement,
 * settledness, majority words and counts do not.
 *
 * There are no exemptions — subgroup wording, negation, attribution to a row
 * and counts are not read, so no phrasing of those can pass. Named models
 * ("ChatGPT stresses …") stay usable for explanatory subgroup prose. The
 * word lists are a closed English set: prose that implies panel agreement
 * without any of them is not detected, but it can never replace or alter
 * the deterministic statements, which are always rendered separately.
 * Pure and client-safe.
 */

export type NarrativeField = "panel_free" | "disagreement";

// ─── Tokenisation ────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/n['’]t\b/g, " not")
    .replace(/[^a-z0-9%/-]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ─── Closed word classes (token sequences) ──────────────────────────────

const AGREEMENT: string[][] = [
  ["agree"], ["agrees"], ["agreed"], ["agreeing"], ["agreement"], ["agreements"],
  ["concur"], ["concurs"], ["concurred"], ["concurrence"],
  ["converge"], ["converges"], ["converged"], ["converging"], ["convergence"], ["convergent"],
  ["align"], ["aligns"], ["aligned"], ["alignment"],
  ["endorse"], ["endorses"], ["endorsed"], ["endorsement"],
  ["consensus"], ["accord"], ["concord"],
  ["one", "voice"], ["of", "one", "mind"], ["same", "conclusion"], ["same", "view"], ["same", "position"],
  ["shared", "view"], ["shared", "position"], ["common", "view"], ["common", "position"], ["common", "ground"],
  ["prevailing", "view"], ["dominant", "view"], ["eye", "to", "eye"], ["same", "page"], ["lockstep"],
  ["no", "disagreement"], ["no", "dissent"], ["without", "dissent"], ["without", "disagreement"],
];

const SETTLED: string[][] = [
  ["settled"], ["resolved"], ["uncontested"], ["undisputed"], ["indisputable"], ["incontrovertible"], ["uncontroversial"],
  ["beyond", "dispute"], ["beyond", "doubt"], ["beyond", "question"], ["no", "doubt"], ["little", "doubt"],
  ["not", "in", "dispute"], ["no", "longer", "debated"], ["proven"], ["conclusively"],
  ["well", "established"], ["well-established"], ["firmly", "established"], ["established", "fact"],
  ["widely", "accepted"], ["generally", "accepted"], ["universally", "accepted"], ["accepted", "view"],
];

const STANDING: string[][] = [
  ["unanimous"], ["unanimously"], ["unanimity"],
  ["majority", "view"], ["majority", "position"], ["minority", "view"], ["minority", "position"], ["plurality", "view"],
];

/** Only in panel-free fields: a "why models disagree" explanation is about division by construction. */
const DIVISION: string[][] = [
  ["disagree"], ["disagrees"], ["disagreed"], ["disagreeing"], ["disagreement"], ["disagreements"],
  ["split"], ["splits"], ["divided"], ["diverge"], ["diverges"], ["diverged"], ["divergence"], ["divergent"],
  ["contested"], ["contentious"], ["controversial"], ["dissent"], ["dissents"], ["dissenting"],
];

/** Names for the panel or its members, when quantified. Model product names are not here: naming a model is how explanatory subgroup prose stays possible. */
const PANEL_NOUNS = new Set([
  "model", "models", "panel", "panels", "panelist", "panelists", "panellist", "panellists", "llm", "llms", "respondent", "respondents",
]);
/** Words that name the panel itself wherever they appear. */
const PANEL_ONLY_NOUNS = new Set(["panel", "panels", "panelist", "panelists", "panellist", "panellists", "llm", "llms"]);
/** Determiners that make "models" the panel ("the models", "these models") rather than models in the subject matter ("climate models"). */
const COLLECTIVE_DETERMINERS = new Set(["the", "these", "those", "our"]);
/** Pronouns that refer to the panel only when quantified ("all of them", "they all"). */
const PANEL_PRONOUNS = new Set(["they", "them"]);

const QUANTIFIERS = new Set([
  "all", "every", "each", "both", "either", "neither", "none", "no", "any", "most", "many", "several", "some", "few",
  "majority", "minority", "half", "whole", "entire", "single", "only", "other", "others", "remaining", "rest", "multiple",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
]);

function isQuantifier(token: string | undefined): boolean {
  return !!token && (QUANTIFIERS.has(token) || /^\d+(\/\d+)?$/.test(token));
}

function hasSequence(tokens: string[], classes: string[][]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    for (const seq of classes) {
      if (i + seq.length <= tokens.length && seq.every((t, k) => tokens[i + k] === t)) return true;
    }
  }
  return false;
}

/** "The panel", "the models", "these models" — the panel as a collective subject. */
function hasCollectivePanelReference(tokens: string[]): boolean {
  return tokens.some((t, i) => PANEL_ONLY_NOUNS.has(t) || (t === "models" && COLLECTIVE_DETERMINERS.has(tokens[i - 1])));
}

/** A panel noun or pronoun with a quantifier up to three tokens before it ("several models", "most of the models") or right after it ("they all", "the models both"). */
function hasQuantifiedPanelReference(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (!PANEL_NOUNS.has(tokens[i]) && !PANEL_PRONOUNS.has(tokens[i])) continue;
    for (let k = Math.max(0, i - 3); k < i; k++) if (isQuantifier(tokens[k])) return true;
    if (isQuantifier(tokens[i + 1])) return true;
  }
  return false;
}

// ─── The rule ────────────────────────────────────────────────────────────

/** Whether a model-written sentence characterises the panel's agreement and so must not be shown. */
export function isAgreementBearing(sentence: string, field: NarrativeField): boolean {
  const tokens = tokenize(sentence);
  if (hasSequence(tokens, AGREEMENT) || hasSequence(tokens, SETTLED) || hasSequence(tokens, STANDING)) return true;
  if (hasQuantifiedPanelReference(tokens)) return true;
  if (field === "panel_free") {
    if (hasSequence(tokens, DIVISION)) return true;
    if (hasCollectivePanelReference(tokens)) return true;
  }
  return false;
}

/** Leading indentation plus an optional list or heading marker ("- ", "* ", "• ", "1. ", "2) ", "## "), kept as written. */
const LINE_MARKER = /^([ \t]*(?:(?:[-*•]|\d+[.)]|#{1,6})[ \t]+)?)/;

/** One line with its agreement-bearing sentences removed, keeping its list/heading marker; "" when nothing remains. */
function filterLine(line: string, field: NarrativeField): string {
  const marker = LINE_MARKER.exec(line)?.[1] ?? "";
  const kept = splitSentences(line.slice(marker.length))
    .filter((s) => !isAgreementBearing(s, field))
    .join(" ");
  return kept ? `${marker}${kept}` : "";
}

/**
 * `text` with every agreement-bearing sentence removed (fail closed); "" when
 * nothing remains. Layout is kept (R4-2): sentences are filtered within each
 * line, so paragraph breaks, single line breaks, list items and headings stay
 * where they were, with their original newline characters (LF or CRLF). A line
 * left empty is dropped together with the line break before it, and a
 * paragraph left empty together with the blank-line separator before it, so
 * no empty paragraph or stray blank line is introduced and no two paragraphs
 * are joined.
 */
export function withoutAgreementClaims(text: string, field: NarrativeField): string {
  // Paragraphs and the blank-line runs between them, in order (separators at odd indices).
  const parts = text.split(/(\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*)/);
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const lines = parts[i].split(/(\r?\n)/);
    let paragraph = "";
    for (let j = 0; j < lines.length; j += 2) {
      const kept = filterLine(lines[j], field);
      if (!kept) continue;
      paragraph += paragraph ? `${lines[j - 1]}${kept}` : kept;
    }
    if (!paragraph) continue;
    out += out ? `${parts[i - 1]}${paragraph}` : paragraph;
  }
  return out;
}

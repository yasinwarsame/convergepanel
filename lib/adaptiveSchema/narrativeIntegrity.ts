/**
 * Narrative integrity (D9, R1 N3)
 *
 * The synthesis narrative is model-written. Its prompt forbids describing a
 * claim more strongly than its structured status allows, but a prompt rule is
 * advisory; this module is the deterministic backstop. It checks each
 * sentence that claims WHOLE-PANEL or MAJORITY agreement against the
 * structured row the sentence is about:
 * - consensus row: whole-panel agreement language is allowed, but unanimity
 *   language ("all models", "every model", "unanimous") only when every
 *   dispatched model took the agreeing position — silent and failed models
 *   did not agree;
 * - majority row: majority language only ("most models", "a majority"),
 *   never whole-panel or unanimity language;
 * - limited_coverage / split / single_source (anything not
 *   TOP_CONSENSUS_ELIGIBLE): no panel or majority agreement language at all;
 * - a sentence that matches no row: rejected only when the run has no
 *   consensus/majority row at all (then no panel agreement exists to describe).
 * Statements about a counted subgroup ("Two models agree that …, while the
 * other assessed models disagree") and negated statements ("there is no
 * consensus", "models do not agree") are not agreement claims and pass.
 *
 * Detection is lexical (English, the narrative prompt's language) and
 * deliberately scoped: it recognises the common ways a sentence asserts panel
 * or majority agreement, not every possible paraphrase. Callers fall back to
 * the deterministic text on any violation; no model is re-called.
 *
 * Pure and client-safe.
 */

import { AlignedClaim } from "./types";
import { isTopConsensusEligible } from "./consensusIntegrity";

export type AgreementClaimLevel = "panel" | "unanimous" | "majority";

const NUMBER_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|\\d+";
/** A counted or partial subject — a subgroup, not the panel. */
const SUBGROUP_QUANTIFIER = new RegExp(`\\b(?:${NUMBER_WORDS}|some|several|a few|few|both|either|neither|only|individual|certain|other|remaining)\\s*$`, "i");
const MAJORITY_QUANTIFIER = /\b(?:most|most of|(?:a |the )?majority of)(?: the)?\s*$/i;
const NEGATION_BEFORE = /\b(?:no|not|never|without|lack(?:s|ing)?|absence of|fail(?:s|ed)? to|little|limited|partial|n't|cannot|can't)\b[^.!?]{0,24}$/i;

const AGREE_VERB = "(?:agree[sd]?|agreeing|converge[sd]?|converging|concur(?:s|red)?|align(?:s|ed)?|are (?:in )?(?:agreement|aligned|unanimous)|reach(?:es|ed)? (?:a |an |broad |full |clear )?(?:consensus|agreement)|share (?:the|a) (?:same )?(?:view|position))";

/** [pattern, claim level]. Subgroup and negation checks are applied to the text before each match. */
const CLAIM_PATTERNS: Array<[RegExp, AgreementClaimLevel]> = [
  [new RegExp(`\\b(?:all(?: of)?(?: the)?(?: \\w+)? models|every model|each model|all (?:the )?(?:\\w+ )?panel(?:ists)?|the (?:whole|entire|full) panel)\\b[^.!?]{0,30}?\\b${AGREE_VERB}\\b`, "i"), "unanimous"],
  [/\b(?:unanimous(?:ly)?|unanimity)\b/i, "unanimous"],
  [new RegExp(`\\b(?:the panel|the models|models|panel)\\s+(?:\\w+\\s+){0,2}?${AGREE_VERB}\\b`, "i"), "panel"],
  [/\b(?:consensus)\b/i, "panel"],
  [/\b(?:broad|strong|clear|general|wide|widespread|overall|panel-wide|near-universal|universal)\s+(?:agreement|accord|alignment)\b/i, "panel"],
  [new RegExp(`\\b(?:most models|most of the models|a majority(?: of (?:the )?models)?|the majority(?: of (?:the )?models)?|majority view|majority of the panel)\\b`, "i"), "majority"],
];

const LEVEL_RANK: Record<AgreementClaimLevel, number> = { majority: 1, panel: 2, unanimous: 3 };

/**
 * The strongest panel/majority agreement claim a sentence makes, or null.
 * A match preceded by a counted/partial subject (a subgroup) or by a negation
 * is not a claim.
 */
export function agreementClaimLevel(sentence: string): AgreementClaimLevel | null {
  let best: AgreementClaimLevel | null = null;
  for (const [pattern, level] of CLAIM_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    for (let m = re.exec(sentence); m; m = re.exec(sentence)) {
      const before = sentence.slice(0, m.index);
      if (SUBGROUP_QUANTIFIER.test(before)) continue;
      // "most models agree" / "a majority of the models agree" is a majority claim (its own pattern), not a panel one.
      if (level === "panel" && MAJORITY_QUANTIFIER.test(before)) continue;
      if (NEGATION_BEFORE.test(before)) continue;
      // A negated verb inside the match ("models do not agree", "models don't converge").
      if (/\b(?:not|never|n't)\b/i.test(m[0])) continue;
      if (!best || LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
    }
  }
  return best;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "in", "on", "to", "is", "are", "was", "were", "be", "been", "for", "with", "by", "vs",
  "that", "this", "it", "its", "as", "at", "from", "than", "more", "less", "models", "model", "panel", "agree", "agrees",
  "agreed", "consensus", "majority", "most", "all", "every", "each", "claim", "claims", "about", "on", "whether", "which",
]);

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
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

function agreeingCount(row: AlignedClaim): number {
  return row.cells.filter((c) => !!c && (c.stance === "agrees" || c.stance === "partial")).length;
}

/** Whether a claim of `level` about `row` is stronger than its structured status allows. */
export function overstatesRow(level: AgreementClaimLevel, row: AlignedClaim, dispatchedPanelSize: number): boolean {
  if (!isTopConsensusEligible(row.status)) return true;
  if (row.status === "majority") return level !== "majority";
  // consensus: unanimity only when every dispatched model agreed.
  if (level === "unanimous") return agreeingCount(row) < dispatchedPanelSize;
  return false;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The sentences of `text` that state more agreement than the structured
 * result allows (see module header). `subjectRow`, when given, is the row the
 * whole text is about (e.g. the split topic a "why models disagree" sentence
 * explains) and is used for any sentence that matches no row by content.
 */
export function overstatingSentences(
  text: string,
  rows: AlignedClaim[],
  dispatchedPanelSize: number,
  subjectRow?: AlignedClaim
): string[] {
  const anyEligible = rows.some((r) => isTopConsensusEligible(r.status));
  const out: string[] = [];
  for (const sentence of splitSentences(text)) {
    const level = agreementClaimLevel(sentence);
    if (!level) continue;
    const row = attributeSentence(sentence, rows) ?? subjectRow ?? null;
    if (row ? overstatesRow(level, row, dispatchedPanelSize) : !anyEligible) out.push(sentence);
  }
  return out;
}

/**
 * Whether model-written "Where models agree" sentences may be shown: every
 * sentence must be about a consensus/majority row (by content) and must not
 * overstate it. Any other outcome means the deterministic lines are used.
 */
export function agreeLinesHonest(lines: string[], rows: AlignedClaim[], dispatchedPanelSize: number): boolean {
  return lines.every((line) => {
    const row = attributeSentence(line, rows);
    if (!row || !isTopConsensusEligible(row.status)) return false;
    return splitSentences(line).every((s) => {
      const level = agreementClaimLevel(s);
      return !level || !overstatesRow(level, row, dispatchedPanelSize);
    });
  });
}

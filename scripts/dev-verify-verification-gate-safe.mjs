#!/usr/bin/env node
/**
 * dev-verify-verification-gate-safe.mjs
 *
 * Lightweight assertions for the Verification Gate logic.
 * Uses inline simulation of the gate logic (no TypeScript imports).
 *
 * Tests:
 *   1. SAFE_TO_EXPLORE for a simple fixture with one non-material disagreement
 *      and inflated trustSummary.
 *   2. NEEDS_HUMAN_REVIEW when a material disagreement is present.
 *   3. Two non-material disagreements → SAFE_TO_EXPLORE (no material → no review).
 *   4. trustSummary inflation is capped.
 *   5. DO_NOT_RELY_YET with missing sources + material disagreement.
 *   6. Clean panel always SAFE_TO_EXPLORE.
 *   7. Tokyo nuance disagreement → SAFE_TO_EXPLORE (canonical token overlap).
 *   8. Nuance keyword disagreement (no polarity) → SAFE_TO_EXPLORE.
 *   9. Source-level checks on verificationGate.ts.
 *
 * Usage:
 *   node scripts/dev-verify-verification-gate-safe.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${label}`);
  }
}

// =========================================================================
// Part 1: Source-level checks on verificationGate.ts
// =========================================================================
console.log("\n--- Source-level checks ---");

const gatePath = resolve(process.cwd(), "lib/verificationGate/verificationGate.ts");
const gateSource = readFileSync(gatePath, "utf-8");

assert(
  gateSource.includes("isMaterialDisagreement"),
  "contains isMaterialDisagreement helper"
);
assert(
  gateSource.includes("isNuanceOnlyDisagreement"),
  "contains isNuanceOnlyDisagreement helper"
);
assert(
  gateSource.includes("extractCanonicalTokens"),
  "contains extractCanonicalTokens helper"
);
assert(
  gateSource.includes("hasOpposingPolarity"),
  "contains hasOpposingPolarity helper"
);
assert(
  gateSource.includes("NUANCE_KEYWORDS"),
  "contains NUANCE_KEYWORDS list"
);
assert(
  gateSource.includes("POLARITY_PAIRS"),
  "contains POLARITY_PAIRS list"
);
assert(
  gateSource.includes("materialDisagreementsCount"),
  "contains materialDisagreementsCount metric"
);
assert(
  /m\.contestedCount\s*>\s*2\s*&&/.test(gateSource),
  "Tier 2 uses contestedCount > 2 && materialDisagreementsCount > 2 && ..."
);
assert(
  gateSource.includes("Minor nuance differences noted"),
  "Non-material disagreements use nuance-specific language"
);
assert(
  gateSource.includes("contestedFromFindings"),
  "contestedCount is derived from findings, not directly from trustSummary"
);
assert(
  gateSource.includes("Math.min(contestedHint"),
  "trustSummary.contestedAreas is capped via Math.min"
);
assert(
  gateSource.includes("[VerificationGate]"),
  "DEV-only log is present"
);
assert(
  gateSource.includes("sourceBacked"),
  "contains sourceBacked input and logic"
);
assert(
  gateSource.includes("questionLength"),
  "contains questionLength for factoid heuristic"
);
assert(
  gateSource.includes("isLikelyFactoid"),
  "contains isLikelyFactoid heuristic"
);
assert(
  gateSource.includes("sourceBacked ? emptyEvidenceCount : 0"),
  "missingSourcesCount forced to 0 when not sourceBacked"
);

// =========================================================================
// Part 2: Inline simulation of the gate logic
// =========================================================================

function normalizeText(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

const COMMON_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "of", "in", "to", "for",
  "at", "by", "on", "it", "its", "this", "that", "and", "or", "but", "not",
  "all", "no", "yes", "has", "have", "had", "do", "does", "did", "will",
  "can", "may", "should", "could", "would", "be", "been", "being",
  "what", "which", "who", "whom", "when", "where", "why", "how",
  "there", "here", "some", "most", "many", "much", "more", "than",
  "also", "each", "every", "both", "few", "other", "such", "only",
  "if", "then", "so", "as", "with", "from", "about", "into", "over",
  "after", "before", "between", "under", "above", "up", "down",
]);

function extractCanonicalTokens(claim) {
  const tokens = [];
  const c = claim.trim();
  const quotedMatches = c.matchAll(/["']([^"']+)["']/g);
  for (const m of quotedMatches) {
    const t = normalizeText(m[1]);
    if (t.length >= 2) tokens.push(t);
  }
  const words = c.split(/\s+/);
  for (const w of words) {
    if (/^[A-Z]/.test(w) && !COMMON_WORDS.has(w.toLowerCase())) {
      const cleaned = w.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cleaned.length >= 2) tokens.push(cleaned);
    }
  }
  const eqNum = c.match(/(?:=|\bis\b|\bequals?\b)\s*(\d+)/i);
  if (eqNum?.[1]) tokens.push(eqNum[1]);
  else {
    const anyNum = c.match(/\b(\d{1,6})\b/);
    if (anyNum?.[1]) tokens.push(anyNum[1]);
  }
  return [...new Set(tokens)];
}

const NUANCE_KEYWORDS = [
  "legal", "statutory", "formalization", "de jure", "de facto",
  "terminology", "wording", "framing", "definition", "semantics",
  "technicality", "pedantic", "clarification", "distinction",
  "axiom", "theorem", "proof", "formal system", "peano", "zfc",
  "foundations", "formalism", "convention",
];

const POLARITY_PAIRS = [
  ["yes", "no"], ["before", "after"], ["increase", "decrease"],
  ["true", "false"], ["agree", "disagree"], ["support", "oppose"],
  ["positive", "negative"], ["likely", "unlikely"],
  ["higher", "lower"], ["more", "less"], ["better", "worse"],
];

function hasOpposingPolarity(positions) {
  const joined = positions.map(normalizeText).join(" ");
  return POLARITY_PAIRS.some(([a, b]) => joined.includes(a) && joined.includes(b));
}

function isNuanceOnlyDisagreement(d, canonicalTokens) {
  const positions = Object.values(d.positionsByModel).map(normalizeText);
  if (positions.length === 0) return false;

  if (canonicalTokens.length > 0) {
    const primary = canonicalTokens[0];
    const matchCount = positions.filter((p) => p.includes(primary)).length;
    if (matchCount / positions.length >= 0.8) return true;
  }

  const combined = normalizeText(d.topic + " " + d.whyTheyDiffer);
  const hasNuanceKeyword = NUANCE_KEYWORDS.some((kw) => combined.includes(kw));
  if (hasNuanceKeyword && !hasOpposingPolarity(positions)) return true;

  return false;
}

function isMaterialDisagreement(d, canonicalTokens) {
  if (isNuanceOnlyDisagreement(d, canonicalTokens)) return false;
  const modelCount = Object.keys(d.positionsByModel).length;
  const positions = Object.values(d.positionsByModel).map(normalizeText);
  if (canonicalTokens.length > 0 && positions.length > 0 && modelCount >= 3) {
    const noTokenMatches = !canonicalTokens.some((token) => {
      const matchCount = positions.filter((p) => p.includes(token)).length;
      return matchCount / positions.length >= 0.8;
    });
    if (noTokenMatches) return true;
  }
  return modelCount >= 3 && (d.whyTheyDiffer.length >= 80 || d.topic.length >= 25);
}

function computeVerificationGate(input) {
  const {
    keyFindings = [],
    disagreements = [],
    biasAndBlindSpots = [],
    openQuestions = [],
    trustSummary,
    sourceBacked = false,
    questionLength,
  } = input;

  const canonicalTokens = keyFindings.length > 0
    ? extractCanonicalTokens(keyFindings[0].claim)
    : [];

  const disagreementsCount = disagreements.length;
  const materialDisagreementsCount = disagreements.filter(
    (d) => isMaterialDisagreement(d, canonicalTokens),
  ).length;

  const emptyEvidenceCount = keyFindings.filter((f) => f.evidenceRefs.length === 0).length;
  const missingSourcesCount = sourceBacked ? emptyEvidenceCount : 0;

  const isLikelyFactoid =
    questionLength != null && questionLength <= 80 && keyFindings.length <= 1;
  const openQuestionsCount = isLikelyFactoid ? 0 : (openQuestions?.length ?? 0);
  const biasFlagsCount = biasAndBlindSpots.length;
  const lowConfidenceCount = keyFindings.filter(
    (f) => f.confidence === "Low" || f.confidence === "Mixed"
  ).length;

  const contestedFromFindings = keyFindings.filter((f) => f.confidence === "Mixed").length;
  const lowFromFindings = keyFindings.filter((f) => f.confidence === "Low").length;

  const contestedHint = trustSummary?.contestedAreas ?? 0;
  const uncertainHint = trustSummary?.uncertainPoints ?? 0;

  const contestedCount = Math.max(
    contestedFromFindings,
    Math.min(contestedHint, contestedFromFindings + 2)
  );
  const uncertainCount = Math.max(
    lowFromFindings + openQuestionsCount,
    Math.min(uncertainHint, lowFromFindings + openQuestionsCount + 3)
  );

  const m = {
    disagreementsCount,
    materialDisagreementsCount,
    contestedCount,
    missingSourcesCount,
    biasFlagsCount,
    uncertainCount,
    lowConfidenceCount,
    sourceBacked,
  };

  // Tier 1
  if (m.missingSourcesCount >= 1 && (m.materialDisagreementsCount >= 1 || m.lowConfidenceCount >= 2)) {
    return { status: "DO_NOT_RELY_YET", metrics: m, reasons: buildReasons(m) };
  }
  // Tier 2 — NEEDS_HUMAN_REVIEW (all four must exceed 2, OR source-backed + missing sources)
  if (
    m.contestedCount > 2 &&
    m.materialDisagreementsCount > 2 &&
    m.biasFlagsCount > 2 &&
    m.uncertainCount > 2
  ) {
    return { status: "NEEDS_HUMAN_REVIEW", metrics: m, reasons: buildReasons(m) };
  }
  if (m.sourceBacked && m.missingSourcesCount >= 1) {
    return { status: "NEEDS_HUMAN_REVIEW", metrics: m, reasons: buildReasons(m) };
  }
  if (m.materialDisagreementsCount >= 1) {
    return { status: "NEEDS_HUMAN_REVIEW", metrics: m, reasons: buildReasons(m) };
  }
  // Low confidence + another risk signal => review
  if (
    m.lowConfidenceCount >= 2 &&
    (m.contestedCount >= 1 || m.materialDisagreementsCount >= 1 || m.uncertainCount >= 3)
  ) {
    return { status: "NEEDS_HUMAN_REVIEW", metrics: m, reasons: buildReasons(m) };
  }
  // Tier 3
  return { status: "SAFE_TO_EXPLORE", metrics: m, reasons: buildReasons(m) };
}

function buildReasons(m) {
  const reasons = [];
  const nuanceCount = m.disagreementsCount - m.materialDisagreementsCount;
  if (m.materialDisagreementsCount >= 1) {
    reasons.push(`Model disagreement on a core conclusion (${m.materialDisagreementsCount})`);
  } else if (nuanceCount >= 1) {
    reasons.push(`Minor nuance differences noted (${nuanceCount})`);
  }
  if (m.sourceBacked && m.missingSourcesCount >= 1) {
    reasons.push(`Missing sources/citations (${m.missingSourcesCount})`);
  }
  return reasons;
}

// -------------------------------------------------------------------------
// Fixture 1 — Simple question, one minor disagreement, inflated trustSummary
// Expected: SAFE_TO_EXPLORE
// -------------------------------------------------------------------------
console.log("\n--- Fixture 1: Simple question (SAFE_TO_EXPLORE expected) ---");

const result1 = computeVerificationGate({
  keyFindings: [{
    claim: "Water boils at 100°C at standard pressure",
    confidence: "High",
    evidenceRefs: ["ref1", "ref2"],
    modelsSupporting: ["chatgpt", "claude", "gemini"],
  }],
  disagreements: [{
    topic: "Boiling point",
    positionsByModel: { chatgpt: "100°C", claude: "99.98°C" },
    whyTheyDiffer: "Rounding difference",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 1, contestedAreas: 10, uncertainPoints: 10 },
});

assert(result1.status === "SAFE_TO_EXPLORE", `status=${result1.status} should be SAFE_TO_EXPLORE`);
assert(result1.metrics.disagreementsCount === 1, `disagreementsCount=${result1.metrics.disagreementsCount} should be 1`);
assert(result1.metrics.materialDisagreementsCount === 0, `materialDisagreementsCount=${result1.metrics.materialDisagreementsCount} should be 0`);
assert(result1.metrics.contestedCount <= 2, `contestedCount=${result1.metrics.contestedCount} should be capped (<=2)`);
assert(result1.metrics.uncertainCount <= 3, `uncertainCount=${result1.metrics.uncertainCount} should be capped (<=3)`);

// -------------------------------------------------------------------------
// Fixture 2 — Material disagreement (AGI timeline)
// Expected: NEEDS_HUMAN_REVIEW (material disagreements trigger review)
// -------------------------------------------------------------------------
console.log("\n--- Fixture 2: Material disagreement (NEEDS_HUMAN_REVIEW) ---");

const result2 = computeVerificationGate({
  keyFindings: [{
    claim: "AI will surpass human reasoning by 2030",
    confidence: "Mixed",
    evidenceRefs: ["ref1"],
    modelsSupporting: ["chatgpt", "gemini"],
  }],
  disagreements: [{
    topic: "Timeline for artificial general intelligence",
    positionsByModel: {
      chatgpt: "AGI likely by 2030",
      claude: "AGI unlikely before 2040",
      gemini: "AGI timeline is fundamentally unpredictable",
    },
    whyTheyDiffer:
      "Fundamental differences in how each model weighs current progress rates versus historical overpromising in the AI field. Claude emphasizes alignment challenges.",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 0, contestedAreas: 1, uncertainPoints: 1 },
});

assert(result2.status === "NEEDS_HUMAN_REVIEW", `status=${result2.status} should be NEEDS_HUMAN_REVIEW`);
assert(result2.metrics.materialDisagreementsCount === 1, `materialDisagreementsCount=${result2.metrics.materialDisagreementsCount} should be 1`);

// -------------------------------------------------------------------------
// Fixture 3 — Two non-material disagreements (no material → SAFE)
// Expected: SAFE_TO_EXPLORE (changed from previous NEEDS_HUMAN_REVIEW)
// -------------------------------------------------------------------------
console.log("\n--- Fixture 3: Two non-material disagreements (SAFE_TO_EXPLORE expected) ---");

const result3 = computeVerificationGate({
  keyFindings: [{
    claim: "Cats are great pets",
    confidence: "High",
    evidenceRefs: ["ref1"],
    modelsSupporting: ["chatgpt", "claude"],
  }],
  disagreements: [
    {
      topic: "Best breed",
      positionsByModel: { chatgpt: "Siamese", claude: "Persian" },
      whyTheyDiffer: "Subjective",
    },
    {
      topic: "Ideal diet",
      positionsByModel: { chatgpt: "Wet food", claude: "Dry food" },
      whyTheyDiffer: "Different sources",
    },
  ],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 1, contestedAreas: 0, uncertainPoints: 0 },
});

assert(result3.status === "SAFE_TO_EXPLORE", `status=${result3.status} should be SAFE_TO_EXPLORE (no material disagreements)`);
assert(result3.metrics.materialDisagreementsCount === 0, "both disagreements are non-material");
assert(result3.metrics.disagreementsCount === 2, `disagreementsCount=${result3.metrics.disagreementsCount} should be 2`);

// -------------------------------------------------------------------------
// Fixture 4 — trustSummary inflation capped, no disagreements
// Expected: SAFE_TO_EXPLORE
// -------------------------------------------------------------------------
console.log("\n--- Fixture 4: trustSummary inflation is capped (SAFE_TO_EXPLORE expected) ---");

const result4 = computeVerificationGate({
  keyFindings: [{
    claim: "The sky is blue",
    confidence: "High",
    evidenceRefs: ["ref1"],
    modelsSupporting: ["chatgpt", "claude", "gemini"],
  }],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 1, contestedAreas: 50, uncertainPoints: 50 },
});

assert(result4.status === "SAFE_TO_EXPLORE", `status=${result4.status} should be SAFE_TO_EXPLORE despite inflated trustSummary`);
assert(result4.metrics.contestedCount <= 2, `contestedCount=${result4.metrics.contestedCount} capped (Mixed=0, max 0+2=2)`);
assert(result4.metrics.uncertainCount <= 3, `uncertainCount=${result4.metrics.uncertainCount} capped (Low+OQ=0, max 0+3=3)`);

// -------------------------------------------------------------------------
// Fixture 5 — DO_NOT_RELY_YET: missing sources + material disagreement
// -------------------------------------------------------------------------
console.log("\n--- Fixture 5: DO_NOT_RELY_YET (missing sources + material disagreement) ---");

const result5 = computeVerificationGate({
  keyFindings: [{
    claim: "Unverified claim about quantum gravity",
    confidence: "Low",
    evidenceRefs: [],
    modelsSupporting: ["chatgpt"],
  }],
  disagreements: [{
    topic: "Validity of the quantum gravity claim",
    positionsByModel: {
      chatgpt: "Plausible",
      claude: "Unlikely",
      gemini: "No basis in current physics",
    },
    whyTheyDiffer:
      "The models differ fundamentally on whether the cited experimental setup is feasible given current technological constraints and theoretical frameworks.",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 0, contestedAreas: 1, uncertainPoints: 1 },
  sourceBacked: true,
});

assert(result5.status === "DO_NOT_RELY_YET", `status=${result5.status} should be DO_NOT_RELY_YET`);
assert(result5.metrics.missingSourcesCount >= 1, `missingSourcesCount=${result5.metrics.missingSourcesCount} should be >=1`);
assert(result5.metrics.materialDisagreementsCount >= 1, `materialDisagreementsCount=${result5.metrics.materialDisagreementsCount} should be >=1`);

// -------------------------------------------------------------------------
// Fixture 6 — Clean panel, zero disagreements
// Expected: SAFE_TO_EXPLORE
// -------------------------------------------------------------------------
console.log("\n--- Fixture 6: Clean panel (SAFE_TO_EXPLORE expected) ---");

const result6 = computeVerificationGate({
  keyFindings: [{
    claim: "2 + 2 = 4",
    confidence: "High",
    evidenceRefs: ["math"],
    modelsSupporting: ["chatgpt", "claude", "gemini", "perplexity"],
  }],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 1, contestedAreas: 0, uncertainPoints: 0 },
});

assert(result6.status === "SAFE_TO_EXPLORE", `status=${result6.status} should be SAFE_TO_EXPLORE`);

// -------------------------------------------------------------------------
// Fixture 7 — Tokyo nuance: all models agree on "Tokyo" but one mentions
//              legal ambiguity. Should be SAFE_TO_EXPLORE.
// -------------------------------------------------------------------------
console.log("\n--- Fixture 7: Tokyo nuance disagreement (SAFE_TO_EXPLORE expected) ---");

const result7 = computeVerificationGate({
  keyFindings: [{
    claim: "Tokyo is the capital of Japan",
    confidence: "High",
    evidenceRefs: ["ref1", "ref2", "ref3"],
    modelsSupporting: ["chatgpt", "claude", "gemini", "perplexity", "grok"],
  }],
  disagreements: [{
    topic: "Legal status of Tokyo as capital",
    positionsByModel: {
      chatgpt: "Tokyo is the capital of Japan",
      claude: "Tokyo is the de facto capital, though no law explicitly designates it",
      gemini: "Tokyo is widely recognized as Japan's capital",
      perplexity: "Tokyo serves as the capital of Japan",
      grok: "Tokyo is Japan's capital city",
    },
    whyTheyDiffer:
      "Models differ on whether to note the legal technicality that no law explicitly designates Tokyo as the capital of Japan",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 5, contestedAreas: 1, uncertainPoints: 0 },
});

assert(result7.status === "SAFE_TO_EXPLORE", `status=${result7.status} should be SAFE_TO_EXPLORE`);
assert(result7.metrics.materialDisagreementsCount === 0, `materialDisagreementsCount=${result7.metrics.materialDisagreementsCount} should be 0 (nuance-only)`);
assert(result7.metrics.disagreementsCount === 1, `disagreementsCount=${result7.metrics.disagreementsCount} should be 1`);
assert(
  result7.reasons.some((r) => r.includes("Minor nuance")),
  "reasons should mention 'Minor nuance', not 'core conclusion'"
);
assert(
  !result7.reasons.some((r) => r.includes("core conclusion")),
  "reasons must NOT mention 'core conclusion'"
);

// -------------------------------------------------------------------------
// Fixture 8 — Nuance keyword path: topic mentions "definition"/"terminology"
//             with no opposing polarity. Should be SAFE_TO_EXPLORE.
// -------------------------------------------------------------------------
console.log("\n--- Fixture 8: Nuance keyword path (SAFE_TO_EXPLORE expected) ---");

const result8 = computeVerificationGate({
  keyFindings: [{
    claim: "GDP measures a country's total economic output",
    confidence: "High",
    evidenceRefs: ["ref1"],
    modelsSupporting: ["chatgpt", "claude", "gemini"],
  }],
  disagreements: [{
    topic: "Precise definition and terminology of GDP measurement",
    positionsByModel: {
      chatgpt: "GDP measures the monetary value of all finished goods and services",
      claude: "GDP measures the total market value of final goods and services produced",
      gemini: "GDP is the sum of gross value added by all producers in an economy",
    },
    whyTheyDiffer:
      "Models use slightly different wording and framing when describing the same fundamental economic concept of GDP measurement.",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 3, contestedAreas: 0, uncertainPoints: 0 },
});

assert(result8.status === "SAFE_TO_EXPLORE", `status=${result8.status} should be SAFE_TO_EXPLORE`);
assert(result8.metrics.materialDisagreementsCount === 0, `materialDisagreementsCount=${result8.metrics.materialDisagreementsCount} should be 0 (nuance keyword)`);

// -------------------------------------------------------------------------
// Fixture 9 — Nuance keyword + opposing polarity = material disagreement
// Expected: NEEDS_HUMAN_REVIEW (material disagreements trigger review)
// -------------------------------------------------------------------------
console.log("\n--- Fixture 9: Material disagreement with opposing polarity (NEEDS_HUMAN_REVIEW) ---");

const result9 = computeVerificationGate({
  keyFindings: [{
    claim: "Tax reform will change economic outcomes",
    confidence: "Mixed",
    evidenceRefs: ["ref1"],
    modelsSupporting: ["chatgpt", "claude"],
  }],
  disagreements: [{
    topic: "Whether the legal definition of income should include capital gains",
    positionsByModel: {
      chatgpt: "Yes, capital gains should be included in the legal definition",
      claude: "No, capital gains should be taxed separately",
      gemini: "The distinction between income and gains is largely a matter of framing and semantics",
    },
    whyTheyDiffer:
      "Fundamental disagreement on the legal and economic definition of income for tax purposes, with substantive policy implications across tax brackets.",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 0, contestedAreas: 1, uncertainPoints: 1 },
});

assert(result9.status === "NEEDS_HUMAN_REVIEW", `status=${result9.status} should be NEEDS_HUMAN_REVIEW`);
assert(result9.metrics.materialDisagreementsCount === 1, `materialDisagreementsCount=${result9.metrics.materialDisagreementsCount} should be 1 (opposing polarity overrides nuance keyword)`);

// -------------------------------------------------------------------------
// Fixture 10 — Non-source-backed factoid (Tokyo) with empty evidenceRefs + openQuestions
// Expected: missingSourcesCount=0, openQuestions excluded from uncertainCount, SAFE_TO_EXPLORE
// -------------------------------------------------------------------------
console.log("\n--- Fixture 10: Non-source-backed factoid (SAFE_TO_EXPLORE, no missing-sources penalty) ---");

const result10 = computeVerificationGate({
  keyFindings: [{
    claim: "Tokyo is the capital of Japan",
    confidence: "High",
    evidenceRefs: [],
    modelsSupporting: ["chatgpt", "claude", "gemini", "perplexity", "grok"],
  }],
  disagreements: [{
    topic: "Legal status of Tokyo as capital",
    positionsByModel: {
      chatgpt: "Tokyo is the capital",
      claude: "Tokyo is the de facto capital",
      gemini: "Tokyo is widely recognized as capital",
      perplexity: "Tokyo serves as the capital",
      grok: "Tokyo is Japan's capital",
    },
    whyTheyDiffer: "Models differ on whether to note legal technicality that no law explicitly designates Tokyo.",
  }],
  biasAndBlindSpots: [],
  openQuestions: ["Is Kyoto ever considered the capital?", "What about historical capitals?", "A", "B", "C", "D"],
  trustSummary: { strongConsensus: 5, contestedAreas: 0, uncertainPoints: 0 },
  sourceBacked: false,
  questionLength: 35,
});

assert(result10.status === "SAFE_TO_EXPLORE", `status=${result10.status} should be SAFE_TO_EXPLORE`);
assert(result10.metrics.missingSourcesCount === 0, `missingSourcesCount=${result10.metrics.missingSourcesCount} should be 0 (non-source-backed, all empty)`);
assert(result10.metrics.uncertainCount === 0, `uncertainCount=${result10.metrics.uncertainCount} should be 0 (factoid excludes openQuestions)`);
assert(
  !result10.reasons.some((r) => r.includes("Missing sources")),
  "reasons must NOT include Missing sources"
);

// -------------------------------------------------------------------------
// Fixture 11 — Source-backed run with empty evidenceRefs
// Expected: missingSourcesCount>0, triggers review
// -------------------------------------------------------------------------
console.log("\n--- Fixture 11: Source-backed with empty evidenceRefs (NEEDS_HUMAN_REVIEW or DO_NOT_RELY_YET) ---");

const result11 = computeVerificationGate({
  keyFindings: [
    { claim: "Claim A", confidence: "High", evidenceRefs: [], modelsSupporting: ["chatgpt", "claude"] },
    { claim: "Claim B", confidence: "High", evidenceRefs: [], modelsSupporting: ["gemini"] },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 2, contestedAreas: 0, uncertainPoints: 0 },
  sourceBacked: true,
  questionLength: 100,
});

assert(result11.metrics.missingSourcesCount === 2, `missingSourcesCount=${result11.metrics.missingSourcesCount} should be 2`);
assert(
  result11.status === "NEEDS_HUMAN_REVIEW" || result11.status === "DO_NOT_RELY_YET",
  `status=${result11.status} should trigger review (missing sources in source-backed mode)`
);
assert(
  result11.reasons.some((r) => r.includes("Missing sources")),
  "reasons should include Missing sources"
);

// -------------------------------------------------------------------------
// Fixture 12 — Non-source-backed: never penalize missing sources
// Expected: missingSourcesCount=0 even when some findings have empty evidenceRefs
// -------------------------------------------------------------------------
console.log("\n--- Fixture 12: Non-source-backed, never penalize missing sources ---");

const result12 = computeVerificationGate({
  keyFindings: [
    { claim: "Claim A", confidence: "High", evidenceRefs: ["ref1"], modelsSupporting: ["chatgpt"] },
    { claim: "Claim B", confidence: "High", evidenceRefs: [], modelsSupporting: ["claude"] },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 2, contestedAreas: 0, uncertainPoints: 0 },
  sourceBacked: false,
  questionLength: 50,
});

assert(result12.metrics.missingSourcesCount === 0, `missingSourcesCount=${result12.metrics.missingSourcesCount} must be 0 (non-source-backed)`);
assert(
  !result12.reasons.some((r) => r.includes("Missing sources")),
  "reasons must NOT include Missing sources when non-source-backed"
);

// -------------------------------------------------------------------------
// Fixture 13 — Deep research multi-claim with missing evidence
// Expected: Still strict (sourceBacked=true or anyHasEvidence path)
// -------------------------------------------------------------------------
console.log("\n--- Fixture 13: Deep research, source-backed, missing evidence (strict) ---");

const result13 = computeVerificationGate({
  keyFindings: [
    { claim: "Complex claim 1", confidence: "Mixed", evidenceRefs: [], modelsSupporting: ["chatgpt"] },
    { claim: "Complex claim 2", confidence: "Low", evidenceRefs: [], modelsSupporting: ["claude"] },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: ["Q1", "Q2"],
  trustSummary: { strongConsensus: 0, contestedAreas: 2, uncertainPoints: 3 },
  sourceBacked: true,
  questionLength: 200,
});

assert(result13.metrics.missingSourcesCount === 2, `missingSourcesCount=${result13.metrics.missingSourcesCount} should be 2`);
assert(
  result13.status === "DO_NOT_RELY_YET",
  `status=${result13.status} should be DO_NOT_RELY_YET (missing sources + low confidence)`
);

// -------------------------------------------------------------------------
// Fixture 14 — All four signals > 2: contested, material disagreements, bias, uncertainty
// Expected: NEEDS_HUMAN_REVIEW
// -------------------------------------------------------------------------
console.log("\n--- Fixture 14: All four signals > 2 (NEEDS_HUMAN_REVIEW expected) ---");

const result14 = computeVerificationGate({
  keyFindings: [
    { claim: "C1", confidence: "Mixed", evidenceRefs: [], modelsSupporting: ["a"] },
    { claim: "C2", confidence: "Mixed", evidenceRefs: [], modelsSupporting: ["b"] },
    { claim: "C3", confidence: "Mixed", evidenceRefs: [], modelsSupporting: ["c"] },
    { claim: "C4", confidence: "Low", evidenceRefs: [], modelsSupporting: ["a"] },
    { claim: "C5", confidence: "Low", evidenceRefs: [], modelsSupporting: ["b"] },
  ],
  disagreements: [
    { topic: "D1", positionsByModel: { a: "A", b: "B", c: "C" }, whyTheyDiffer: "Long rationale x".repeat(20) },
    { topic: "D2", positionsByModel: { a: "X", b: "Y", c: "Z" }, whyTheyDiffer: "Long rationale y".repeat(20) },
    { topic: "D3", positionsByModel: { a: "1", b: "2", c: "3" }, whyTheyDiffer: "Long rationale z".repeat(20) },
  ],
  biasAndBlindSpots: [
    { biasType: "B1", description: "d1", modelsImplicated: [] },
    { biasType: "B2", description: "d2", modelsImplicated: [] },
    { biasType: "B3", description: "d3", modelsImplicated: [] },
  ],
  openQuestions: ["Q1", "Q2", "Q3", "Q4", "Q5"],
  trustSummary: { strongConsensus: 0, contestedAreas: 5, uncertainPoints: 5 },
  sourceBacked: false,
  questionLength: 150,
});

assert(result14.status === "NEEDS_HUMAN_REVIEW", `status=${result14.status} should be NEEDS_HUMAN_REVIEW`);
assert(result14.metrics.contestedCount > 2, `contestedCount=${result14.metrics.contestedCount} > 2`);
assert(result14.metrics.materialDisagreementsCount > 2, `materialDisagreementsCount=${result14.metrics.materialDisagreementsCount} > 2`);
assert(result14.metrics.biasFlagsCount > 2, `biasFlagsCount=${result14.metrics.biasFlagsCount} > 2`);
assert(result14.metrics.uncertainCount > 2, `uncertainCount=${result14.metrics.uncertainCount} > 2`);

// -------------------------------------------------------------------------
// Fixture 15 — lowConfidenceCount >= 2 but contested=0, uncertain 0..2, no material
// Expected: SAFE_TO_EXPLORE (new rule must not over-trigger)
// -------------------------------------------------------------------------
console.log("\n--- Fixture 15: Two Low findings, no other risk signals (SAFE_TO_EXPLORE) ---");

const result15 = computeVerificationGate({
  keyFindings: [
    { claim: "Claim A", confidence: "Low", evidenceRefs: [], modelsSupporting: ["a"] },
    { claim: "Claim B", confidence: "Low", evidenceRefs: [], modelsSupporting: ["b"] },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 0, contestedAreas: 0, uncertainPoints: 0 },
  sourceBacked: false,
  questionLength: 100,
});

assert(result15.status === "SAFE_TO_EXPLORE", `status=${result15.status} should be SAFE_TO_EXPLORE`);
assert(result15.metrics.lowConfidenceCount >= 2, `lowConfidenceCount=${result15.metrics.lowConfidenceCount} >= 2`);
assert(result15.metrics.contestedCount === 0, `contestedCount=${result15.metrics.contestedCount} should be 0`);
assert(result15.metrics.uncertainCount <= 2, `uncertainCount=${result15.metrics.uncertainCount} <= 2`);

// -------------------------------------------------------------------------
// Fixture 16 — lowConfidenceCount >= 2 + contestedCount >= 1
// Expected: NEEDS_HUMAN_REVIEW
// -------------------------------------------------------------------------
console.log("\n--- Fixture 16: Two Low findings + contested claim (NEEDS_HUMAN_REVIEW) ---");

const result16 = computeVerificationGate({
  keyFindings: [
    { claim: "Claim A", confidence: "Low", evidenceRefs: [], modelsSupporting: ["a"] },
    { claim: "Claim B", confidence: "Low", evidenceRefs: [], modelsSupporting: ["b"] },
    { claim: "Claim C", confidence: "Mixed", evidenceRefs: [], modelsSupporting: ["a"] },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 0, contestedAreas: 0, uncertainPoints: 0 },
  sourceBacked: false,
  questionLength: 100,
});

assert(result16.status === "NEEDS_HUMAN_REVIEW", `status=${result16.status} should be NEEDS_HUMAN_REVIEW`);
assert(result16.metrics.lowConfidenceCount >= 2, `lowConfidenceCount=${result16.metrics.lowConfidenceCount} >= 2`);
assert(result16.metrics.contestedCount >= 1, `contestedCount=${result16.metrics.contestedCount} >= 1`);

// -------------------------------------------------------------------------
// Fixture 17 — lowConfidenceCount >= 2 + uncertainCount >= 3
// Expected: NEEDS_HUMAN_REVIEW
// -------------------------------------------------------------------------
console.log("\n--- Fixture 17: Two Low findings + uncertainCount >= 3 (NEEDS_HUMAN_REVIEW) ---");

const result17 = computeVerificationGate({
  keyFindings: [
    { claim: "Claim A", confidence: "Low", evidenceRefs: [], modelsSupporting: ["a"] },
    { claim: "Claim B", confidence: "Low", evidenceRefs: [], modelsSupporting: ["b"] },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: ["Q1", "Q2", "Q3", "Q4"],
  trustSummary: { strongConsensus: 0, contestedAreas: 0, uncertainPoints: 0 },
  sourceBacked: false,
  questionLength: 150,
});

assert(result17.status === "NEEDS_HUMAN_REVIEW", `status=${result17.status} should be NEEDS_HUMAN_REVIEW`);
assert(result17.metrics.lowConfidenceCount >= 2, `lowConfidenceCount=${result17.metrics.lowConfidenceCount} >= 2`);
assert(result17.metrics.uncertainCount >= 3, `uncertainCount=${result17.metrics.uncertainCount} >= 3`);

// -------------------------------------------------------------------------
// Fixture 18 — Source-backed + missing + lowConfidenceCount >= 2 (Tier 1 precedence)
// Expected: DO_NOT_RELY_YET (Tier 1 fires before Tier 2)
// -------------------------------------------------------------------------
console.log("\n--- Fixture 18: Source-backed + missing + 2 Low findings (DO_NOT_RELY_YET) ---");

const result18 = computeVerificationGate({
  keyFindings: [
    { claim: "Claim A", confidence: "Low", evidenceRefs: [], modelsSupporting: ["a"] },
    { claim: "Claim B", confidence: "Low", evidenceRefs: [], modelsSupporting: ["b"] },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 0, contestedAreas: 0, uncertainPoints: 0 },
  sourceBacked: true,
  questionLength: 100,
});

assert(result18.status === "DO_NOT_RELY_YET", `status=${result18.status} should be DO_NOT_RELY_YET (Tier 1)`);
assert(result18.metrics.missingSourcesCount >= 1, `missingSourcesCount=${result18.metrics.missingSourcesCount} >= 1`);
assert(result18.metrics.lowConfidenceCount >= 2, `lowConfidenceCount=${result18.metrics.lowConfidenceCount} >= 2`);

// -------------------------------------------------------------------------
// Fixture 19 — "2+2=4" with axiom/theorem disagreement, no evidenceRefs, sourceBacked:false
// Expected: SAFE_TO_EXPLORE
// -------------------------------------------------------------------------
console.log("\n--- Fixture 19: 2+2=4, axiom/theorem nuance, non-source-backed (SAFE_TO_EXPLORE) ---");

const result19 = computeVerificationGate({
  keyFindings: [{
    claim: "2 + 2 = 4",
    confidence: "High",
    evidenceRefs: [],
    modelsSupporting: ["chatgpt", "claude", "gemini", "perplexity", "grok"],
  }],
  disagreements: [{
    topic: "Whether this is an axiom or derivable theorem in Peano arithmetic",
    positionsByModel: {
      chatgpt: "Yes, 2+2=4. It follows from Peano axioms.",
      claude: "Yes. In ZFC and Peano arithmetic, 4 is the result.",
      gemini: "Yes. It is provable from the axioms of arithmetic.",
      perplexity: "Yes, 4. The formal system defines addition.",
      grok: "Yes. 2+2 equals 4 by definition of natural number addition.",
    },
    whyTheyDiffer: "Models differ on formalism framing: axiom vs theorem, Peano vs ZFC foundations.",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 5, contestedAreas: 0, uncertainPoints: 0 },
  sourceBacked: false,
  questionLength: 15,
});

assert(result19.status === "SAFE_TO_EXPLORE", `status=${result19.status} should be SAFE_TO_EXPLORE`);
assert(result19.metrics.missingSourcesCount === 0, `missingSourcesCount=${result19.metrics.missingSourcesCount} should be 0`);
assert(result19.metrics.materialDisagreementsCount === 0, "axiom/theorem framing should be nuance-only");
assert(!result19.reasons.some((r) => r.includes("Missing sources")), "must NOT mention Missing sources");

// -------------------------------------------------------------------------
// Fixture 20 — Same as 19 but sourceBacked:true
// Expected: Escalate (NEEDS_HUMAN_REVIEW or DO_NOT_RELY_YET) due to empty evidenceRefs
// -------------------------------------------------------------------------
console.log("\n--- Fixture 20: 2+2=4, axiom/theorem nuance, source-backed + empty refs (escalate) ---");

const result20 = computeVerificationGate({
  keyFindings: [{
    claim: "2 + 2 = 4",
    confidence: "High",
    evidenceRefs: [],
    modelsSupporting: ["chatgpt", "claude", "gemini"],
  }],
  disagreements: [{
    topic: "Axiom vs theorem framing",
    positionsByModel: {
      chatgpt: "Yes, 4. Provable from Peano.",
      claude: "Yes. Follows from axioms.",
      gemini: "Yes, 4.",
    },
    whyTheyDiffer: "Different formalism framing.",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 3, contestedAreas: 0, uncertainPoints: 0 },
  sourceBacked: true,
  questionLength: 15,
});

assert(
  result20.status === "NEEDS_HUMAN_REVIEW" || result20.status === "DO_NOT_RELY_YET",
  `status=${result20.status} should escalate (source-backed + empty evidenceRefs)`
);
assert(result20.metrics.missingSourcesCount >= 1, `missingSourcesCount=${result20.metrics.missingSourcesCount} >= 1`);

// -------------------------------------------------------------------------
// Fixture 21 — Contradiction: "2+2=5" or "Capital is Osaka"
// Expected: NEEDS_HUMAN_REVIEW or DO_NOT_RELY_YET
// -------------------------------------------------------------------------
console.log("\n--- Fixture 21: Contradiction - Capital of Japan is Osaka (NEEDS_HUMAN_REVIEW) ---");

const result21 = computeVerificationGate({
  keyFindings: [{
    claim: "Tokyo is the capital of Japan",
    confidence: "High",
    evidenceRefs: [],
    modelsSupporting: ["chatgpt", "claude"],
  }],
  disagreements: [{
    topic: "Capital of Japan",
    positionsByModel: {
      chatgpt: "Tokyo is the capital of Japan",
      claude: "Osaka is the capital of Japan",
      gemini: "Kyoto was the capital historically.",
    },
    whyTheyDiffer: "Models give conflicting answers about which city is the capital.",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 0, contestedAreas: 1, uncertainPoints: 1 },
  sourceBacked: false,
  questionLength: 25,
});

assert(
  result21.status === "NEEDS_HUMAN_REVIEW" || result21.status === "DO_NOT_RELY_YET",
  `status=${result21.status} should escalate (contradiction)`
);
assert(result21.metrics.materialDisagreementsCount >= 1, "contradictory positions should be material");

// -------------------------------------------------------------------------
// Fixture 22 — 2+2=5 contradiction
// Expected: NEEDS_HUMAN_REVIEW
// -------------------------------------------------------------------------
console.log("\n--- Fixture 22: Contradiction - 2+2=5 (NEEDS_HUMAN_REVIEW) ---");

const result22 = computeVerificationGate({
  keyFindings: [{
    claim: "2 + 2 = 4",
    confidence: "High",
    evidenceRefs: [],
    modelsSupporting: ["chatgpt", "claude"],
  }],
  disagreements: [{
    topic: "Result of 2+2",
    positionsByModel: {
      chatgpt: "4",
      claude: "5",
      gemini: "4",
    },
    whyTheyDiffer: "One model incorrectly states 2+2=5.",
  }],
  biasAndBlindSpots: [],
  openQuestions: [],
  trustSummary: { strongConsensus: 0, contestedAreas: 1, uncertainPoints: 0 },
  sourceBacked: false,
  questionLength: 12,
});

assert(
  result22.status === "NEEDS_HUMAN_REVIEW" || result22.status === "DO_NOT_RELY_YET",
  `status=${result22.status} should escalate (2+2=5 contradiction)`
);
assert(result22.metrics.materialDisagreementsCount >= 1, "4 vs 5 contradiction should be material");

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n=== Verification Gate assertions: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
console.log("✅ All verification gate assertions passed.\n");

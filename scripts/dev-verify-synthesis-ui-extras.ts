/**
 * Dev Verification Script: Synthesis UI Extras
 *
 * Verifies the markdown builder for Copy as Markdown:
 * 1. Fixture 1: sourceBacked + sourced findings → includes "Source coverage:"
 * 2. Fixture 2: non-sourceBacked + no evidence refs → excludes "Source coverage:"
 * 3. Both include "## Verification Gate" and "Model health:"
 *
 * Usage:
 *   npx ts-node scripts/dev-verify-synthesis-ui-extras.ts
 *   # or: node scripts/dev-verify-synthesis-ui-extras.mjs (if using ESM)
 */

import { buildSynthesisMarkdown } from "../lib/ui/copyFormats";

const gate = {
  status: "SAFE_TO_EXPLORE" as const,
  label: "Safe to explore",
  reasons: ["Minor nuance differences noted (1)"],
  recommendedNextSteps: ["Review key findings for context"],
  metrics: {
    disagreementsCount: 0,
    materialDisagreementsCount: 0,
    contestedCount: 0,
    missingSourcesCount: 0,
    biasFlagsCount: 0,
    uncertainCount: 0,
    lowConfidenceCount: 0,
  },
};

const verdict = {
  question: "What is the capital of Japan?",
  topConsensus: "Tokyo is the capital.",
  consensusModelCount: 4,
  topDisagreement: null as string | null,
  disagreementDetail: null as string | null,
  disagreementModelCount: 0,
  gateLabel: "Safe to explore",
  gateStatus: "SAFE_TO_EXPLORE",
  keyBlindSpot: null as string | null,
  grounding: { level: "source-backed" as const, label: "Source-backed" },
  recommendedNextSteps: ["Review key findings"],
};

const modelHealth = {
  total: 5,
  responded: 5,
  substitutedCount: 0,
  failedCount: 0,
};

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    process.exit(1);
  }
}

// Fixture 1: source-backed with sourced findings
const markdownSourceBacked = buildSynthesisMarkdown(
  verdict.question,
  gate,
  verdict,
  modelHealth,
  { sourcedFindings: 3, totalFindings: 5, coveragePct: 60 },
  null
);

// Fixture 2: non-source-backed, no evidence refs
const markdownNonSourceBacked = buildSynthesisMarkdown(
  verdict.question,
  gate,
  verdict,
  modelHealth,
  null, // no source coverage
  null
);

// Fixture 3: substitutions + failures → Panel note (provider names, not per-slot)
const markdownWithSubstitutions = buildSynthesisMarkdown(
  verdict.question,
  gate,
  verdict,
  {
    total: 5,
    responded: 4,
    substitutedCount: 2,
    failedCount: 1,
    substitutedProviders: ["DeepSeek"], // 2 slots, same provider → "2 models substituted (DeepSeek)"
  },
  null,
  null
);

console.log("\n--- Fixture 1: sourceBacked + sourced findings ---\n");

assert(markdownSourceBacked.includes("## Verification Gate"), 'includes "## Verification Gate"');
assert(markdownSourceBacked.includes("Model health:"), 'includes "Model health:"');
assert(markdownSourceBacked.includes("Source coverage:"), 'includes "Source coverage:" when sourceBacked');
assert(
  markdownSourceBacked.includes("3/5 claims sourced (60%)"),
  'includes sourced count and percentage'
);

console.log("\n--- Fixture 2: non-sourceBacked ---\n");

assert(markdownNonSourceBacked.includes("## Verification Gate"), 'includes "## Verification Gate"');
assert(markdownNonSourceBacked.includes("Model health:"), 'includes "Model health:"');
assert(
  !markdownNonSourceBacked.includes("Source coverage:"),
  'excludes "Source coverage:" when not sourceBacked'
);

console.log("\n--- Fixture 3: substitutions + failures → Panel note ---\n");

assert(
  markdownWithSubstitutions.includes("Panel note:"),
  'includes "Panel note:" when substitutions or failures'
);
assert(
  markdownWithSubstitutions.includes("2 models substituted (DeepSeek)"),
  'Panel note lists unique providers, not per-slot model names'
);
assert(
  markdownWithSubstitutions.includes("1 failed"),
  'Panel note lists failed count'
);

// Fixture 4: 3+ providers → "(DeepSeek +2)" format
const markdownManyProviders = buildSynthesisMarkdown(
  verdict.question,
  gate,
  verdict,
  {
    total: 5,
    responded: 3,
    substitutedCount: 3,
    failedCount: 0,
    substitutedProviders: ["DeepSeek", "OpenAI", "Anthropic"],
  },
  null,
  null
);

console.log("\n--- Fixture 4: 3+ providers → compact format ---\n");

assert(
  markdownManyProviders.includes("(DeepSeek +2)"),
  'Panel note uses "FirstProvider +N" when 3+ providers'
);

console.log("\n✅ All assertions passed.\n");

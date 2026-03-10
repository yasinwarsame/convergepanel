#!/usr/bin/env node

/**
 * Dev verification script for the Verification Gate module.
 *
 * Runs deterministic fixtures through the same logic as
 * lib/verificationGate/verificationGate.ts (re-implemented inline
 * to avoid TypeScript import issues in plain Node).
 *
 * Usage: node scripts/dev-verify-verification-gate.mjs
 * Exit code 0 = all pass, 1 = at least one failure.
 */

// ---------------------------------------------------------------------------
// Inline re-implementation of computeVerificationGate
// (mirrors lib/verificationGate/verificationGate.ts exactly)
// ---------------------------------------------------------------------------

function extractMetrics(input) {
  const keyFindings = input.keyFindings || [];
  const disagreements = input.disagreements || [];
  const biasAndBlindSpots = input.biasAndBlindSpots || [];
  const openQuestions = input.openQuestions || [];
  const ts = input.trustSummary;

  const disagreementsCount = disagreements.length;

  const contestedCount = ts?.contestedAreas ??
    keyFindings.filter((f) => f.confidence === "Mixed").length;

  const missingSourcesCount = keyFindings.filter(
    (f) => f.evidenceRefs.length === 0
  ).length;

  const biasFlagsCount = biasAndBlindSpots.length;

  const uncertainCount = ts?.uncertainPoints ??
    (keyFindings.filter((f) => f.confidence === "Low").length + openQuestions.length);

  const lowConfidenceCount = keyFindings.filter(
    (f) => f.confidence === "Low" || f.confidence === "Mixed"
  ).length;

  return {
    disagreementsCount,
    contestedCount,
    missingSourcesCount,
    biasFlagsCount,
    uncertainCount,
    lowConfidenceCount,
  };
}

function determineStatus(m) {
  if (m.missingSourcesCount >= 1 && (m.disagreementsCount >= 1 || m.lowConfidenceCount >= 2)) {
    return "DO_NOT_RELY_YET";
  }
  if (
    m.disagreementsCount >= 1 ||
    m.contestedCount >= 3 ||
    (m.biasFlagsCount >= 1 && m.uncertainCount >= 5)
  ) {
    return "NEEDS_HUMAN_REVIEW";
  }
  return "SAFE_TO_EXPLORE";
}

function buildReasons(m) {
  const reasons = [];
  if (m.disagreementsCount >= 1) reasons.push(`Model disagreement on a core conclusion (${m.disagreementsCount})`);
  if (m.contestedCount >= 1) reasons.push(`Contested claims detected (${m.contestedCount})`);
  if (m.missingSourcesCount >= 1) reasons.push(`Missing sources/citations (${m.missingSourcesCount})`);
  if (m.biasFlagsCount >= 1) reasons.push(`Possible bias/blind spots (${m.biasFlagsCount})`);
  if (m.uncertainCount >= 1) reasons.push(`High uncertainty signals (${m.uncertainCount})`);
  return reasons;
}

function buildNextSteps(m, status) {
  const steps = [];
  if (m.missingSourcesCount >= 1) steps.push("Request sources for the top claims and verify against primary references.");
  if (m.disagreementsCount >= 1) steps.push("Isolate the disputed premise and rerun with a narrower question focused on that premise.");
  if (m.contestedCount >= 1) steps.push("Extract the top contested claims and verify them independently before using in a memo.");
  if (m.biasFlagsCount >= 1) steps.push("Run an alternative framing / counterfactual prompt to test for blind spots.");
  if (status === "DO_NOT_RELY_YET") steps.push("Do not use for automated action; treat as hypothesis only until verified.");
  if (steps.length === 0) steps.push("Models show broad agreement — suitable for exploratory use. Cross-check key claims with primary sources before acting on them.");
  return steps;
}

const STATUS_LABELS = {
  SAFE_TO_EXPLORE: "Broadly consistent",
  NEEDS_HUMAN_REVIEW: "Needs human review",
  DO_NOT_RELY_YET: "Low confidence — review required",
};

function computeVerificationGate(input) {
  const metrics = extractMetrics(input);
  const status = determineStatus(metrics);
  const reasons = buildReasons(metrics);
  const recommendedNextSteps = buildNextSteps(metrics, status);
  return { status, label: STATUS_LABELS[status], reasons, recommendedNextSteps, metrics };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

function finding(overrides = {}) {
  return {
    claim: "Test claim",
    confidence: "High",
    evidenceRefs: ["ref1"],
    modelsSupporting: ["gpt-4", "claude"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

console.log("\n=== Verification Gate Tests ===\n");

// 1. Clean run — all high-confidence, with evidence, no disagreements
console.log("--- Fixture 1: Clean run (SAFE_TO_EXPLORE) ---");
{
  const result = computeVerificationGate({
    keyFindings: [
      finding(),
      finding({ claim: "Second claim" }),
    ],
    disagreements: [],
    biasAndBlindSpots: [],
    openQuestions: [],
  });
  assert(result.status === "SAFE_TO_EXPLORE", `status = ${result.status}`);
  assert(result.label === "Broadly consistent", `label = "${result.label}"`);
  assert(result.reasons.length === 0, `reasons empty (got ${result.reasons.length})`);
  assert(result.recommendedNextSteps.length >= 1, "has at least one next step");
}

// 2. Disagreement present — NEEDS_HUMAN_REVIEW
console.log("\n--- Fixture 2: One disagreement (NEEDS_HUMAN_REVIEW) ---");
{
  const result = computeVerificationGate({
    keyFindings: [finding()],
    disagreements: [{ topic: "Tax impact", positionsByModel: { "gpt-4": "positive", "claude": "negative" }, whyTheyDiffer: "Different data" }],
    biasAndBlindSpots: [],
    openQuestions: [],
  });
  assert(result.status === "NEEDS_HUMAN_REVIEW", `status = ${result.status}`);
  assert(result.reasons.some(r => r.includes("disagreement")), "reason mentions disagreement");
  assert(result.recommendedNextSteps.some(s => s.includes("disputed premise")), "step mentions disputed premise");
}

// 3. Many contested areas (>= 3) — NEEDS_HUMAN_REVIEW
console.log("\n--- Fixture 3: Three contested via trustSummary (NEEDS_HUMAN_REVIEW) ---");
{
  const result = computeVerificationGate({
    keyFindings: [finding()],
    disagreements: [],
    biasAndBlindSpots: [],
    openQuestions: [],
    trustSummary: { strongConsensus: 5, contestedAreas: 3, uncertainPoints: 0 },
  });
  assert(result.status === "NEEDS_HUMAN_REVIEW", `status = ${result.status}`);
  assert(result.reasons.some(r => r.includes("Contested")), "reason mentions contested");
}

// 4. Missing sources + disagreement — DO_NOT_RELY_YET
console.log("\n--- Fixture 4: Missing sources + disagreement (DO_NOT_RELY_YET) ---");
{
  const result = computeVerificationGate({
    keyFindings: [
      finding({ evidenceRefs: [] }),
    ],
    disagreements: [{ topic: "Cost estimate", positionsByModel: { a: "high", b: "low" }, whyTheyDiffer: "Methods" }],
    biasAndBlindSpots: [],
    openQuestions: [],
  });
  assert(result.status === "DO_NOT_RELY_YET", `status = ${result.status}`);
  assert(result.label === "Low confidence — review required", `label = "${result.label}"`);
  assert(result.recommendedNextSteps.some(s => s.includes("Do not use for automated")), "step warns about automated action");
}

// 5. Missing sources + multiple low-confidence findings — DO_NOT_RELY_YET
console.log("\n--- Fixture 5: Missing sources + low confidence (DO_NOT_RELY_YET) ---");
{
  const result = computeVerificationGate({
    keyFindings: [
      finding({ evidenceRefs: [], confidence: "Low" }),
      finding({ evidenceRefs: ["x"], confidence: "Mixed" }),
    ],
    disagreements: [],
    biasAndBlindSpots: [],
    openQuestions: [],
  });
  assert(result.status === "DO_NOT_RELY_YET", `status = ${result.status}`);
  assert(result.metrics.missingSourcesCount === 1, `missingSourcesCount = ${result.metrics.missingSourcesCount}`);
  assert(result.metrics.lowConfidenceCount === 2, `lowConfidenceCount = ${result.metrics.lowConfidenceCount}`);
}

// 6. Bias + high uncertainty — NEEDS_HUMAN_REVIEW
console.log("\n--- Fixture 6: Bias + high uncertainty (NEEDS_HUMAN_REVIEW) ---");
{
  const result = computeVerificationGate({
    keyFindings: [
      finding({ confidence: "Low" }),
      finding({ confidence: "Low" }),
    ],
    disagreements: [],
    biasAndBlindSpots: [{ biasType: "framing", description: "Western perspective", modelsImplicated: ["gpt-4"] }],
    openQuestions: ["Q1", "Q2", "Q3"],
    // uncertainCount = 2 (Low findings) + 3 (openQuestions) = 5
  });
  assert(result.status === "NEEDS_HUMAN_REVIEW", `status = ${result.status}`);
  assert(result.reasons.some(r => r.includes("bias")), "reason mentions bias");
  assert(result.reasons.some(r => r.includes("uncertainty")), "reason mentions uncertainty");
}

// 7. Bias alone (low uncertainty) — SAFE_TO_EXPLORE
console.log("\n--- Fixture 7: Bias only, low uncertainty (SAFE_TO_EXPLORE) ---");
{
  const result = computeVerificationGate({
    keyFindings: [finding()],
    disagreements: [],
    biasAndBlindSpots: [{ biasType: "anchoring", description: "First result bias", modelsImplicated: ["claude"] }],
    openQuestions: [],
  });
  assert(result.status === "SAFE_TO_EXPLORE", `status = ${result.status}`);
  assert(result.reasons.some(r => r.includes("bias")), "reason still mentions bias");
}

// 8. Empty input — SAFE_TO_EXPLORE
console.log("\n--- Fixture 8: Empty input (SAFE_TO_EXPLORE) ---");
{
  const result = computeVerificationGate({});
  assert(result.status === "SAFE_TO_EXPLORE", `status = ${result.status}`);
  assert(result.reasons.length === 0, "no reasons");
  assert(result.recommendedNextSteps.length === 1, "one default step");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

/**
 * Dev verification for synthesis consensus scoring (lib/verification/consensusScoring.ts).
 * Logic mirrored — keep in sync when changing computeSynthesisConsensusScoring.
 */

const MIN_RAW_TEXT_LEN = 48;
const NEGATION_NEAR_CLAIM_RE =
  /\b(not|no evidence|incorrect|unlikely|false|deny|contradict|dispute|refute|wrong|myth|doesn't|don't|didn't)\b/i;

function coerceSynthStatus(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s === "ok" || s === "substituted") return s;
  return "failed";
}

function extractAnchorTokens(claim) {
  const raw = claim.trim();
  if (!raw) return [];
  const tokens = new Set();
  for (const m of raw.matchAll(/\b\d+(?:[.,]\d+)?%?\b/g)) tokens.add(m[0].toLowerCase());
  for (const m of raw.matchAll(/"([^"]{2,120})"/g)) {
    const t = m[1].trim().toLowerCase().slice(0, 80);
    if (t.length >= 2) tokens.add(t);
  }
  for (const m of raw.matchAll(/\b([A-Z][a-z]{2,})\b/g)) tokens.add(m[1]);
  return [...tokens].sort((a, b) => a.localeCompare(b)).slice(0, 10);
}

function windowHasNegation(textLower, idx, needleLen) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(textLower.length, idx + needleLen + 40);
  return NEGATION_NEAR_CLAIM_RE.test(textLower.slice(start, end));
}

function classifyModelStanceForClaim(text, anchors) {
  if (!text?.trim() || anchors.length === 0) return "unknown";
  const lower = text.toLowerCase();
  let foundAny = false;
  for (const a of anchors) {
    const needle = a.toLowerCase();
    if (needle.length < 2) continue;
    let idx = 0;
    while ((idx = lower.indexOf(needle, idx)) !== -1) {
      foundAny = true;
      if (windowHasNegation(lower, idx, needle.length)) return "dissent";
      idx += Math.max(1, needle.length);
    }
  }
  if (!foundAny) return "unknown";
  return "support";
}

function usableSynthesisRows(results) {
  return results.filter((r) => {
    const st = coerceSynthStatus(r.status);
    if (st !== "ok" && st !== "substituted") return false;
    const t = (r.rawText ?? "").trim();
    return t.length >= MIN_RAW_TEXT_LEN;
  });
}

function perClaimEvidenceQuality(evidenceRefCount, supportRatio) {
  if (evidenceRefCount >= 1 && supportRatio >= 0.8) return "strong";
  if (evidenceRefCount >= 1 && supportRatio >= 0.5 && supportRatio < 0.8) return "mixed";
  if (evidenceRefCount === 0 || supportRatio < 0.5) return "weak";
  return "mixed";
}

function perClaimConfidenceLabel(supportRatio, sourceBacked, evidenceRefCount) {
  if (supportRatio >= 0.8 && (sourceBacked ? evidenceRefCount >= 1 : true)) return "High";
  if (supportRatio >= 0.6) return "Medium";
  return "Low";
}

function computeFixture(synthesis, results, sourceBacked, runId) {
  const usable = usableSynthesisRows(results);
  const modelsHealthy = usable.length;
  const modelCount = Math.max(1, results.length);
  const mhForRatio = Math.max(1, modelsHealthy);

  const enrichedKeyFindings = synthesis.keyFindings.map((kf) => {
    const anchors = extractAnchorTokens(kf.claim);
    const supportingModels = [];
    const dissentingModels = [];
    const unknownModels = [];
    for (const row of usable) {
      const text = (row.rawText ?? "").trim();
      const stance = classifyModelStanceForClaim(text, anchors);
      if (stance === "support") supportingModels.push(row.modelId);
      else if (stance === "dissent") dissentingModels.push(row.modelId);
      else unknownModels.push(row.modelId);
    }
    const supportRatio = Math.round((supportingModels.length / mhForRatio) * 1000) / 1000;
    const evidenceRefs = kf.evidenceRefs ?? [];
    const evidenceQuality = perClaimEvidenceQuality(evidenceRefs.length, supportRatio);
    const confidenceLabel = perClaimConfidenceLabel(supportRatio, sourceBacked, evidenceRefs.length);
    return {
      support: {
        supportingModels: [...supportingModels].sort(),
        dissentingModels: [...dissentingModels].sort(),
        unknownModels: [...unknownModels].sort(),
        supportRatio,
        confidenceLabel,
      },
      evidenceQuality,
    };
  });

  const ratios = enrichedKeyFindings.map((f) => f.support.supportRatio);
  const avgRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0.5;
  let score = Math.round(avgRatio * 100);
  if (synthesis.disagreements.length >= 2) score -= 10;
  if (synthesis.biasAndBlindSpots.length >= 1) score -= 10;
  const weakCount = enrichedKeyFindings.filter((f) => f.evidenceQuality === "weak").length;
  score -= Math.min(25, weakCount * 5);
  if (modelsHealthy < 4) score -= 10;
  const overallConsensusScore = Math.max(0, Math.min(100, score));

  const highConfidenceClaims = enrichedKeyFindings.filter((f) => f.support.confidenceLabel === "High").length;
  const lowEvidenceClaims = enrichedKeyFindings.filter((f) => f.evidenceQuality === "weak").length;

  return {
    overallConsensusScore,
    highConfidenceClaims,
    lowEvidenceClaims,
    modelsHealthy,
    enrichedKeyFindings,
    auditClaims: enrichedKeyFindings.map((f, i) => ({
      claimTruncated: synthesis.keyFindings[i].claim.slice(0, 200),
      supportRatio: f.support.supportRatio,
      evidenceQuality: f.evidenceQuality,
    })),
  };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const baseModels = [
  { modelId: "m1", status: "ok", rawText: " ".repeat(50) + "Inflation reached 12% in AcmeCorp study 2030. " + " ".repeat(50) },
  { modelId: "m2", status: "ok", rawText: " ".repeat(50) + "The 12% figure and AcmeCorp 2030 are consistent. " + " ".repeat(50) },
  { modelId: "m3", status: "ok", rawText: " ".repeat(50) + "AcmeCorp reported 12% inflation by 2030. " + " ".repeat(50) },
  { modelId: "m4", status: "ok", rawText: " ".repeat(50) + "12% and 2030 align with AcmeCorp. " + " ".repeat(50) },
  { modelId: "m5", status: "ok", rawText: " ".repeat(50) + "Study shows 12% for AcmeCorp in 2030. " + " ".repeat(50) },
];

const baseSynthesis = (overrides) => ({
  executiveSummary: "Test",
  keyFindings: [
    {
      claim: 'Inflation hit 12% in the "AcmeCorp" study by 2030.',
      confidence: "High",
      evidenceRefs: ["https://example.com/source"],
      modelsSupporting: ["m1"],
    },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  methodology: "Test",
  ...overrides,
});

// 1) High agreement
{
  const syn = baseSynthesis({});
  const r = computeFixture(syn, baseModels, true, "run-1");
  assert(r.overallConsensusScore > 80, `expected score > 80, got ${r.overallConsensusScore}`);
  assert(r.highConfidenceClaims > 0, "expected highConfidenceClaims > 0");
  assert(r.enrichedKeyFindings[0].support, "support block missing");
  assert(r.enrichedKeyFindings[0].support.supportRatio >= 0.8, "support ratio should be high");
}

// 2) Nuance: one disagreement topic but same anchors in model text — still strong per-claim support
{
  const syn = baseSynthesis({
    disagreements: [
      {
        topic: "Wording nuance",
        positionsByModel: { m1: "a", m2: "b" },
        whyTheyDiffer: "Tone differs",
      },
    ],
  });
  const r = computeFixture(syn, baseModels, true, "run-2");
  assert(r.overallConsensusScore >= 75, `expected score >= 75 with single disagreement, got ${r.overallConsensusScore}`);
}

// 3) Two disagreements + no evidence refs + weak support text mismatch
{
  const weakModels = baseModels.map((m, i) => ({
    ...m,
    rawText:
      i < 2
        ? " ".repeat(50) + "Unrelated topic without anchors here. " + " ".repeat(50)
        : m.rawText,
  }));
  const syn = baseSynthesis({
    keyFindings: [
      {
        claim: "Quantum widgets speed up 99% in the Zorg trial.",
        confidence: "Low",
        evidenceRefs: [],
        modelsSupporting: ["m1"],
      },
    ],
    disagreements: [{ topic: "a", positionsByModel: { m1: "x" }, whyTheyDiffer: "a" }, { topic: "b", positionsByModel: { m1: "y" }, whyTheyDiffer: "b" }],
    biasAndBlindSpots: [],
  });
  const r = computeFixture(syn, weakModels, false, "run-3");
  assert(r.lowEvidenceClaims > 0, "expected lowEvidenceClaims > 0");
  assert(r.overallConsensusScore < 85, `expected lower score, got ${r.overallConsensusScore}`);
}

// Determinism
{
  const syn = baseSynthesis({});
  const a = JSON.stringify(computeFixture(syn, baseModels, true, "x"));
  const b = JSON.stringify(computeFixture(syn, baseModels, true, "x"));
  assert(a === b, "deterministic output");
}

// Audit bundle shape (no raw model text)
{
  const syn = baseSynthesis({});
  const r = computeFixture(syn, baseModels, true, "run-audit");
  assert(Array.isArray(r.auditClaims), "claims array");
  assert(!JSON.stringify(r).includes("rawText"), "fixture output must not echo rawText in audit slice");
}

console.log("OK: dev-verify-consensus-scoring — synthesis consensus checks passed.");

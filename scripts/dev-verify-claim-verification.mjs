/**
 * Dev script: deterministic tests for claim verification verdict + consensus helpers.
 * Mirrors lib/verification/claimVerdict.ts and consensus scoring (verification mode).
 */

function computeClaimVerdict(modelResults) {
  const usableResults = modelResults.filter((r) => r.status === "ok");
  const totalUsable = usableResults.length;
  if (totalUsable === 0) return "unverifiable";

  const accurateCount = usableResults.filter((r) => r.verdict === "accurate").length;
  const inaccurateCount = usableResults.filter((r) => r.verdict === "inaccurate").length;
  const partialCount = usableResults.filter((r) => r.verdict === "partially_accurate").length;
  const unverifiableCount = usableResults.filter((r) => r.verdict === "unverifiable").length;

  if (accurateCount / totalUsable >= 0.8) return "confirmed";

  if (
    accurateCount > 0 &&
    inaccurateCount > 0 &&
    Math.abs(accurateCount - inaccurateCount) <= 1
  ) {
    return "disputed";
  }

  if (
    partialCount >= totalUsable * 0.4 ||
    (accurateCount + partialCount) / totalUsable >= 0.6
  ) {
    return "partially_true";
  }

  if (unverifiableCount / totalUsable >= 0.5) return "unverifiable";

  return "disputed";
}

function computeConsensusScoringVerification({ modelRows, aggregateVerdict }) {
  const modelCount = Math.max(1, modelRows.length);
  const usable = modelRows.filter((r) => r.status === "ok" && r.verdict);
  const totalUsable = Math.max(1, usable.length);
  const modelsHealthy = usable.length;

  const accurate = usable.filter((r) => r.verdict === "accurate").length;
  const partial = usable.filter((r) => r.verdict === "partially_accurate").length;
  const inaccurate = usable.filter((r) => r.verdict === "inaccurate").length;
  const supportRatio = (accurate + 0.5 * partial) / totalUsable;
  const lowEvidenceClaims =
    usable.filter((r) => r.confidence === "low").length +
    modelRows.filter((r) => r.status === "parse_error").length;

  const healthRatio = modelsHealthy / modelCount;
  let verdictBoost = 0;
  switch (aggregateVerdict) {
    case "confirmed":
      verdictBoost = 18;
      break;
    case "partially_true":
      verdictBoost = 5;
      break;
    case "disputed":
      verdictBoost = -8;
      break;
    case "unverifiable":
      verdictBoost = -15;
      break;
    default:
      break;
  }
  const disagreementPenalty = inaccurate > 0 && accurate > 0 ? 12 : 0;
  const rawScore =
    40 +
    45 * supportRatio +
    20 * healthRatio -
    disagreementPenalty +
    verdictBoost -
    Math.min(20, lowEvidenceClaims * 5);

  const overallConsensusScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  let confidenceLabel = "Medium";
  if (overallConsensusScore >= 72 && modelsHealthy >= Math.ceil(modelCount * 0.6)) {
    confidenceLabel = "High";
  } else if (overallConsensusScore < 45 || modelsHealthy < Math.ceil(modelCount * 0.4)) {
    confidenceLabel = "Low";
  }

  return { consensusScore: overallConsensusScore, confidenceLabel };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function auditOk(bundle) {
  const s = JSON.stringify(bundle);
  if (s.includes("rawText") || s.includes("rawResponse")) return false;
  return true;
}

function buildMinimalAudit() {
  return {
    version: "1",
    kind: "claim_verification",
    claimCharCount: 12,
    modelCount: 2,
    verdict: "confirmed",
    consensusScore: 90,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    perModel: [
      {
        modelId: "chatgpt",
        pipelineStatus: "ok",
        verdictLabel: "accurate",
        confidence: "high",
        summaryLength: 10,
        counts: { correct: 1, incorrect: 0, unverifiable: 0 },
      },
    ],
    generatedAt: new Date(0).toISOString(),
  };
}

function run() {
  const allAccurate = [
    { status: "ok", verdict: "accurate" },
    { status: "ok", verdict: "accurate" },
    { status: "ok", verdict: "accurate" },
    { status: "ok", verdict: "accurate" },
    { status: "ok", verdict: "accurate" },
  ];
  const v1 = computeClaimVerdict(allAccurate);
  assert(v1 === "confirmed", `expected confirmed, got ${v1}`);
  const c1 = computeConsensusScoringVerification({
    modelRows: allAccurate.map((r) => ({ ...r, confidence: "high" })),
    aggregateVerdict: v1,
  });
  assert(c1.consensusScore > 80, `expected score > 80, got ${c1.consensusScore}`);

  const disputed = [
    { status: "ok", verdict: "accurate" },
    { status: "ok", verdict: "accurate" },
    { status: "ok", verdict: "inaccurate" },
    { status: "ok", verdict: "inaccurate" },
    { status: "ok", verdict: "partially_accurate" },
  ];
  const v2 = computeClaimVerdict(disputed);
  assert(v2 === "disputed", `expected disputed, got ${v2}`);

  // Majority partial + accurate, no inaccurate (disputed branch requires both accurate & inaccurate)
  const partialMix = [
    { status: "ok", verdict: "partially_accurate" },
    { status: "ok", verdict: "partially_accurate" },
    { status: "ok", verdict: "partially_accurate" },
    { status: "ok", verdict: "partially_accurate" },
    { status: "ok", verdict: "accurate" },
  ];
  const v3 = computeClaimVerdict(partialMix);
  assert(v3 === "partially_true", `expected partially_true, got ${v3}`);

  const unv = [
    { status: "ok", verdict: "unverifiable" },
    { status: "ok", verdict: "unverifiable" },
    { status: "ok", verdict: "unverifiable" },
    { status: "ok", verdict: "accurate" },
    { status: "ok", verdict: "partially_accurate" },
  ];
  const v4 = computeClaimVerdict(unv);
  assert(v4 === "unverifiable", `expected unverifiable, got ${v4}`);

  const twoOnly = [
    { status: "ok", verdict: "accurate" },
    { status: "ok", verdict: "inaccurate" },
  ];
  const v5 = computeClaimVerdict(twoOnly);
  assert(v5 === "disputed", `edge 2 models: expected disputed, got ${v5}`);

  const zeroUsable = [
    { status: "parse_error" },
    { status: "failed" },
    { status: "parse_error" },
  ];
  const v6 = computeClaimVerdict(zeroUsable);
  assert(v6 === "unverifiable", `0 usable: expected unverifiable, got ${v6}`);

  for (let i = 0; i < 50; i++) {
    const rows = Array.from({ length: 5 }, (_, j) => ({
      status: j === i % 5 ? "parse_error" : "ok",
      verdict: ["accurate", "inaccurate", "partially_accurate", "unverifiable", "accurate"][j],
      confidence: "medium",
    }));
    computeClaimVerdict(rows);
  }

  const audit = buildMinimalAudit();
  assert(auditOk(audit), "audit must not contain raw field names");

  console.log("dev-verify-claim-verification: all assertions passed");
}

run();

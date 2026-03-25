/**
 * Dev script: deterministic tests for lib/governance/policyEngine.ts evaluatePolicies().
 * Logic is mirrored from policyEngine.ts — keep in sync when changing rules engine.
 */

/** @typedef {{ overallConsensusScore: number; supportRatio: number; confidenceLabel: string; evidenceQuality: string; lowEvidenceClaims: number; modelsHealthy: number; modelCount: number }} ConsensusSummary */

/**
 * @param {Array<{ id: string; name: string; description: string; enabled: boolean; condition: { type: string; threshold?: number }; action: string }>} rules
 * @param {ConsensusSummary} consensusSummary
 */
function evaluatePolicies(rules, consensusSummary) {
  const triggered = [];
  let blocked = false;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    let matches = false;
    switch (rule.condition.type) {
      case "consensus_below":
        matches = consensusSummary.overallConsensusScore < (rule.condition.threshold ?? 60);
        break;
      case "evidence_quality":
        matches = consensusSummary.lowEvidenceClaims > 0;
        break;
      case "model_health":
        matches = consensusSummary.modelsHealthy < (rule.condition.threshold ?? 4);
        break;
      default:
        matches = false;
    }

    if (matches) {
      triggered.push({
        rule,
        matchReason: `${rule.condition.type}: threshold not met`,
      });
      if (rule.action === "block") {
        blocked = true;
      }
    }
  }

  return {
    triggered,
    blocked,
    requiresReview: triggered.some((t) => t.rule.action === "require_review"),
  };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** @returns {ConsensusSummary} */
function baseSummary() {
  return {
    overallConsensusScore: 80,
    supportRatio: 0.8,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    lowEvidenceClaims: 0,
    modelsHealthy: 5,
    modelCount: 5,
  };
}

// --- Tests ---

// 1) Consensus below threshold → flag triggers
{
  const rules = [
    {
      id: "t1",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "consensus_below", threshold: 50 },
      action: "flag",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), overallConsensusScore: 40 });
  assert(ev.triggered.length === 1 && ev.triggered[0].rule.id === "t1", "low consensus should trigger flag rule");
  assert(ev.blocked === false, "flag action must not set blocked");
  assert(ev.requiresReview === false, "flag must not set requiresReview");
}

// 2) Consensus above threshold → no trigger
{
  const rules = [
    {
      id: "t2",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "consensus_below", threshold: 50 },
      action: "flag",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), overallConsensusScore: 80 });
  assert(ev.triggered.length === 0, "high consensus should not trigger");
}

// 3) Block rule + low consensus → blocked true
{
  const rules = [
    {
      id: "block-low",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "consensus_below", threshold: 70 },
      action: "block",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), overallConsensusScore: 50 });
  assert(ev.blocked === true, "block action must set blocked");
  assert(ev.triggered.length === 1, "block rule should appear in triggered");
}

// 4) Multiple rules, disabled ignored
{
  const rules = [
    {
      id: "on",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "consensus_below", threshold: 90 },
      action: "flag",
    },
    {
      id: "off",
      name: "n2",
      description: "d2",
      enabled: false,
      condition: { type: "consensus_below", threshold: 10 },
      action: "block",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), overallConsensusScore: 50 });
  assert(ev.triggered.length === 1 && ev.triggered[0].rule.id === "on", "only enabled rules trigger");
  assert(ev.blocked === false, "disabled block rule must not block");
}

// 5) No rules
{
  const ev = evaluatePolicies([], baseSummary());
  assert(ev.triggered.length === 0 && ev.blocked === false && ev.requiresReview === false, "empty rules → clean result");
}

// 6) Evidence quality — weak evidence
{
  const rules = [
    {
      id: "ev",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "evidence_quality" },
      action: "flag",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), lowEvidenceClaims: 2 });
  assert(ev.triggered.length === 1, "lowEvidenceClaims > 0 triggers evidence_quality");
}

// 7) Model health 3 healthy, threshold 4 → trigger
{
  const rules = [
    {
      id: "mh",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "model_health", threshold: 4 },
      action: "flag",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), modelsHealthy: 3, modelCount: 5 });
  assert(ev.triggered.length === 1, "3/5 healthy below threshold 4 should trigger");
}

// 8) Model health 5/5, threshold 4 → no trigger
{
  const rules = [
    {
      id: "mh2",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "model_health", threshold: 4 },
      action: "flag",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), modelsHealthy: 5, modelCount: 5 });
  assert(ev.triggered.length === 0, "5 healthy should not trigger model_health rule");
}

// 9) Deterministic — same inputs same output
{
  const rules = [
    {
      id: "d",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "consensus_below", threshold: 60 },
      action: "require_review",
    },
  ];
  const s = { ...baseSummary(), overallConsensusScore: 30 };
  const a = evaluatePolicies(rules, s);
  const b = evaluatePolicies(rules, s);
  assert(deepEqual(a, b), "evaluation must be deterministic");
}

// 10) blocked only when a block rule matched
{
  const rules = [
    {
      id: "f",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "consensus_below", threshold: 90 },
      action: "flag",
    },
    {
      id: "b",
      name: "n2",
      description: "d2",
      enabled: true,
      condition: { type: "model_health", threshold: 2 },
      action: "block",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), overallConsensusScore: 20, modelsHealthy: 5 });
  assert(ev.triggered.length === 1, "only consensus rule should match");
  assert(ev.blocked === false, "blocked false when no block rule matched");
}

// 11) requiresReview only for require_review action
{
  const rules = [
    {
      id: "rr",
      name: "n",
      description: "d",
      enabled: true,
      condition: { type: "consensus_below", threshold: 90 },
      action: "require_review",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), overallConsensusScore: 10 });
  assert(ev.requiresReview === true, "require_review rule sets requiresReview");
  const ev2 = evaluatePolicies(
    [
      {
        id: "fl",
        name: "n",
        description: "d",
        enabled: true,
        condition: { type: "consensus_below", threshold: 90 },
        action: "flag",
      },
    ],
    { ...baseSummary(), overallConsensusScore: 10 },
  );
  assert(ev2.requiresReview === false, "flag-only must not set requiresReview");
}

// 12) Disabled rules never appear in triggered
{
  const rules = [
    {
      id: "dis",
      name: "n",
      description: "d",
      enabled: false,
      condition: { type: "consensus_below", threshold: 100 },
      action: "block",
    },
  ];
  const ev = evaluatePolicies(rules, { ...baseSummary(), overallConsensusScore: 0 });
  assert(ev.triggered.length === 0, "disabled rule must not trigger");
}

console.log("OK: dev-verify-policy-engine — all policy engine checks passed.");

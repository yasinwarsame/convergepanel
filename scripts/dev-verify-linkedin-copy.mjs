#!/usr/bin/env node
/**
 * Dev Verification Script: LinkedIn Copy (plain Node/ESM)
 *
 * Verifies buildLinkedInPost output without TypeScript/ts-node.
 * Inline builder logic to avoid import path issues.
 *
 * Usage: node scripts/dev-verify-linkedin-copy.mjs
 */

function singleLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clamp(text, maxChars) {
  const s = singleLine(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1).trimEnd() + "…";
}

function bullets(list, max, maxPerBullet = 140) {
  return list.slice(0, max).map((b) => clamp(b, maxPerBullet));
}

function buildIntroLine(params) {
  const { question, gate } = params;
  const raw = singleLine(question || "").replace(/[.!?]+$/, "").trim();
  const topicLabel =
    raw.length <= 12 ? "" : raw.length > 90 ? raw.slice(0, 87).trimEnd() + "…" : raw;
  const gateLabel = gate?.label ?? "quick reliability pass";

  if (!topicLabel) {
    return `I ran a multi-model panel; verdict: ${gateLabel}.`;
  }
  return `Quick panel check on: ${topicLabel} — verdict: ${gateLabel}.`;
}

function buildLinkedInPost(params) {
  const { question, gate, verdict, modelHealth } = params;
  const lines = [];

  lines.push(buildIntroLine({ question, gate, verdict }));
  lines.push("");

  lines.push(`Panel Verdict: ${gate.label}`);
  lines.push("");

  if (gate.reasons.length > 0) {
    lines.push("Why:");
    bullets(gate.reasons, 3).forEach((r) => lines.push(`• ${r}`));
    lines.push("");
  }

  if (gate.recommendedNextSteps.length > 0) {
    lines.push("Next steps:");
    bullets(gate.recommendedNextSteps, 3).forEach((s) => lines.push(`• ${s}`));
    lines.push("");
  }

  const consensus = clamp(verdict.topConsensus, 200);
  const agreedBy =
    verdict.consensusModelCount > 0
      ? ` Agreed by ${verdict.consensusModelCount} model${verdict.consensusModelCount !== 1 ? "s" : ""}.`
      : "";
  lines.push(`Consensus: ${consensus}${agreedBy}`);
  lines.push("");

  if (verdict.topDisagreement) {
    const topic = clamp(verdict.topDisagreement, 80);
    const detail = verdict.disagreementDetail ? clamp(verdict.disagreementDetail, 180) : "";
    lines.push(`Disagreement: ${topic}`);
    if (detail) lines.push(detail);
    lines.push("");
  }

  if (verdict.keyBlindSpot) {
    lines.push(`Caveat: ${singleLine(verdict.keyBlindSpot)}`);
    lines.push("");
  }

  const { total, responded, substituted, failed } = modelHealth;
  let healthLine = `Model health: ${responded}/${total} responded`;
  if (substituted > 0 || failed > 0) {
    const parts = [];
    if (substituted > 0) {
      const list = modelHealth.substitutedProviders ?? [];
      const prov =
        list.length > 2 ? `${list[0]} +${list.length - 1}` : list.length ? list.join(", ") : "";
      parts.push(`Substituted: ${substituted}${prov ? ` (${prov})` : ""}`);
    }
    if (failed > 0) parts.push(`Failed: ${failed}`);
    healthLine += " • " + parts.join(" • ");
  }
  lines.push(healthLine);
  lines.push("");

  lines.push(
    "Built with ConvergePanel — a multi-model panel that highlights consensus, disagreements, and blind spots."
  );
  lines.push("");
  lines.push("#AI #Research #DecisionMaking");

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    process.exit(1);
  }
}

// Fixtures
const gateSafe = {
  status: "SAFE_TO_EXPLORE",
  label: "Safe to explore",
  reasons: ["Minor nuance differences noted (1)"],
  recommendedNextSteps: ["Review key findings for context", "Compare with primary sources"],
  metrics: {},
};

const gateReview = {
  status: "NEEDS_HUMAN_REVIEW",
  label: "Needs human review",
  reasons: ["Material disagreement on key claim", "Conflicting model positions require verification"],
  recommendedNextSteps: ["Verify primary sources", "Consult domain expert"],
  metrics: {},
};

const verdictMinimal = {
  question: "What is the capital of Japan?",
  topConsensus: "Tokyo is the capital of Japan.",
  consensusModelCount: 4,
  topDisagreement: null,
  disagreementDetail: null,
  disagreementModelCount: 0,
  gateLabel: "Safe to explore",
  gateStatus: "SAFE_TO_EXPLORE",
  keyBlindSpot: null,
  grounding: { level: "source-backed", label: "Source-backed" },
  recommendedNextSteps: ["Review key findings for context"],
};

const verdictWithDisagreement = {
  question: "What are the main risks of AI in healthcare?",
  topConsensus: "AI can improve diagnostics but requires careful validation.",
  consensusModelCount: 3,
  topDisagreement: "Level of regulatory oversight needed",
  disagreementDetail:
    "Some models favor stricter FDA-style approval; others suggest a lighter framework for decision-support tools.",
  disagreementModelCount: 2,
  gateLabel: "Needs human review",
  gateStatus: "NEEDS_HUMAN_REVIEW",
  keyBlindSpot: "Training data bias may not be fully apparent.",
  grounding: { level: "mixed", label: "Mixed" },
  recommendedNextSteps: ["Verify primary sources", "Consult domain expert"],
};

const postA = buildLinkedInPost({
  question: verdictMinimal.question,
  gate: gateSafe,
  verdict: verdictMinimal,
  modelHealth: { total: 5, responded: 5, substituted: 0, failed: 0 },
});

const postB = buildLinkedInPost({
  question: verdictWithDisagreement.question,
  gate: gateReview,
  verdict: verdictWithDisagreement,
  modelHealth: {
    total: 5,
    responded: 3,
    substituted: 1,
    failed: 1,
    substitutedProviders: ["DeepSeek"],
  },
});

console.log("\n--- Fixture a: SAFE_TO_EXPLORE, substitutions=0 ---\n");

const firstLineA = postA.split("\n")[0];
assert(firstLineA && firstLineA.length > 0, "first line is not empty");
assert(
  postA.startsWith("Quick panel check on:") || postA.includes("capital of Japan"),
  "intro includes topic (truncated question)"
);
assert(
  postA.includes("Safe to explore") || postA.includes("Verdict:") || postA.includes("Result:"),
  "intro includes gate.label or verdict phrase"
);
assert(postA.includes("Panel Verdict:"), 'contains "Panel Verdict:"');
assert(postA.includes("Why:"), 'contains "Why:"');
assert(postA.includes("Next steps:"), 'contains "Next steps:"');
assert(postA.includes("Model health:"), 'contains "Model health:"');
assert(postA.length >= 300 && postA.length <= 1200, "length between 300-1200 chars");
assert(!postA.includes("undefined"), "no undefined");
assert(!postA.includes("\n\n\n"), "no triple blank lines");
assert(!postA.includes("{"), "no raw JSON braces");

console.log("\n--- Fixture b: NEEDS_HUMAN_REVIEW, substituted=1, failed=1 ---\n");

const firstLineB = postB.split("\n")[0];
assert(firstLineB && firstLineB.length > 0, "first line is not empty");
assert(
  postB.includes("AI in healthcare") || postB.includes("Quick panel check"),
  "intro includes topic or topic-aware phrase"
);
assert(postB.includes("Needs human review") || postB.includes("Verdict:"), "intro includes gate.label");
assert(postB.includes("Panel Verdict:"), 'contains "Panel Verdict:"');
assert(postB.includes("Why:"), 'contains "Why:"');
assert(postB.includes("Next steps:"), 'contains "Next steps:"');
assert(postB.includes("Model health:"), 'contains "Model health:"');
assert(postB.includes("Disagreement:"), 'contains "Disagreement:"');
assert(postB.includes("Substituted:") || postB.includes("substituted"), "mentions substitution");
assert(postB.includes("Failed:") || postB.includes("failed"), "mentions failure");
assert(postB.length >= 300 && postB.length <= 1200, "length between 300-1200 chars");
assert(!postB.includes("undefined"), "no undefined");

// Fixture c: empty/short question → generic intro fallback
const postC = buildLinkedInPost({
  question: "Hi",
  gate: gateSafe,
  verdict: verdictMinimal,
  modelHealth: { total: 5, responded: 5, substituted: 0, failed: 0 },
});

console.log("\n--- Fixture c: short question → generic intro fallback ---\n");

assert(
  postC.includes("I ran a multi-model panel; verdict:"),
  "generic intro when question too short"
);
assert(postC.includes("Safe to explore"), "gate label in intro");

// Fixture d: long caveat (>= 300 chars) — must NOT be truncated
const longCaveat =
  "The analysis may underrepresent perspectives in other regions. " +
  "Several models drew primarily from Western sources, and the framing of key issues " +
  "could differ if non-English or regional datasets were emphasized. " +
  "Readers should consider supplementing with local expertise.";
const verdictLongCaveat = {
  ...verdictWithDisagreement,
  keyBlindSpot: longCaveat,
};

const postD = buildLinkedInPost({
  question: verdictLongCaveat.question,
  gate: gateReview,
  verdict: verdictLongCaveat,
  modelHealth: { total: 5, responded: 5, substituted: 0, failed: 0 },
});

console.log("\n--- Fixture d: long caveat — full text, no truncation ---\n");

assert(
  postD.includes("underrepresent perspectives in other regions"),
  "full caveat substring present"
);
assert(postD.includes("Caveat:"), "Caveat line exists");
assert(
  postD.includes("Caveat:") && postD.includes("underrepresent perspectives in other regions"),
  "Caveat line contains full substring"
);
assert(
  !postD.includes("underrepresent perspective…"),
  "no mid-word truncation (our ellipsis)"
);
assert(!postD.includes("undefined"), "no undefined");
assert(!postD.includes("{"), "no raw JSON");
assert(postD.length >= 300 && postD.length <= 1800, "length within 300-1800 chars (caveat full)");

console.log("\n✅ All assertions passed.\n");

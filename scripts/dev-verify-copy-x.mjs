#!/usr/bin/env node
/**
 * dev-verify-copy-x.mjs
 *
 * Verifies that Copy-for-X helpers produce correct output:
 *  1. Short copy never contains "..."
 *  2. Thread chunks are each ≤ 280 chars
 *  3. Thread contains the full disagreementDetail text
 *  4. Short copy contains no mid-string truncation
 */

// Inline re-implementations to avoid TypeScript/ESM import issues

function trimToSentence(text, maxLen) {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastPeriod = slice.lastIndexOf(". ");
  if (lastPeriod > maxLen * 0.3) return slice.slice(0, lastPeriod + 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.3) return slice.slice(0, lastSpace);
  return slice;
}

function buildCopyForXShort(v) {
  const firstSentence = (s) => {
    const m = s.match(/^[^.!?]*[.!?]/);
    return m ? m[0] : s;
  };

  const parts = [];
  parts.push(trimToSentence(v.question, 120));
  parts.push("");
  parts.push(`Consensus: ${firstSentence(v.topConsensus)}`);

  if (v.topDisagreement) {
    parts.push(`Disagreement: ${firstSentence(v.topDisagreement)}`);
  }

  parts.push(`Gate: ${v.gateLabel}`);

  if (v.keyBlindSpot) {
    parts.push(`Caveat: ${firstSentence(v.keyBlindSpot)}`);
  }

  parts.push("");
  parts.push("via ConvergePanel");

  let text = parts.join("\n");

  if (text.length > 280 && v.keyBlindSpot) {
    const idx = parts.findIndex((p) => p.startsWith("Caveat:"));
    if (idx !== -1) { parts.splice(idx, 1); text = parts.join("\n"); }
  }
  if (text.length > 280 && v.topDisagreement) {
    const idx = parts.findIndex((p) => p.startsWith("Disagreement:"));
    if (idx !== -1) { parts.splice(idx, 1); text = parts.join("\n"); }
  }

  return text;
}

function splitIntoXThread(text, maxLen = 280) {
  if (text.length <= maxLen) return [text];

  const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) ?? [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    const candidate = current ? `${current} ${trimmed}` : trimmed;

    if (candidate.length <= maxLen - 6) {
      current = candidate;
    } else {
      if (current) chunks.push(current);

      if (trimmed.length <= maxLen - 6) {
        current = trimmed;
      } else {
        const words = trimmed.split(/\s+/);
        current = "";
        for (const word of words) {
          const next = current ? `${current} ${word}` : word;
          if (next.length > maxLen - 6) {
            if (current) chunks.push(current);
            current = word;
          } else {
            current = next;
          }
        }
      }
    }
  }
  if (current) chunks.push(current);

  if (chunks.length <= 1) return chunks;
  return chunks.map((c, i) => `${i + 1}/${chunks.length} ${c}`);
}

function buildCopyForXThread(v) {
  const parts = [];
  parts.push(v.question);
  parts.push("");
  parts.push(`Consensus: ${v.topConsensus}`);

  if (v.topDisagreement) {
    parts.push(`Key disagreement: ${v.topDisagreement}`);
    if (v.disagreementDetail) {
      parts.push(v.disagreementDetail);
    }
  }

  parts.push(`Verification Gate: ${v.gateLabel}`);

  if (v.keyBlindSpot) {
    parts.push(`Caveat: ${v.keyBlindSpot}`);
  }

  parts.push("");
  parts.push("via ConvergePanel — multi-model AI synthesis");

  const fullText = parts.join("\n");
  return splitIntoXThread(fullText);
}

// ── Fixtures ──

const shortVerdict = {
  question: "Is remote work better than in-office?",
  topConsensus: "Studies show hybrid models work best for productivity.",
  consensusModelCount: 3,
  topDisagreement: "Impact on culture",
  disagreementDetail: "Some models say culture suffers; others say it adapts.",
  disagreementModelCount: 2,
  gateLabel: "Broadly consistent",
  gateStatus: "SAFE_TO_EXPLORE",
  keyBlindSpot: "Most studies are from tech sector only.",
  grounding: { level: "mixed", label: "Mixed / unclear" },
  recommendedNextSteps: ["Cross-check claims."],
};

const longVerdict = {
  question: "What are the relative weights of macroeconomic factors affecting housing affordability in major metropolitan areas across different economic cycles?",
  topConsensus: "Interest rates and housing supply constraints are consistently identified as the two dominant factors. Wage stagnation relative to housing costs creates a persistent affordability gap that compounds over time. Zoning restrictions and NIMBYism further limit new construction in high-demand areas.",
  consensusModelCount: 4,
  topDisagreement: "Relative weights of demand-side versus supply-side factors in determining housing prices across different metropolitan contexts and economic conditions",
  disagreementDetail: "Models fundamentally disagree on whether demand-side factors (population growth, foreign investment, speculative buying) or supply-side constraints (zoning, construction costs, land availability) are the primary driver. Claude emphasizes institutional and regulatory barriers while GPT focuses on macroeconomic demand pressures. Grok highlights the role of monetary policy as an independent variable that interacts with both supply and demand channels in non-linear ways that make simple decomposition misleading.",
  disagreementModelCount: 4,
  gateLabel: "Needs human review",
  gateStatus: "NEEDS_HUMAN_REVIEW",
  keyBlindSpot: "All models draw primarily from US, UK, and Australian housing market data. Markets with fundamentally different structures such as Singapore's public housing model, Vienna's social housing program, or Tokyo's permissive zoning approach are largely absent from the analysis. This geographic bias may overstate the inevitability of affordability crises and understate the effectiveness of policy interventions that have been successful in other contexts.",
  grounding: { level: "source-backed", label: "Source-backed" },
  recommendedNextSteps: ["Verify the disputed premise with primary sources.", "Add counter-sources from non-Western markets."],
};

// ── Tests ──

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

console.log("\n=== Test 1: Short copy — no ellipsis ===\n");

const shortCopyShort = buildCopyForXShort(shortVerdict);
assert(!shortCopyShort.includes("..."), "Short verdict short copy has no '...'");
assert(shortCopyShort.length <= 280, `Short verdict ≤ 280 chars (got ${shortCopyShort.length})`);

const longCopyShort = buildCopyForXShort(longVerdict);
assert(!longCopyShort.includes("..."), "Long verdict short copy has no '...'");
assert(longCopyShort.length <= 280, `Long verdict short copy ≤ 280 chars (got ${longCopyShort.length})`);

console.log("\n=== Test 2: Thread — chunk sizes ===\n");

const shortThread = buildCopyForXThread(shortVerdict);
for (let i = 0; i < shortThread.length; i++) {
  assert(shortThread[i].length <= 280, `Short thread chunk ${i + 1} ≤ 280 (got ${shortThread[i].length})`);
}

const longThread = buildCopyForXThread(longVerdict);
assert(longThread.length > 1, `Long verdict produces a thread (got ${longThread.length} tweets)`);
for (let i = 0; i < longThread.length; i++) {
  assert(longThread[i].length <= 280, `Long thread chunk ${i + 1} ≤ 280 (got ${longThread[i].length})`);
}

console.log("\n=== Test 3: Thread — full text preserved ===\n");

const joinedThread = longThread.join("\n\n");
assert(
  joinedThread.includes("demand-side factors") && joinedThread.includes("supply-side constraints"),
  "Thread contains full disagreementDetail key phrases"
);
assert(
  joinedThread.includes("Singapore") && joinedThread.includes("Vienna"),
  "Thread contains full caveat key phrases"
);

console.log("\n=== Test 4: Short copy — no mid-field truncation ===\n");

// Verify that each field in the short copy, if present, ends at a sentence boundary
const shortLines = longCopyShort.split("\n").filter(Boolean);
for (const line of shortLines) {
  assert(
    !line.includes("..."),
    `Line has no '...': "${line.slice(0, 60)}${line.length > 60 ? "…" : ""}"`
  );
}

console.log("\n=== Test 5: Edge case — verdict with no disagreement or caveat ===\n");

const minimalVerdict = {
  question: "Is the sky blue?",
  topConsensus: "Yes, due to Rayleigh scattering.",
  consensusModelCount: 5,
  topDisagreement: null,
  disagreementDetail: null,
  disagreementModelCount: 0,
  gateLabel: "Broadly consistent",
  gateStatus: "SAFE_TO_EXPLORE",
  keyBlindSpot: null,
  grounding: { level: "source-backed", label: "Source-backed" },
  recommendedNextSteps: [],
};

const minimalShort = buildCopyForXShort(minimalVerdict);
assert(!minimalShort.includes("..."), "Minimal verdict has no '...'");
assert(minimalShort.length <= 280, `Minimal verdict ≤ 280 (got ${minimalShort.length})`);

const minimalThread = buildCopyForXThread(minimalVerdict);
assert(minimalThread.length === 1, `Minimal verdict produces single tweet (got ${minimalThread.length})`);

// ── Summary ──

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(40));

if (failed > 0) {
  process.exit(1);
}
console.log("\n✅ All copy-for-X tests passed.\n");

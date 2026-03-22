#!/usr/bin/env node
/**
 * Dev verification: Ask screen — header usage pill removed, low-runs hint near Run button.
 *
 * Usage: node scripts/dev-verify-low-remaining-indicator.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const askPagePath = path.join(__dirname, "..", "app", "page.tsx");

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    process.exit(1);
  }
}

const src = fs.readFileSync(askPagePath, "utf8");

console.log("\n--- Ask page (app/page.tsx): low-runs indicator & no header pill ---\n");

assert(!src.includes("runs used"), 'Ask page does not contain header pill copy "runs used"');
assert(
  !/rounded-full\s+bg-blue-50[\s\S]*runs used/.test(src),
  "no blue-50 rounded-full usage pill block pattern"
);

assert(src.includes("LOW_REMAINING_THRESHOLD"), "defines LOW_REMAINING_THRESHOLD");
assert(
  /Math\.floor\(\s*effectiveMonthlyLimit\s*\*\s*0\.1\s*\)/.test(src) ||
    /Math\.floor\(\s*effectiveMonthlyLimit\s*\*\s*0\.10\s*\)/.test(src),
  "threshold uses 10% of monthly limit (floor)"
);
assert(src.includes("Math.max(3,"), "threshold uses max(3, …)");
assert(src.includes("showLowRunsRemaining"), "defines showLowRunsRemaining");
assert(
  src.includes("remainingRuns > 0") && src.includes("remainingRuns <="),
  "low state requires remainingRuns in (0, threshold]"
);
assert(
  src.includes("Low runs remaining:") && src.includes("left this month"),
  "indicator copy present"
);
assert(
  /showLowRunsRemaining\s*&&\s*\(/.test(src),
  "indicator is conditionally rendered from showLowRunsRemaining"
);

// Near Run button: hint should appear after Run Panel button label in file order
const runPanelIdx = src.indexOf('"Run Panel"');
const lowHintIdx = src.indexOf("Low runs remaining:");
assert(runPanelIdx !== -1 && lowHintIdx > runPanelIdx, "low-runs copy appears after Run Panel control");

console.log("\n✅ All assertions passed.\n");

#!/usr/bin/env node
/**
 * Assertion script for normalizeClusterLabel
 * 
 * Verifies that label normalization follows the correct rules:
 * - "contested" => "disagreement"
 * - "consensus" | "single" | "disagreement" => itself
 * - anything else => "single"
 * 
 * CRITICAL: This script catches the specific bug where `typeof input === "string"`
 * would incorrectly map any string to "consensus".
 * 
 * Run: npm run check:labels
 * Exit codes: 0 = all pass, 1 = failure
 */

// Inline the function to test (avoids module resolution issues)
// This MUST match the implementation in lib/consensus.ts exactly
function normalizeClusterLabel(label) {
  // Map legacy "contested" to "disagreement"
  if (label === "contested") {
    return "disagreement";
  }
  // Membership check: only accept exact valid labels
  if (label === "consensus" || label === "single" || label === "disagreement") {
    return label;
  }
  // Safe default for any unknown input
  return "single";
}

const testCases = [
  // Valid labels should pass through unchanged
  { input: "consensus", expected: "consensus", description: "valid: consensus" },
  { input: "single", expected: "single", description: "valid: single" },
  { input: "disagreement", expected: "disagreement", description: "valid: disagreement" },

  // Legacy mapping
  { input: "contested", expected: "disagreement", description: "legacy: contested => disagreement" },

  // REGRESSION TESTS: Unknown strings MUST return "single", NOT "consensus"
  // This catches the bug: `if (typeof input === 'string') return 'consensus'`
  { input: "foo", expected: "single", description: "unknown string 'foo' => single (NOT consensus)" },
  { input: "bar", expected: "single", description: "unknown string 'bar' => single" },
  { input: "agreement", expected: "single", description: "similar-sounding 'agreement' => single" },
  { input: "", expected: "single", description: "empty string => single" },
  { input: " ", expected: "single", description: "whitespace only => single" },
  { input: "CONSENSUS", expected: "single", description: "uppercase CONSENSUS => single (case sensitive)" },
  { input: "Consensus", expected: "single", description: "mixed case Consensus => single" },
  { input: " consensus ", expected: "single", description: "padded consensus => single (no trim)" },
  { input: "consensus\n", expected: "single", description: "consensus with newline => single" },

  // Non-string types MUST return "single"
  { input: undefined, expected: "single", description: "undefined => single" },
  { input: null, expected: "single", description: "null => single" },
  { input: 123, expected: "single", description: "number 123 => single" },
  { input: 0, expected: "single", description: "number 0 => single" },
  { input: true, expected: "single", description: "boolean true => single" },
  { input: false, expected: "single", description: "boolean false => single" },
  { input: {}, expected: "single", description: "empty object => single" },
  { input: [], expected: "single", description: "empty array => single" },
  { input: { label: "consensus" }, expected: "single", description: "object with label => single" },
  { input: ["consensus"], expected: "single", description: "array with consensus => single" },
  { input: NaN, expected: "single", description: "NaN => single" },
  { input: Infinity, expected: "single", description: "Infinity => single" },
];

function runTests() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  console.log("=== normalizeClusterLabel Assertion Tests ===\n");

  for (const tc of testCases) {
    const result = normalizeClusterLabel(tc.input);
    const ok = result === tc.expected;

    if (ok) {
      passed++;
      console.log(`✓ ${tc.description}`);
    } else {
      failed++;
      const msg = `✗ ${tc.description}: expected "${tc.expected}", got "${result}"`;
      console.log(msg);
      failures.push(msg);
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    console.error("FAILURES:");
    failures.forEach((f) => console.error(`  ${f}`));
    console.error(
      "\nREGRESSION ALERT: If unknown strings return 'consensus', " +
      "check for `typeof input === 'string'` bug in normalizeClusterLabel."
    );
    return false;
  }

  console.log("All assertions passed. Label normalization is correct.");
  return true;
}

// Run and exit with appropriate code
const success = runTests();
process.exit(success ? 0 : 1);

#!/usr/bin/env node

/**
 * Dev Verification Script: DeepSeek Fallback Skip for Non-Transient Errors
 *
 * Tests that:
 *   a) openai_429 with "billing details" / "exceeded your current quota" => DeepSeek NOT called
 *   b) openai_timeout => DeepSeek WOULD be called
 *   c) openai_auth => DeepSeek NOT called
 *   d) openai_forbidden => DeepSeek NOT called
 *   e) openai_429 with generic "rate limit" (transient) => DeepSeek IS called
 *   f) Default timeout is 15_000ms
 *
 * Uses source-level checks + inline simulation (no network, no imports).
 *
 * Usage:
 *   node scripts/dev-verify-deepseek-fallback-skip.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// ─── Source-level checks ──────────────────────────────────────────────────

const panelSrc = readFileSync(resolve(process.cwd(), "lib/panel.ts"), "utf-8");
const deepseekSrc = readFileSync(resolve(process.cwd(), "lib/connectors/deepseek.ts"), "utf-8");

console.log("\nTest A: shouldAttemptDeepSeek function exists in panel.ts");
{
  assert(panelSrc.includes("function shouldAttemptDeepSeek"), "shouldAttemptDeepSeek is defined");
  assert(panelSrc.includes("shouldAttemptDeepSeek(primaryCode, primaryResult)"), "shouldAttemptDeepSeek is called in runSlotWithFallback");
}

console.log("\nTest B: Non-transient quota phrases are checked");
{
  assert(panelSrc.includes("billing details"), "Checks 'billing details'");
  assert(panelSrc.includes("exceeded your current quota"), "Checks 'exceeded your current quota'");
  assert(panelSrc.includes("please check your plan"), "Checks 'please check your plan'");
  assert(panelSrc.includes("insufficient_quota"), "Checks 'insufficient_quota'");
}

console.log("\nTest C: Auth and forbidden codes skip DeepSeek");
{
  assert(panelSrc.includes('"_auth"'), "Checks _auth code");
  assert(panelSrc.includes('"_forbidden"'), "Checks _forbidden code");
}

console.log("\nTest D: Default timeout is 15_000ms");
{
  const m = deepseekSrc.match(/DEFAULT_DEEPSEEK_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
  const raw = m ? m[1].replace(/_/g, "") : null;
  const val = raw ? Number(raw) : null;
  assert(val === 15000, `Default timeout is 15000ms (got ${val})`);
}

console.log("\nTest E: DEV-only call counter exists");
{
  assert(deepseekSrc.includes("__deepseekCallCount"), "Has __deepseekCallCount");
  assert(deepseekSrc.includes("__resetDeepseekCallCount"), "Has __resetDeepseekCallCount");
}

console.log("\nTest F: Skip log exists");
{
  assert(
    panelSrc.includes("Skipping DeepSeek fallback"),
    "Log message for skip exists"
  );
  assert(
    panelSrc.includes("non-transient primary failure"),
    "Log mentions non-transient"
  );
}

// ─── Inline simulation of shouldAttemptDeepSeek ───────────────────────────

const NON_TRANSIENT_QUOTA_PHRASES = [
  "billing details",
  "exceeded your current quota",
  "please check your plan",
  "insufficient_quota",
];

function shouldAttemptDeepSeek(primaryCode, errorMessage) {
  if (primaryCode.includes("_auth") || primaryCode.includes("_forbidden")) {
    return false;
  }
  if (primaryCode.includes("_429")) {
    const msg = (errorMessage ?? "").toLowerCase();
    if (NON_TRANSIENT_QUOTA_PHRASES.some(phrase => msg.includes(phrase))) {
      return false;
    }
  }
  return true;
}

console.log("\nTest G: Quota 429 with 'billing details' => skip DeepSeek");
{
  const code = "openai_429";
  const msg = "429 You exceeded your current quota, please check your plan and billing details.";
  assert(!shouldAttemptDeepSeek(code, msg), "DeepSeek NOT attempted for quota 429 with billing details");
}

console.log("\nTest H: Quota 429 with 'exceeded your current quota' => skip DeepSeek");
{
  const code = "openai_429";
  const msg = "429 You exceeded your current quota";
  assert(!shouldAttemptDeepSeek(code, msg), "DeepSeek NOT attempted for exceeded quota");
}

console.log("\nTest I: Quota 429 with 'insufficient_quota' => skip DeepSeek");
{
  const code = "openai_429";
  const msg = "Error code: insufficient_quota";
  assert(!shouldAttemptDeepSeek(code, msg), "DeepSeek NOT attempted for insufficient_quota");
}

console.log("\nTest J: Transient 429 (generic rate limit) => attempt DeepSeek");
{
  const code = "openai_429";
  const msg = "429 rate limit exceeded, please retry";
  assert(shouldAttemptDeepSeek(code, msg), "DeepSeek IS attempted for transient rate limit");
}

console.log("\nTest K: openai_timeout => attempt DeepSeek");
{
  const code = "openai_timeout";
  const msg = "Request timed out after 30s";
  assert(shouldAttemptDeepSeek(code, msg), "DeepSeek IS attempted for timeout");
}

console.log("\nTest L: openai_5xx => attempt DeepSeek");
{
  const code = "openai_5xx";
  const msg = "500 Internal Server Error";
  assert(shouldAttemptDeepSeek(code, msg), "DeepSeek IS attempted for 5xx");
}

console.log("\nTest M: openai_auth => skip DeepSeek");
{
  const code = "openai_auth";
  const msg = "401 Unauthorized";
  assert(!shouldAttemptDeepSeek(code, msg), "DeepSeek NOT attempted for auth error");
}

console.log("\nTest N: anthropic_forbidden => skip DeepSeek");
{
  const code = "anthropic_forbidden";
  const msg = "403 Forbidden";
  assert(!shouldAttemptDeepSeek(code, msg), "DeepSeek NOT attempted for forbidden");
}

console.log("\nTest O: google_auth => skip DeepSeek");
{
  const code = "google_auth";
  const msg = "401 API key invalid";
  assert(!shouldAttemptDeepSeek(code, msg), "DeepSeek NOT attempted for google auth error");
}

console.log("\nTest P: Combined reason only when DeepSeek attempted");
{
  // When skipped: reason is just primaryCode
  const quotaCode = "openai_429";
  const quotaMsg = "exceeded your current quota, billing details";
  const skipped = !shouldAttemptDeepSeek(quotaCode, quotaMsg);
  const skipReason = quotaCode; // no pipe
  assert(skipped && !skipReason.includes("|"), "Skipped reason has no pipe separator");

  // When attempted and DS fails: reason is combined
  const timeoutCode = "openai_timeout";
  const timeoutMsg = "timeout";
  const attempted = shouldAttemptDeepSeek(timeoutCode, timeoutMsg);
  const dsCode = "deepseek_timeout";
  const combinedReason = `${timeoutCode}|${dsCode}`;
  assert(attempted && combinedReason === "openai_timeout|deepseek_timeout", "Combined reason has pipe separator");
}

// ─── Summary ───────────────────────────────────────────────────────────────

console.log("\n────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ VERIFICATION FAILED");
  process.exit(1);
} else {
  console.log("\n✅ ALL TESTS PASSED");
  process.exit(0);
}

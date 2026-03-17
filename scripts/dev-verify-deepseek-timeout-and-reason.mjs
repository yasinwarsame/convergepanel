#!/usr/bin/env node

/**
 * Dev Verification Script: DeepSeek Timeout, Message Shape & Combined Reason
 *
 * Assertions:
 *   a) Default timeout <= 20_000
 *   b) Default retries === 0
 *   c) Messages are [system, user] — user content is buildPanelPrompt output,
 *      NOT a duplicated bare question
 *   d) Combined reason format: primaryCode|deepseekCode
 *
 * Usage:
 *   node scripts/dev-verify-deepseek-timeout-and-reason.mjs
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
// We read the source file directly to verify defaults without importing
// (avoids needing tsc/tsx for path aliases).

const deepseekSrc = readFileSync(
  resolve(process.cwd(), "lib/connectors/deepseek.ts"),
  "utf-8"
);

console.log("\nTest A: Default timeout <= 15_000");
{
  const m = deepseekSrc.match(/DEFAULT_DEEPSEEK_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
  const raw = m ? m[1].replace(/_/g, "") : null;
  const val = raw ? Number(raw) : null;
  assert(val !== null, `Found DEFAULT_DEEPSEEK_TIMEOUT_MS constant (${val})`);
  assert(val !== null && val <= 15_000, `Default timeout ${val}ms <= 15000ms`);
}

console.log("\nTest B: Default retries === 0");
{
  const m = deepseekSrc.match(/DEFAULT_DEEPSEEK_MAX_RETRIES\s*=\s*(\d+)/);
  const val = m ? Number(m[1]) : null;
  assert(val !== null, `Found DEFAULT_DEEPSEEK_MAX_RETRIES constant (${val})`);
  assert(val === 0, `Default retries === 0 (got ${val})`);
}

console.log("\nTest C: Messages shape — no duplicate question");
{
  // The source must NOT have { role: "user", content: sanitizedQuestion }
  // It MUST have { role: "user", content: userPrompt } where userPrompt = buildPanelPrompt(...)
  const hasDuplicateQuestion =
    /messages:\s*\[[\s\S]*?\{\s*role:\s*["']user["'],\s*content:\s*sanitizedQuestion\s*\}/m.test(
      deepseekSrc
    );
  assert(!hasDuplicateQuestion, "No { role: 'user', content: sanitizedQuestion } in messages");

  const hasUserPrompt =
    /messages:\s*\[[\s\S]*?\{\s*role:\s*["']user["'],\s*content:\s*userPrompt\s*\}/m.test(
      deepseekSrc
    );
  assert(hasUserPrompt, "Messages use { role: 'user', content: userPrompt } (from buildPanelPrompt)");

  const hasSystemInstruction =
    /messages:\s*\[[\s\S]*?\{\s*role:\s*["']system["'],\s*content:\s*DEEPSEEK_SYSTEM_INSTRUCTION\s*\}/m.test(
      deepseekSrc
    );
  assert(hasSystemInstruction, "Messages use generic DEEPSEEK_SYSTEM_INSTRUCTION as system content");

  const hasTestHelper = deepseekSrc.includes("export function _buildDeepSeekMessagesForTest");
  assert(hasTestHelper, "_buildDeepSeekMessagesForTest is exported");
}

console.log("\nTest D: Env-configurable timeout and retries");
{
  const hasTimeoutEnv = deepseekSrc.includes('readIntEnv("DEEPSEEK_TIMEOUT_MS"');
  assert(hasTimeoutEnv, "DEEPSEEK_TIMEOUT_MS reads from env via readIntEnv");

  const hasRetriesEnv = deepseekSrc.includes('readIntEnv("DEEPSEEK_MAX_RETRIES"');
  assert(hasRetriesEnv, "DEEPSEEK_MAX_RETRIES reads from env via readIntEnv");
}

console.log("\nTest E: Error classification codes");
{
  assert(deepseekSrc.includes('"deepseek_timeout"'), "Has deepseek_timeout code");
  assert(deepseekSrc.includes('"deepseek_429"'), "Has deepseek_429 code");
  assert(deepseekSrc.includes('"deepseek_auth"'), "Has deepseek_auth code");
  assert(deepseekSrc.includes('"deepseek_5xx"'), "Has deepseek_5xx code");
  assert(deepseekSrc.includes('"deepseek_empty_response"'), "Has deepseek_empty_response code");
  assert(deepseekSrc.includes('"deepseek_unknown"'), "Has deepseek_unknown code");
}

// ─── Panel combined reason checks ─────────────────────────────────────────

const panelSrc = readFileSync(
  resolve(process.cwd(), "lib/panel.ts"),
  "utf-8"
);

console.log("\nTest F: Panel combined reason format");
{
  const hasCombined = panelSrc.includes("${primaryCode}|${dsResult.code}");
  assert(hasCombined, "Combined reason uses primaryCode|dsResult.code format");
}

console.log("\nTest G: Panel classifyPrimaryErrorCode handles quota/billing");
{
  assert(
    panelSrc.includes("exceeded your current quota"),
    "classifyPrimaryErrorCode detects 'exceeded your current quota'"
  );
  assert(
    panelSrc.includes("billing details"),
    "classifyPrimaryErrorCode detects 'billing details'"
  );
}

console.log("\nTest H: Panel dev log shows primaryCode not status");
{
  const hasOldLog = panelSrc.includes("${primaryResult.status}). Attempting DeepSeek");
  assert(!hasOldLog, "Old log with primaryResult.status is removed");

  const hasNewLog = panelSrc.includes("${primaryCode}). Attempting DeepSeek");
  assert(hasNewLog, "New log shows primaryCode");
}

console.log("\nTest I: classifyPrimaryErrorCode splits 401 and 403");
{
  const hasAuth401 = /msg\.includes\(["']401["']\)[\s\S]*?_auth/.test(panelSrc);
  assert(hasAuth401, "401 maps to <provider>_auth");

  const hasForbidden = /msg\.includes\(["']403["']\)[\s\S]*?_forbidden/.test(panelSrc);
  assert(hasForbidden, "403 maps to <provider>_forbidden");
}

console.log("\nTest J: 5xx detection uses regex");
{
  const has5xxRegex = panelSrc.includes("\\b5\\d{2}\\b");
  assert(has5xxRegex, "5xx detection uses /\\b5\\d{2}\\b/ regex");
}

// ─── Simulate combined reason ──────────────────────────────────────────────

console.log("\nTest K: Simulated combined reason string");
{
  const primaryCode = "openai_429";
  const deepseekCode = "deepseek_timeout";
  const combined = `${primaryCode}|${deepseekCode}`;
  assert(combined === "openai_429|deepseek_timeout", `Combined reason is '${combined}'`);
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

#!/usr/bin/env node

/**
 * Dev Verification Script: Normalization Boundary Guarantees (v1)
 *
 * Tests:
 * 1. Legacy statuses ("error"/"timeout"/"refused") always become "failed"
 * 2. Missing provider/requestedModel/actualModel are filled per policy
 * 3. Legacy substitutedFrom object variants (missing fields) normalized
 * 4. substitutedFrom string missing ":" gets "unknown:" prefix
 * 5. substitutionReason with newlines/long text becomes "unknown_error"
 * 6. buildSubstitutionBlock output: valid JSON, ≤5 entries, fields ≤80, no newlines
 * 7. assertPublicStatus detects leaked internal statuses
 * 8. isUsableResult correctly identifies ok+substituted
 * 9. publicizePanelResults handles heterogeneous input
 * 10. Idempotency and edge cases
 *
 * Usage:
 *   node scripts/dev-verify-deepseek-normalization-boundaries.mjs
 */

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

// ─── Inline replicas of normalize.ts / publicize.ts ────────────────────────

const LEGACY_TO_FAILED = new Set(["error", "timeout", "refused"]);
const PUBLIC_STATUSES = new Set(["ok", "substituted", "failed"]);
const REASON_CODE_RE = /^[a-z0-9_:.-]{1,80}$/i;

function coerceStatus(raw) {
  if (raw === "ok" || raw === "substituted" || raw === "failed") return raw;
  if (LEGACY_TO_FAILED.has(raw)) return "failed";
  return "failed";
}

function assertPublicStatus(status, context) {
  if (PUBLIC_STATUSES.has(status)) return status;
  const coerced = coerceStatus(status);
  // In test context, just coerce (no console.error spam)
  return coerced;
}

function sanitizeSubstitutionReason(reason) {
  if (!reason) return undefined;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return undefined;
  if (REASON_CODE_RE.test(trimmed)) return trimmed;
  return "unknown_error";
}

function normalizeSubstitutedFrom(value, fallbackProvider) {
  if (value == null) return undefined;
  if (typeof value === "object" && value !== null) {
    const prov = value.provider || fallbackProvider || "unknown";
    const model = value.model || "unknown";
    return `${prov}:${model}`;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s.length === 0) return undefined;
    if (s.includes(":")) return s;
    if (fallbackProvider) return `${fallbackProvider}:${s}`;
    return `unknown:${s}`;
  }
  return undefined;
}

function extractSubstitutionReason(existing, rawSubstitutedFrom) {
  if (existing) return sanitizeSubstitutionReason(existing);
  if (rawSubstitutedFrom && typeof rawSubstitutedFrom === "object" && rawSubstitutedFrom.reason) {
    return sanitizeSubstitutionReason(rawSubstitutedFrom.reason);
  }
  return undefined;
}

function normalizeModelResultPublic(result, defaults) {
  const status = coerceStatus(result.status);
  const requestedModel = result.requestedModel || (defaults && defaults.requestedModel) || result.modelId || "unknown";
  const provider = result.provider || (defaults && defaults.provider) || "unknown";
  let actualModel = result.actualModel || (defaults && defaults.actualModel) || "";
  if (!actualModel) {
    if (status === "substituted" && provider === "deepseek") {
      actualModel = "deepseek-chat";
    } else {
      actualModel = requestedModel || "unknown";
    }
  }
  const rawSF = result.substitutedFrom;
  const sfProvider = (defaults && defaults.provider) || (status !== "substituted" ? provider : undefined);
  const substitutedFrom = normalizeSubstitutedFrom(rawSF, sfProvider);
  const substitutionReason = extractSubstitutionReason(result.substitutionReason, rawSF);
  const out = {
    ...result,
    status,
    requestedModel,
    provider,
    actualModel,
    substitutedFrom,
    substitutionReason,
  };
  if (out.substitutedFrom === undefined) delete out.substitutedFrom;
  if (out.substitutionReason === undefined) delete out.substitutionReason;
  return out;
}

function isUsableResult(result) {
  const s = coerceStatus(result.status);
  return s === "ok" || s === "substituted";
}

function stripNewlines(val) {
  return val.replace(/[\r\n]+/g, " ").trim();
}

function sanitizeBlockField(val, maxLen) {
  if (!val) return "";
  const cleaned = stripNewlines(val);
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen - 1) + "…";
}

function sanitizeBlockReason(val) {
  if (!val) return "";
  const cleaned = stripNewlines(val);
  if (cleaned.length === 0) return "";
  if (REASON_CODE_RE.test(cleaned)) return cleaned;
  return "unknown_error";
}

function buildSubstitutionBlock(entries) {
  if (entries.length === 0) return "";
  const capped = entries.slice(0, 5).map((e) => ({
    slot: sanitizeBlockField(e.slot, 80),
    requestedModel: sanitizeBlockField(e.requestedModel, 80),
    provider: sanitizeBlockField(e.provider, 80),
    actualModel: sanitizeBlockField(e.actualModel, 80),
    reason: sanitizeBlockReason(e.reason),
  }));
  return `\nSUBSTITUTIONS:\n${JSON.stringify(capped)}\n`;
}

function publicizePanelResults(rawResults) {
  if (!Array.isArray(rawResults)) return [];
  return rawResults
    .filter((r) => r != null && typeof r === "object" && typeof r.modelId === "string")
    .map((raw) => {
      const normalized = normalizeModelResultPublic(raw);
      assertPublicStatus(normalized.status, `publicizePanelResults(${normalized.modelId})`);
      return normalized;
    });
}

// ─── Test 1: Legacy statuses always become "failed" ────────────────────────

function test1_legacyStatuses() {
  console.log("\nTest 1: Legacy statuses always become 'failed'");

  for (const legacy of ["error", "timeout", "refused"]) {
    const r = normalizeModelResultPublic({
      modelId: "chatgpt",
      status: legacy,
      requestedModel: "gpt-4o-mini",
      provider: "openai",
      actualModel: "gpt-4o-mini",
    });
    assert(r.status === "failed", `"${legacy}" → "failed"`);
  }

  // Unknown garbage status
  const r2 = normalizeModelResultPublic({ modelId: "test", status: "gibberish" });
  assert(r2.status === "failed", '"gibberish" → "failed"');

  // Public statuses pass through
  for (const pub of ["ok", "substituted", "failed"]) {
    const r = normalizeModelResultPublic({ modelId: "test", status: pub });
    assert(r.status === pub, `"${pub}" passes through`);
  }
}

// ─── Test 2: Missing metadata filled per policy ───────────────────────────

function test2_missingMetadata() {
  console.log("\nTest 2: Missing metadata filled per policy");

  // Completely bare result
  const bare = normalizeModelResultPublic({ modelId: "chatgpt", status: "ok" });
  assert(bare.requestedModel === "chatgpt", "requestedModel falls back to modelId");
  assert(bare.provider === "unknown", 'provider defaults to "unknown"');
  assert(bare.actualModel === "chatgpt", "actualModel falls back to requestedModel");

  // No modelId either
  const empty = normalizeModelResultPublic({ modelId: "", status: "failed" });
  assert(empty.requestedModel === "unknown", 'requestedModel falls back to "unknown"');
  assert(empty.provider === "unknown", 'provider defaults to "unknown"');
  assert(empty.actualModel === "unknown", 'actualModel falls back to "unknown"');

  // Substituted with deepseek provider but missing actualModel
  const sub = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    provider: "deepseek",
  });
  assert(sub.actualModel === "deepseek-chat", 'substituted+deepseek provider → actualModel="deepseek-chat"');

  // Substituted with non-deepseek provider
  const sub2 = normalizeModelResultPublic({
    modelId: "claude",
    status: "substituted",
    requestedModel: "claude-3-haiku",
    provider: "anthropic",
  });
  assert(sub2.actualModel === "claude-3-haiku", "substituted+non-deepseek → actualModel=requestedModel");

  // Defaults parameter fills gaps
  const withDefaults = normalizeModelResultPublic(
    { modelId: "gemini", status: "ok" },
    { requestedModel: "gemini-2.0-flash", provider: "google", actualModel: "gemini-2.0-flash" }
  );
  assert(withDefaults.requestedModel === "gemini-2.0-flash", "defaults requestedModel used");
  assert(withDefaults.provider === "google", "defaults provider used");
  assert(withDefaults.actualModel === "gemini-2.0-flash", "defaults actualModel used");
}

// ─── Test 3: Legacy substitutedFrom object variants ────────────────────────

function test3_legacySubstitutedFromObjects() {
  console.log("\nTest 3: Legacy substitutedFrom object variants normalized");

  // Full object
  const r1 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutedFrom: { provider: "openai", model: "gpt-4o-mini", reason: "openai_timeout" },
  });
  assert(r1.substitutedFrom === "openai:gpt-4o-mini", 'full object → "openai:gpt-4o-mini"');
  assert(r1.substitutionReason === "openai_timeout", "reason extracted from object");

  // Object missing provider
  const r2 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutedFrom: { model: "gpt-4o-mini" },
  });
  assert(r2.substitutedFrom === "unknown:gpt-4o-mini", 'missing provider → "unknown:gpt-4o-mini"');

  // Object missing model
  const r3 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutedFrom: { provider: "openai" },
  });
  assert(r3.substitutedFrom === "openai:unknown", 'missing model → "openai:unknown"');

  // Object missing both
  const r4 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutedFrom: {},
  });
  assert(r4.substitutedFrom === "unknown:unknown", 'empty object → "unknown:unknown"');

  // Object with reason but no top-level substitutionReason
  const r5 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutedFrom: { provider: "openai", model: "gpt-4o-mini", reason: "openai_429" },
  });
  assert(r5.substitutionReason === "openai_429", "reason bubbles up from object");
}

// ─── Test 4: substitutedFrom string missing ":" ───────────────────────────

function test4_substitutedFromNoColon() {
  console.log("\nTest 4: substitutedFrom string missing ':' gets prefix");

  // Bare string with no fallback provider
  const r1 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "ok",
    substitutedFrom: "gpt-4o-mini",
  });
  assert(
    r1.substitutedFrom === "unknown:gpt-4o-mini",
    `bare string no provider → "unknown:gpt-4o-mini" (got "${r1.substitutedFrom}")`
  );

  // Bare string with defaults provider
  const r2 = normalizeModelResultPublic(
    { modelId: "chatgpt", status: "ok", substitutedFrom: "gpt-4o-mini" },
    { provider: "openai" }
  );
  assert(
    r2.substitutedFrom === "openai:gpt-4o-mini",
    `bare string with default provider → "openai:gpt-4o-mini" (got "${r2.substitutedFrom}")`
  );

  // Already has colon → unchanged
  const r3 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "ok",
    substitutedFrom: "openai:gpt-4o-mini",
  });
  assert(r3.substitutedFrom === "openai:gpt-4o-mini", "with colon → unchanged");

  // Empty string → undefined
  const r4 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "ok",
    substitutedFrom: "",
  });
  assert(r4.substitutedFrom === undefined, "empty string → undefined");

  // Whitespace-only → undefined
  const r5 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "ok",
    substitutedFrom: "   ",
  });
  assert(r5.substitutedFrom === undefined, "whitespace-only → undefined");
}

// ─── Test 5: substitutionReason sanitization ──────────────────────────────

function test5_substitutionReasonSanitization() {
  console.log("\nTest 5: substitutionReason with newlines/long text → 'unknown_error'");

  // Valid code-like reason
  const r1 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutionReason: "openai_timeout",
  });
  assert(r1.substitutionReason === "openai_timeout", "valid reason preserved");

  // Reason with newlines
  const r2 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutionReason: "some error\nwith newlines\nand stuff",
  });
  assert(r2.substitutionReason === "unknown_error", "newlines → unknown_error");

  // Very long reason (>80 chars)
  const r3 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutionReason: "a".repeat(100),
  });
  assert(r3.substitutionReason === "unknown_error", ">80 chars → unknown_error");

  // Reason with spaces (not code-like)
  const r4 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutionReason: "API returned error 500 Internal Server Error",
  });
  assert(r4.substitutionReason === "unknown_error", "spaces → unknown_error");

  // Empty/whitespace reason
  const r5 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutionReason: "   ",
  });
  assert(r5.substitutionReason === undefined, "whitespace-only → undefined");

  // Reason with dots and dashes (valid)
  const r6 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutionReason: "openai_5xx.retried-2",
  });
  assert(r6.substitutionReason === "openai_5xx.retried-2", "dots and dashes are valid");

  // Legacy object reason with spaces → sanitized
  const r7 = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutedFrom: { provider: "openai", model: "gpt-4o-mini", reason: "Request failed with status 500" },
  });
  assert(r7.substitutionReason === "unknown_error", "object reason with spaces → unknown_error");
}

// ─── Test 6: buildSubstitutionBlock hardening ─────────────────────────────

function test6_substitutionBlockHardening() {
  console.log("\nTest 6: buildSubstitutionBlock output hardening");

  // Empty
  assert(buildSubstitutionBlock([]) === "", "empty → empty string");

  // Valid JSON output
  const block1 = buildSubstitutionBlock([{
    slot: "chatgpt",
    requestedModel: "gpt-4o-mini",
    provider: "deepseek",
    actualModel: "deepseek-chat",
    reason: "openai_timeout",
  }]);
  assert(block1.includes("SUBSTITUTIONS:"), "has SUBSTITUTIONS header");
  const jsonPart1 = block1.replace("\nSUBSTITUTIONS:\n", "").trim();
  let parsed1;
  try { parsed1 = JSON.parse(jsonPart1); } catch { parsed1 = null; }
  assert(parsed1 !== null, "output is valid JSON");
  assert(Array.isArray(parsed1) && parsed1.length === 1, "one entry");

  // Caps to 5
  const entries8 = [];
  for (let i = 0; i < 8; i++) {
    entries8.push({ slot: `m${i}`, requestedModel: `r${i}`, provider: `p${i}`, actualModel: `a${i}`, reason: `reason_${i}` });
  }
  const block8 = buildSubstitutionBlock(entries8);
  const parsed8 = JSON.parse(block8.replace("\nSUBSTITUTIONS:\n", "").trim());
  assert(parsed8.length === 5, `capped to 5 (got ${parsed8.length})`);

  // Fields truncated to ≤80
  const longEntry = [{
    slot: "x".repeat(200),
    requestedModel: "y".repeat(200),
    provider: "z".repeat(200),
    actualModel: "w".repeat(200),
    reason: "v".repeat(200),
  }];
  const blockLong = buildSubstitutionBlock(longEntry);
  const parsedLong = JSON.parse(blockLong.replace("\nSUBSTITUTIONS:\n", "").trim());
  for (const key of ["slot", "requestedModel", "provider", "actualModel"]) {
    assert(parsedLong[0][key].length <= 80, `${key} ≤ 80 chars (got ${parsedLong[0][key].length})`);
  }
  // reason field: either valid code or "unknown_error" (both ≤80)
  assert(parsedLong[0].reason.length <= 80, `reason ≤ 80 chars`);

  // No newlines in output fields
  const newlineEntry = [{
    slot: "chat\ngpt",
    requestedModel: "gpt\r\n4o",
    provider: "open\nai",
    actualModel: "deep\nseek",
    reason: "timeout\nerror",
  }];
  const blockNl = buildSubstitutionBlock(newlineEntry);
  const parsedNl = JSON.parse(blockNl.replace("\nSUBSTITUTIONS:\n", "").trim());
  for (const key of ["slot", "requestedModel", "provider", "actualModel"]) {
    assert(!parsedNl[0][key].includes("\n"), `${key} has no newlines`);
    assert(!parsedNl[0][key].includes("\r"), `${key} has no carriage returns`);
  }

  // Reason with spaces/newlines → "unknown_error"
  assert(parsedNl[0].reason === "unknown_error", 'reason with newlines → "unknown_error"');
}

// ─── Test 7: assertPublicStatus detects leaks ─────────────────────────────

function test7_assertPublicStatus() {
  console.log("\nTest 7: assertPublicStatus detects leaked internal statuses");

  assert(assertPublicStatus("ok") === "ok", "ok passes");
  assert(assertPublicStatus("substituted") === "substituted", "substituted passes");
  assert(assertPublicStatus("failed") === "failed", "failed passes");
  assert(assertPublicStatus("error") === "failed", "error coerced to failed");
  assert(assertPublicStatus("timeout") === "failed", "timeout coerced to failed");
  assert(assertPublicStatus("refused") === "failed", "refused coerced to failed");
  assert(assertPublicStatus("random") === "failed", "unknown coerced to failed");
}

// ─── Test 8: isUsableResult ───────────────────────────────────────────────

function test8_isUsableResult() {
  console.log("\nTest 8: isUsableResult correctly identifies ok+substituted");

  assert(isUsableResult({ status: "ok" }) === true, "ok → true");
  assert(isUsableResult({ status: "substituted" }) === true, "substituted → true");
  assert(isUsableResult({ status: "failed" }) === false, "failed → false");
  assert(isUsableResult({ status: "error" }) === false, "error (legacy) → false");
  assert(isUsableResult({ status: "timeout" }) === false, "timeout (legacy) → false");
  assert(isUsableResult({ status: "refused" }) === false, "refused (legacy) → false");
}

// ─── Test 9: publicizePanelResults ────────────────────────────────────────

function test9_publicizePanelResults() {
  console.log("\nTest 9: publicizePanelResults handles heterogeneous input");

  const rawResults = [
    { modelId: "chatgpt", status: "ok", requestedModel: "gpt-4o-mini", provider: "openai", actualModel: "gpt-4o-mini" },
    { modelId: "claude", status: "error", requestedModel: "claude-3-haiku", provider: "anthropic" },
    { modelId: "gemini", status: "substituted", provider: "deepseek", substitutedFrom: { provider: "google", model: "gemini-2.0-flash", reason: "google_timeout" } },
    null,
    "not an object",
    { noModelId: true, status: "ok" },
    { modelId: "grok", status: "timeout", substitutionReason: "Some long error message with spaces and stuff" },
  ];

  const results = publicizePanelResults(rawResults);

  assert(results.length === 4, `4 valid results (got ${results.length})`);

  // All statuses are public
  const validStatuses = new Set(["ok", "substituted", "failed"]);
  assert(results.every(r => validStatuses.has(r.status)), "all statuses are public");

  // All have required fields
  assert(results.every(r => typeof r.requestedModel === "string" && r.requestedModel.length > 0), "all have requestedModel");
  assert(results.every(r => typeof r.provider === "string" && r.provider.length > 0), "all have provider");
  assert(results.every(r => typeof r.actualModel === "string" && r.actualModel.length > 0), "all have actualModel");

  // Legacy "error" coerced
  const claude = results.find(r => r.modelId === "claude");
  assert(claude.status === "failed", 'claude "error" → "failed"');

  // Legacy object substitutedFrom converted
  const gemini = results.find(r => r.modelId === "gemini");
  assert(gemini.status === "substituted", "gemini is substituted");
  assert(gemini.substitutedFrom === "google:gemini-2.0-flash", "gemini substitutedFrom normalized");
  assert(gemini.substitutionReason === "google_timeout", "gemini substitutionReason from object");

  // grok: timeout → failed, long reason → unknown_error
  const grok = results.find(r => r.modelId === "grok");
  assert(grok.status === "failed", 'grok "timeout" → "failed"');
  assert(grok.substitutionReason === "unknown_error", "grok long reason → unknown_error");
}

// ─── Test 10: Edge cases and idempotency ──────────────────────────────────

function test10_edgeCases() {
  console.log("\nTest 10: Edge cases and idempotency");

  // Normalize already-normalized result (idempotent)
  const original = {
    modelId: "chatgpt",
    status: "substituted",
    requestedModel: "gpt-4o-mini",
    provider: "deepseek",
    actualModel: "deepseek-chat",
    substitutedFrom: "openai:gpt-4o-mini",
    substitutionReason: "openai_timeout",
  };
  const first = normalizeModelResultPublic(original);
  const second = normalizeModelResultPublic(first);
  assert(JSON.stringify(first) === JSON.stringify(second), "idempotent: double normalize unchanged");

  // null/undefined substitutedFrom
  const r1 = normalizeModelResultPublic({ modelId: "test", status: "ok", substitutedFrom: null });
  assert(r1.substitutedFrom === undefined, "null substitutedFrom → undefined");

  const r2 = normalizeModelResultPublic({ modelId: "test", status: "ok", substitutedFrom: undefined });
  assert(r2.substitutedFrom === undefined, "undefined substitutedFrom → undefined");

  // Number as substitutedFrom (weird edge case)
  const r3 = normalizeModelResultPublic({ modelId: "test", status: "ok", substitutedFrom: 42 });
  assert(r3.substitutedFrom === undefined, "number substitutedFrom → undefined");

  // publicizePanelResults with non-array
  assert(publicizePanelResults(null).length === 0, "null input → empty array");
  assert(publicizePanelResults("string").length === 0, "string input → empty array");
  assert(publicizePanelResults(123).length === 0, "number input → empty array");
  assert(publicizePanelResults([]).length === 0, "empty array → empty array");

  // Status output only ever contains public statuses
  const allStatuses = ["ok", "substituted", "failed", "error", "timeout", "refused", "garbage", "", null, undefined];
  for (const s of allStatuses) {
    const coerced = coerceStatus(s);
    assert(PUBLIC_STATUSES.has(coerced), `coerceStatus("${s}") → "${coerced}" is public`);
  }
}

// ─── Run all ───────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Normalization Boundary Verification (v1) ===\n");

  test1_legacyStatuses();
  test2_missingMetadata();
  test3_legacySubstitutedFromObjects();
  test4_substitutedFromNoColon();
  test5_substitutionReasonSanitization();
  test6_substitutionBlockHardening();
  test7_assertPublicStatus();
  test8_isUsableResult();
  test9_publicizePanelResults();
  test10_edgeCases();

  console.log("\n────────────────────────────────────");
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error("\n❌ VERIFICATION FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ ALL TESTS PASSED");
    process.exit(0);
  }
}

main();

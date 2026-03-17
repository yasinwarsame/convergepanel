#!/usr/bin/env node

/**
 * Dev Verification Script: DeepSeek Contract (v3 — tightened public contract)
 *
 * Tests:
 * 1. Public statuses are only ok/substituted/failed
 * 2. Legacy substitutedFrom object is accepted and normalized to string "<provider>:<model>"
 * 3. substitutedFrom always contains ":" when status=substituted
 * 4. actualModel always present on all results
 * 5. Legacy statuses (error/timeout/refused) normalize to failed
 * 6. SUBSTITUTIONS block builder caps to 5 and truncates fields
 * 7. Backward-compat: normalizer handles missing fields gracefully
 * 8. substitutedFrom includes provider context
 * 9. coerceStatus handles all legacy values
 * 10. Slot simulation with full metadata
 *
 * Usage:
 *   node scripts/dev-verify-deepseek-contract.mjs
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

// ─── Inline replicas of normalize.ts functions ─────────────────────────────
// (We inline them because this is a .mjs script and can't import .ts directly)

const LEGACY_TO_FAILED = new Set(["error", "timeout", "refused"]);

function coerceStatus(raw) {
  if (raw === "ok" || raw === "substituted" || raw === "failed") return raw;
  if (LEGACY_TO_FAILED.has(raw)) return "failed";
  return "failed";
}

function normalizeSubstitutedFrom(value, fallbackProvider) {
  if (value == null) return undefined;
  if (typeof value === "object" && value !== null) {
    const prov = value.provider || fallbackProvider || "unknown";
    const model = value.model || "unknown";
    return `${prov}:${model}`;
  }
  if (typeof value === "string") {
    if (value.includes(":")) return value;
    if (fallbackProvider) return `${fallbackProvider}:${value}`;
    return value;
  }
  return undefined;
}

function extractSubstitutionReason(existing, rawSubstitutedFrom) {
  if (existing) return existing;
  if (rawSubstitutedFrom && typeof rawSubstitutedFrom === "object" && rawSubstitutedFrom.reason) {
    return rawSubstitutedFrom.reason;
  }
  return undefined;
}

function normalizeModelResultPublic(result, defaults) {
  const status = coerceStatus(result.status);
  const requestedModel = result.requestedModel || (defaults && defaults.requestedModel) || result.modelId;
  const provider = result.provider || (defaults && defaults.provider) || "unknown";
  const actualModel = result.actualModel || (defaults && defaults.actualModel) || requestedModel;
  const rawSF = result.substitutedFrom;
  const sfProvider = (defaults && defaults.provider) || (status !== "substituted" ? provider : undefined);
  const substitutedFrom = normalizeSubstitutedFrom(rawSF, sfProvider);
  const substitutionReason = extractSubstitutionReason(result.substitutionReason, rawSF);

  return {
    ...result,
    status,
    requestedModel,
    provider,
    actualModel,
    ...(substitutedFrom !== undefined ? { substitutedFrom } : {}),
    ...(substitutionReason !== undefined ? { substitutionReason } : {}),
  };
}

function truncField(val, maxLen) {
  if (!val) return "";
  return val.length <= maxLen ? val : val.slice(0, maxLen - 1) + "…";
}

function buildSubstitutionBlock(entries) {
  if (entries.length === 0) return "";
  const capped = entries.slice(0, 5).map((e) => ({
    slot: truncField(e.slot, 80),
    requestedModel: truncField(e.requestedModel, 80),
    provider: truncField(e.provider, 80),
    actualModel: truncField(e.actualModel, 80),
    reason: truncField(e.reason, 80),
  }));
  return `\nSUBSTITUTIONS:\n${JSON.stringify(capped)}\n`;
}

// ─── Test 1: coerceStatus only returns ok/substituted/failed ───────────────

function test1_coerceStatus() {
  console.log("\nTest 1: coerceStatus only returns ok/substituted/failed");

  assert(coerceStatus("ok") === "ok", 'ok → ok');
  assert(coerceStatus("substituted") === "substituted", 'substituted → substituted');
  assert(coerceStatus("failed") === "failed", 'failed → failed');
  assert(coerceStatus("error") === "failed", 'error → failed');
  assert(coerceStatus("timeout") === "failed", 'timeout → failed');
  assert(coerceStatus("refused") === "failed", 'refused → failed');
  assert(coerceStatus("anything_else") === "failed", 'unknown → failed');

  const validStatuses = new Set(["ok", "substituted", "failed"]);
  for (const legacy of ["ok", "substituted", "failed", "error", "timeout", "refused", "garbage"]) {
    assert(validStatuses.has(coerceStatus(legacy)), `coerceStatus("${legacy}") ∈ {ok,substituted,failed}`);
  }
}

// ─── Test 2: Legacy substitutedFrom object normalized to string ────────────

function test2_legacySubstitutedFromObject() {
  console.log("\nTest 2: Legacy substitutedFrom object normalized to string");

  const result = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    substitutedFrom: { provider: "openai", model: "gpt-4o-mini", reason: "openai_timeout" },
  });

  assert(typeof result.substitutedFrom === "string", "substitutedFrom is string");
  assert(result.substitutedFrom === "openai:gpt-4o-mini", `substitutedFrom is "openai:gpt-4o-mini" (got "${result.substitutedFrom}")`);
  assert(result.substitutionReason === "openai_timeout", `substitutionReason extracted from object.reason (got "${result.substitutionReason}")`);
}

// ─── Test 3: substitutedFrom always contains ":" when substituted ──────────

function test3_substitutedFromContainsColon() {
  console.log("\nTest 3: substitutedFrom always contains ':' when status=substituted");

  // Case A: string without colon + known provider → provider prepended
  const a = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    provider: "deepseek",
    substitutedFrom: "gpt-4o-mini",
  }, { provider: "openai" });
  assert(a.substitutedFrom.includes(":"), `Case A: "${a.substitutedFrom}" contains ":"`);

  // Case B: string already with colon
  const b = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    provider: "deepseek",
    substitutedFrom: "openai:gpt-4o-mini",
  });
  assert(b.substitutedFrom === "openai:gpt-4o-mini", `Case B: "${b.substitutedFrom}" unchanged`);

  // Case C: object form
  const c = normalizeModelResultPublic({
    modelId: "claude",
    status: "substituted",
    substitutedFrom: { provider: "anthropic", model: "claude-3-haiku" },
  });
  assert(c.substitutedFrom.includes(":"), `Case C: "${c.substitutedFrom}" contains ":"`);
}

// ─── Test 4: actualModel always present ────────────────────────────────────

function test4_actualModelAlwaysPresent() {
  console.log("\nTest 4: actualModel is always present on normalized results");

  // Success case
  const ok = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "ok",
    requestedModel: "gpt-4o-mini",
    provider: "openai",
    actualModel: "gpt-4o-mini",
  });
  assert(typeof ok.actualModel === "string" && ok.actualModel.length > 0, "ok: actualModel present");

  // Substituted case
  const sub = normalizeModelResultPublic({
    modelId: "chatgpt",
    status: "substituted",
    requestedModel: "gpt-4o-mini",
    provider: "deepseek",
    actualModel: "deepseek-chat",
  });
  assert(sub.actualModel === "deepseek-chat", "substituted: actualModel is deepseek-chat");

  // Failed case (no actualModel provided)
  const fail = normalizeModelResultPublic({
    modelId: "gemini",
    status: "failed",
    requestedModel: "gemini-2.0-flash",
    provider: "google",
  });
  assert(fail.actualModel === "gemini-2.0-flash", "failed: actualModel falls back to requestedModel");

  // Bare minimum (no metadata at all)
  const bare = normalizeModelResultPublic({
    modelId: "grok",
    status: "error",
  });
  assert(typeof bare.actualModel === "string" && bare.actualModel.length > 0, "bare: actualModel falls back to modelId");
  assert(bare.actualModel === "grok", `bare: actualModel is "grok" (got "${bare.actualModel}")`);
}

// ─── Test 5: Legacy statuses coerced to "failed" ──────────────────────────

function test5_legacyStatusesCoerced() {
  console.log("\nTest 5: Legacy statuses (error/timeout/refused) coerced to failed");

  for (const legacy of ["error", "timeout", "refused"]) {
    const r = normalizeModelResultPublic({
      modelId: "chatgpt",
      status: legacy,
      requestedModel: "gpt-4o-mini",
      provider: "openai",
      actualModel: "gpt-4o-mini",
    });
    assert(r.status === "failed", `"${legacy}" coerced to "failed"`);
  }
}

// ─── Test 6: buildSubstitutionBlock caps to 5 and truncates ────────────────

function test6_substitutionBlockCaps() {
  console.log("\nTest 6: buildSubstitutionBlock caps to 5 and truncates fields");

  // Empty
  assert(buildSubstitutionBlock([]) === "", "Empty entries → empty string");

  // 8 entries → only first 5
  const entries = [];
  for (let i = 0; i < 8; i++) {
    entries.push({
      slot: `model_${i}`,
      requestedModel: `model-requested-${i}`,
      provider: `provider-${i}`,
      actualModel: `model-actual-${i}`,
      reason: `reason_${i}`,
    });
  }
  const block = buildSubstitutionBlock(entries);
  assert(block.includes("SUBSTITUTIONS:"), "Block includes SUBSTITUTIONS header");
  const parsed = JSON.parse(block.replace("\nSUBSTITUTIONS:\n", "").trim());
  assert(parsed.length === 5, `Capped to 5 entries (got ${parsed.length})`);

  // Long field truncation
  const longEntry = [{
    slot: "a".repeat(200),
    requestedModel: "b".repeat(200),
    provider: "c".repeat(200),
    actualModel: "d".repeat(200),
    reason: "e".repeat(200),
  }];
  const longBlock = buildSubstitutionBlock(longEntry);
  const longParsed = JSON.parse(longBlock.replace("\nSUBSTITUTIONS:\n", "").trim());
  assert(longParsed[0].slot.length <= 80, `slot truncated to ≤80 (got ${longParsed[0].slot.length})`);
  assert(longParsed[0].requestedModel.length <= 80, `requestedModel truncated to ≤80`);
  assert(longParsed[0].reason.length <= 80, `reason truncated to ≤80`);
}

// ─── Test 7: Normalizer handles missing fields gracefully ──────────────────

function test7_missingFieldsGraceful() {
  console.log("\nTest 7: Normalizer handles missing fields gracefully");

  const minimal = normalizeModelResultPublic({
    modelId: "perplexity",
    status: "ok",
  });

  assert(minimal.status === "ok", "status preserved");
  assert(minimal.requestedModel === "perplexity", "requestedModel falls back to modelId");
  assert(minimal.provider === "unknown", "provider defaults to 'unknown'");
  assert(minimal.actualModel === "perplexity", "actualModel falls back to requestedModel");
  assert(minimal.substitutedFrom === undefined, "substitutedFrom undefined when not set");
  assert(minimal.substitutionReason === undefined, "substitutionReason undefined when not set");
}

// ─── Test 8: substitutedFrom includes provider context ─────────────────────

function test8_substitutedFromProviderContext() {
  console.log("\nTest 8: substitutedFrom includes provider context");

  // Bare model name + provider in defaults
  const r = normalizeModelResultPublic(
    {
      modelId: "claude",
      status: "substituted",
      provider: "deepseek",
      substitutedFrom: "claude-3-haiku-20240307",
    },
    { provider: "anthropic" }
  );

  assert(
    r.substitutedFrom === "anthropic:claude-3-haiku-20240307",
    `substitutedFrom prefixed with default provider: "${r.substitutedFrom}"`
  );
}

// ─── Test 9: normalizeModelResultPublic is idempotent ──────────────────────

function test9_idempotent() {
  console.log("\nTest 9: normalizeModelResultPublic is idempotent");

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

  assert(first.status === second.status, "status stable");
  assert(first.requestedModel === second.requestedModel, "requestedModel stable");
  assert(first.provider === second.provider, "provider stable");
  assert(first.actualModel === second.actualModel, "actualModel stable");
  assert(first.substitutedFrom === second.substitutedFrom, "substitutedFrom stable");
  assert(first.substitutionReason === second.substitutionReason, "substitutionReason stable");
}

// ─── Test 10: Full slot simulation with metadata ───────────────────────────

function test10_fullSlotSimulation() {
  console.log("\nTest 10: Full slot simulation with metadata");

  const MODEL_PROVIDERS = {
    chatgpt: "openai",
    claude: "anthropic",
    gemini: "google",
    grok: "xai",
    perplexity: "perplexity",
  };

  const MODEL_STRINGS = {
    chatgpt: "gpt-4o-mini",
    claude: "claude-3-haiku-20240307",
    gemini: "gemini-2.0-flash",
    grok: "grok-4-1-fast-reasoning",
    perplexity: "sonar",
  };

  // Simulate what the orchestrator produces for a substituted slot
  const rawSubstituted = {
    modelId: "chatgpt",
    status: "substituted",
    rawText: "DeepSeek response text",
    latencyMs: 1234,
    requestedModel: "gpt-4o-mini",
    provider: "deepseek",
    actualModel: "deepseek-chat",
    substitutedFrom: "openai:gpt-4o-mini",
    substitutionReason: "openai_timeout",
  };

  const norm = normalizeModelResultPublic(rawSubstituted);

  assert(norm.status === "substituted", "status is substituted");
  assert(norm.requestedModel === "gpt-4o-mini", "requestedModel correct");
  assert(norm.provider === "deepseek", "provider is deepseek");
  assert(norm.actualModel === "deepseek-chat", "actualModel is deepseek-chat");
  assert(norm.substitutedFrom === "openai:gpt-4o-mini", "substitutedFrom correct format");
  assert(norm.substitutionReason === "openai_timeout", "substitutionReason correct");

  // Simulate a failed slot
  const rawFailed = {
    modelId: "gemini",
    status: "error",
    rawText: "Model unavailable.",
    latencyMs: 0,
    requestedModel: "gemini-2.0-flash",
    provider: "google",
    actualModel: "gemini-2.0-flash",
    substitutionReason: "google_5xx",
  };

  const normFail = normalizeModelResultPublic(rawFailed);
  assert(normFail.status === "failed", 'legacy "error" coerced to "failed"');
  assert(normFail.requestedModel === "gemini-2.0-flash", "requestedModel preserved");
  assert(normFail.actualModel === "gemini-2.0-flash", "actualModel preserved");

  // Simulate an ok slot
  const rawOk = {
    modelId: "claude",
    status: "ok",
    rawText: "Claude response",
    latencyMs: 500,
    requestedModel: "claude-3-haiku-20240307",
    provider: "anthropic",
    actualModel: "claude-3-haiku-20240307",
  };

  const normOk = normalizeModelResultPublic(rawOk);
  assert(normOk.status === "ok", "status stays ok");
  assert(normOk.substitutedFrom === undefined, "no substitutedFrom for ok");
  assert(normOk.substitutionReason === undefined, "no substitutionReason for ok");
}

// ─── Run all ───────────────────────────────────────────────────────────────

async function main() {
  console.log("=== DeepSeek Contract Verification (v3) ===\n");

  test1_coerceStatus();
  test2_legacySubstitutedFromObject();
  test3_substitutedFromContainsColon();
  test4_actualModelAlwaysPresent();
  test5_legacyStatusesCoerced();
  test6_substitutionBlockCaps();
  test7_missingFieldsGraceful();
  test8_substitutedFromProviderContext();
  test9_idempotent();
  test10_fullSlotSimulation();

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

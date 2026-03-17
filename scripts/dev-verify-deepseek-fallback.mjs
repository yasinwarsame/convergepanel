#!/usr/bin/env node

/**
 * Dev Verification Script: DeepSeek Fallback (v2 — tightened semantics)
 *
 * Tests:
 * 1. Substituted slot → status "substituted", provider "deepseek", actualModel set, etc.
 * 2. Failed slot → status "failed", slot still present
 * 3. Ok slot → status "ok", requestedModel/provider/actualModel all set
 * 4. Provider allowlist: xai/perplexity should NOT fallback by default
 * 5. Env override enables fallback for xai/perplexity
 * 6. Non-retryable errors skip retry
 *
 * Usage:
 *   node scripts/dev-verify-deepseek-fallback.mjs
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

// ─── Inline simulation ────────────────────────────────────────────────────

const RETRYABLE_STATUSES = ["timeout", "refused", "rate_limited"];

function isRetryableResult(result) {
  if (result.status === "ok") return false;
  if (RETRYABLE_STATUSES.includes(result.status)) return true;
  const msg = (result.errorMessage ?? "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("429") || msg.includes("5xx") || msg.includes("server error");
}

function isNonRetryable(result) {
  const msg = (result.errorMessage ?? "").toLowerCase();
  return msg.includes("401") || msg.includes("403") || msg.includes("auth") || msg.includes("forbidden");
}

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

function classifyPrimaryErrorCode(modelId, result) {
  const provider = MODEL_PROVIDERS[modelId];
  const msg = (result.errorMessage ?? "").toLowerCase();
  if (result.status === "timeout" || msg.includes("timeout")) return `${provider}_timeout`;
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("exceeded your current quota") || msg.includes("billing details")) return `${provider}_429`;
  if (msg.includes("401")) return `${provider}_auth`;
  if (msg.includes("403") || msg.includes("forbidden") || msg.includes("request not allowed")) return `${provider}_forbidden`;
  if (/\b5\d{2}\b/.test(msg) || msg.includes("server error")) return `${provider}_5xx`;
  return `${provider}_error`;
}

async function simulateSlot(modelId, primaryFn, deepseekFn, allowlist) {
  const provider = MODEL_PROVIDERS[modelId];
  const requestedModel = MODEL_STRINGS[modelId];

  let primaryResult = primaryFn();

  if (primaryResult.status === "ok") {
    return {
      ...primaryResult,
      requestedModel,
      provider,
      actualModel: requestedModel,
    };
  }

  // Retry up to 2 for retryable
  if (!isNonRetryable(primaryResult) && isRetryableResult(primaryResult)) {
    for (let i = 0; i < 2; i++) {
      primaryResult = primaryFn();
      if (primaryResult.status === "ok") {
        return { ...primaryResult, requestedModel, provider, actualModel: requestedModel };
      }
      if (isNonRetryable(primaryResult) || !isRetryableResult(primaryResult)) break;
    }
  }

  // Check allowlist
  if (!allowlist.has(provider)) {
    return {
      modelId,
      status: "failed",
      rawText: "Model unavailable.",
      errorMessage: primaryResult.errorMessage || `${modelId} failed`,
      latencyMs: primaryResult.latencyMs || 0,
      requestedModel,
      provider,
      actualModel: requestedModel,
      substitutionReason: "fallback_not_allowed",
    };
  }

  // DeepSeek fallback
  if (!deepseekFn) {
    return {
      modelId,
      status: "failed",
      rawText: "Model unavailable.",
      errorMessage: primaryResult.errorMessage || `${modelId} failed`,
      latencyMs: primaryResult.latencyMs || 0,
      requestedModel,
      provider,
      actualModel: requestedModel,
      substitutionReason: classifyPrimaryErrorCode(modelId, primaryResult),
    };
  }

  const primaryCode = classifyPrimaryErrorCode(modelId, primaryResult);
  const ds = deepseekFn();

  if (ds.ok) {
    return {
      modelId,
      status: "substituted",
      rawText: ds.text,
      latencyMs: ds.latencyMs || 100,
      requestedModel,
      provider: "deepseek",
      actualModel: ds.actualModel || "deepseek-chat",
      substitutedFrom: requestedModel,
      substitutionReason: primaryCode,
    };
  }

  const combinedReason = `${primaryCode}|${ds.code}`;

  return {
    modelId,
    status: "failed",
    rawText: "Model unavailable.",
    errorMessage: primaryResult.errorMessage || `${modelId} failed`,
    latencyMs: primaryResult.latencyMs || 0,
    requestedModel,
    provider,
    actualModel: requestedModel,
    substitutionReason: combinedReason,
  };
}

async function simulatePanel(selectedModels, primaryFns, deepseekFn, allowlistOverride) {
  const allowlist = allowlistOverride || new Set(["openai", "anthropic", "google"]);
  const results = await Promise.all(
    selectedModels.map((id) => simulateSlot(id, primaryFns[id], deepseekFn, allowlist))
  );
  return results;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const MODELS = ["chatgpt", "claude", "grok", "perplexity", "gemini"];

function okResult(id) {
  return { modelId: id, status: "ok", rawText: `Response from ${id}`, latencyMs: 200 };
}

function errorResult(id, msg) {
  return { modelId: id, status: "error", rawText: null, errorMessage: msg || "API error", latencyMs: 50 };
}

function timeoutResult(id) {
  return { modelId: id, status: "timeout", rawText: null, errorMessage: "timeout", latencyMs: 30000 };
}

function dsOk() {
  return { ok: true, text: "DeepSeek fallback response", actualModel: "deepseek-chat", latencyMs: 150 };
}

function dsFail() {
  return { ok: false, code: "deepseek_auth", retryable: false, message: "DeepSeek auth failed", latencyMs: 10 };
}

// ─── Test 1: All models succeed — status "ok", metadata correct ────────────

async function test1_allOk() {
  console.log("\nTest 1: All models succeed — status ok, metadata present");

  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });

  const results = await simulatePanel(MODELS, fns, dsOk);

  assert(results.length === 5, "Exactly 5 results");
  assert(results.every((r) => r.status === "ok"), "All status === 'ok'");
  assert(results.every((r) => !r.substitutedFrom), "No substitutedFrom on any");

  for (const r of results) {
    assert(r.requestedModel === MODEL_STRINGS[r.modelId], `${r.modelId}: requestedModel is ${r.requestedModel}`);
    assert(r.provider === MODEL_PROVIDERS[r.modelId], `${r.modelId}: provider is ${r.provider}`);
    assert(r.actualModel === MODEL_STRINGS[r.modelId], `${r.modelId}: actualModel equals requestedModel`);
  }
}

// ─── Test 2: One model fails, DeepSeek succeeds → status "substituted" ────

async function test2_substituted() {
  console.log("\nTest 2: GPT fails, DeepSeek succeeds → status 'substituted'");

  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });
  fns["chatgpt"] = () => errorResult("chatgpt", "API error 500");

  const results = await simulatePanel(MODELS, fns, dsOk);

  assert(results.length === 5, "Exactly 5 results");

  const gpt = results.find((r) => r.modelId === "chatgpt");
  assert(gpt.status === "substituted", "GPT status === 'substituted'");
  assert(gpt.provider === "deepseek", "GPT provider === 'deepseek'");
  assert(gpt.actualModel === "deepseek-chat", "GPT actualModel === 'deepseek-chat'");
  assert(gpt.requestedModel === "gpt-4o-mini", "GPT requestedModel === 'gpt-4o-mini'");
  assert(gpt.substitutedFrom === "gpt-4o-mini", "GPT substitutedFrom === 'gpt-4o-mini'");
  assert(typeof gpt.substitutionReason === "string" && gpt.substitutionReason.length > 0, "GPT substitutionReason is set");
  assert(gpt.rawText === "DeepSeek fallback response", "GPT rawText from DeepSeek");

  const others = results.filter((r) => r.modelId !== "chatgpt");
  assert(others.every((r) => r.status === "ok" && !r.substitutedFrom), "Other 4 status ok, no substitution");
}

// ─── Test 3: Multiple fail, DeepSeek succeeds → all "substituted" ─────────

async function test3_multipleSubstituted() {
  console.log("\nTest 3: GPT + Claude + Gemini fail, DeepSeek succeeds → all substituted");

  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });
  fns["chatgpt"] = () => errorResult("chatgpt");
  fns["claude"] = () => errorResult("claude");
  fns["gemini"] = () => timeoutResult("gemini");

  const results = await simulatePanel(MODELS, fns, dsOk);

  assert(results.length === 5, "Exactly 5 results");

  for (const id of ["chatgpt", "claude", "gemini"]) {
    const r = results.find((x) => x.modelId === id);
    assert(r.status === "substituted", `${id} status === 'substituted'`);
    assert(r.provider === "deepseek", `${id} provider === 'deepseek'`);
    assert(r.actualModel === "deepseek-chat", `${id} actualModel is deepseek-chat`);
    assert(!!r.substitutedFrom, `${id} has substitutedFrom`);
    assert(!!r.substitutionReason, `${id} has substitutionReason`);
  }

  for (const id of ["grok", "perplexity"]) {
    const r = results.find((x) => x.modelId === id);
    assert(r.status === "ok" && !r.substitutedFrom, `${id} is ok, no substitution`);
  }
}

// ─── Test 4: Both primary + DeepSeek fail → status "failed" ───────────────

async function test4_failed() {
  console.log("\nTest 4: GPT fails + DeepSeek fails → status 'failed'");

  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });
  fns["chatgpt"] = () => errorResult("chatgpt", "Auth error 401");

  const results = await simulatePanel(MODELS, fns, dsFail);

  assert(results.length === 5, "Exactly 5 results");

  const gpt = results.find((r) => r.modelId === "chatgpt");
  assert(gpt.status === "failed", "GPT status === 'failed'");
  assert(gpt.rawText === "Model unavailable.", "Placeholder rawText");
  assert(!gpt.substitutedFrom, "No substitutedFrom (both failed)");
  assert(gpt.requestedModel === "gpt-4o-mini", "requestedModel set");
  assert(gpt.provider === "openai", "provider is openai (original)");
}

// ─── Test 5: Non-retryable (401) skips retry ──────────────────────────────

async function test5_nonRetryableSkipsRetry() {
  console.log("\nTest 5: 401 error skips retry, goes straight to DeepSeek");

  let callCount = 0;
  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });
  fns["claude"] = () => {
    callCount++;
    return errorResult("claude", "401 Unauthorized");
  };

  const results = await simulatePanel(MODELS, fns, dsOk);

  assert(results.length === 5, "Exactly 5 results");
  assert(callCount === 1, `Primary called only once (got ${callCount})`);

  const claude = results.find((r) => r.modelId === "claude");
  assert(claude.status === "substituted", "Claude status === 'substituted'");
  assert(claude.provider === "deepseek", "provider === 'deepseek'");
  assert(claude.substitutionReason === "anthropic_auth", `substitutionReason is 'anthropic_auth' (got '${claude.substitutionReason}')`);
}

// ─── Test 6: Default allowlist — xai/perplexity NOT allowed ───────────────

async function test6_defaultAllowlistBlocks() {
  console.log("\nTest 6: Default allowlist blocks xai/perplexity fallback");

  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });
  fns["grok"] = () => errorResult("grok", "Server error 500");
  fns["perplexity"] = () => errorResult("perplexity", "Server error 500");

  const results = await simulatePanel(MODELS, fns, dsOk);

  const grok = results.find((r) => r.modelId === "grok");
  assert(grok.status === "failed", "Grok status === 'failed' (not substituted)");
  assert(grok.substitutionReason === "fallback_not_allowed", `Grok reason is 'fallback_not_allowed' (got '${grok.substitutionReason}')`);
  assert(!grok.substitutedFrom, "Grok has no substitutedFrom");

  const perp = results.find((r) => r.modelId === "perplexity");
  assert(perp.status === "failed", "Perplexity status === 'failed' (not substituted)");
  assert(perp.substitutionReason === "fallback_not_allowed", `Perplexity reason is 'fallback_not_allowed'`);
}

// ─── Test 7: Env override enables xai/perplexity fallback ─────────────────

async function test7_envOverrideAllowsAll() {
  console.log("\nTest 7: Env override enables xai/perplexity fallback");

  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });
  fns["grok"] = () => errorResult("grok", "Server error 500");
  fns["perplexity"] = () => errorResult("perplexity", "Server error 500");

  const fullAllowlist = new Set(["openai", "anthropic", "google", "xai", "perplexity"]);
  const results = await simulatePanel(MODELS, fns, dsOk, fullAllowlist);

  const grok = results.find((r) => r.modelId === "grok");
  assert(grok.status === "substituted", "Grok status === 'substituted' with override");
  assert(grok.provider === "deepseek", "Grok provider === 'deepseek'");

  const perp = results.find((r) => r.modelId === "perplexity");
  assert(perp.status === "substituted", "Perplexity status === 'substituted' with override");
  assert(perp.provider === "deepseek", "Perplexity provider === 'deepseek'");
}

// ─── Test 8: No DeepSeek key → failed ─────────────────────────────────────

async function test8_noDeepseekKey() {
  console.log("\nTest 8: No DeepSeek available → status 'failed'");

  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });
  fns["gemini"] = () => errorResult("gemini", "Server error");

  const results = await simulatePanel(MODELS, fns, null);

  const gem = results.find((r) => r.modelId === "gemini");
  assert(gem.status === "failed", "Gemini status === 'failed'");
  assert(gem.rawText === "Model unavailable.", "Placeholder rawText");
}

// ─── Test 9: Substituted result has all required fields ───────────────────

async function test9_substitutedFieldsComplete() {
  console.log("\nTest 9: Substituted result has ALL required fields");

  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });
  fns["chatgpt"] = () => timeoutResult("chatgpt");

  const results = await simulatePanel(MODELS, fns, dsOk);
  const gpt = results.find((r) => r.modelId === "chatgpt");

  assert(gpt.status === "substituted", "status === 'substituted'");
  assert(gpt.requestedModel === "gpt-4o-mini", "requestedModel present");
  assert(gpt.provider === "deepseek", "provider === 'deepseek'");
  assert(gpt.actualModel === "deepseek-chat", "actualModel === 'deepseek-chat'");
  assert(gpt.substitutedFrom === "gpt-4o-mini", "substitutedFrom === 'gpt-4o-mini'");
  assert(gpt.substitutionReason === "openai_timeout", `substitutionReason === 'openai_timeout' (got '${gpt.substitutionReason}')`);
  assert(typeof gpt.rawText === "string" && gpt.rawText.length > 0, "rawText is non-empty string");
}

// ─── Test 10: Failed result has all required fields ───────────────────────

async function test10_failedFieldsComplete() {
  console.log("\nTest 10: Failed result has ALL required fields");

  const fns = {};
  MODELS.forEach((id) => { fns[id] = () => okResult(id); });
  fns["claude"] = () => errorResult("claude", "Server error 500");

  const results = await simulatePanel(MODELS, fns, dsFail);
  const cl = results.find((r) => r.modelId === "claude");

  assert(cl.status === "failed", "status === 'failed'");
  assert(cl.requestedModel === "claude-3-haiku-20240307", "requestedModel present");
  assert(cl.provider === "anthropic", "provider === 'anthropic' (original)");
  assert(cl.actualModel === "claude-3-haiku-20240307", "actualModel equals requestedModel");
  assert(cl.rawText === "Model unavailable.", "placeholder rawText");
  assert(typeof cl.substitutionReason === "string", "substitutionReason present");
}

// ─── Run all ───────────────────────────────────────────────────────────────

async function main() {
  console.log("=== DeepSeek Fallback Verification (v2) ===\n");

  await test1_allOk();
  await test2_substituted();
  await test3_multipleSubstituted();
  await test4_failed();
  await test5_nonRetryableSkipsRetry();
  await test6_defaultAllowlistBlocks();
  await test7_envOverrideAllowsAll();
  await test8_noDeepseekKey();
  await test9_substitutedFieldsComplete();
  await test10_failedFieldsComplete();

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

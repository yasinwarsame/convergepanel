/**
 * P0 restoration (2026-11-01): sanitized Gemini failure diagnostics.
 *
 * Production had every Gemini call failing with nothing logged (all connector error logging was dev-only). These
 * tests pin two things:
 *   1. The classification separates authentication, permission, quota/rate limit, model availability, malformed
 *      request, provider outage, timeout, network and empty response. That includes Google's HTTP 400 answer to an
 *      invalid key, which the connector's own user-facing branch reports as "invalid request format".
 *   2. Sanitization: no message, prompt, response, key, URL, errorDetails metadata or free text ever reaches the log.
 *
 * The connector is exercised for real; only the Google SDK and the logger are doubles.
 */
const mockGenerateContent = jest.fn();
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: () => ({ generateContent: (...a: unknown[]) => mockGenerateContent(...a) }) })),
}));
const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { buildGeminiFailureDiagnostic, buildGeminiEmptyResponseDiagnostic } from "@/lib/connectors/geminiFailureDiagnostic";
import { callGemini } from "@/lib/connectors/gemini";

const SECRET_KEY = "AIzaSyFAKE-test-key-value-0000000000000";
const PROMPT = "CONFIDENTIAL research question about acquisitions";

/** Shaped like @google/generative-ai's GoogleGenerativeAIFetchError. */
function fetchError(status: number, statusText: string, reasons: string[], message = `[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${SECRET_KEY}: [${status} ${statusText}] API key not valid. ${PROMPT}`) {
  const e: any = new Error(message);
  e.name = "GoogleGenerativeAIFetchError";
  e.status = status;
  e.statusText = statusText;
  e.errorDetails = reasons.map((reason) => ({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com", metadata: { consumer: "projects/123456789012", service: "generativelanguage.googleapis.com" } }));
  return e;
}

const ctx = { model: "gemini-2.5-flash", attempt: 1, maxAttempts: 3, latencyMs: 250 };

describe("buildGeminiFailureDiagnostic: classification", () => {
  it.each([
    ["invalid key (Google answers 400)", fetchError(400, "Bad Request", ["API_KEY_INVALID"]), "authentication"],
    ["expired key", fetchError(400, "Bad Request", ["API_KEY_EXPIRED"]), "authentication"],
    ["401", fetchError(401, "Unauthorized", []), "authentication"],
    ["API not enabled / service disabled", fetchError(403, "Forbidden", ["SERVICE_DISABLED"]), "permission"],
    ["billing disabled (403 + BILLING_DISABLED)", fetchError(403, "Forbidden", ["BILLING_DISABLED"]), "billing"],
    ["key restricted by referrer", fetchError(403, "Forbidden", ["API_KEY_HTTP_REFERRER_BLOCKED"]), "permission"],
    ["plain 403", fetchError(403, "Forbidden", []), "permission"],
    ["Payment Required (the Production failure, 2026-11-01)", fetchError(402, "Payment Required", []), "billing"],
    ["quota", fetchError(429, "Too Many Requests", ["RATE_LIMIT_EXCEEDED"]), "quota_or_rate_limit"],
    ["plain 429", fetchError(429, "Too Many Requests", []), "quota_or_rate_limit"],
    ["model retired / not found", fetchError(404, "Not Found", []), "model_unavailable"],
    ["malformed request", fetchError(400, "Bad Request", []), "invalid_request"],
    ["provider outage", fetchError(503, "Service Unavailable", []), "provider_unavailable"],
  ])("%s -> %s", (_label, error, category) => {
    expect(buildGeminiFailureDiagnostic(error, ctx).category).toBe(category);
  });

  it("timeout and network failures are distinct from HTTP failures", () => {
    expect(buildGeminiFailureDiagnostic(new Error("timeout"), { ...ctx, isTimeout: true }).category).toBe("timeout");
    const net: any = new TypeError("fetch failed");
    expect(buildGeminiFailureDiagnostic(net, ctx).category).toBe("network");
    expect(buildGeminiFailureDiagnostic({}, ctx).category).toBe("unknown");
    expect(buildGeminiFailureDiagnostic(null, ctx).category).toBe("unknown");
  });

  it("the operation defaults to the panel call and carries the stage when given", () => {
    expect(buildGeminiFailureDiagnostic({}, ctx).operation).toBe("panel");
    expect(buildGeminiFailureDiagnostic({}, { ...ctx, operation: "classification" }).operation).toBe("classification");
  });
});

describe("buildGeminiFailureDiagnostic: sanitization", () => {
  it("records status, reasons and counters, and nothing from the message, URL, key, prompt or metadata", () => {
    const d = buildGeminiFailureDiagnostic(fetchError(400, "Bad Request", ["API_KEY_INVALID"]), { ...ctx, operation: "synthesis_narrative" });
    expect(d).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
      operation: "synthesis_narrative",
      category: "authentication",
      httpStatus: 400,
      httpStatusText: "Bad Request",
      reasons: ["API_KEY_INVALID"],
      errorName: "GoogleGenerativeAIFetchError",
      attempt: 1,
      maxAttempts: 3,
      latencyMs: 250,
    });
    const s = JSON.stringify(d);
    for (const leak of [SECRET_KEY, "key=", "CONFIDENTIAL", "projects/123456789012", "generativelanguage.googleapis.com", "API key not valid"]) expect(s).not.toContain(leak);
  });

  it("drops reason codes, status text and names that are not plain enum/identifier shapes", () => {
    const e: any = { status: 400, statusText: `Bad ${SECRET_KEY}`, name: "x y <script>", errorDetails: [{ reason: `leak ${PROMPT}` }, { reason: "lowercase_reason" }, { reason: "API_KEY_INVALID" }, null, "str"] };
    const d = buildGeminiFailureDiagnostic(e, ctx);
    expect(d.reasons).toEqual(["API_KEY_INVALID"]);
    expect(d.httpStatusText).toBeNull();
    expect(d.errorName).toBeNull();
    expect(JSON.stringify(d)).not.toContain("CONFIDENTIAL");
  });

  it("an out-of-range or non-integer status is not reported as an HTTP status", () => {
    expect(buildGeminiFailureDiagnostic({ status: "400" }, ctx).httpStatus).toBeNull();
    expect(buildGeminiFailureDiagnostic({ status: 99 }, ctx).httpStatus).toBeNull();
    expect(buildGeminiFailureDiagnostic({ status: 400.5 }, ctx).httpStatus).toBeNull();
  });

  it("empty-response diagnostics keep only an enum-shaped finishReason", () => {
    expect(buildGeminiEmptyResponseDiagnostic({ ...ctx, finishReason: "SAFETY" }).finishReason).toBe("SAFETY");
    expect(buildGeminiEmptyResponseDiagnostic({ ...ctx, finishReason: `x ${PROMPT}` }).finishReason).toBeNull();
    expect(buildGeminiEmptyResponseDiagnostic(ctx as never).category).toBe("empty_response");
  });
});

describe("callGemini (real connector): one sanitized Production log line per failed call", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, GEMINI_API_KEY: SECRET_KEY, NODE_ENV: "production" };
    mockGenerateContent.mockReset();
    mockWarn.mockReset();
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  function onlyLog() {
    const calls = mockWarn.mock.calls.filter((c) => c[0] === "[Gemini connector] call failed");
    expect(calls).toHaveLength(1);
    const payload = calls[0][1];
    const s = JSON.stringify(calls[0]);
    for (const leak of [SECRET_KEY, "CONFIDENTIAL", "projects/123456789012", "API key not valid", "key="]) expect(s).not.toContain(leak);
    return payload;
  }

  it("an invalid key (HTTP 400 + API_KEY_INVALID) on an analysis stage is logged as authentication with its operation", async () => {
    mockGenerateContent.mockRejectedValue(fetchError(400, "Bad Request", ["API_KEY_INVALID"]));
    const r = await callGemini(PROMPT, null, undefined, { systemPromptOverride: "sys", diagnosticOperation: "classification" });
    expect(r.status).toBe("error");
    expect(onlyLog()).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite", operation: "classification", category: "authentication", httpStatus: 400, reasons: ["API_KEY_INVALID"] });
  });

  it("a retired model (404) on the panel call is logged as model_unavailable, operation panel", async () => {
    mockGenerateContent.mockRejectedValue(fetchError(404, "Not Found", []));
    const r = await callGemini(PROMPT, null, undefined);
    expect(r.status).toBe("error");
    expect(onlyLog()).toMatchObject({ operation: "panel", category: "model_unavailable", httpStatus: 404 });
  });

  it("billing disabled (403 + BILLING_DISABLED) is logged as billing", async () => {
    mockGenerateContent.mockRejectedValue(fetchError(403, "Forbidden", ["BILLING_DISABLED"]));
    await callGemini(PROMPT, null, undefined, { diagnosticOperation: "bias_detection" });
    expect(onlyLog()).toMatchObject({ operation: "bias_detection", category: "billing", httpStatus: 403, reasons: ["BILLING_DISABLED"] });
  });

  it("a rate limit is retried, and only the final failure is logged, with its attempt count", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      mockGenerateContent.mockRejectedValue(fetchError(429, "Too Many Requests", ["RATE_LIMIT_EXCEEDED"]));
      const p = callGemini(PROMPT, null, undefined, { diagnosticOperation: "coverage_audit" });
      for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(7000);
      const r = await p;
      expect(r.status).toBe("error");
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      expect(onlyLog()).toMatchObject({ operation: "coverage_audit", category: "quota_or_rate_limit", attempt: 3, maxAttempts: 3 });
    } finally {
      jest.useRealTimers();
    }
  });

  it("an empty response is logged as empty_response with its finish reason", async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: async () => "", candidates: [{ finishReason: "MAX_TOKENS" }] } });
    const r = await callGemini(PROMPT, null, undefined, { diagnosticOperation: "synthesis_narrative" });
    expect(r.status).toBe("error");
    expect(onlyLog()).toMatchObject({ operation: "synthesis_narrative", category: "empty_response", finishReason: "MAX_TOKENS" });
  });

  it("a successful call logs nothing", async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: async () => "fine", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } });
    const r = await callGemini(PROMPT, null, undefined, { diagnosticOperation: "classification" });
    expect(r.status).toBe("ok");
    expect(mockWarn.mock.calls.filter((c) => c[0] === "[Gemini connector] call failed")).toHaveLength(0);
  });

  it("the diagnostic option is never sent to Google: the request body is unchanged by it", async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: async () => "fine", candidates: [{ finishReason: "STOP" }] } });
    await callGemini(PROMPT, null, undefined, { systemPromptOverride: "sys", maxOutputTokens: 50 });
    await callGemini(PROMPT, null, undefined, { systemPromptOverride: "sys", maxOutputTokens: 50, diagnosticOperation: "classification" });
    expect(JSON.stringify(mockGenerateContent.mock.calls[1])).toBe(JSON.stringify(mockGenerateContent.mock.calls[0]));
    expect(JSON.stringify(mockGenerateContent.mock.calls[1])).not.toContain("classification");
  });
});

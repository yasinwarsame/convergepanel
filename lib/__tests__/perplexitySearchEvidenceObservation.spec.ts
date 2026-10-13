/**
 * Order 5 Phase 0 — pure Provider Search Evidence observer: response shape,
 * search-result extraction, URL/date/last_updated counters, and the closed
 * eligibility decision. Synthetic ModelResults only; no provider calls.
 */

import {
  classifyPublicationDate,
  observeProviderSearchEvidence,
  PHASE0_INELIGIBILITY_REASONS,
  AdaptiveSlotState,
} from "@/lib/providers/perplexitySearchEvidenceObservation";
import type { ModelResult } from "@/lib/types";

const NOW = new Date("2026-10-13T20:30:00.000Z"); // UTC day 2026-10-13
const NONE: AdaptiveSlotState = { kind: "none" };

function entry(over: Record<string, unknown> = {}) {
  return { id: 1, url: "https://example.com/a", title: "T", snippet: "S", date: "2026-01-02", last_updated: "2026-02-03", ...over };
}

function agent(output: unknown[], over: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "perplexity/sonar",
    output: [...output, { type: "message", content: [{ type: "output_text", text: "Answer text" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...over,
  };
}

function slot(rawResponse: unknown, over: Partial<ModelResult> = {}): ModelResult {
  return { modelId: "perplexity", status: "ok", rawText: "Answer text", provider: "perplexity", latencyMs: 5, rawResponse, ...over };
}

const observe = (result: ModelResult, adaptive: AdaptiveSlotState = NONE) => observeProviderSearchEvidence({ result, adaptive, observedAt: NOW });

describe("response shape", () => {
  it.each([
    ["supported Agent response", agent([{ type: "search_results", results: [entry()] }]), "agent"],
    ["legacy Chat Completions", { choices: [{ message: { content: "x" } }], search_results: [entry()], citations: ["https://x.com"] }, "legacy_chat"],
    ["malformed object", { hello: "world" }, "malformed"],
    ["array", [entry()], "malformed"],
    ["missing output", { object: "response", status: "completed" }, "malformed"],
    ["null", null, "absent"],
    ["undefined", undefined, "absent"],
  ])("%s → %s", (_label, raw, shape) => {
    expect(observe(slot(raw)).responseShape).toBe(shape);
  });

  it("legacy top-level search_results / citations are never counted as evidence", () => {
    const o = observe(slot({ choices: [{ message: { content: "x" } }], search_results: [entry(), entry()], citations: ["https://a.com"] }));
    expect(o).toMatchObject({ searchResultItems: 0, resultEntries: 0, urlUsable: 0, eligible: false, ineligibilityReason: "legacy_response" });
  });

  it("an Agent response that ALSO carries legacy top-level search_results counts only output[] items", () => {
    const o = observe(slot({ ...agent([]), search_results: [entry(), entry(), entry()], citations: ["https://a.com"] }));
    expect(o).toMatchObject({ searchResultItems: 0, resultEntries: 0, ineligibilityReason: "no_search_results" });
  });

  it("model-written source labels / message text are never evidence", () => {
    const raw = agent([]);
    (raw.output as any[]).push({ type: "message", content: [{ type: "output_text", text: "Sources: https://example.com/a (2026-01-01)" }] });
    expect(observe(slot(raw, { rawText: "See https://example.com/a" }))).toMatchObject({ resultEntries: 0, urlUsable: 0, ineligibilityReason: "no_search_results" });
  });

  it("agent status is a closed category", () => {
    expect(observe(slot(agent([], { status: "weird_new_status" }))).agentStatus).toBe("other");
    expect(observe(slot(agent([], { status: "incomplete" }))).agentStatus).toBe("incomplete");
    expect(observe(slot({ choices: [] })).agentStatus).toBeNull();
  });
});

describe("search-result extraction", () => {
  it("zero items", () => {
    expect(observe(slot(agent([])))).toMatchObject({ searchResultItems: 0, resultEntries: 0, ineligibilityReason: "no_search_results" });
  });
  it("one item with empty results", () => {
    expect(observe(slot(agent([{ type: "search_results", results: [] }])))).toMatchObject({ searchResultItems: 1, resultEntries: 0, ineligibilityReason: "no_search_results" });
  });
  it("one item, non-array results", () => {
    expect(observe(slot(agent([{ type: "search_results", results: "x" }])))).toMatchObject({ searchResultItems: 1, resultEntries: 0 });
  });
  it("ten normal results", () => {
    const results = Array.from({ length: 10 }, (_, i) => entry({ url: `https://example.com/${i}` }));
    expect(observe(slot(agent([{ type: "search_results", results }])))).toMatchObject({
      searchResultItems: 1,
      resultEntries: 10,
      urlUsable: 10,
      safeEntries: 10,
      dateValid: 10,
      lastUpdatedPresent: 10,
      eligible: true,
      ineligibilityReason: null,
    });
  });
  it("multiple items aggregate in provider order; malformed entries are counted, never repaired", () => {
    const o = observe(
      slot(
        agent([
          { type: "search_results", results: [entry(), null, "https://example.com/x", 7] },
          { type: "other_tool", results: [entry(), entry()] },
          { type: "search_results", results: [entry({ url: "ftp://x.com" }), entry({ url: "https://u:p@x.com" })] },
        ])
      )
    );
    expect(o).toMatchObject({
      searchResultItems: 2,
      resultEntries: 6,
      malformedEntries: 3,
      urlUsable: 1,
      urlInvalid: 1,
      privacyDroppedEntries: 1,
      safeEntries: 1,
      dateValid: 3,
      eligible: true,
    });
  });
});

describe("URL counters (one class per entry)", () => {
  it("counts usable / invalid / over-limit / privacy-dropped exactly", () => {
    const o = observe(
      slot(
        agent([
          {
            type: "search_results",
            results: [
              entry({ url: "https://example.com/ok" }),
              entry({ url: "http://example.com/ok2" }),
              entry({ url: "not a url" }),
              entry({ url: undefined }),
              entry({ url: "https://example.com/" + "a".repeat(600) }),
              entry({ url: "https://example.com/a?access_token=abc" }),
              entry({ url: "https://example.com/items/3f2b8c1e-9d4a-4f6b-8e2c-1a2b3c4d5e6f" }),
            ],
          },
        ])
      )
    );
    expect(o).toMatchObject({ resultEntries: 7, urlUsable: 3, urlInvalid: 2, urlOverLimit: 1, privacyDroppedEntries: 1, safeEntries: 3 });
  });

  it("a credential URL drops the whole entry: it contributes no safe entry, and nothing sanitized is retained", () => {
    const o = observe(slot(agent([{ type: "search_results", results: [entry({ url: "https://example.com/a?token=abc&id=1" })] }])));
    expect(o).toMatchObject({ privacyDroppedEntries: 1, urlUsable: 0, safeEntries: 0, eligible: false, ineligibilityReason: "no_safe_result_entries" });
  });
});

describe("publication date (provider `date`) — strict calendar days", () => {
  it.each([
    [undefined, "absent"],
    [null, "absent"],
    ["", "absent"],
    ["   ", "absent"],
    ["2026-01-02", "valid"],
    ["2024-02-29", "valid"], // leap day
    ["2000-02-29", "valid"], // 400-year leap
    ["1970-01-01", "valid"], // no implausibility threshold in Phase 0
    ["2026-10-13", "valid"], // today (UTC)
    ["2026-10-14", "future"],
    ["2099-01-01", "future"],
    ["2025-02-29", "malformed"], // not a leap year
    ["1900-02-29", "malformed"], // century non-leap
    ["2026-02-30", "malformed"],
    ["2026-13-01", "malformed"],
    ["2026-00-10", "malformed"],
    ["0000-01-01", "malformed"],
    ["2026-1-2", "malformed"],
    ["2026/01/02", "malformed"],
    ["2026-01-02T10:00:00Z", "malformed"],
    ["Jan 2, 2026", "malformed"],
    [" 2026-01-02", "malformed"],
    [20260102, "malformed"],
    [{ y: 2026 }, "malformed"],
  ])("%p → %s", (value, cls) => {
    expect(classifyPublicationDate(value, "2026-10-13")).toBe(cls);
  });

  it("future is judged against the observation's UTC day, not local time", () => {
    const lateUtc = new Date("2026-10-13T23:59:59.999Z");
    const o = observeProviderSearchEvidence({
      result: slot(agent([{ type: "search_results", results: [entry({ date: "2026-10-13" }), entry({ date: "2026-10-14" })] }])),
      adaptive: NONE,
      observedAt: lateUtc,
    });
    expect(o).toMatchObject({ dateValid: 1, dateFuture: 1 });
  });

  it("counts every class across entries", () => {
    const o = observe(
      slot(agent([{ type: "search_results", results: [entry({ date: undefined }), entry({ date: "2026-01-01" }), entry({ date: "2026-02-30" }), entry({ date: "2030-01-01" })] }]))
    );
    expect(o).toMatchObject({ dateAbsent: 1, dateValid: 1, dateMalformed: 1, dateFuture: 1 });
  });
});

describe("last_updated is never the publication date", () => {
  it("present/absent only", () => {
    const o = observe(slot(agent([{ type: "search_results", results: [entry({ last_updated: "2026-03-01" }), entry({ last_updated: undefined }), entry({ last_updated: null })] }])));
    expect(o).toMatchObject({ lastUpdatedPresent: 1, lastUpdatedAbsent: 2 });
  });

  it("blank strings are absent; any other non-null value (0, false, a string) is present", () => {
    const o = observe(
      slot(agent([{ type: "search_results", results: [entry({ last_updated: "" }), entry({ last_updated: "  " }), entry({ last_updated: 0 }), entry({ last_updated: false })] }]))
    );
    expect(o).toMatchObject({ lastUpdatedPresent: 2, lastUpdatedAbsent: 2 });
  });

  it("a missing date is not filled from last_updated", () => {
    const o = observe(slot(agent([{ type: "search_results", results: [entry({ date: undefined, last_updated: "2026-03-01" })] }])));
    expect(o).toMatchObject({ dateAbsent: 1, dateValid: 0, lastUpdatedPresent: 1 });
  });

  it("a malformed last_updated does not influence the publication-date class", () => {
    const o = observe(slot(agent([{ type: "search_results", results: [entry({ date: "2026-01-02", last_updated: "garbage" })] }])));
    expect(o).toMatchObject({ dateValid: 1, dateMalformed: 0, lastUpdatedPresent: 1 });
  });
});

describe("eligibility (single Perplexity response, closed reasons)", () => {
  const good = () => agent([{ type: "search_results", results: [entry()] }]);
  const adaptive = (retryOutcome: unknown, retried?: unknown): AdaptiveSlotState => ({ kind: "result", retryOutcome, retried });

  it.each([
    ["normal Perplexity ok, non-adaptive run", slot(good()), NONE, true, null, "not_applicable"],
    ["adaptive run, no retry metadata", slot(good()), adaptive(undefined, undefined), true, null, "eligible"],
    ["failed_call", slot(good()), adaptive("failed_call"), true, null, "eligible"],
    ["no_change", slot(good()), adaptive("no_change", true), true, null, "eligible"],
    ["skipped_budget", slot(good()), adaptive("skipped_budget"), true, null, "eligible"],
    ["adopted_full", slot(good()), adaptive("adopted_full", true), false, "retry_ineligible", "ineligible"],
    ["adopted_partial", slot(good()), adaptive("adopted_partial", true), false, "retry_ineligible", "ineligible"],
    ["ineligible_substituted outcome", slot(good()), adaptive("ineligible_substituted"), false, "retry_ineligible", "ineligible"],
    ["unknown retry outcome fails closed", slot(good()), adaptive("adopted_everything"), false, "retry_ineligible", "ineligible"],
    ["legacy retried:true without outcome", slot(good()), adaptive(undefined, true), false, "retry_ineligible", "ineligible"],
    ["adaptive finalization unavailable", slot(good()), { kind: "unavailable" } as AdaptiveSlotState, false, "adaptive_state_unknown", "unknown"],
  ])("%s", (_label, result, adaptiveState, eligible, reason, retryEligibility) => {
    const o = observe(result as ModelResult, adaptiveState as AdaptiveSlotState);
    expect(o).toMatchObject({ eligible, ineligibilityReason: reason, retryEligibility });
  });

  it("DeepSeek-substituted slot (logical modelId perplexity) is never Perplexity evidence", () => {
    const o = observe(slot(good(), { status: "substituted", provider: "deepseek", substitutedFrom: "perplexity:perplexity/sonar" }));
    expect(o).toMatchObject({ provider: "deepseek", resultStatus: "substituted", eligible: false, ineligibilityReason: "substituted" });
  });

  it("provider identity comes from `provider`, not from `modelId`", () => {
    expect(observe(slot(good(), { provider: undefined }))).toMatchObject({ provider: "absent", eligible: false, ineligibilityReason: "provider_not_perplexity" });
    expect(observe(slot(good(), { provider: "openai" }))).toMatchObject({ provider: "other", ineligibilityReason: "provider_not_perplexity" });
  });

  it("result error (rawResponse retained) still yields shape diagnostics but is ineligible", () => {
    const o = observe(slot(agent([{ type: "search_results", results: [entry()] }], { status: "failed" }), { status: "error" }));
    expect(o).toMatchObject({ resultStatus: "error_or_other", responseShape: "agent", resultEntries: 1, eligible: false, ineligibilityReason: "result_not_ok" });
  });

  it("rawResponse absent", () => {
    expect(observe(slot(undefined))).toMatchObject({ responseShape: "absent", eligible: false, ineligibilityReason: "no_raw_response" });
  });

  it("legacy response / malformed Agent response", () => {
    expect(observe(slot({ choices: [{ message: { content: "x" } }] }))).toMatchObject({ ineligibilityReason: "legacy_response" });
    expect(observe(slot({ object: "response", status: "completed" }))).toMatchObject({ ineligibilityReason: "malformed_response" });
  });

  it("an Agent run that is not completed/usable is ineligible even with search results", () => {
    expect(observe(slot(agent([{ type: "search_results", results: [entry()] }], { status: "failed" })))).toMatchObject({
      ineligibilityReason: "agent_not_completed_or_usable",
    });
  });

  it("a truncated (max_output_tokens) Agent answer is usable", () => {
    const o = observe(slot(agent([{ type: "search_results", results: [entry()] }], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })));
    expect(o).toMatchObject({ eligible: true });
  });

  it("no search results / all privacy-dropped", () => {
    expect(observe(slot(agent([])))).toMatchObject({ ineligibilityReason: "no_search_results" });
    const allDropped = agent([{ type: "search_results", results: [entry({ url: "https://x.com/?api_key=1" }), entry({ url: "https://u:p@x.com/" })] }]);
    expect(observe(slot(allDropped))).toMatchObject({ privacyDroppedEntries: 2, ineligibilityReason: "no_safe_result_entries" });
  });

  it("every reason is in the closed enum, and an eligible observation has no reason", () => {
    expect([...PHASE0_INELIGIBILITY_REASONS].sort()).toEqual(
      [
        "adaptive_state_unknown",
        "agent_not_completed_or_usable",
        "legacy_response",
        "malformed_response",
        "no_raw_response",
        "no_safe_result_entries",
        "no_search_results",
        "provider_not_perplexity",
        "result_not_ok",
        "retry_ineligible",
        "substituted",
      ].sort()
    );
  });
});

describe("observation content and purity", () => {
  it("contains only numbers, booleans, null and closed enum strings — no URL, domain, title, snippet, date or text", () => {
    const raw = agent([
      { type: "search_results", results: [entry({ url: "https://secret-domain.example/path?q=private", title: "Private Title", snippet: "Private snippet", date: "2026-01-02" })] },
    ]);
    const o = observe(slot(raw, { rawText: "Private answer" }));
    const json = JSON.stringify(o);
    for (const needle of ["secret-domain", "example", "private", "Private", "2026-01-02", "Answer", "http", "Title", "snippet"]) {
      expect(json).not.toContain(needle);
    }
    const allowedStrings = new Set([
      "perplexity", "deepseek", "other", "absent", "ok", "substituted", "error_or_other", "agent", "legacy_chat", "malformed",
      "completed", "incomplete", "failed", "cancelled", "in_progress", "queued", "not_applicable", "eligible", "ineligible", "unknown",
      ...PHASE0_INELIGIBILITY_REASONS,
    ]);
    for (const [key, value] of Object.entries(o)) {
      if (typeof value === "string") expect(allowedStrings.has(value)).toBe(true);
      else expect(["number", "boolean"].includes(typeof value) || value === null).toBe(true);
      void key;
    }
  });

  it("has exactly the closed key set", () => {
    expect(Object.keys(observe(slot(agent([])))).sort()).toEqual(
      [
        "schemaVersion", "provider", "resultStatus", "responseShape", "agentStatus", "searchResultItems", "resultEntries", "malformedEntries",
        "urlUsable", "urlInvalid", "urlOverLimit", "privacyDroppedEntries", "dateAbsent", "dateValid", "dateMalformed", "dateFuture",
        "lastUpdatedPresent", "lastUpdatedAbsent", "retryEligibility", "safeEntries", "eligible", "ineligibilityReason",
      ].sort()
    );
  });

  it("never mutates rawResponse and never throws on hostile data", () => {
    const raw = agent([{ type: "search_results", results: [entry(), { url: { toString: () => "x" } }, { date: [], last_updated: 0 }] }]);
    const before = JSON.stringify(raw);
    Object.freeze(raw);
    expect(() => observe(slot(raw))).not.toThrow();
    expect(JSON.stringify(raw)).toBe(before);
    for (const hostile of [0, "str", true, [], { object: "response", status: 5, output: [] }, { object: "response", status: "completed", output: [null, 1, "x"] }]) {
      expect(() => observe(slot(hostile as any))).not.toThrow();
    }
  });
});

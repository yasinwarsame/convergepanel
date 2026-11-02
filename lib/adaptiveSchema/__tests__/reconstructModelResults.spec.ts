/**
 * Ruling B (2026-11-02): per-model results for reopened Milestone-2 reports are rebuilt from the saved responses with
 * the live validator, and carried by the read payload for Personal and Team alike.
 */
const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { reconstructModelResults, SAVED_COPY_SHORTENED, SAVED_COPY_UNSTRUCTURED } from "@/lib/adaptiveSchema/reconstructModelResults";
import { validateAdaptiveResponse } from "@/lib/adaptiveSchema/validator";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { buildRunReadPayload } from "@/lib/runs/runReadPayload";

const body = (m: string) => JSON.stringify({ subjects: [`${m} subject`], attributes: ["x"], cells: [], directConclusion: `${m} conclusion` });

describe("reconstructModelResults", () => {
  it("a responding row equals exactly what the live validator returns for the same saved text", () => {
    const [r] = reconstructModelResults("comparison_matrix", [{ modelId: "chatgpt", status: "ok", rawText: body("chatgpt") }]);
    expect(r).toEqual(validateAdaptiveResponse("chatgpt" as never, getResultSchema("comparison_matrix" as never), body("chatgpt")));
    expect(r.ok).toBe(true);
  });

  it("a row that did not respond is a failed slot exactly as live ('Empty response'), whatever text it carries", () => {
    const [r] = reconstructModelResults("comparison_matrix", [{ modelId: "gemini", status: "failed", rawText: "Gemini request failed. Please try again." }]);
    expect(r).toEqual({ modelId: "gemini", schemaId: "comparison_matrix", ok: false, data: null, parseError: "Empty response" });
  });

  it("a saved copy shortened by the storage cap says so; an unshortened non-validating copy gets the neutral saved-copy notice (never a format verdict)", () => {
    const cut = body("claude").slice(0, 25);
    const [short] = reconstructModelResults("comparison_matrix", [{ modelId: "claude", status: "ok", rawText: cut, wasTruncatedForStorage: true }]);
    expect([short.ok, short.parseError]).toEqual([false, SAVED_COPY_SHORTENED]);
    const [bad] = reconstructModelResults("comparison_matrix", [{ modelId: "claude", status: "ok", rawText: cut }]);
    expect(bad.ok).toBe(false);
    // Review R2 MINOR-A: a live retry is never saved, so a non-validating saved copy gets the neutral notice, never parse details.
    expect(bad.parseError).toBe(SAVED_COPY_UNSTRUCTURED);
  });

  it("a read logs nothing, even for unparseable text that a parse error would quote; live validation still logs", () => {
    mockWarn.mockClear();
    reconstructModelResults("comparison_matrix", [{ modelId: "claude", status: "ok", rawText: "SECRET-CONTENT not json" }, { modelId: "chatgpt", status: "ok", rawText: JSON.stringify({ subjects: 5 }) }]);
    expect(mockWarn).not.toHaveBeenCalled();
    validateAdaptiveResponse("claude" as never, getResultSchema("comparison_matrix" as never), "SECRET-CONTENT not json");
    expect(mockWarn).toHaveBeenCalled();
  });

  it("an unknown schema yields nothing rather than a guess", () => {
    expect(reconstructModelResults("not_a_schema", [{ modelId: "chatgpt", status: "ok", rawText: "{}" }])).toEqual([]);
  });
});

describe("buildRunReadPayload carries modelResults for a valid Milestone-2 envelope only", () => {
  const envelope = { version: 1, schemaId: "comparison_matrix", answerShape: "comparison_grid", classification: { queryType: "comparison_matrix", confidence: 0.9 }, meta: {}, generatedAt: "2026-09-01T00:00:00.000Z", result: { subjects: ["a"], attributes: ["x"], cells: [], totalModels: 2 } };
  const doc = (extra: Record<string, unknown>) => ({
    userId: "owner-1",
    question: "Q?",
    status: "complete",
    runDocument: { perModel: [
      { modelId: "chatgpt", status: "ok", rawTextTruncated: body("chatgpt"), tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 1, wasTruncated: false },
      { modelId: "gemini", status: "error", rawTextTruncated: "Gemini request failed.", tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 1, wasTruncated: false },
    ] },
    ...extra,
  });
  const read = (data: Record<string, unknown>, viewerRole: "owner" | "team_member" | "team_reviewer" = "owner") =>
    buildRunReadPayload({ mayReadDecisionContent: true, runId: "run-1", data, viewerRole, resolveReviewRouting: jest.fn().mockResolvedValue("not_configured") });

  it.each(["owner", "team_member", "team_reviewer"] as const)("%s: one entry per saved row, in order; the failed row is a failed slot", async (role) => {
    const p: any = await read(doc({ adaptiveOutput: envelope }), role);
    expect(p.adaptive.status).toBe("valid");
    expect(p.adaptive.modelResults.map((r: any) => [r.modelId, r.ok])).toEqual([["chatgpt", true], ["gemini", false]]);
    // Derived only from rows the same payload already returns to this viewer: no new data.
    expect(p.adaptive.modelResults.map((r: any) => r.modelId)).toEqual(p.results.map((r: any) => r.modelId));
  });

  it("no valid Milestone-2 envelope → no modelResults key at all (legacy and absent payloads unchanged)", async () => {
    const p: any = await read(doc({}));
    expect(p.adaptive.status).toBe("absent");
    expect("modelResults" in p.adaptive).toBe(false);
  });
});

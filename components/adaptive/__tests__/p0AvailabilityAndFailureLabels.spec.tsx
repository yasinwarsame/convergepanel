/**
 * D-3 / D-4 (shared Adaptive Schema architecture, 2026-11-02).
 *
 * D-4: a model the run records as not having responded is described as such. Production 2026-11-01 showed Gemini's
 * HTTP 402 as "returned an incompatible format… Details: Empty response". A model that DID respond with text that
 * failed validation keeps "incompatible format". A surface without the run's record keeps its original wording.
 * D-3: the analysis-availability notice states exactly which automated steps did not run, and nothing when all ran.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FailedResultsNote } from "@/components/adaptive/shared";
import { RunSlotStatusContext, didNotRespondText, slotDidNotRespond } from "@/components/adaptive/RunSlotStatusContext";
import AnalysisAvailabilityNotice, { ANALYSIS_NOTICE_LINES, analysisAvailabilityLines } from "@/components/adaptive/AnalysisAvailabilityNotice";
import { SAVED_COPY_SHORTENED, SAVED_COPY_UNSTRUCTURED } from "@/lib/adaptiveSchema/savedCopyNotice";

const failedRow = (modelId: string, parseError = "Empty response") => ({ modelId, schemaId: "generic", ok: false, data: null, parseError }) as never;
const html = (el: ReturnType<typeof createElement>, statuses?: Map<string, string>) =>
  renderToStaticMarkup(statuses ? createElement(RunSlotStatusContext.Provider, { value: statuses }, el) : el);

describe("D-4 failure labels", () => {
  it("a provider failure (recorded status error) says 'did not respond', never 'incompatible format', and shows no Details", () => {
    const out = html(createElement(FailedResultsNote, { failed: [failedRow("gemini")] }), new Map([["gemini", "error"], ["chatgpt", "ok"]]));
    expect(out).toContain("did not respond and was excluded from comparison.");
    // Review MINOR-1: the default claims no cause ("failed" covers timeouts, refusals and errors alike).
    expect(out).not.toContain("provider returned an error");
    expect(out).not.toContain("incompatible format");
    expect(out).not.toContain("Empty response");
  });

  it.each([
    ["timeout", "did not respond in time"],
    ["refused", "declined to answer"],
    ["rate_limited", "rate-limited by its provider"],
    ["failed (what saved rows actually record)", "did not respond and was excluded from comparison."],
  ])("recorded status %s → %s", (status, phrase) => {
    expect(html(createElement(FailedResultsNote, { failed: [failedRow("gemini")] }), new Map([["gemini", status]]))).toContain(phrase);
  });

  it("a model that RESPONDED (recorded ok) but failed validation keeps 'incompatible format' and its parse details", () => {
    const out = html(createElement(FailedResultsNote, { failed: [failedRow("claude", "Unexpected token")] }), new Map([["claude", "ok"]]));
    expect(out).toContain("returned an incompatible format");
    expect(out).toContain("Unexpected token");
    expect(out).not.toContain("did not respond");
  });

  it.each([
    ["shortened", SAVED_COPY_SHORTENED],
    ["unstructured", SAVED_COPY_UNSTRUCTURED],
  ])("review R2 MINOR-A: a reopened response whose saved copy is %s is described as such: never 'incompatible format', 'excluded' or parse details", (_l, notice) => {
    const out = html(createElement(FailedResultsNote, { failed: [failedRow("claude", notice)] }), new Map([["claude", "ok"]]));
    expect(out).toContain(notice.replaceAll("'", "&#x27;"));
    expect(out).not.toContain("incompatible format");
    expect(out).not.toContain("excluded");
    expect(out).not.toContain("Details");
    // Review R3 MINOR-1: the heading does not call a saved-copy row uncompared.
    expect(out).toContain("1 saved response can&#x27;t be shown here");
    expect(out).not.toContain("couldn&#x27;t be compared");
  });

  it("a mixed list (a real failure plus a saved-copy row) keeps the original heading for the real failure", () => {
    const out = html(createElement(FailedResultsNote, { failed: [failedRow("gemini"), failedRow("claude", SAVED_COPY_UNSTRUCTURED)] }), new Map([["gemini", "failed"], ["claude", "ok"]]));
    expect(out).toContain("2 models couldn&#x27;t be compared");
    expect(out).toContain("did not respond and was excluded from comparison.");
    expect(out).toContain(SAVED_COPY_UNSTRUCTURED.replaceAll("'", "&#x27;"));
  });

  it("without the run's record (no provider) the original wording is kept: it cannot tell a failure from a format problem", () => {
    const out = html(createElement(FailedResultsNote, { failed: [failedRow("gemini")] }));
    expect(out).toContain("returned an incompatible format");
  });

  it("helpers: ok/substituted and unknown slots are never 'did not respond'; the wording is fixed system text", () => {
    const m = new Map([["a", "ok"], ["b", "substituted"], ["c", ""], ["d", "error"]]);
    expect([slotDidNotRespond(m, "a"), slotDidNotRespond(m, "b"), slotDidNotRespond(m, "c"), slotDidNotRespond(m, "zz"), slotDidNotRespond(null, "d")]).toEqual([null, null, null, null, null]);
    expect(slotDidNotRespond(m, "d")).toBe("error");
    expect(didNotRespondText("anything-else")).toBe("did not respond and was excluded from comparison.");
  });
});

describe("D-3 analysis-availability notice", () => {
  const base = { queryType: "generic", confidence: 0 } as never;
  it.each([
    ["heuristic classification", { ...(base as object), queryType: "decision_support", classificationSource: "heuristic", fallbackReason: "connector_error" }, null, [ANALYSIS_NOTICE_LINES.heuristic]],
    ["default generic after a provider failure", { ...(base as object), fallbackReason: "connector_error" }, null, [ANALYSIS_NOTICE_LINES.generalFormat]],
    ["default generic after a timeout", { ...(base as object), fallbackReason: "timeout" }, null, [ANALYSIS_NOTICE_LINES.generalFormat]],
    ["low confidence (a model verdict, not a failure)", { ...(base as object), fallbackReason: "low_confidence" }, null, []],
    ["empty input", { ...(base as object), fallbackReason: "empty_query" }, null, []],
    ["model classification, synthesis ran", { queryType: "comparison_matrix", confidence: 0.9 }, { degraded: false }, []],
    ["degraded synthesis only", { queryType: "comparison_matrix", confidence: 0.9 }, { degraded: true }, [ANALYSIS_NOTICE_LINES.degraded]],
    ["heuristic + degraded", { ...(base as object), queryType: "causal_explanation", classificationSource: "heuristic", fallbackReason: "connector_error" }, { degraded: true }, [ANALYSIS_NOTICE_LINES.heuristic, ANALYSIS_NOTICE_LINES.degraded]],
  ])("%s", (_label, classification, synthesisReport, want) => {
    expect(analysisAvailabilityLines(classification as never, synthesisReport as never)).toEqual(want);
    const out = renderToStaticMarkup(createElement(AnalysisAvailabilityNotice, { classification: classification as never, synthesisReport: synthesisReport as never }));
    if ((want as string[]).length === 0) expect(out).toBe("");
    else for (const line of want as string[]) expect(out).toContain(line.replaceAll("'", "&#x27;"));
  });
});

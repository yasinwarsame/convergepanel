/**
 * Order 6 S-1b.2 — unit tests for `buildDsProvenanceP2View`, the P2 sibling of
 * the route adapter. The route-level acceptance suite is
 * app/api/user/runs/[runId]/governance/__tests__/dsProvenanceP2View.spec.ts.
 */

const mockBuilderCalls: unknown[] = [];
let mockBuilderResult: unknown = undefined;
jest.mock("../dsProvenanceViewMin", () => {
  const actual = jest.requireActual("../dsProvenanceViewMin");
  return {
    ...actual,
    buildDsProvenanceViewMin: (input: unknown) => {
      mockBuilderCalls.push(input);
      return mockBuilderResult !== undefined ? mockBuilderResult : actual.buildDsProvenanceViewMin(input);
    },
  };
});
const mockParseCalls: string[] = [];
jest.mock("../governanceRecordParser", () => {
  const actual = jest.requireActual("../governanceRecordParser");
  return { ...actual, parseGovernanceRecord: (r: unknown) => (mockParseCalls.push("governance"), actual.parseGovernanceRecord(r)) };
});
jest.mock("../persistedOutput", () => {
  const actual = jest.requireActual("../persistedOutput");
  return { ...actual, parsePersistedAdaptiveOutput: (o: unknown) => (mockParseCalls.push("output"), actual.parsePersistedAdaptiveOutput(o)) };
});

import { readFileSync } from "fs";
import { join } from "path";
import { buildDsProvenanceP2View, type DsProvenanceP2SurfaceRequest } from "../dsProvenanceRouteAdapter";

const G = JSON.parse(readFileSync(join(__dirname, "fixtures", "dsProvenanceViewMin.goldens.json"), "utf-8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const DS_OUTPUT = () => clone(G.fixtures.adaptive["r10f:R1-02"]);
const RECORD = (key: string) => clone(G.fixtures.governance[key].record);

const OWNER: DsProvenanceP2SurfaceRequest = { surfaceId: "P2", role: "owner", mayReadDecisionReviewer: true };
const REVIEWER_DENIED: DsProvenanceP2SurfaceRequest = { surfaceId: "P2", role: "personal_reviewer", mayReadDecisionReviewer: false };

const p2 = (over: Partial<Parameters<typeof buildDsProvenanceP2View>[0]> = {}) =>
  buildDsProvenanceP2View({ enabled: true, surfaceRequest: OWNER, storedAdaptiveOutput: DS_OUTPUT(), governanceRecord: RECORD("R12T:approved"), ...over });

const L4_STATIC = [
  "option_clustering_unverified", "option_clustering_unverified_text", "option_clustering_unverified_knownDefect", "evidence_self_reported", "sources_unchecked",
  "freshness_not_evaluated", "retry_text_not_retained", "rules_unversioned", "historical_rules_unknown", "review_history_not_shown", "review_history_not_shown_text",
];

beforeEach(() => {
  mockBuilderCalls.length = 0;
  mockParseCalls.length = 0;
  mockBuilderResult = undefined;
});

describe("flag", () => {
  it.each([false, undefined, "true", 1, null])("enabled=%p → null; nothing parsed, builder never called", (enabled) => {
    expect(p2({ enabled: enabled as boolean })).toBeNull();
    expect(mockParseCalls).toEqual([]);
    expect(mockBuilderCalls).toHaveLength(0);
  });

  it("enabled=true with a readable review on a Decision Support output → the P2 view, built once", () => {
    const view = p2();
    expect(view).toEqual({
      kind: "ds_provenance_min",
      version: 1,
      surfaceId: "P2",
      l4: expect.any(Object),
      humanReview: { state: "decided", decision: "approved", reviewedContent: "run_result_by_id_only", reviewedAt: "2026-10-02T00:00:00.000Z" },
      useAuthorization: "not_authorized_no_policy",
    });
    expect(Object.keys(view!)).toEqual(["kind", "version", "surfaceId", "l4", "humanReview", "useAuthorization"]);
    expect(Object.keys(view!.l4)).toEqual(L4_STATIC);
    expect(mockBuilderCalls).toHaveLength(1);
  });
});

describe("R11-OPEN-1: only when the record parses (the P2 response already carries a usable review)", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["malformed", RECORD("R12P:malformed_status")],
    ["unsupported_version", RECORD("R12P:unsupported_version")],
    ["non_object", "corrupt"],
  ])("record %s → null; output never parsed, builder never called", (_name, record) => {
    expect(p2({ governanceRecord: record })).toBeNull();
    expect(mockParseCalls).toEqual(["governance"]);
    expect(mockBuilderCalls).toHaveLength(0);
  });

  it.each([
    ["absent", undefined],
    ["malformed", { version: 1, schemaId: "decision_support" }],
    ["unsupported", { version: 2 }],
  ])("stored output %s → null, builder never called", (_name, output) => {
    expect(p2({ storedAdaptiveOutput: output })).toBeNull();
    expect(mockParseCalls).toEqual(["governance", "output"]);
    expect(mockBuilderCalls).toHaveLength(0);
  });

  it("a non-Decision-Support output with a readable review → null", () => {
    const output = { version: 1, schemaId: "deep_research", answerShape: "deep_research_view", classification: { queryType: "deep_research", confidence: 0.9 }, meta: {}, generatedAt: "2026-09-01T00:00:00.000Z", result: { executiveSummary: "S", findings: [], lowConfidenceFindings: [], totalModels: 1 } };
    expect(p2({ storedAdaptiveOutput: output })).toBeNull();
    expect(mockBuilderCalls).toHaveLength(1);
  });
});

describe("D-11(A) on P2", () => {
  it("never decidedVia or conditions, for any record", () => {
    for (const key of ["L5T:TEAM_PANEL_AWC", "L5T:TEAM_OVERRIDE_AWC", "L5P:PERSONAL_SELF_AWC", "R12P2:decidedVia_single_reviewer", "R12T:decidedVia_unknown_string_NON_WRITER"]) {
      const view = p2({ governanceRecord: RECORD(key) });
      expect([key, "decidedVia" in view!.humanReview, "conditions" in view!.humanReview]).toEqual([key, false, false]);
    }
  });

  it("reviewedAt only through the reviewer-identity gate, and only for a single-reviewer decision", () => {
    expect(p2({ surfaceRequest: REVIEWER_DENIED })!.humanReview).toEqual({ state: "decided", decision: "approved", reviewedContent: "run_result_by_id_only" });
    expect("reviewedAt" in p2({ governanceRecord: RECORD("L5T:TEAM_PANEL_AWC") })!.humanReview).toBe(false);
    expect(p2({ governanceRecord: RECORD("R12P2:decidedVia_single_reviewer") })!.humanReview.reviewedAt).toBe("2026-10-25T20:06:06.189Z");
  });
});

describe("fail closed: anything other than an exact P2 view is omitted", () => {
  it.each([
    ["not_built", { kind: "not_built", version: 1, reason: "viewer_context_mismatch" }],
    ["humanReviewUnavailable", { kind: "ds_provenance_min", version: 1, surfaceId: "P2", l4: {}, humanReviewUnavailable: true, useAuthorization: "not_authorized_no_policy" }],
    ["state:none", { kind: "ds_provenance_min", version: 1, surfaceId: "P2", l4: {}, humanReview: { state: "none" }, useAuthorization: "not_authorized_no_policy" }],
    ["a P1 view", { kind: "ds_provenance_min", version: 1, surfaceId: "P1", l4: {}, humanReview: { state: "pending", decision: "pending", reviewedContent: "run_result_by_id_only" }, useAuthorization: "not_authorized_no_policy" }],
    ["L1 present", { kind: "ds_provenance_min", version: 1, surfaceId: "P2", l1: { slots: "unknown" }, l4: {}, humanReview: { state: "pending", decision: "pending", reviewedContent: "run_result_by_id_only" }, useAuthorization: "not_authorized_no_policy" }],
    ["an extra top-level key", { kind: "ds_provenance_min", version: 1, surfaceId: "P2", l4: {}, humanReview: { state: "pending", decision: "pending", reviewedContent: "run_result_by_id_only" }, useAuthorization: "not_authorized_no_policy", extra: true }],
    ["keys out of order", { version: 1, kind: "ds_provenance_min", surfaceId: "P2", l4: {}, humanReview: { state: "pending", decision: "pending", reviewedContent: "run_result_by_id_only" }, useAuthorization: "not_authorized_no_policy" }],
    ["decidedVia", { kind: "ds_provenance_min", version: 1, surfaceId: "P2", l4: {}, humanReview: { state: "decided", decision: "approved", reviewedContent: "run_result_by_id_only", decidedVia: "single_or_legacy" }, useAuthorization: "not_authorized_no_policy" }],
    ["conditions", { kind: "ds_provenance_min", version: 1, surfaceId: "P2", l4: {}, humanReview: { state: "decided", decision: "approved", reviewedContent: "run_result_by_id_only", conditions: [] }, useAuthorization: "not_authorized_no_policy" }],
    ["no humanReview", { kind: "ds_provenance_min", version: 1, surfaceId: "P2", l4: {}, useAuthorization: "not_authorized_no_policy", humanReview: undefined }],
  ])("a builder result with %s is never returned", (_name, result) => {
    mockBuilderResult = result;
    expect(p2()).toBeNull();
  });

  it("an owner context the builder rejects (mayReadDecisionReviewer false) → null", () => {
    expect(p2({ surfaceRequest: { surfaceId: "P2", role: "owner", mayReadDecisionReviewer: false } })).toBeNull();
  });
});

describe("pass-through and purity", () => {
  it("hands the builder the parsed stored output, the raw record and the route's context, unchanged; no results", () => {
    const record = RECORD("L5P:PERSONAL_SELF_AWC");
    const output = DS_OUTPUT();
    p2({ surfaceRequest: REVIEWER_DENIED, storedAdaptiveOutput: output, governanceRecord: record });
    expect(mockBuilderCalls).toHaveLength(1);
    const input = mockBuilderCalls[0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["governanceRecord", "publicAdaptiveOutput", "publicResults", "surfaceRequest"]);
    expect(input.publicResults).toBeNull();
    expect(input.publicAdaptiveOutput).toEqual(output);
    expect(input.governanceRecord).toBe(record);
    expect(input.surfaceRequest).toBe(REVIEWER_DENIED);
  });

  it("does not mutate its inputs", () => {
    const record = RECORD("L5T:TEAM_PANEL_AWC");
    const output = DS_OUTPUT();
    const before = JSON.stringify([output, record, OWNER]);
    p2({ storedAdaptiveOutput: output, governanceRecord: record });
    expect(JSON.stringify([output, record, OWNER])).toBe(before);
  });
});

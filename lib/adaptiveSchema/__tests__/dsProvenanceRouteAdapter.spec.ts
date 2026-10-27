/**
 * Order 6 S-1b.1 — unit tests for `buildDsProvenanceRouteView`, the P1/W1
 * route adapter. The route-level acceptance suite is
 * app/api/user/runs/[runId]/__tests__/dsProvenanceRouteView.spec.ts.
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

import { readFileSync } from "fs";
import { join } from "path";
import { buildDsProvenanceRouteView, type DsProvenanceRouteSurfaceRequest } from "../dsProvenanceRouteAdapter";
import { parsePersistedAdaptiveOutput } from "../persistedOutput";
import { parseGovernanceRecord } from "../governanceRecordParser";
import type { RunReadPayload } from "@/lib/runs/runReadPayload";

const G = JSON.parse(readFileSync(join(__dirname, "fixtures", "dsProvenanceViewMin.goldens.json"), "utf-8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const DS_OUTPUT = () => clone(G.fixtures.adaptive["r10f:R1-02"]);
const RECORD = (key: string) => clone(G.fixtures.governance[key].record);
const RESULTS = [{ modelId: "chatgpt", status: "ok", provider: "openai", requestedModel: "gpt-5" }];

/** A payload exactly as `buildRunReadPayload` shapes it for a valid adaptive output and a readable record. */
function payloadFor(output: unknown, record: unknown): Pick<RunReadPayload, "results" | "adaptive"> {
  const parsed = parsePersistedAdaptiveOutput(output);
  if (!parsed.ok) return { results: RESULTS as never, adaptive: { status: parsed.reason, output: null, humanReview: null, reviewRouting: "unknown", automatedGovernance: null } };
  const gov = parseGovernanceRecord(record);
  return {
    results: RESULTS as never,
    adaptive: { status: "valid", output: parsed.output, humanReview: gov.ok ? { status: gov.record.humanReview.status } : null, reviewRouting: "unknown", automatedGovernance: null },
  };
}

const OWNER: DsProvenanceRouteSurfaceRequest = { surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: true };
const W1_MEMBER: DsProvenanceRouteSurfaceRequest = { surfaceId: "W1", role: "team_member" };

beforeEach(() => {
  mockBuilderCalls.length = 0;
  mockBuilderResult = undefined;
});

describe("flag", () => {
  it.each([false, undefined, "true", 1, null])("enabled=%p → null, builder never called", (enabled) => {
    const record = RECORD("L5T:TEAM_PANEL_AWC");
    expect(buildDsProvenanceRouteView({ enabled: enabled as boolean, surfaceRequest: OWNER, payload: payloadFor(DS_OUTPUT(), record), governanceRecord: record })).toBeNull();
    expect(mockBuilderCalls).toHaveLength(0);
  });

  it("enabled=true with a usable review → the builder's view, built once", () => {
    const record = RECORD("L5T:TEAM_PANEL_AWC");
    const view = buildDsProvenanceRouteView({ enabled: true, surfaceRequest: OWNER, payload: payloadFor(DS_OUTPUT(), record), governanceRecord: record });
    expect(view?.kind).toBe("ds_provenance_min");
    expect(view?.surfaceId).toBe("P1");
    expect(mockBuilderCalls).toHaveLength(1);
  });
});

describe("R11-OPEN-1: only when the payload already carries a usable review", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["malformed", RECORD("R12P:malformed_status")],
    ["unsupported_version", RECORD("R12P:unsupported_version")],
    ["non_object", "corrupt"],
  ])("record %s → null, builder never called", (_name, record) => {
    expect(buildDsProvenanceRouteView({ enabled: true, surfaceRequest: OWNER, payload: payloadFor(DS_OUTPUT(), record), governanceRecord: record })).toBeNull();
    expect(mockBuilderCalls).toHaveLength(0);
  });

  it.each([
    ["absent", undefined],
    ["malformed", { version: 1, schemaId: "decision_support" }],
    ["unsupported", { version: 2 }],
  ])("adaptive output %s → null, builder never called", (_name, output) => {
    const record = RECORD("R12T:approved");
    expect(buildDsProvenanceRouteView({ enabled: true, surfaceRequest: OWNER, payload: payloadFor(output, record), governanceRecord: record })).toBeNull();
    expect(mockBuilderCalls).toHaveLength(0);
  });

  it("an inconsistent payload (review claimed, record unreadable or absent) never yields the marker or state:none", () => {
    for (const record of [undefined, RECORD("R12P:malformed_status")]) {
      const payload = payloadFor(DS_OUTPUT(), RECORD("R12T:approved"));
      expect(payload.adaptive.humanReview).not.toBeNull();
      expect(buildDsProvenanceRouteView({ enabled: true, surfaceRequest: OWNER, payload, governanceRecord: record })).toBeNull();
    }
    expect(mockBuilderCalls).toHaveLength(2);
  });
});

describe("fail closed: anything other than a built view is omitted", () => {
  it("a non-Decision-Support output with a readable review → null", () => {
    const output = { version: 1, schemaId: "deep_research", answerShape: "deep_research_view", classification: { queryType: "deep_research", confidence: 0.9 }, meta: {}, generatedAt: "2026-09-01T00:00:00.000Z", result: { executiveSummary: "S", findings: [], lowConfidenceFindings: [], totalModels: 1 } };
    const record = RECORD("R12T:approved");
    const payload = payloadFor(output, record);
    expect(payload.adaptive.status).toBe("valid");
    expect(buildDsProvenanceRouteView({ enabled: true, surfaceRequest: OWNER, payload, governanceRecord: record })).toBeNull();
    expect(mockBuilderCalls).toHaveLength(1);
  });

  it.each([
    ["P1 team path with a personal role", { surfaceId: "P1", path: "team_bound", role: "personal_reviewer", mayReadDecisionContent: true }],
    ["P1 team path without content authority", { surfaceId: "P1", path: "team_bound", role: "team_member", mayReadDecisionContent: false }],
    ["P1 personal path with a Team role", { surfaceId: "P1", path: "personal", role: "team_member", mayReadDecisionContent: true }],
    ["P1 owner without content authority", { surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: false }],
    ["W1 with a personal role", { surfaceId: "W1", role: "owner" }],
  ])("context mismatch (%s) → null", (_name, surfaceRequest) => {
    const record = RECORD("R12T:approved");
    expect(buildDsProvenanceRouteView({ enabled: true, surfaceRequest: surfaceRequest as DsProvenanceRouteSurfaceRequest, payload: payloadFor(DS_OUTPUT(), record), governanceRecord: record })).toBeNull();
  });

  it.each([
    ["not_built", { kind: "not_built", version: 1, reason: "viewer_context_mismatch" }],
    ["humanReviewUnavailable", { kind: "ds_provenance_min", version: 1, surfaceId: "P1", l4: {}, humanReviewUnavailable: true, useAuthorization: "not_authorized_no_policy" }],
    ["state:none", { kind: "ds_provenance_min", version: 1, surfaceId: "P1", l4: {}, humanReview: { state: "none" }, useAuthorization: "not_authorized_no_policy" }],
  ])("a builder result of %s is never returned", (_name, result) => {
    mockBuilderResult = result;
    const record = RECORD("R12T:approved");
    expect(buildDsProvenanceRouteView({ enabled: true, surfaceRequest: OWNER, payload: payloadFor(DS_OUTPUT(), record), governanceRecord: record })).toBeNull();
  });
});

describe("pass-through and purity", () => {
  it("hands the builder exactly the route's projection, record and context, unchanged", () => {
    const record = RECORD("L5T:TEAM_PANEL_AWC");
    const payload = payloadFor(DS_OUTPUT(), record);
    buildDsProvenanceRouteView({ enabled: true, surfaceRequest: W1_MEMBER, payload, governanceRecord: record });
    expect(mockBuilderCalls).toHaveLength(1);
    const input = mockBuilderCalls[0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["governanceRecord", "publicAdaptiveOutput", "publicResults", "surfaceRequest"]);
    expect(input.publicResults).toBe(payload.results);
    expect(input.publicAdaptiveOutput).toBe(payload.adaptive.output);
    expect(input.governanceRecord).toBe(record);
    expect(input.surfaceRequest).toBe(W1_MEMBER);
  });

  it("does not mutate its inputs", () => {
    const record = RECORD("L5T:TEAM_PANEL_AWC");
    const payload = payloadFor(DS_OUTPUT(), record);
    const before = JSON.stringify([payload, record, OWNER]);
    buildDsProvenanceRouteView({ enabled: true, surfaceRequest: OWNER, payload, governanceRecord: record });
    expect(JSON.stringify([payload, record, OWNER])).toBe(before);
  });

  it("W1 and P1 views of the same run differ only in surfaceId", () => {
    const record = RECORD("L5T:TEAM_OVERRIDE_AWC");
    const payload = payloadFor(DS_OUTPUT(), record);
    const p1 = buildDsProvenanceRouteView({ enabled: true, surfaceRequest: { surfaceId: "P1", path: "team_bound", role: "team_member", mayReadDecisionContent: true }, payload, governanceRecord: record });
    const w1 = buildDsProvenanceRouteView({ enabled: true, surfaceRequest: W1_MEMBER, payload, governanceRecord: record });
    expect(p1?.surfaceId).toBe("P1");
    expect(w1?.surfaceId).toBe("W1");
    expect({ ...w1, surfaceId: "P1" }).toEqual(p1);
  });
});

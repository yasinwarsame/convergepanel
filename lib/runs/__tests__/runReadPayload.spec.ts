/**
 * Team Research Parity, Phase R1 — `buildRunReadPayload()` contract.
 * Real parsers, real rehydration, real claim-id attachment; only the
 * injected review-routing resolver is a test double (it is the builder's
 * ONLY I/O seam and must be called exactly when the route always did).
 */
import { buildRunReadPayload } from "@/lib/runs/runReadPayload";
import {
  FIXTURE_OWNER_UID,
  FIXTURE_RUN_ID,
  comparisonMatrixAdaptiveOutput,
  deepResearchAdaptiveOutput,
  fullTeamRunData,
  governanceRecord,
  legacyAdaptiveOutput,
} from "./runReadFixtures";

function resolver(value: "in_queue" | "not_configured" | "unknown" = "in_queue") {
  return jest.fn().mockResolvedValue(value);
}

describe("buildRunReadPayload — envelope interpretation", () => {
  it("emits the frozen key order and every persisted envelope for an owner", async () => {
    const data = fullTeamRunData();
    const r = resolver();
    const payload = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data, viewerRole: "owner", resolveReviewRouting: r });
    expect(Object.keys(payload)).toEqual(["ok", "runId", "viewerRole", "question", "selectedModels", "status", "results", "synthesisCache", "governance", "governanceStatus", "adaptive", "legacyAdaptive"]);
    expect(payload.ok).toBe(true);
    expect(payload.runId).toBe(FIXTURE_RUN_ID);
    expect(payload.viewerRole).toBe("owner");
    expect(payload.question).toBe("What should we build?");
    expect(payload.selectedModels).toEqual(["chatgpt", "claude"]);
    expect(payload.status).toBe("complete");
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0]).toMatchObject({ modelId: "chatgpt", tokenUsage: { totalTokens: 3 }, latencyMs: 120 });
    expect(payload.synthesisCache).toEqual({ report: { headline: "Report" }, schemaVersion: 1, synthesizedBy: "claude", consensusSummary: { agreement: 0.8 } });
    expect(payload.governance).toEqual({ governanceReviewRequired: true, blockedByPolicy: false, policyBlockMessage: undefined, policyFlags: ["pii"] });
    expect(payload.governanceStatus).toBe("needs_review");
    expect(payload.adaptive.status).toBe("valid");
    expect(payload.legacyAdaptive).toEqual({ status: "valid", output: legacyAdaptiveOutput() });
  });

  it("prefers runDocument.perModel and only falls back to the legacy results[] when rehydration is empty", async () => {
    const withBoth = fullTeamRunData({ results: [{ modelId: "grok", status: "ok", rawText: "legacy row" }] });
    const a = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: withBoth, viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(a.results.map((r) => r.modelId)).toEqual(["chatgpt", "claude"]);

    const legacyOnly = fullTeamRunData({ runDocument: undefined, results: [{ modelId: "grok", status: "ok", rawText: "legacy row" }] });
    const b = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: legacyOnly, viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(b.results).toHaveLength(1);
    expect(b.results[0]).toMatchObject({ modelId: "grok" });

    const neither = fullTeamRunData({ runDocument: undefined, results: undefined });
    const c = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: neither, viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(c.results).toEqual([]);
  });

  it("synthesisCache requires BOTH a report and schemaVersion 1; synthesizedBy defaults to 'cached'; consensus defaults to null", async () => {
    const noVersion = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ schemaVersion: 2 }), viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(noVersion.synthesisCache).toBeNull();
    const noReport = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ synthesizedStructuredReport: undefined }), viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(noReport.synthesisCache).toBeNull();
    const defaults = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ synthesizedBy: undefined, synthesisConsensusSummary: undefined }), viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(defaults.synthesisCache).toEqual({ report: { headline: "Report" }, schemaVersion: 1, synthesizedBy: "cached", consensusSummary: null });
  });

  it("governanceStatus accepts only the three org statuses; governance is null when teamGovernance carries no signal", async () => {
    const bogus = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ governanceStatus: "weird", teamGovernance: { policyFlags: [], blocked: false, blockMessage: "", governanceReviewRequired: false } }), viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(bogus.governanceStatus).toBeNull();
    expect(bogus.governance).toBeNull();
    const blocked = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ governanceStatus: "blocked", teamGovernance: { blocked: true, blockMessage: "Stop" } }), viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(blocked.governanceStatus).toBe("blocked");
    expect(blocked.governance).toEqual({ governanceReviewRequired: false, blockedByPolicy: true, policyBlockMessage: "Stop", policyFlags: undefined });
  });

  it("adaptive: absent / unsupported_version / malformed are distinct non-error states with null output, null humanReview and reviewRouting 'unknown'", async () => {
    for (const [raw, reason] of [
      [undefined, "absent"],
      [{ ...deepResearchAdaptiveOutput(), version: 2 }, "unsupported_version"],
      [{ ...deepResearchAdaptiveOutput(), answerShape: "ranked_list" }, "malformed"],
    ] as const) {
      const r = resolver();
      const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ adaptiveOutput: raw }), viewerRole: "owner", resolveReviewRouting: r });
      expect(p.adaptive).toEqual({ status: reason, output: null, humanReview: null, reviewRouting: "unknown" });
      // Without a valid adaptive envelope governance is never consulted, so no review-routing I/O either.
      expect(r).not.toHaveBeenCalled();
    }
  });

  it("legacyAdaptive is parsed independently of adaptive — a legacy-only run is adaptive 'absent' AND legacyAdaptive 'valid'", async () => {
    const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ adaptiveOutput: undefined, governanceRecord: undefined }), viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(p.adaptive.status).toBe("absent");
    expect(p.legacyAdaptive.status).toBe("valid");
    const malformed = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ legacyAdaptiveOutput: { version: 1, schemaId: "procedural" } }), viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(malformed.legacyAdaptive).toEqual({ status: "malformed", output: null });
  });

  it("humanReview carries status/conditions/decidedVia only — never reviewer id, name or comment", async () => {
    const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ governanceRecord: governanceRecord("approved_with_conditions") }), viewerRole: "owner", resolveReviewRouting: resolver() });
    expect(p.adaptive.status).toBe("valid");
    if (p.adaptive.status !== "valid") throw new Error("unreachable");
    expect(p.adaptive.humanReview).toEqual({ status: "approved_with_conditions", conditions: ["cond-a"], decidedVia: "workspace_review" });
    expect(JSON.stringify(p)).not.toContain("rev-secret");
    expect(JSON.stringify(p)).not.toContain("Secret Name");
    expect(JSON.stringify(p)).not.toContain("secret comment");
  });

  it("a malformed governanceRecord beside a valid adaptive envelope yields humanReview null and no review-routing I/O", async () => {
    const r = resolver();
    const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ governanceRecord: { version: 1 } }), viewerRole: "owner", resolveReviewRouting: r });
    if (p.adaptive.status !== "valid") throw new Error("expected valid adaptive");
    expect(p.adaptive.humanReview).toBeNull();
    expect(p.adaptive.reviewRouting).toBe("unknown");
    expect(r).not.toHaveBeenCalled();
  });
});

describe("buildRunReadPayload — review routing seam", () => {
  it.each(["unreviewed", "pending"])("status %s → resolver called once with runId, the RUN OWNER uid and the requestId; its value is surfaced", async (status) => {
    const r = resolver("not_configured");
    const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ governanceRecord: governanceRecord(status) }), viewerRole: "team_member", requestId: "req-1", resolveReviewRouting: r });
    expect(r).toHaveBeenCalledTimes(1);
    expect(r).toHaveBeenCalledWith({ runId: FIXTURE_RUN_ID, ownerUid: FIXTURE_OWNER_UID, requestId: "req-1" });
    if (p.adaptive.status !== "valid") throw new Error("expected valid adaptive");
    expect(p.adaptive.reviewRouting).toBe("not_configured");
  });

  it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"])("decided status %s → resolver NOT called; reviewRouting stays 'unknown'", async (status) => {
    const r = resolver();
    const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ governanceRecord: governanceRecord(status) }), viewerRole: "owner", resolveReviewRouting: r });
    expect(r).not.toHaveBeenCalled();
    if (p.adaptive.status !== "valid") throw new Error("expected valid adaptive");
    expect(p.adaptive.reviewRouting).toBe("unknown");
  });
});

describe("buildRunReadPayload — deep research claim ids and redaction", () => {
  it("attaches deterministic claimIds to deep_research findings at response time without mutating the input document", async () => {
    const data = fullTeamRunData();
    const before = JSON.stringify(data);
    const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data, viewerRole: "owner", resolveReviewRouting: resolver() });
    if (p.adaptive.status !== "valid" || p.adaptive.output.schemaId !== "deep_research") throw new Error("expected deep_research");
    const findings = p.adaptive.output.result.findings as Array<{ claimId?: string | null }>;
    expect(findings.every((f) => typeof f.claimId === "string" && f.claimId.length > 0)).toBe(true);
    const low = p.adaptive.output.result.lowConfidenceFindings as Array<{ claimId?: string | null }>;
    expect(typeof low[0].claimId).toBe("string");
    expect(JSON.stringify(data)).toBe(before);
    // Deterministic: same run + same finding → same id.
    const again = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData(), viewerRole: "owner", resolveReviewRouting: resolver() });
    if (again.adaptive.status !== "valid") throw new Error("unreachable");
    expect((again.adaptive.output.result as { findings: Array<{ claimId?: string }> }).findings[0].claimId).toBe(findings[0].claimId);
  });

  it("does not attach claimIds to a non-deep_research envelope", async () => {
    const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData({ adaptiveOutput: comparisonMatrixAdaptiveOutput(), governanceRecord: governanceRecord("approved", { schemaId: "comparison_matrix", answerShape: "comparison_grid" }) }), viewerRole: "owner", resolveReviewRouting: resolver() });
    if (p.adaptive.status !== "valid") throw new Error("expected valid adaptive");
    expect(p.adaptive.output).toEqual(comparisonMatrixAdaptiveOutput());
  });

  it.each(["personal_reviewer", "team_reviewer"] as const)("%s loses tokenUsage and latencyMs on every row, same length and other fields intact", async (role) => {
    const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData(), viewerRole: role, resolveReviewRouting: resolver() });
    expect(p.viewerRole).toBe(role);
    expect(p.results).toHaveLength(2);
    for (const row of p.results as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty("tokenUsage");
      expect(row).not.toHaveProperty("latencyMs");
      expect(typeof row.modelId).toBe("string");
      expect(typeof row.rawText).toBe("string");
    }
  });

  it.each(["owner", "team_member"] as const)("%s keeps tokenUsage and latencyMs", async (role) => {
    const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: FIXTURE_RUN_ID, data: fullTeamRunData(), viewerRole: role, resolveReviewRouting: resolver() });
    for (const row of p.results as Array<Record<string, unknown>>) {
      expect(row).toHaveProperty("tokenUsage");
      expect(row).toHaveProperty("latencyMs");
    }
  });
});

/**
 * Evidence Workspace, Phase 11A.4 — proves `attachDeepResearchClaimIds()`
 * attaches the exact same selector `resolveClaimVerificationOrigin()` would
 * later independently re-verify (same runId/section/index/rawId/summary
 * inputs, via the same `buildDeepResearchClaimId()`), and that it never
 * mutates its input — the object a caller might separately persist must
 * come out identical.
 */

import { attachDeepResearchClaimIds } from "@/lib/verification/attachDeepResearchClaimIds";
import { buildDeepResearchClaimId } from "@/lib/verification/claimVerificationOrigin";
import type { AggregatedResearchFinding, DeepResearchResult } from "@/lib/adaptiveSchema/types";

function makeFinding(overrides: Partial<AggregatedResearchFinding> & { id: string; summary: string }): AggregatedResearchFinding {
  return {
    title: overrides.title ?? "A finding",
    category: "General",
    evidenceStrength: "unknown",
    sourceBacked: false,
    sources: [],
    coverageCount: 1,
    totalModels: 1,
    coverageRatio: 1,
    contributingModels: ["claude"],
    ...overrides,
  };
}

function makeResult(findings: AggregatedResearchFinding[], lowConfidenceFindings: AggregatedResearchFinding[] = []): DeepResearchResult {
  return {
    executiveSummary: "x",
    findings,
    lowConfidenceFindings,
    disagreements: [],
    evidenceGaps: [],
    openQuestions: [],
    panelBlindSpots: [],
    researchBoundaries: [],
    recommendedNextSteps: [],
    sourceCoverage: { findingsWithSources: 0, totalFindings: findings.length, coverageRatio: 0 },
    totalModels: 1,
  };
}

describe("attachDeepResearchClaimIds", () => {
  it("attaches the exact selector buildDeepResearchClaimId itself would produce for each finding", () => {
    const f0 = makeFinding({ id: "raw-0", summary: "First finding." });
    const f1 = makeFinding({ id: "raw-1", summary: "Second finding." });
    const result = makeResult([f0, f1]);
    const augmented = attachDeepResearchClaimIds("run-1", result);

    expect(augmented.findings[0].claimId).toBe(buildDeepResearchClaimId({ runId: "run-1", section: "findings", index: 0, finding: f0 }));
    expect(augmented.findings[1].claimId).toBe(buildDeepResearchClaimId({ runId: "run-1", section: "findings", index: 1, finding: f1 }));
  });

  it("attaches selectors to lowConfidenceFindings using the lowConfidenceFindings section", () => {
    const lc0 = makeFinding({ id: "raw-lc-0", summary: "A low-confidence finding." });
    const result = makeResult([], [lc0]);
    const augmented = attachDeepResearchClaimIds("run-1", result);
    expect(augmented.lowConfidenceFindings[0].claimId).toBe(
      buildDeepResearchClaimId({ runId: "run-1", section: "lowConfidenceFindings", index: 0, finding: lc0 })
    );
  });

  it("binds runId — the identical finding at the identical position gets a DIFFERENT selector for a different runId", () => {
    const f0 = makeFinding({ id: "raw-0", summary: "Same content." });
    const result = makeResult([f0]);
    const a = attachDeepResearchClaimIds("run-A", result);
    const b = attachDeepResearchClaimIds("run-B", result);
    expect(a.findings[0].claimId).not.toBe(b.findings[0].claimId);
  });

  it("does not mutate the original findings array or finding objects", () => {
    const f0 = makeFinding({ id: "raw-0", summary: "Untouched." });
    const result = makeResult([f0]);
    const originalFindingsRef = result.findings;
    const originalFinding0 = result.findings[0];
    attachDeepResearchClaimIds("run-1", result);
    expect(result.findings).toBe(originalFindingsRef);
    expect(result.findings[0]).toBe(originalFinding0);
    expect(Object.prototype.hasOwnProperty.call(originalFinding0, "claimId")).toBe(false);
  });

  it("returns a new top-level object and new array references, never the same object", () => {
    const result = makeResult([makeFinding({ id: "raw-0", summary: "x" })]);
    const augmented = attachDeepResearchClaimIds("run-1", result);
    expect(augmented).not.toBe(result);
    expect(augmented.findings).not.toBe(result.findings);
    expect(augmented.lowConfidenceFindings).not.toBe(result.lowConfidenceFindings);
  });

  it("preserves every other field on the result and on each finding unchanged", () => {
    const f0 = makeFinding({ id: "raw-0", summary: "Preserved.", title: "Title", coverageCount: 3, totalModels: 4 });
    const result = makeResult([f0]);
    const augmented = attachDeepResearchClaimIds("run-1", result);
    expect(augmented.executiveSummary).toBe(result.executiveSummary);
    expect(augmented.findings[0].title).toBe("Title");
    expect(augmented.findings[0].summary).toBe("Preserved.");
    expect(augmented.findings[0].coverageCount).toBe(3);
    expect(augmented.findings[0].totalModels).toBe(4);
  });

  it("handles empty findings/lowConfidenceFindings arrays without error", () => {
    const result = makeResult([], []);
    const augmented = attachDeepResearchClaimIds("run-1", result);
    expect(augmented.findings).toEqual([]);
    expect(augmented.lowConfidenceFindings).toEqual([]);
  });
});

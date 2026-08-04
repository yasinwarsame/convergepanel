/**
 * Bias & Blind Spots Tier 3 Tests (deterministic diagnostics).
 */

import { computeAdaptiveDiagnostics } from "@/lib/adaptiveSchema/diagnostics";
import { AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";

function cell(
  modelId: string,
  overrides: Partial<AlignedClaimCell> = {}
): AlignedClaimCell {
  return {
    modelId: modelId as any,
    stance: "agrees",
    rawStance: "asserts",
    confidence: "settled",
    excerpt: "x",
    ...overrides,
  };
}

function row(id: string, agreementScore: number, cells: AlignedClaimCell[]): AlignedClaim {
  return {
    id,
    claimText: id,
    cells,
    agreementScore,
    certaintyScore: agreementScore,
    status: "consensus",
  };
}

describe("computeAdaptiveDiagnostics", () => {
  it("fires the homogeneity flag on an all-1.00 agreement fixture", () => {
    const rows = [
      row("a", 1.0, [cell("chatgpt"), cell("claude")]),
      row("b", 1.0, [cell("chatgpt"), cell("claude")]),
      row("c", 1.0, [cell("chatgpt"), cell("claude")]),
    ];
    const diagnostics = computeAdaptiveDiagnostics(rows);
    expect(diagnostics.meanAgreement).toBe(1);
    expect(diagnostics.homogeneityFlag).toBe(true);
  });

  it("does not fire the homogeneity flag on a mixed-agreement fixture", () => {
    const rows = [
      row("a", 1.0, [cell("chatgpt"), cell("claude")]),
      row("b", 0.3, [cell("chatgpt", { stance: "disputes" }), cell("claude")]),
      row("c", 0.6, [cell("chatgpt"), cell("claude")]),
    ];
    const diagnostics = computeAdaptiveDiagnostics(rows);
    expect(diagnostics.meanAgreement).toBeCloseTo(0.633, 2);
    expect(diagnostics.homogeneityFlag).toBe(false);
  });

  it("does not fire on an empty claim set", () => {
    const diagnostics = computeAdaptiveDiagnostics([]);
    expect(diagnostics.homogeneityFlag).toBe(false);
    expect(diagnostics.totalClaimCount).toBe(0);
    expect(diagnostics.citedClaimCount).toBe(0);
  });

  it("counts a claim as cited only when a cell carries a Metric with a real source", () => {
    const rows: AlignedClaim[] = [
      row("metric-with-source", 1, [
        cell("chatgpt", { raw: { label: "P/E", value: 20, unit: "x", asOf: "2024", source: "10-K filing" } }),
      ]),
      row("metric-without-source", 1, [
        cell("chatgpt", { raw: { label: "P/E", value: 20, unit: "x", asOf: "2024", source: "unknown" } }),
      ]),
      row("plain-claim", 1, [cell("chatgpt")]),
    ];
    const diagnostics = computeAdaptiveDiagnostics(rows);
    expect(diagnostics.citedClaimCount).toBe(1);
    expect(diagnostics.totalClaimCount).toBe(3);
  });

  it("tallies evidence mix by the modal evidenceType per row", () => {
    const rows: AlignedClaim[] = [
      row("empirical-row", 1, [cell("chatgpt", { evidenceType: "empirical" }), cell("claude", { evidenceType: "empirical" })]),
      row("anecdotal-row", 1, [cell("chatgpt", { evidenceType: "anecdotal" })]),
      row("no-evidence-type-row", 1, [cell("chatgpt")]),
    ];
    const diagnostics = computeAdaptiveDiagnostics(rows);
    expect(diagnostics.evidenceMix).toEqual({ empirical: 1, theoretical: 0, anecdotal: 1, authoritative: 0 });
  });
});

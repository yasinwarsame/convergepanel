/**
 * Team Workspace Boundary Hardening, backend correction (10C.4A-U2B) —
 * `isSubstantiveDecisionReceiptConclusion()` tests. This is the ONE shared
 * definition reused by both the Team client's `hasUsableDecisionReceipt()`
 * and every backend mutation function that records a substantive human
 * judgment.
 */

import { isSubstantiveDecisionReceiptConclusion } from "@/lib/adaptiveSchema/decisionReceiptUsability";

describe("isSubstantiveDecisionReceiptConclusion", () => {
  it("accepts a normal, meaningful conclusion", () => {
    expect(isSubstantiveDecisionReceiptConclusion("Overall risk is moderate.")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isSubstantiveDecisionReceiptConclusion("")).toBe(false);
  });

  it("rejects whitespace-only strings", () => {
    expect(isSubstantiveDecisionReceiptConclusion("   ")).toBe(false);
    expect(isSubstantiveDecisionReceiptConclusion("\n\t")).toBe(false);
    expect(isSubstantiveDecisionReceiptConclusion(" \n \t ")).toBe(false);
  });

  it("accepts a conclusion with leading/trailing whitespace around real content", () => {
    expect(isSubstantiveDecisionReceiptConclusion("  Go: proceed with vendor A.  ")).toBe(true);
  });

  it("accepts a single non-whitespace character", () => {
    expect(isSubstantiveDecisionReceiptConclusion("x")).toBe(true);
  });
});

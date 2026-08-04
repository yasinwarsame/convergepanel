/**
 * Query-Routing Redesign, Phase 1 — persistAdaptiveOutput() tests.
 *
 * First test file in the repo to mock lib/firebase/admin directly (no
 * existing pattern to follow — lib/firestore/runs.ts had zero tests before
 * this phase, confirmed during the Phase 0 audit). Kept minimal: a fake
 * `set()` spy is enough to prove the write path, size-guard, and failure
 * handling without standing up a real Firestore emulator.
 */

const mockSet = jest.fn();
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: mockCollection },
}));

import { persistAdaptiveOutput } from "@/lib/firestore/runs";

describe("persistAdaptiveOutput", () => {
  afterEach(() => jest.clearAllMocks());

  it("saves a normally-sized envelope with a merge write, scoped to the run's own document", async () => {
    mockSet.mockResolvedValueOnce(undefined);
    const output = { version: 1, schemaId: "decision_support", result: { options: [] } };

    const outcome = await persistAdaptiveOutput("run-123", output);

    expect(outcome).toEqual({ saved: true });
    expect(mockCollection).toHaveBeenCalledWith("runs");
    expect(mockDoc).toHaveBeenCalledWith("run-123");
    expect(mockSet).toHaveBeenCalledWith({ adaptiveOutput: output }, { merge: true });
  });

  it("omits (does not throw or fail the run) when the envelope would exceed the document-size safety budget", async () => {
    // Comfortably over MAX_TOTAL_DOC_SIZE (850,000 chars) — the design doc's
    // own worst-case schema estimate (comparison_matrix, ~60KB) is nowhere
    // near this, so this fixture is deliberately pathological, not realistic.
    const hugeResult = { blob: "x".repeat(2_000_000) };
    const outcome = await persistAdaptiveOutput("run-456", { version: 1, result: hugeResult });

    expect(outcome).toEqual({ saved: false, reason: "oversized" });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("catches a write failure and returns a safe failure result rather than throwing", async () => {
    mockSet.mockRejectedValueOnce(new Error("Firestore unavailable"));
    const outcome = await persistAdaptiveOutput("run-789", { version: 1, result: {} });

    expect(outcome).toEqual({ saved: false, reason: "write_failed" });
  });
});

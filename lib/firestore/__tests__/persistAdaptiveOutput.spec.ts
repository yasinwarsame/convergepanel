/**
 * Query-Routing Redesign, Phase 1 — persistAdaptiveOutput() tests.
 *
 * Research deletion integrity (2026-11-03): the write now runs in a transaction guarded by the deletion barrier. The
 * spec therefore uses the shared transactional fake, not a `set()` spy. Each original assertion is kept as the same
 * statement about the applied write:
 *   - collection "runs", document id, merge write of `{ adaptiveOutput }`;
 *   - nothing written when oversized;
 *   - `write_failed` on a storage failure.
 * The barrier cases are added.
 */
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));

import { persistAdaptiveOutput } from "@/lib/firestore/runs";

describe("persistAdaptiveOutput", () => {
  beforeEach(() => {
    db.docs.clear();
    db.hooks = {};
    db.writeLog = [];
  });

  it("saves a normally-sized envelope with a merge write, scoped to the run's own document", async () => {
    db.seed("runs/run-123", { userId: "u1" });
    const output = { version: 1, schemaId: "decision_support", result: { options: [] } };

    const outcome = await persistAdaptiveOutput("run-123", output);

    expect(outcome).toEqual({ saved: true });
    expect(db.writeLog).toEqual([{ kind: "merge", path: "runs/run-123", data: { adaptiveOutput: output }, via: "tx" }]);
    expect(db.read("runs/run-123")).toEqual({ userId: "u1", adaptiveOutput: output });
  });

  it("omits (does not throw or fail the run) when the envelope would exceed the document-size safety budget", async () => {
    // Comfortably over MAX_TOTAL_DOC_SIZE (850,000 chars) — the design doc's
    // own worst-case schema estimate (comparison_matrix, ~60KB) is nowhere
    // near this, so this fixture is deliberately pathological, not realistic.
    db.seed("runs/run-456", { userId: "u1" });
    const hugeResult = { blob: "x".repeat(2_000_000) };
    const outcome = await persistAdaptiveOutput("run-456", { version: 1, result: hugeResult });

    expect(outcome).toEqual({ saved: false, reason: "oversized" });
    expect(db.writeLog).toEqual([]);
  });

  it("catches a write failure and returns a safe failure result rather than throwing", async () => {
    db.seed("runs/run-789", { userId: "u1" });
    db.hooks.failCommit = () => {
      throw new Error("Firestore unavailable");
    };
    const outcome = await persistAdaptiveOutput("run-789", { version: 1, result: {} });

    expect(outcome).toEqual({ saved: false, reason: "write_failed" });
    expect(db.writeLog).toEqual([]);
  });

  it("deletion barrier: a missing run is not recreated, and a tombstoned run is refused", async () => {
    expect(await persistAdaptiveOutput("run-gone", { version: 1 })).toEqual({ saved: false, reason: "write_failed" });
    db.seed("runs/run-del", { userId: "u1" });
    db.seed("runDeletionJobs/run-del", { state: "in_progress" });
    expect(await persistAdaptiveOutput("run-del", { version: 1 })).toEqual({ saved: false, reason: "write_failed" });
    expect(db.writeLog).toEqual([]);
    expect(db.read("runs/run-gone")).toBeUndefined();
  });
});

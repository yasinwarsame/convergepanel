/**
 * Evidence Workspace, Phase 11A.3 — `saveClaimVerification()` /
 * `ClaimVerificationFirestoreDoc` backward-compatibility tests. Closes the
 * 11A.1 test gap identified by the 11A.0D1 reconciliation audit: a
 * dedicated write-path test proving a legacy verification (no `origin`,
 * no `projectId`) remains fully valid, and that adding both fields as
 * optional never makes them required.
 */

// Research deletion integrity (2026-11-03): an origin-linked save runs in a transaction guarded by the deletion barrier
// (on the SOURCE run), so this spec uses the shared transactional fake. Each original assertion reads the applied write.
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
const verificationWrites = () => db.writeLog.filter((w) => w.path.startsWith("verifications/"));
const persistedAt = (i: number) => verificationWrites()[i].data as Record<string, unknown>;

import { Timestamp } from "firebase-admin/firestore";
import { saveClaimVerification, type ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";

function legacyDoc(): Omit<ClaimVerificationFirestoreDoc, "timestamp"> {
  return {
    userId: "uid-1",
    claim: "A legacy claim, created before origin/projectId existed.",
    type: "claim_verification",
    verdict: "accurate",
    consensusScore: 80,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 1,
    modelResults: [],
    auditBundle: {} as ClaimVerificationFirestoreDoc["auditBundle"],
    selectedModels: ["claude", "chatgpt"],
  };
}

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  db.writeLog = [];
  db.seed("runs/run-1", { userId: "uid-1" }); // the origin source run exists and is writable
});

describe("saveClaimVerification — legacy/backward-compatibility (Phase 11A.3)", () => {
  it("a legacy doc with neither origin nor projectId saves successfully — remains fully valid", async () => {
    await expect(saveClaimVerification("vcl-1", legacyDoc())).resolves.toBeUndefined();
    expect(verificationWrites()).toHaveLength(1);
    expect(verificationWrites()[0]).toMatchObject({ kind: "set", path: "verifications/vcl-1", via: "direct" });
  });

  it("the persisted payload omits origin and projectId entirely — never writes them as null, never requires them", async () => {
    await saveClaimVerification("vcl-1", legacyDoc());
    const persisted = persistedAt(0);
    expect(Object.prototype.hasOwnProperty.call(persisted, "origin")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(persisted, "projectId")).toBe(false);
  });

  it("adding optional projectId does not make it required — TypeScript accepts the legacy doc shape unchanged (compile-time proof via this file's own successful build)", () => {
    // If projectId/origin were ever accidentally made required fields on
    // ClaimVerificationFirestoreDoc, legacyDoc() above would fail to
    // compile (tsc --noEmit), not merely fail this assertion. This test
    // exists so a future reader sees the intent explicitly stated.
    const doc: Omit<ClaimVerificationFirestoreDoc, "timestamp"> = legacyDoc();
    expect(doc.origin).toBeUndefined();
    expect(doc.projectId).toBeUndefined();
  });

  it("an origin-linked doc (both origin and projectId present) still saves and serializes both fields verbatim", async () => {
    const origin = { type: "deep_research_claim" as const, runId: "run-1", claimId: "v1:findings:0:" + "a".repeat(43) };
    await saveClaimVerification("vcl-2", { ...legacyDoc(), origin, projectId: "proj-1" });
    const persisted = persistedAt(0);
    expect(persisted.origin).toEqual(origin);
    expect(persisted.projectId).toBe("proj-1");
  });

  it("an origin-linked doc with a null projectId (unprojected source run) persists projectId: null explicitly (distinct from 'absent' for an ordinary verification)", async () => {
    const origin = { type: "deep_research_claim" as const, runId: "run-1", claimId: "v1:findings:0:" + "a".repeat(43) };
    await saveClaimVerification("vcl-3", { ...legacyDoc(), origin, projectId: null });
    const persisted = persistedAt(0);
    expect(persisted.projectId).toBeNull();
  });

  it("timestamp defaults to Timestamp.now() when omitted, unaffected by origin/projectId presence", async () => {
    await saveClaimVerification("vcl-1", legacyDoc());
    const persisted = persistedAt(0);
    expect(persisted.timestamp).toBeInstanceOf(Timestamp);
  });

  it("an origin-linked doc is written in a transaction (barrier on the source run)", async () => {
    const origin = { type: "deep_research_claim" as const, runId: "run-1", claimId: "c" };
    await saveClaimVerification("vcl-4", { ...legacyDoc(), origin, projectId: null });
    expect(verificationWrites()).toEqual([expect.objectContaining({ kind: "set", path: "verifications/vcl-4", via: "tx" })]);
  });

  it("deletion barrier: an origin-linked doc whose source run is deleted, being deleted or missing is refused, and nothing is written", async () => {
    db.seed("runs/run-marked", { userId: "uid-1", deletion: { state: "pending" } });
    db.seed("runDeletionJobs/run-tomb", { state: "complete" });
    for (const runId of ["run-marked", "run-tomb", "run-missing"]) {
      await expect(saveClaimVerification(`vcl-${runId}`, { ...legacyDoc(), origin: { type: "deep_research_claim", runId, claimId: "c" }, projectId: null })).rejects.toMatchObject({ code: "research_write_refused" });
    }
    expect(verificationWrites()).toEqual([]);
  });
});

/**
 * Multi-Reviewer Panel Foundation, Part B —
 * getAdaptiveHumanReviewPanel() / submitAdaptiveHumanReviewPanel() /
 * cancelAdaptiveHumanReviewPanel() tests.
 */

const runDocs = new Map<string, Record<string, any>>();
const panelDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };
const readShouldThrow = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (runId: string) => ({
      id: runId,
      get: jest.fn().mockImplementation(async () => ({ exists: runDocs.has(runId), data: () => runDocs.get(runId) })),
      collection: (subName: string) => ({
        doc: (docId: string) => ({
          get: jest.fn().mockImplementation(async () => {
            if (readShouldThrow.value) throw new Error("boom");
            const key = `${runId}/${docId}`;
            return { exists: panelDocs.has(key), data: () => panelDocs.get(key) };
          }),
        }),
      }),
    }),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    const txn = {
      get: async (ref: { id: string }) => {
        return (ref as any).__isPanelRef
          ? { exists: panelDocs.has(`${(ref as any).__runId}/current`), data: () => panelDocs.get(`${(ref as any).__runId}/current`) }
          : { exists: runDocs.has(ref.id), data: () => runDocs.get(ref.id) };
      },
      set: (ref: { id: string }, value: Record<string, unknown>) => {
        panelDocs.set(`${(ref as any).__runId}/current`, value);
      },
    };
    return fn(txn);
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Tag panel refs so the transaction fake can distinguish "runs/{id}" from
// "runs/{id}/humanReviewPanel/current" — identical technique already used
// in adaptiveHumanReviewAssignment.spec.ts (this file's sibling).
const originalCollection = mockAdminDb.collection;
mockAdminDb.collection = (name: string) => {
  const base = originalCollection(name);
  return {
    doc: (runId: string) => {
      const runRef = base.doc(runId);
      return {
        ...runRef,
        id: runId,
        collection: (subName: string) => {
          const subCollection = runRef.collection(subName);
          return {
            ...subCollection,
            doc: (docId: string) => {
              const docRef = subCollection.doc(docId);
              return { ...docRef, id: docId, __isPanelRef: subName === "humanReviewPanel" && docId === "current", __runId: runId };
            },
          };
        },
      };
    },
  };
};

import {
  getAdaptiveHumanReviewPanel,
  submitAdaptiveHumanReviewPanel,
  cancelAdaptiveHumanReviewPanel,
} from "@/lib/firestore/runs";

const RUN_ID = "run-1";
const TEAM_ID = "team-1";

function governanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "x",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

// createdAt/updatedAt default to a fixed PAST date (never "now") so tests
// that don't stub `now` (the two concurrent-mutation tests below, which
// exercise real Date.now() on purpose) can never accidentally produce a
// createdAt-after-updatedAt malformed-parse false positive depending on
// real wall-clock time when the suite happens to run.
function storedPanel(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: TEAM_ID,
    runId: RUN_ID,
    mode: "majority_quorum",
    reviewerUserIds: ["a", "b", "c"],
    requiredReviewerCount: 3,
    quorum: 2,
    status: "open",
    revision: 1,
    createdAt: "2020-01-01T00:00:00.000Z",
    createdByUserId: "admin-uid",
    updatedAt: "2020-01-01T00:00:00.000Z",
    updatedByUserId: "admin-uid",
    ...overrides,
  };
}

beforeEach(() => {
  runDocs.clear();
  panelDocs.clear();
  firestoreUnavailableFlag.value = false;
  readShouldThrow.value = false;
});

describe("getAdaptiveHumanReviewPanel", () => {
  it("returns absent when no document exists", async () => {
    expect(await getAdaptiveHumanReviewPanel(RUN_ID)).toEqual({ status: "absent" });
  });

  it("returns found with the parsed panel when a valid document exists", async () => {
    panelDocs.set(`${RUN_ID}/current`, storedPanel());
    const result = await getAdaptiveHumanReviewPanel(RUN_ID, TEAM_ID);
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.panel.reviewerUserIds).toEqual(["a", "b", "c"]);
  });

  it("returns malformed for a corrupted stored document", async () => {
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ quorum: 999 }));
    expect(await getAdaptiveHumanReviewPanel(RUN_ID)).toEqual({ status: "malformed" });
  });

  it("returns unsupported_version for a future schema version", async () => {
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ schemaVersion: 2 }));
    expect(await getAdaptiveHumanReviewPanel(RUN_ID)).toEqual({ status: "unsupported_version" });
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    expect(await getAdaptiveHumanReviewPanel(RUN_ID)).toEqual({ status: "firestore_unavailable" });
  });

  it("returns read_failed when the read throws", async () => {
    readShouldThrow.value = true;
    expect(await getAdaptiveHumanReviewPanel(RUN_ID)).toEqual({ status: "read_failed" });
  });
});

describe("submitAdaptiveHumanReviewPanel — creation", () => {
  it("creates the first panel at revision 1 with server-derived timestamps/actor and derived quorum", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["b", "a", "c"],
      actorUserId: "admin-uid",
      expectedRevision: 0,
      now: "2026-07-31T01:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.panel.revision).toBe(1);
      expect(result.panel.reviewerUserIds).toEqual(["a", "b", "c"]);
      expect(result.panel.requiredReviewerCount).toBe(3);
      expect(result.panel.quorum).toBe(2);
      expect(result.panel.createdAt).toBe("2026-07-31T01:00:00.000Z");
      expect(result.panel.createdByUserId).toBe("admin-uid");
      expect(result.panel.status).toBe("open");
    }
  });

  it("rejects creation with a non-zero expectedRevision when no panel exists", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 3,
    });
    expect(result).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("rejects when the review is no longer pending", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "approved" } }) });
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "not_pending" });
  });

  it("never mutates governanceRecord", async () => {
    const before = governanceRecord();
    runDocs.set(RUN_ID, { governanceRecord: { ...before } });
    await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(runDocs.get(RUN_ID)!.governanceRecord).toEqual(before);
  });

  it("fails closed on a missing parent run", async () => {
    const result = await submitAdaptiveHumanReviewPanel({
      runId: "does-not-exist",
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "run_missing" });
  });

  it("returns firestore_unavailable safely", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "firestore_unavailable" });
  });

  it("two concurrent creations with expectedRevision 0: only the first commits", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const first = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    const second = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["c", "d"],
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "stale_revision" });
  });
});

describe("submitAdaptiveHumanReviewPanel — reconfiguration", () => {
  it("requires the exact current revision", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ revision: 2 }));
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["x", "y"],
      actorUserId: "admin-uid",
      expectedRevision: 1, // stale — actual is 2
    });
    expect(result).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("increments revision by exactly 1, preserves createdAt/createdByUserId, replaces reviewers, recalculates quorum", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(
      `${RUN_ID}/current`,
      storedPanel({ revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", createdByUserId: "owner-uid" })
    );
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["x", "y", "z", "w"],
      actorUserId: "admin-uid",
      expectedRevision: 1,
      now: "2026-07-31T02:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.panel.revision).toBe(2);
      expect(result.panel.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(result.panel.createdByUserId).toBe("owner-uid");
      expect(result.panel.updatedAt).toBe("2026-07-31T02:00:00.000Z");
      expect(result.panel.updatedByUserId).toBe("admin-uid");
      expect(result.panel.reviewerUserIds).toEqual(["w", "x", "y", "z"]);
      expect(result.panel.requiredReviewerCount).toBe(4);
      expect(result.panel.quorum).toBe(3);
    }
  });

  it("rejects reconfiguring a CANCELLED panel — no reopening, even with the correct expectedRevision", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ status: "cancelled", revision: 3 }));
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 3, // matches exactly, but panel is terminal
    });
    expect(result).toEqual({ ok: false, reason: "panel_cancelled" });
  });

  it("fails closed on a malformed stored panel — never overwrites it", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ quorum: 999, revision: 1 }));
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    expect(result).toEqual({ ok: false, reason: "panel_malformed" });
    expect(panelDocs.get(`${RUN_ID}/current`)!.quorum).toBe(999); // untouched
  });

  it("fails closed on an unsupported-version stored panel", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ schemaVersion: 2, revision: 1 }));
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    expect(result).toEqual({ ok: false, reason: "panel_unsupported_version" });
  });

  it("race: review becomes terminal before this transaction's own read — reconfiguration fails, never silently allowed through", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "rejected" } }) });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ revision: 1 }));
    const result = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    expect(result).toEqual({ ok: false, reason: "not_pending" });
    expect(panelDocs.get(`${RUN_ID}/current`)!.revision).toBe(1); // untouched
  });

  it("two concurrent reconfigurations from the same revision: only the first commits", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ revision: 1 }));
    const first = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    const second = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["c", "d"],
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "stale_revision" });
  });
});

describe("cancelAdaptiveHumanReviewPanel", () => {
  it("cancels an open panel: revision +1, status cancelled, reviewer list preserved, no physical delete", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ revision: 1, reviewerUserIds: ["a", "b", "c"] }));
    const result = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 1,
      now: "2026-08-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.panel.status).toBe("cancelled");
      expect(result.panel.revision).toBe(2);
      expect(result.panel.reviewerUserIds).toEqual(["a", "b", "c"]);
      expect(result.panel.updatedByUserId).toBe("owner-uid");
    }
    expect(panelDocs.has(`${RUN_ID}/current`)).toBe(true); // still exists — never physically deleted
  });

  it("rejects cancelling an absent panel", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const result = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "panel_absent" });
  });

  it("rejects cancelling an already-cancelled panel — no reopening, no double-cancel", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ status: "cancelled", revision: 2 }));
    const result = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 2,
    });
    expect(result).toEqual({ ok: false, reason: "panel_already_cancelled" });
  });

  it("requires the exact current revision", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ revision: 5 }));
    const result = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 4,
    });
    expect(result).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("rejects cancellation when the review is no longer pending (terminal review protection)", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "changes_requested" } }) });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ revision: 1 }));
    const result = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 1,
    });
    expect(result).toEqual({ ok: false, reason: "not_pending" });
  });

  it("fails closed on a malformed stored panel — never overwrites it", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ quorum: 999, revision: 1 }));
    const result = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 1,
    });
    expect(result).toEqual({ ok: false, reason: "panel_malformed" });
  });

  it("two concurrent cancellations from the same revision: only the first commits (the second sees the now-cancelled status, reported as panel_already_cancelled — a more informative outcome than a generic stale_revision, since the status check runs before the revision check)", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ revision: 1 }));
    const first = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 1,
    });
    const second = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 1,
    });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "panel_already_cancelled" });
  });

  it("two concurrent cancellations from the same revision, where a third party reconfigured (not cancelled) in between: the second sees stale_revision", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/current`, storedPanel({ revision: 1 }));
    const reconfigured = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: ["x", "y"],
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    expect(reconfigured.ok).toBe(true);
    const staleCancel = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 1, // stale — the panel is now at revision 2 and still open
    });
    expect(staleCancel).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("returns firestore_unavailable safely", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await cancelAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedRevision: 1,
    });
    expect(result).toEqual({ ok: false, reason: "firestore_unavailable" });
  });
});

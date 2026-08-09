/**
 * Adaptive Research Export, Phase 1 — Firestore persistence tests.
 *
 * The critical case from Part 17: snapshot immutability. Generating export
 * A must freeze A's `reportSnapshot` at that moment; mutating the caller's
 * source object afterward, or generating a later export B for the same
 * run, must never change A's persisted content. `reportVersion` must
 * increment monotonically per run, and `supersedeOlderAdaptiveExports`
 * must only ever touch `artifactStatus` — never `reportSnapshot` — on an
 * older export.
 *
 * Firestore itself is faked in-memory (no real Admin SDK / emulator) —
 * `firebase-admin/firestore`'s `FieldValue`/`Timestamp` are mocked as real
 * classes (so `sanitizeForFirestore`'s own `instanceof FieldValue` guard,
 * exercised for real here, still works) and `@/lib/firebase/admin`'s
 * `adminDb` is replaced with a small Map-backed transaction/batch-capable
 * stand-in — deliberately reusing `sanitizeForFirestore` for real (not
 * mocked) since its recursive deep-copy is exactly what gives this fake the
 * same "writes don't alias the caller's object" guarantee real Firestore
 * provides.
 */

class FakeFieldValue {
  __increment?: number;
  static increment(n: number) {
    const fv = new FakeFieldValue();
    fv.__increment = n;
    return fv;
  }
}
class FakeTimestamp {}

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: FakeFieldValue,
  Timestamp: FakeTimestamp,
}));

function isIncrementSentinel(v: unknown): v is FakeFieldValue {
  return v instanceof FakeFieldValue && typeof (v as FakeFieldValue).__increment === "number";
}

function applyMergeDotPath(target: Record<string, any>, updates: Record<string, any>) {
  for (const [key, value] of Object.entries(updates)) {
    const parts = key.split(".");
    let node = target;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] ?? {};
      node = node[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    node[leaf] = isIncrementSentinel(value) ? (typeof node[leaf] === "number" ? node[leaf] : 0) + value.__increment : value;
  }
}

function makeFakeAdminDb() {
  const runs = new Map<string, Record<string, any>>();
  const exportDocs = new Map<string, Map<string, any>>();

  function exportsForRun(runId: string) {
    if (!exportDocs.has(runId)) exportDocs.set(runId, new Map());
    return exportDocs.get(runId)!;
  }

  function runDocRef(runId: string) {
    return {
      async get() {
        return { exists: runs.has(runId), data: () => runs.get(runId) };
      },
      set(data: any, opts?: { merge?: boolean }) {
        const prev = runs.get(runId) ?? {};
        if (opts?.merge) {
          const next = { ...prev };
          applyMergeDotPath(next, data);
          runs.set(runId, next);
        } else {
          runs.set(runId, data);
        }
      },
      collection(name: string) {
        if (name !== "exports") throw new Error(`unexpected subcollection ${name}`);
        const docs = exportsForRun(runId);
        function docRef(exportId: string) {
          return {
            id: exportId,
            async get() {
              return { exists: docs.has(exportId), data: () => docs.get(exportId) };
            },
            set(data: any, opts?: { merge?: boolean }) {
              const prev = docs.get(exportId) ?? {};
              if (opts?.merge) {
                const next = { ...prev };
                applyMergeDotPath(next, data);
                docs.set(exportId, next);
              } else {
                docs.set(exportId, data);
              }
            },
          };
        }
        return {
          doc: docRef,
          where(field: string, op: string, value: unknown) {
            return {
              async get() {
                const matched = [...docs.entries()]
                  .filter(([, d]) => (op === "==" ? d[field] === value : true))
                  .map(([id]) => ({ id, ref: docRef(id) }));
                return { docs: matched };
              },
            };
          },
        };
      },
    };
  }

  const adminDb: any = {
    collection(name: string) {
      if (name !== "runs") throw new Error(`unexpected collection ${name}`);
      return { doc: (runId: string) => runDocRef(runId) };
    },
    async runTransaction(fn: (txn: any) => Promise<any>) {
      const txn = {
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      };
      return fn(txn);
    },
    batch() {
      const ops: Array<() => void> = [];
      return {
        set: (ref: any, data: any, opts?: any) => ops.push(() => ref.set(data, opts)),
        async commit() {
          ops.forEach((op) => op());
        },
      };
    },
  };

  return { adminDb, exportDocs };
}

const { adminDb: fakeAdminDb, exportDocs } = makeFakeAdminDb();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return fakeAdminDb;
  },
}));

import {
  createAdaptiveExportRecord,
  markAdaptiveExportReady,
  supersedeOlderAdaptiveExports,
  getAdaptiveExportRecord,
  CreateAdaptiveExportInput,
} from "@/lib/firestore/adaptiveExports";

function buildInput(runId: string, exportId: string, question: string): CreateAdaptiveExportInput {
  return {
    runId,
    exportId,
    record: {
      version: 1,
      exportId,
      runId,
      schemaId: "comparison_matrix",
      schemaFamily: "milestone2",
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "uid-1",
      format: "pdf",
      artifactStatus: "generating",
      classification: "internal",
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
      reportSnapshot: {
        question,
        models: [{ modelId: "chatgpt" as any, ok: true }],
        reportTypeLabel: "Comparison Report",
        consensusLevel: "moderate",
        sourceGroundingLevel: "strong",
        reportGeneratedAt: "2026-01-01T00:00:00.000Z",
        milestone2: { schemaId: "comparison_matrix", result: {}, meta: {} as any, decisionReceipt: undefined },
      },
      exportMetadata: {
        exportId,
        runId,
        schemaVersion: 1,
        exportedSections: ["reportSnapshot.milestone2"],
        createdAt: "2026-01-01T00:00:00.000Z",
        requestingUser: "uid-1",
      },
    },
  };
}

describe("adaptiveExports Firestore persistence — snapshot immutability (Part 17's critical case)", () => {
  const RUN_ID = "run-immutability-1";

  it("reportVersion increments monotonically per run across successive exports", async () => {
    const a = await createAdaptiveExportRecord(buildInput(RUN_ID, "exp-a", "Question A"));
    const b = await createAdaptiveExportRecord(buildInput(RUN_ID, "exp-b", "Question B"));
    expect(a).toEqual({ ok: true, reportVersion: 1 });
    expect(b).toEqual({ ok: true, reportVersion: 2 });
  });

  it("mutating the caller's source object AFTER generating export A never changes A's persisted snapshot", async () => {
    const input = buildInput(RUN_ID, "exp-mutate-a", "Original question");
    await createAdaptiveExportRecord(input);

    // Simulate the live run changing after export — mutate the very same
    // object reference that was passed into createAdaptiveExportRecord.
    input.record.reportSnapshot.question = "MUTATED — should never appear in the persisted export";

    const stored = await getAdaptiveExportRecord(RUN_ID, "exp-mutate-a");
    expect(stored).toEqual({ ok: true, record: expect.objectContaining({ reportSnapshot: expect.objectContaining({ question: "Original question" }) }) });
  });

  it("generating a newer export B never mutates an older export A's content — A remains historically retrievable with its own distinct snapshot", async () => {
    await createAdaptiveExportRecord(buildInput(RUN_ID, "exp-a2", "Question at time of A"));
    await createAdaptiveExportRecord(buildInput(RUN_ID, "exp-b2", "Question at time of B — run has since changed"));

    const a = await getAdaptiveExportRecord(RUN_ID, "exp-a2");
    const b = await getAdaptiveExportRecord(RUN_ID, "exp-b2");
    expect(a.ok && a.record.reportSnapshot.question).toBe("Question at time of A");
    expect(b.ok && b.record.reportSnapshot.question).toBe("Question at time of B — run has since changed");
    expect(a.ok && a.record.reportVersion).not.toBe(b.ok && b.record.reportVersion);
  });

  it("supersedeOlderAdaptiveExports only ever changes artifactStatus on the older export — reportSnapshot is byte-identical before and after", async () => {
    const runId = "run-supersede-1";
    await createAdaptiveExportRecord(buildInput(runId, "exp-old", "Old export question"));
    await markAdaptiveExportReady(runId, "exp-old", "sha-old");
    const before = await getAdaptiveExportRecord(runId, "exp-old");
    expect(before.ok && before.record.artifactStatus).toBe("ready");
    const snapshotBefore = before.ok ? JSON.stringify(before.record.reportSnapshot) : null;

    await createAdaptiveExportRecord(buildInput(runId, "exp-new", "New export question"));
    await markAdaptiveExportReady(runId, "exp-new", "sha-new");
    await supersedeOlderAdaptiveExports(runId, "exp-new");

    const after = await getAdaptiveExportRecord(runId, "exp-old");
    expect(after.ok && after.record.artifactStatus).toBe("superseded");
    expect(after.ok ? JSON.stringify(after.record.reportSnapshot) : null).toBe(snapshotBefore);

    const newExport = await getAdaptiveExportRecord(runId, "exp-new");
    expect(newExport.ok && newExport.record.artifactStatus).toBe("ready");
  });

  it("superseded is a lifecycle transition, not an invalidation — the superseded export's full record (not just status) remains readable", async () => {
    const runId = "run-supersede-2";
    await createAdaptiveExportRecord(buildInput(runId, "exp-x", "X"));
    await markAdaptiveExportReady(runId, "exp-x", "sha-x");
    await createAdaptiveExportRecord(buildInput(runId, "exp-y", "Y"));
    await markAdaptiveExportReady(runId, "exp-y", "sha-y");
    await supersedeOlderAdaptiveExports(runId, "exp-y");

    const superseded = await getAdaptiveExportRecord(runId, "exp-x");
    expect(superseded.ok).toBe(true);
    expect(superseded.ok && superseded.record.reportSnapshot.question).toBe("X");
  });
});

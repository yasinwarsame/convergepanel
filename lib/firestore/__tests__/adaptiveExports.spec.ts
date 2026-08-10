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
 *
 * `runTransaction`'s fake is NOT a bare "call the callback once" stub — an
 * earlier version of this fake was exactly that, which would have let a
 * genuine lost-update bug in `createAdaptiveExportRecord` pass silently
 * (two "concurrent" transactions both reading `adaptiveExportCounter` at
 * the same value before either commits would both compute the same
 * `nextVersion`, and JS's single-threaded scheduling makes that interleaving
 * deterministic-ish rather than a real stress test). Real Firestore
 * transactions use optimistic concurrency control: every document a
 * transaction reads is version-tracked, and if any of them changed before
 * the transaction commits, the SDK transparently retries the entire
 * callback against fresh data. This fake reproduces exactly that — per-key
 * version counters, per-attempt read tracking, conflict detection before
 * "commit", and automatic retry — so a concurrency test against it is
 * actually proving something about `createAdaptiveExportRecord`'s real
 * transaction usage, not just exercising happy-path sequencing.
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
  /** Per-document-key version counter, bumped on every committed write — the basis for optimistic-concurrency contention detection below. */
  const versions = new Map<string, number>();

  function bumpVersion(key: string) {
    versions.set(key, (versions.get(key) ?? 0) + 1);
  }
  function currentVersion(key: string): number {
    return versions.get(key) ?? 0;
  }

  function exportsForRun(runId: string) {
    if (!exportDocs.has(runId)) exportDocs.set(runId, new Map());
    return exportDocs.get(runId)!;
  }

  function runDocRef(runId: string) {
    const key = `runs/${runId}`;
    return {
      __key: key,
      async get() {
        // A real DocumentSnapshot is frozen at read time — .data() must
        // keep returning what was true at that moment even if the
        // document is written again afterward. A lazy `() => runs.get(id)`
        // closure would silently read the LATEST state instead, which
        // would mask exactly the stale-read race this fake exists to catch.
        const snapshot = runs.has(runId) ? { ...runs.get(runId) } : undefined;
        return { exists: runs.has(runId), data: () => snapshot };
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
        bumpVersion(key);
      },
      collection(name: string) {
        if (name !== "exports") throw new Error(`unexpected subcollection ${name}`);
        const docs = exportsForRun(runId);
        function docRef(exportId: string) {
          const exportKey = `runs/${runId}/exports/${exportId}`;
          return {
            __key: exportKey,
            id: exportId,
            async get() {
              const snapshot = docs.has(exportId) ? { ...docs.get(exportId) } : undefined;
              return { exists: docs.has(exportId), data: () => snapshot };
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
              bumpVersion(exportKey);
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
          orderBy(field: string, direction: "asc" | "desc" = "asc") {
            return {
              async get() {
                const sorted = [...docs.entries()].sort(([, a], [, b]) => {
                  const cmp = (a[field] ?? 0) < (b[field] ?? 0) ? -1 : (a[field] ?? 0) > (b[field] ?? 0) ? 1 : 0;
                  return direction === "desc" ? -cmp : cmp;
                });
                return { docs: sorted.map(([id, d]) => ({ id, data: () => ({ ...d }) })) };
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
    /**
     * Real optimistic-concurrency simulation: each attempt tracks the
     * version of every doc it reads; if any of those docs were written by
     * another attempt before this one "commits", the whole callback is
     * retried against fresh data (matching real Firestore's transparent
     * retry-on-contention behavior) rather than silently committing a
     * stale computation. Writes are buffered and only applied once no
     * conflict is detected, so a losing attempt never partially commits.
     */
    async runTransaction(fn: (txn: any) => Promise<any>) {
      const MAX_ATTEMPTS = 25;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const readVersions = new Map<string, number>();
        const pendingWrites: Array<{ ref: any; data: any; opts?: any }> = [];
        const txn = {
          get: async (ref: any) => {
            if (!readVersions.has(ref.__key)) readVersions.set(ref.__key, currentVersion(ref.__key));
            return ref.get();
          },
          set: (ref: any, data: any, opts?: any) => {
            pendingWrites.push({ ref, data, opts });
          },
        };

        const result = await fn(txn);

        const conflict = [...readVersions].some(([key, versionAtRead]) => currentVersion(key) !== versionAtRead);
        if (conflict) continue; // another transaction committed first — retry against fresh data, exactly like real Firestore

        for (const { ref, data, opts } of pendingWrites) ref.set(data, opts);
        return result;
      }
      throw new Error(`runTransaction: exceeded ${MAX_ATTEMPTS} attempts under simulated contention`);
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
  listAdaptiveExportRecords,
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

describe("adaptiveExports Firestore persistence — reportVersion concurrency (critical integrity review)", () => {
  it("two genuinely concurrent export creations for the same run never receive the same reportVersion — no lost update", async () => {
    const runId = "run-concurrent-1";

    // Fired via Promise.all with no await between them: both calls execute
    // synchronously up to their first internal `await txn.get(runRef)`,
    // which is exactly the interleaving window a lost-update bug would need
    // — both transactions would read `adaptiveExportCounter` at the same
    // value before either has committed. The fake's contention-detecting
    // runTransaction (above) forces whichever one loses the race to retry
    // against the post-commit value, matching real Firestore's guarantee.
    const [a, b] = await Promise.all([
      createAdaptiveExportRecord(buildInput(runId, "exp-concurrent-a", "Question A")),
      createAdaptiveExportRecord(buildInput(runId, "exp-concurrent-b", "Question B")),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const versions = [a.ok && a.reportVersion, b.ok && b.reportVersion].sort();
    expect(versions).toEqual([1, 2]); // distinct, ordered, no collision

    // Both records persisted independently, each with its own distinct version.
    const recA = await getAdaptiveExportRecord(runId, "exp-concurrent-a");
    const recB = await getAdaptiveExportRecord(runId, "exp-concurrent-b");
    expect(recA.ok && recB.ok && recA.record.reportVersion).not.toBe(recB.ok && recB.record.reportVersion);
  });

  it("ten genuinely concurrent export creations for the same run each receive a distinct reportVersion 1..10 — no lost update under higher contention", async () => {
    const runId = "run-concurrent-many";
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createAdaptiveExportRecord(buildInput(runId, `exp-many-${i}`, `Question ${i}`)))
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const versions = results.map((r) => r.ok && r.reportVersion).sort((x, y) => (x as number) - (y as number));
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("concurrent export creations for DIFFERENT runs do not contend with each other — each independently starts at reportVersion 1", async () => {
    const [a, b] = await Promise.all([
      createAdaptiveExportRecord(buildInput("run-independent-a", "exp-1", "Q")),
      createAdaptiveExportRecord(buildInput("run-independent-b", "exp-1", "Q")),
    ]);
    expect(a).toEqual({ ok: true, reportVersion: 1 });
    expect(b).toEqual({ ok: true, reportVersion: 1 });
  });
});

describe("listAdaptiveExportRecords (Phase 2 — historical export listing)", () => {
  it("returns every export for a run, newest reportVersion first, including superseded ones (Part 8: superseded is never hidden)", async () => {
    const runId = "run-list-1";
    await createAdaptiveExportRecord(buildInput(runId, "exp-l1", "Q1"));
    await markAdaptiveExportReady(runId, "exp-l1", "sha-1");
    await createAdaptiveExportRecord(buildInput(runId, "exp-l2", "Q2"));
    await markAdaptiveExportReady(runId, "exp-l2", "sha-2");
    await supersedeOlderAdaptiveExports(runId, "exp-l2");
    await createAdaptiveExportRecord(buildInput(runId, "exp-l3", "Q3"));
    await markAdaptiveExportReady(runId, "exp-l3", "sha-3");
    await supersedeOlderAdaptiveExports(runId, "exp-l3");

    const result = await listAdaptiveExportRecords(runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((r) => r.exportId)).toEqual(["exp-l3", "exp-l2", "exp-l1"]);
    expect(result.records.map((r) => r.reportVersion)).toEqual([3, 2, 1]);
    expect(result.records.map((r) => r.artifactStatus)).toEqual(["ready", "superseded", "superseded"]);
  });

  it("returns an empty list for a run with no exports, never an error", async () => {
    const result = await listAdaptiveExportRecords("run-list-empty");
    expect(result).toEqual({ ok: true, records: [] });
  });

  it("list results are independent per run — a run's list never includes another run's exports", async () => {
    await createAdaptiveExportRecord(buildInput("run-list-a", "exp-a1", "QA"));
    await createAdaptiveExportRecord(buildInput("run-list-b", "exp-b1", "QB"));
    const listA = await listAdaptiveExportRecords("run-list-a");
    const listB = await listAdaptiveExportRecords("run-list-b");
    expect(listA.ok && listA.records.map((r) => r.exportId)).toEqual(["exp-a1"]);
    expect(listB.ok && listB.records.map((r) => r.exportId)).toEqual(["exp-b1"]);
  });
});

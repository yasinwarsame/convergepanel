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

/**
 * Integrity hotfix — this used to be `applyMergeDotPath`, which SPLIT
 * top-level string keys on "." and treated them as nested paths (e.g.
 * `"exportMetadata.fileHash"` became a nested write). That is real
 * Firestore `.update()` behavior, but NOT `.set(data, {merge:true})`
 * behavior — real `.set(..., {merge:true})` stores a dotted top-level key
 * LITERALLY (a field genuinely named with a dot in it), and instead
 * performs a RECURSIVE merge on any top-level value that is itself a
 * plain nested object. The old (wrong) mock is exactly why the
 * `markAdaptiveExportReady` field-path bug (see that function's own doc
 * comment in lib/firestore/adaptiveExports.ts) went undetected through
 * three phases — every test here ran against a mock that was MORE lenient
 * than real Firestore, silently accepting code that real Firestore would
 * not have merged the way the code intended. This corrected version
 * matches real `.set(..., {merge:true})` semantics precisely: literal
 * top-level keys (dots and all), recursive merge for nested plain objects.
 */
function isPlainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof FakeFieldValue) && !(v instanceof FakeTimestamp);
}

function deepMergeAssign(target: Record<string, any>, updates: Record<string, any>) {
  for (const [key, value] of Object.entries(updates)) {
    if (isIncrementSentinel(value)) {
      target[key] = (typeof target[key] === "number" ? target[key] : 0) + value.__increment;
    } else if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) target[key] = {};
      deepMergeAssign(target[key], value);
    } else {
      target[key] = value;
    }
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
          deepMergeAssign(next, data);
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
                deepMergeAssign(next, data);
                docs.set(exportId, next);
              } else {
                docs.set(exportId, data);
              }
              bumpVersion(exportKey);
            },
          };
        }
        // Chainable in any order (orderBy/.where/.limit), matching how real
        // Firestore Query objects work — each call returns a new query
        // description; filtering/sorting/limiting are all applied together
        // at `.get()` time. Needed since Phase 5's pagination chains
        // `.orderBy(...).limit(...).where(...)` (limit before where),
        // the reverse of this collection's original `.where(...).get()` /
        // `.orderBy(...).get()` single-clause-only shape.
        function buildQuery(state: { filters: Array<[string, string, unknown]>; order?: [string, "asc" | "desc"]; limitN?: number }) {
          return {
            where(field: string, op: string, value: unknown) {
              return buildQuery({ ...state, filters: [...state.filters, [field, op, value]] });
            },
            orderBy(field: string, direction: "asc" | "desc" = "asc") {
              return buildQuery({ ...state, order: [field, direction] });
            },
            limit(n: number) {
              return buildQuery({ ...state, limitN: n });
            },
            async get() {
              let entries = [...docs.entries()];
              for (const [field, op, value] of state.filters) {
                entries = entries.filter(([, d]) => {
                  if (op === "==") return d[field] === value;
                  if (op === "<") return (d[field] ?? 0) < (value as number);
                  if (op === "<=") return (d[field] ?? 0) <= (value as number);
                  if (op === ">") return (d[field] ?? 0) > (value as number);
                  if (op === ">=") return (d[field] ?? 0) >= (value as number);
                  return true;
                });
              }
              if (state.order) {
                const [field, direction] = state.order;
                entries = entries.sort(([, a], [, b]) => {
                  const cmp = (a[field] ?? 0) < (b[field] ?? 0) ? -1 : (a[field] ?? 0) > (b[field] ?? 0) ? 1 : 0;
                  return direction === "desc" ? -cmp : cmp;
                });
              }
              if (state.limitN !== undefined) entries = entries.slice(0, state.limitN);
              return { docs: entries.map(([id, d]) => ({ id, ref: docRef(id), data: () => ({ ...d }) })) };
            },
          };
        }
        return { doc: docRef, ...buildQuery({ filters: [] }) };
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

describe("Integrity hotfix — markAdaptiveExportReady persists fileHash correctly (fixes the dotted-key .set(merge:true) bug)", () => {
  it("persists fileHash NESTED inside exportMetadata in the raw stored document — never as a literal top-level 'exportMetadata.fileHash' field (Step 4, mandatory: tests the persisted representation itself, not just the public DTO)", async () => {
    const runId = "run-filehash-persisted-shape";
    await createAdaptiveExportRecord(buildInput(runId, "exp-hash-1", "Q"));
    await markAdaptiveExportReady(runId, "exp-hash-1", "sha-nested-check");

    // Bypass getAdaptiveExportRecord's own normalization entirely — inspect
    // the RAW stored document, exactly as it exists in the fake Firestore's
    // backing store, the same way `snap.data()` would return it from real
    // Firestore. This is the one assertion that would have caught the
    // original bug: before the fix, `raw.exportMetadata.fileHash` was
    // `undefined` and `raw["exportMetadata.fileHash"]` held the real hash.
    const raw = exportDocs.get(runId)!.get("exp-hash-1");
    expect(raw.exportMetadata.fileHash).toBe("sha-nested-check");
    expect(raw["exportMetadata.fileHash"]).toBeUndefined();
  });

  it("sibling exportMetadata fields survive markAdaptiveExportReady — exportId/reportVersion/schemaId/schemaFamily/requestingUser/exportedSections/finalReportVersion are all preserved, not wiped by the merge", async () => {
    const runId = "run-filehash-siblings-preserved";
    await createAdaptiveExportRecord(buildInput(runId, "exp-siblings", "Sibling-preservation question"));
    const beforeReady = exportDocs.get(runId)!.get("exp-siblings");
    const exportMetadataBefore = { ...beforeReady.exportMetadata };

    await markAdaptiveExportReady(runId, "exp-siblings", "sha-siblings");

    const raw = exportDocs.get(runId)!.get("exp-siblings");
    expect(raw.exportMetadata).toMatchObject({
      exportId: exportMetadataBefore.exportId,
      runId: exportMetadataBefore.runId,
      schemaVersion: exportMetadataBefore.schemaVersion,
      exportedSections: exportMetadataBefore.exportedSections,
      createdAt: exportMetadataBefore.createdAt,
      requestingUser: exportMetadataBefore.requestingUser,
      finalReportVersion: exportMetadataBefore.finalReportVersion,
      fileHash: "sha-siblings",
    });
    // Also confirm via the normalized public reader, matching what the history route/UI actually see.
    const record = await getAdaptiveExportRecord(runId, "exp-siblings");
    expect(record.ok && record.record.exportMetadata).toEqual(raw.exportMetadata);
  });

  it("legacy malformed record (literal top-level 'exportMetadata.fileHash', no nested hash) is still readable through getAdaptiveExportRecord via the backward-compatibility boundary", async () => {
    const runId = "run-filehash-legacy-malformed";
    await createAdaptiveExportRecord(buildInput(runId, "exp-legacy", "Legacy question"));
    // Simulate a record written by the OLD buggy code path — bypass
    // markAdaptiveExportReady entirely and write the malformed shape
    // directly into the fake store, exactly as real historical production
    // documents actually look (confirmed by direct Firestore inspection
    // before this fix).
    const raw = exportDocs.get(runId)!.get("exp-legacy");
    raw.artifactStatus = "ready";
    raw["exportMetadata.fileHash"] = "legacy-literal-hash";
    exportDocs.get(runId)!.set("exp-legacy", raw);

    const record = await getAdaptiveExportRecord(runId, "exp-legacy");
    expect(record.ok && record.record.exportMetadata.fileHash).toBe("legacy-literal-hash");
  });

  it("legacy malformed record is also readable through listAdaptiveExportRecords (the history-list path), not just getAdaptiveExportRecord", async () => {
    const runId = "run-filehash-legacy-list";
    await createAdaptiveExportRecord(buildInput(runId, "exp-legacy-list", "Legacy list question"));
    const raw = exportDocs.get(runId)!.get("exp-legacy-list");
    raw.artifactStatus = "ready";
    raw["exportMetadata.fileHash"] = "legacy-list-hash";
    exportDocs.get(runId)!.set("exp-legacy-list", raw);

    const result = await listAdaptiveExportRecords(runId);
    expect(result.ok && result.records[0].exportMetadata.fileHash).toBe("legacy-list-hash");
  });

  it("when a record has BOTH a genuinely nested fileHash and a stale legacy literal field, the nested (canonical, more recent) value always wins", async () => {
    const runId = "run-filehash-nested-wins";
    await createAdaptiveExportRecord(buildInput(runId, "exp-both", "Both-fields question"));
    const raw = exportDocs.get(runId)!.get("exp-both");
    raw.artifactStatus = "ready";
    raw.exportMetadata = { ...raw.exportMetadata, fileHash: "correct-nested-hash" };
    raw["exportMetadata.fileHash"] = "stale-legacy-hash-should-be-ignored";
    exportDocs.get(runId)!.set("exp-both", raw);

    const record = await getAdaptiveExportRecord(runId, "exp-both");
    expect(record.ok && record.record.exportMetadata.fileHash).toBe("correct-nested-hash");
  });

  it("a record with no fileHash at all (never marked ready, or genuinely never hashed) has fileHash undefined — the compatibility boundary never fabricates a value", async () => {
    const runId = "run-filehash-absent";
    await createAdaptiveExportRecord(buildInput(runId, "exp-none", "No hash question"));
    const record = await getAdaptiveExportRecord(runId, "exp-none");
    expect(record.ok && record.record.exportMetadata.fileHash).toBeUndefined();
  });

  it("final review, Step 5/8 — the malformed literal 'exportMetadata.fileHash' key is never present on the object returned by the compatibility boundary, from either read path — it is not merely functionally overridden, it is genuinely absent, so no future caller can leak it by spreading/serializing the record wholesale", async () => {
    const runId = "run-filehash-no-leak";
    await createAdaptiveExportRecord(buildInput(runId, "exp-no-leak", "No-leak question"));
    const raw = exportDocs.get(runId)!.get("exp-no-leak");
    raw.artifactStatus = "ready";
    raw["exportMetadata.fileHash"] = "should-never-appear-as-a-top-level-key";
    exportDocs.get(runId)!.set("exp-no-leak", raw);

    const viaGet = await getAdaptiveExportRecord(runId, "exp-no-leak");
    expect(viaGet.ok && Object.prototype.hasOwnProperty.call(viaGet.record, "exportMetadata.fileHash")).toBe(false);
    expect(viaGet.ok && Object.keys(viaGet.record)).not.toContain("exportMetadata.fileHash");

    const viaList = await listAdaptiveExportRecords(runId);
    const listedRecord = viaList.ok ? viaList.records.find((r) => r.exportId === "exp-no-leak") : undefined;
    expect(listedRecord && Object.prototype.hasOwnProperty.call(listedRecord, "exportMetadata.fileHash")).toBe(false);

    // The value is still correctly readable via the canonical nested path — this test is about the STRAY key's absence, not the value's presence (covered by the earlier tests).
    expect(viaGet.ok && viaGet.record.exportMetadata.fileHash).toBe("should-never-appear-as-a-top-level-key");
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

  it("Phase 5 (Part 20) — three concurrent MIXED-format export creations (pdf/docx/json) for the same run never collide on reportVersion; the transaction never inspects format", async () => {
    const runId = "run-concurrent-mixed-format";
    const pdfInput = buildInput(runId, "exp-mixed-pdf", "PDF question");
    const docxInput = buildInput(runId, "exp-mixed-docx", "DOCX question");
    docxInput.record.format = "docx";
    const jsonInput = buildInput(runId, "exp-mixed-json", "JSON question");
    jsonInput.record.format = "json";

    const [pdf, docx, json] = await Promise.all([
      createAdaptiveExportRecord(pdfInput),
      createAdaptiveExportRecord(docxInput),
      createAdaptiveExportRecord(jsonInput),
    ]);

    expect(pdf.ok).toBe(true);
    expect(docx.ok).toBe(true);
    expect(json.ok).toBe(true);
    const versions = [pdf.ok && pdf.reportVersion, docx.ok && docx.reportVersion, json.ok && json.reportVersion].sort(
      (a, b) => (a as number) - (b as number)
    );
    expect(versions).toEqual([1, 2, 3]); // distinct, no duplicates, format-agnostic

    const pdfRec = await getAdaptiveExportRecord(runId, "exp-mixed-pdf");
    const docxRec = await getAdaptiveExportRecord(runId, "exp-mixed-docx");
    const jsonRec = await getAdaptiveExportRecord(runId, "exp-mixed-json");
    expect(pdfRec.ok && pdfRec.record.format).toBe("pdf");
    expect(docxRec.ok && docxRec.record.format).toBe("docx");
    expect(jsonRec.ok && jsonRec.record.format).toBe("json");
    // Each format's own reportVersion still matches one of the distinct assigned versions above.
    const recordedVersions = [pdfRec.ok && pdfRec.record.reportVersion, docxRec.ok && docxRec.record.reportVersion, jsonRec.ok && jsonRec.record.reportVersion];
    expect(new Set(recordedVersions).size).toBe(3);
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
    expect(result).toEqual({ ok: true, records: [], hasMore: false });
  });

  it("list results are independent per run — a run's list never includes another run's exports", async () => {
    await createAdaptiveExportRecord(buildInput("run-list-a", "exp-a1", "QA"));
    await createAdaptiveExportRecord(buildInput("run-list-b", "exp-b1", "QB"));
    const listA = await listAdaptiveExportRecords("run-list-a");
    const listB = await listAdaptiveExportRecords("run-list-b");
    expect(listA.ok && listA.records.map((r) => r.exportId)).toEqual(["exp-a1"]);
    expect(listB.ok && listB.records.map((r) => r.exportId)).toEqual(["exp-b1"]);
  });

  describe("Phase 5 final review, Step 6 — malformed pagination inputs never remove the server-side cap", () => {
    const runId = "run-list-malformed-inputs";
    beforeAll(async () => {
      for (let i = 0; i < 60; i++) {
        await createAdaptiveExportRecord(buildInput(runId, `exp-malformed-${i}`, `Q${i}`));
      }
    });

    it("no limit — defaults to 30", async () => {
      const r = await listAdaptiveExportRecords(runId);
      expect(r.ok && r.records.length).toBe(30);
    });
    it("limit=1", async () => {
      const r = await listAdaptiveExportRecords(runId, { limit: 1 });
      expect(r.ok && r.records.length).toBe(1);
    });
    it("limit=50 (the max)", async () => {
      const r = await listAdaptiveExportRecords(runId, { limit: 50 });
      expect(r.ok && r.records.length).toBe(50);
    });
    it("limit=9999 — clamped to 50, never unbounded", async () => {
      const r = await listAdaptiveExportRecords(runId, { limit: 9999 });
      expect(r.ok && r.records.length).toBe(50);
    });
    it("limit=0 — clamped up to the minimum of 1, never an empty/unbounded read", async () => {
      const r = await listAdaptiveExportRecords(runId, { limit: 0 });
      expect(r.ok && r.records.length).toBe(1);
    });
    it("limit=-5 (negative) — clamped up to 1", async () => {
      const r = await listAdaptiveExportRecords(runId, { limit: -5 });
      expect(r.ok && r.records.length).toBe(1);
    });
    it("limit=10.9 (fractional) — truncated to a valid integer Firestore limit, never passed through as a fraction", async () => {
      const r = await listAdaptiveExportRecords(runId, { limit: 10.9 });
      expect(r.ok && r.records.length).toBe(10);
    });
    it("limit=Infinity — rejected as non-finite, falls back to the default page size", async () => {
      const r = await listAdaptiveExportRecords(runId, { limit: Infinity });
      expect(r.ok && r.records.length).toBe(30);
    });
    it("limit=NaN — rejected, falls back to the default page size", async () => {
      const r = await listAdaptiveExportRecords(runId, { limit: NaN });
      expect(r.ok && r.records.length).toBe(30);
    });
    it("beforeReportVersion=NaN (simulating a non-numeric cursor slipping through) — rejected, behaves as the first page", async () => {
      const r = await listAdaptiveExportRecords(runId, { beforeReportVersion: NaN });
      expect(r.ok && r.records.length).toBe(30);
      expect(r.ok && r.records[0].reportVersion).toBe(60);
    });
    it("beforeReportVersion=2.9 (fractional cursor) — truncated, never throws", async () => {
      const r = await listAdaptiveExportRecords(runId, { beforeReportVersion: 2.9 });
      // Truncates to 2, so only reportVersion 1 is strictly less than 2.
      expect(r.ok && r.records.map((x) => x.reportVersion)).toEqual([1]);
    });
  });

  describe("Phase 5 final review, Step 7 — pagination is stable across identical createdAt timestamps (sort/cursor key is reportVersion, never createdAt)", () => {
    it("many records sharing the exact same createdAt string paginate with no duplicates and no omissions", async () => {
      const runId = "run-list-timestamp-collision";
      const SAME_TIMESTAMP = "2026-08-11T12:00:00.000Z";
      for (let i = 0; i < 12; i++) {
        const input = buildInput(runId, `exp-tie-${i}`, `Q${i}`);
        input.record.createdAt = SAME_TIMESTAMP;
        input.record.exportMetadata.createdAt = SAME_TIMESTAMP;
        await createAdaptiveExportRecord(input);
      }
      // Every record genuinely shares createdAt — a createdAt-ordered cursor would be ambiguous here.
      const all = await listAdaptiveExportRecords(runId);
      expect(all.ok && new Set(all.ok ? all.records.map((r) => r.createdAt) : []).size).toBe(1);

      // Paginate in pages of 5 using the real cursor contract, exactly as the API route does.
      const seen: number[] = [];
      let cursor: number | undefined = undefined;
      for (let page = 0; page < 10; page++) {
        const r = await listAdaptiveExportRecords(runId, { limit: 5, beforeReportVersion: cursor });
        if (!r.ok) throw new Error("unexpected read failure");
        seen.push(...r.records.map((x) => x.reportVersion));
        if (!r.hasMore) break;
        cursor = r.records[r.records.length - 1].reportVersion;
      }
      const expected = Array.from({ length: 12 }, (_, i) => 12 - i); // 12..1 descending
      expect(seen).toEqual(expected); // no duplicates, no omissions, deterministic order despite the timestamp tie
    });
  });

  describe("Phase 5 final review, Step 8 — a cursor can never cross a run boundary (structural: the collection query is always scoped by the URL-path runId, the cursor is only ever a numeric filter within it)", () => {
    it("a cursor value that happens to also be a valid reportVersion in ANOTHER run never leaks that other run's records", async () => {
      await createAdaptiveExportRecord(buildInput("run-cursor-victim", "exp-v1", "victim Q1"));
      await createAdaptiveExportRecord(buildInput("run-cursor-victim", "exp-v2", "victim Q2"));
      // run-cursor-attacker has its OWN reportVersion 1/2, structurally unrelated to the victim run's.
      await createAdaptiveExportRecord(buildInput("run-cursor-attacker", "exp-atk-1", "attacker Q1"));

      // "Attacker" supplies a cursor for run-cursor-attacker's own list call — even a maximally
      // permissive cursor value (a huge reportVersion, i.e. "give me everything before this")
      // can only ever read from the collection scoped to THAT run's own path.
      const result = await listAdaptiveExportRecords("run-cursor-attacker", { beforeReportVersion: 999999 });
      expect(result.ok).toBe(true);
      expect(result.ok && result.records.every((r) => r.runId === "run-cursor-attacker")).toBe(true);
      expect(result.ok && result.records.some((r) => r.runId === "run-cursor-victim")).toBe(false);
    });

    it("a cursor for a deleted/nonexistent export version (a gap in the sequence) still returns the correct remaining records, never an error", async () => {
      const runId = "run-cursor-gap";
      await createAdaptiveExportRecord(buildInput(runId, "exp-gap-1", "Q1"));
      await createAdaptiveExportRecord(buildInput(runId, "exp-gap-2", "Q2"));
      await createAdaptiveExportRecord(buildInput(runId, "exp-gap-3", "Q3"));
      // Cursor references reportVersion 2 even if that exact record were later removed —
      // "< 2" is a pure numeric filter, not a lookup of the cursor's own document.
      const result = await listAdaptiveExportRecords(runId, { beforeReportVersion: 2 });
      expect(result.ok && result.records.map((r) => r.reportVersion)).toEqual([1]);
    });
  });

  describe("Phase 5 final review, Step 9 — pagination behavior under concurrent insertion (newest-first, live, not snapshot-isolated)", () => {
    it("fetching page 2 with page 1's cursor after a NEW export was created never duplicates or silently skips any of page 1's original items", async () => {
      const runId = "run-concurrent-insert-pagination";
      for (let i = 0; i < 6; i++) {
        await createAdaptiveExportRecord(buildInput(runId, `exp-ci-${i}`, `Q${i}`));
      }
      const page1 = await listAdaptiveExportRecords(runId, { limit: 3 });
      expect(page1.ok && page1.records.map((r) => r.reportVersion)).toEqual([6, 5, 4]);
      const cursor = page1.ok ? page1.records[page1.records.length - 1].reportVersion : undefined;

      // A newer export is created between page 1 and page 2 — this is explicitly
      // "live, newest-first" pagination (documented below), not a fixed snapshot:
      // the new export becomes the new head of the list, but it sorts ABOVE the
      // cursor (reportVersion 7 > 4), so it can never appear on page 2 and can
      // never cause any of page 1's original 3 items to be duplicated or skipped.
      await createAdaptiveExportRecord(buildInput(runId, "exp-ci-new", "New Q"));

      const page2 = await listAdaptiveExportRecords(runId, { limit: 3, beforeReportVersion: cursor });
      expect(page2.ok && page2.records.map((r) => r.reportVersion)).toEqual([3, 2, 1]);

      const allSeen = [...(page1.ok ? page1.records : []), ...(page2.ok ? page2.records : [])].map((r) => r.reportVersion);
      expect(new Set(allSeen).size).toBe(allSeen.length); // no duplicates across the two pages
      expect(allSeen).not.toContain(7); // the newly-inserted head item never leaks into an already-cursored older page
    });
  });
});

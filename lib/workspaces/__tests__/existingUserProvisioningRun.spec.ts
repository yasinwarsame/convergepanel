/**
 * Existing-User Personal Workspace Provisioning, Phase 2B —
 * runExistingUserProvisioning() orchestration tests: pagination, bounded
 * concurrency, the required mixed-population fixture (users A-E), resume,
 * and full-rerun idempotency.
 */

const workspaceDocs = new Map<string, Record<string, unknown>>();

function alreadyExistsError() {
  const err: any = new Error("6 ALREADY_EXISTS");
  err.code = 6;
  return err;
}

function buildMockAdminDb() {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: jest.fn().mockImplementation(async () => {
          const key = `${name}/${id}`;
          return { exists: workspaceDocs.has(key), data: () => workspaceDocs.get(key) };
        }),
        create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          if (workspaceDocs.has(key)) throw alreadyExistsError();
          workspaceDocs.set(key, value);
        }),
      }),
    }),
  };
}

function seed(uid: string, overrides: Record<string, unknown> = {}) {
  workspaceDocs.set(`workspaces/personal-${uid}`, {
    schemaVersion: 1,
    id: `personal-${uid}`,
    type: "personal",
    name: "Personal Workspace",
    ownerUserId: uid,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  });
}

async function loadModule() {
  jest.resetModules();
  workspaceDocs.clear();
  jest.doMock("@/lib/env", () => ({ PERSONAL_WORKSPACE_PROVISIONING_ENABLED: true }));
  jest.doMock("@/lib/firebase/admin", () => ({ adminDb: buildMockAdminDb() }));
  jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
  return import("@/lib/workspaces/existingUserProvisioningRun");
}

describe("runExistingUserProvisioning — pagination", () => {
  it("walks multiple pages until pageToken is exhausted, with zero missing or duplicate processing", async () => {
    const { runExistingUserProvisioning } = await loadModule();

    const pages = [
      { users: [{ uid: "u1", disabled: false }, { uid: "u2", disabled: false }], pageToken: "page-2" },
      { users: [{ uid: "u3", disabled: false }, { uid: "u4", disabled: false }], pageToken: "page-3" },
      { users: [{ uid: "u5", disabled: false }], pageToken: undefined },
    ];

    const seenTokens: (string | undefined)[] = [];
    const listUsersPage = jest.fn().mockImplementation(async (pageToken: string | undefined) => {
      seenTokens.push(pageToken);
      const idx = pageToken === undefined ? 0 : pageToken === "page-2" ? 1 : 2;
      return pages[idx];
    });

    const result = await runExistingUserProvisioning({
      dryRun: true,
      concurrency: 3,
      excludedUids: new Set(),
      listUsersPage,
    });

    expect(seenTokens).toEqual([undefined, "page-2", "page-3"]);
    expect(result.status).toBe("complete");
    expect(result.pageCount).toBe(3);
    expect(result.totals.scanned).toBe(5);
    expect(result.totals.eligible).toBe(5);
    expect(result.lastPageToken).toBeNull();
    expect(result.counts.missing).toBe(5);
  });

  it("invokes onPageComplete once per page with running totals and the next token", async () => {
    const { runExistingUserProvisioning } = await loadModule();
    const onPageComplete = jest.fn();

    const listUsersPage = jest
      .fn()
      .mockResolvedValueOnce({ users: [{ uid: "u1", disabled: false }], pageToken: "tok-2" })
      .mockResolvedValueOnce({ users: [{ uid: "u2", disabled: false }], pageToken: undefined });

    await runExistingUserProvisioning({ dryRun: true, concurrency: 2, excludedUids: new Set(), listUsersPage, onPageComplete });

    expect(onPageComplete).toHaveBeenCalledTimes(2);
    expect(onPageComplete).toHaveBeenNthCalledWith(1, { scanned: 1, eligible: 1, excluded: 0, nextPageToken: "tok-2" });
    expect(onPageComplete).toHaveBeenNthCalledWith(2, { scanned: 2, eligible: 2, excluded: 0, nextPageToken: undefined });
  });
});

describe("runExistingUserProvisioning — fatal enumeration failure produces an incomplete result, never a thrown exception", () => {
  it("page 1 succeeds, page 2's Auth listing fails: previous page's results are preserved, status is incomplete, no false coverage claim", async () => {
    const { runExistingUserProvisioning } = await loadModule();

    const listUsersPage = jest
      .fn()
      .mockResolvedValueOnce({ users: [{ uid: "u1", disabled: false }, { uid: "u2", disabled: false }], pageToken: "page-2" })
      .mockRejectedValueOnce(new Error("simulated Firebase Auth listUsers() transient failure"));

    const result = await runExistingUserProvisioning({ dryRun: true, concurrency: 2, excludedUids: new Set(), listUsersPage });

    // Does not throw — resolves to a result object instead.
    expect(result.status).toBe("incomplete");
    expect(result.fatalError).toEqual(expect.objectContaining({ code: "enumeration_failed" }));
    // Page 1's results are preserved, not discarded.
    expect(result.pageCount).toBe(1);
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.eligible).toBe(2);
    expect(result.counts.missing).toBe(2);
    // The raw exception is never persisted into the result.
    expect(JSON.stringify(result)).not.toContain("simulated Firebase Auth listUsers() transient failure");
  });

  it("a fatal failure on the very first page still returns a well-formed (if empty) incomplete result", async () => {
    const { runExistingUserProvisioning } = await loadModule();
    const listUsersPage = jest.fn().mockRejectedValueOnce(new Error("boom"));

    const result = await runExistingUserProvisioning({ dryRun: false, concurrency: 2, excludedUids: new Set(), listUsersPage });

    expect(result.status).toBe("incomplete");
    expect(result.pageCount).toBe(0);
    expect(result.totals).toEqual({ scanned: 0, eligible: 0, excluded: 0 });
  });
});

describe("isCompleteWithFullCoverage — the sole Phase-3-readiness predicate", () => {
  it("returns true only for a complete run with zero missing, zero conflicts, zero failures", async () => {
    const { runExistingUserProvisioning, isCompleteWithFullCoverage } = await loadModule();
    const listUsersPage = jest.fn().mockResolvedValueOnce({ users: [{ uid: "u1", disabled: false }], pageToken: undefined });
    // u1 will report "missing" in a fresh mock DB — not full coverage yet.
    const result = await runExistingUserProvisioning({ dryRun: true, concurrency: 1, excludedUids: new Set(), listUsersPage });
    expect(isCompleteWithFullCoverage(result)).toBe(false); // missing=1
  });

  it("returns false for an incomplete run even if its partial counts look clean", async () => {
    const { runExistingUserProvisioning, isCompleteWithFullCoverage } = await loadModule();
    const listUsersPage = jest.fn().mockRejectedValueOnce(new Error("boom"));
    const result = await runExistingUserProvisioning({ dryRun: true, concurrency: 1, excludedUids: new Set(), listUsersPage });
    expect(result.status).toBe("incomplete");
    expect(isCompleteWithFullCoverage(result)).toBe(false);
  });

  it("returns true for a complete run with zero missing/conflicts/failures", async () => {
    const { runExistingUserProvisioning, isCompleteWithFullCoverage } = await loadModule();
    const listUsersPage = jest.fn().mockResolvedValueOnce({ users: [], pageToken: undefined });
    const result = await runExistingUserProvisioning({ dryRun: true, concurrency: 1, excludedUids: new Set(), listUsersPage });
    expect(result.status).toBe("complete");
    expect(isCompleteWithFullCoverage(result)).toBe(true);
  });
});

describe("runExistingUserProvisioning — bounded concurrency", () => {
  it("never exceeds the configured concurrency limit within a page", async () => {
    const { runExistingUserProvisioning } = await loadModule();

    const users = Array.from({ length: 12 }, (_, i) => ({ uid: `u${i}`, disabled: false }));
    const listUsersPage = jest.fn().mockResolvedValueOnce({ users, pageToken: undefined });

    let inFlight = 0;
    let maxObserved = 0;

    // Instrument by wrapping the mock Firestore's get() to observe concurrency directly.
    const db = require("@/lib/firebase/admin").adminDb;
    const realCollection = db.collection.bind(db);
    db.collection = (name: string) => {
      const inner = realCollection(name);
      return {
        doc: (id: string) => {
          const docRef = inner.doc(id);
          return {
            ...docRef,
            get: async (...args: unknown[]) => {
              inFlight += 1;
              maxObserved = Math.max(maxObserved, inFlight);
              await new Promise((resolve) => setImmediate(resolve));
              const result = await docRef.get(...args);
              inFlight -= 1;
              return result;
            },
          };
        },
      };
    };

    await runExistingUserProvisioning({ dryRun: true, concurrency: 4, excludedUids: new Set(), listUsersPage });

    expect(maxObserved).toBeLessThanOrEqual(4);
    expect(maxObserved).toBeGreaterThan(1);
  });
});

describe("runExistingUserProvisioning — required mixed-population fixture (Users A-E)", () => {
  it("A -> created, B -> existing, C -> conflict(malformed), D -> conflict(wrong_owner), E -> excluded, with zero mutation to C/D/E", async () => {
    const { runExistingUserProvisioning } = await loadModule();

    // User B: valid existing workspace.
    seed("user-b");
    // User C: malformed deterministic workspace (missing required fields).
    workspaceDocs.set("workspaces/personal-user-c", { schemaVersion: 1, id: "personal-user-c" });
    // User D: wrong-owner deterministic workspace.
    seed("user-d", { ownerUserId: "someone-else" });

    const beforeC = { ...workspaceDocs.get("workspaces/personal-user-c") };
    const beforeD = { ...workspaceDocs.get("workspaces/personal-user-d") };

    const users = [
      { uid: "user-a", disabled: false }, // A: no workspace
      { uid: "user-b", disabled: false }, // B: valid existing
      { uid: "user-c", disabled: false }, // C: malformed
      { uid: "user-d", disabled: false }, // D: wrong owner
      { uid: "user-e", disabled: false }, // E: excluded (explicit)
    ];
    const listUsersPage = jest.fn().mockResolvedValueOnce({ users, pageToken: undefined });

    const result = await runExistingUserProvisioning({
      dryRun: false,
      concurrency: 5,
      excludedUids: new Set(["user-e"]),
      listUsersPage,
    });

    expect(result.counts.created).toBe(1); // A
    expect(result.counts.existing).toBe(1); // B
    expect(result.counts.conflict).toBe(2); // C, D
    expect(result.counts.excluded).toBe(1); // E

    expect(workspaceDocs.has("workspaces/personal-user-a")).toBe(true); // A created
    expect(workspaceDocs.get("workspaces/personal-user-c")).toEqual(beforeC); // C untouched
    expect(workspaceDocs.get("workspaces/personal-user-d")).toEqual(beforeD); // D untouched
    expect(workspaceDocs.has("workspaces/personal-user-e")).toBe(false); // E never touched

    const conflictUids = result.conflicts.map((c) => c.uid).sort();
    expect(conflictUids).toEqual(["user-c", "user-d"]);
    const excludedUids = result.excludedRecords.map((r) => r.uid);
    expect(excludedUids).toEqual(["user-e"]);
  });
});

describe("runExistingUserProvisioning — resume", () => {
  it("resuming from a startPageToken skips already-scanned pages", async () => {
    const { runExistingUserProvisioning } = await loadModule();

    const listUsersPage = jest.fn().mockImplementation(async (pageToken: string | undefined) => {
      if (pageToken === "resume-here") return { users: [{ uid: "u3", disabled: false }], pageToken: undefined };
      throw new Error("should not be called with any other token when resuming");
    });

    const result = await runExistingUserProvisioning({
      dryRun: true,
      concurrency: 2,
      excludedUids: new Set(),
      startPageToken: "resume-here",
      listUsersPage,
    });

    expect(listUsersPage).toHaveBeenCalledTimes(1);
    expect(listUsersPage).toHaveBeenCalledWith("resume-here");
    expect(result.totals.scanned).toBe(1);
  });
});

describe("runExistingUserProvisioning — idempotent full re-run", () => {
  it("a second full execute run creates zero new duplicates and reports previously-created users as existing, with no timestamp mutation", async () => {
    const { runExistingUserProvisioning } = await loadModule();

    const users = [
      { uid: "user-1", disabled: false },
      { uid: "user-2", disabled: false },
    ];
    const listUsersPage = () => Promise.resolve({ users, pageToken: undefined });

    const firstRun = await runExistingUserProvisioning({ dryRun: false, concurrency: 2, excludedUids: new Set(), listUsersPage });
    expect(firstRun.counts.created).toBe(2);

    const snapshotAfterFirstRun = new Map(workspaceDocs);

    const secondRun = await runExistingUserProvisioning({ dryRun: false, concurrency: 2, excludedUids: new Set(), listUsersPage });
    expect(secondRun.counts.existing).toBe(2);
    expect(secondRun.counts.created ?? 0).toBe(0);

    // No document mutated between runs (same createdAt/updatedAt, no new doc count).
    expect(workspaceDocs.size).toBe(snapshotAfterFirstRun.size);
    for (const [key, value] of snapshotAfterFirstRun) {
      expect(workspaceDocs.get(key)).toEqual(value);
    }
  });
});

describe("runExistingUserProvisioning — Auth/profile mismatch edge cases", () => {
  it("an Auth user with no Firestore users/{uid} profile is still successfully provisioned", async () => {
    const { runExistingUserProvisioning } = await loadModule();
    // No `users/{uid}` profile is ever read by this pipeline — eligibility and
    // provisioning are both driven purely by the Auth user record, so a
    // missing profile document has no representation here at all.
    const users = [{ uid: "auth-only-user", disabled: false }];
    const listUsersPage = () => Promise.resolve({ users, pageToken: undefined });

    const result = await runExistingUserProvisioning({ dryRun: false, concurrency: 1, excludedUids: new Set(), listUsersPage });

    expect(result.counts.created).toBe(1);
    expect(workspaceDocs.has("workspaces/personal-auth-only-user")).toBe(true);
  });

  it("a Firestore-profile-only user (no Auth account) is never enumerated, hence never provisioned", async () => {
    const { runExistingUserProvisioning } = await loadModule();
    // The population source is exclusively listUsersPage (Auth), so a
    // Firestore-only "ghost" profile simply never appears in `users` here —
    // there is no code path by which it could be provisioned.
    const listUsersPage = () => Promise.resolve({ users: [], pageToken: undefined });

    const result = await runExistingUserProvisioning({ dryRun: false, concurrency: 1, excludedUids: new Set(), listUsersPage });

    expect(result.totals.scanned).toBe(0);
    expect(workspaceDocs.size).toBe(0);
  });
});

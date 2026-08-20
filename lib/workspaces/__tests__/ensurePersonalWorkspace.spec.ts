/**
 * Personal Workspace Provisioning, Phase 2 — ensurePersonalWorkspace()
 * tests: idempotency, conflict handling, and concurrency.
 *
 * Concurrency disclosure (per program requirement — do not overstate this):
 * this repository has no Firestore emulator or `@firebase/rules-unit-testing`
 * infrastructure (confirmed: `firebase.json` declares no `emulators` block,
 * no such dependency exists in package.json — the same finding Phase 1's
 * review already made). The concurrency tests below use a realistic,
 * stateful, single-process in-memory mock of `adminDb` that reproduces
 * Firestore's actual `.create()` contract — a synchronous, atomic
 * check-and-set at a fixed document id, exactly one caller ever succeeds —
 * and genuinely dispatches 10 real concurrent `ensurePersonalWorkspace()`
 * promises via `Promise.all`, with an artificial microtask delay on the
 * READ path (`.get()`) only, so the "loser reads back the winner's
 * document" branch is genuinely exercised under real interleaving. This is
 * NOT a distributed Firestore emulator test — it validates that this
 * SERVICE'S logic correctly handles the two real outcomes
 * (`.create()` succeeds / `.create()` throws ALREADY_EXISTS) that real
 * Firestore's server-side atomicity guarantees, not that a real
 * distributed system was exercised.
 */

import { Status } from "google-gax";

const workspaceDocs = new Map<string, Record<string, unknown>>();
const flagValue = { value: false };
const readDelayEnabled = { value: false };

/**
 * Uses the real numeric `Status.ALREADY_EXISTS` (6) from `google-gax` —
 * the actual dependency `firebase-admin@12.7.0`'s Firestore client uses
 * internally, verified by direct source inspection (see
 * `lib/firestore/__tests__/workspaces.spec.ts`'s own header comment). Not
 * a mock-invented shape.
 */
function alreadyExistsError() {
  const err: any = new Error(`${Status.ALREADY_EXISTS} ALREADY_EXISTS: Document already exists.`);
  err.code = Status.ALREADY_EXISTS;
  return err;
}

function microtaskDelay() {
  return new Promise((resolve) => setImmediate(resolve));
}

function buildMockAdminDb() {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: jest.fn().mockImplementation(async () => {
          if (readDelayEnabled.value) await microtaskDelay();
          const key = `${name}/${id}`;
          return { exists: workspaceDocs.has(key), data: () => workspaceDocs.get(key) };
        }),
        // Synchronous check-and-set, deliberately with NO artificial
        // delay — this correctly models Firestore's real atomicity
        // guarantee for `.create()` at a fixed document id (see file
        // header). Introducing a yield here would test a scenario real
        // Firestore's server-side atomicity never actually allows.
        create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          if (workspaceDocs.has(key)) throw alreadyExistsError();
          workspaceDocs.set(key, value);
        }),
      }),
    }),
  };
}

async function loadWithFlag(enabled: boolean) {
  jest.resetModules();
  workspaceDocs.clear();
  jest.doMock("@/lib/env", () => ({ PERSONAL_WORKSPACE_PROVISIONING_ENABLED: enabled }));
  jest.doMock("@/lib/firebase/admin", () => ({ adminDb: buildMockAdminDb() }));
  jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
  const mod = await import("@/lib/workspaces/ensurePersonalWorkspace");
  return mod.ensurePersonalWorkspace;
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

beforeEach(() => {
  readDelayEnabled.value = false;
});

describe("ensurePersonalWorkspace — flag state", () => {
  it("returns disabled and touches Firestore not at all when the flag is off", async () => {
    const ensure = await loadWithFlag(false);
    const result = await ensure("owner-1");
    expect(result).toEqual({ status: "disabled" });
    expect(workspaceDocs.size).toBe(0);
  });

  it("proceeds normally when the flag is on", async () => {
    const ensure = await loadWithFlag(true);
    const result = await ensure("owner-1");
    expect(result.status).toBe("created");
  });
});

describe("ensurePersonalWorkspace — uid validation", () => {
  it("returns invalid_uid for a structurally invalid uid, without any Firestore write", async () => {
    const ensure = await loadWithFlag(true);
    const result = await ensure("");
    expect(result).toEqual({ status: "invalid_uid" });
    expect(workspaceDocs.size).toBe(0);
  });
});

describe("ensurePersonalWorkspace — idempotency", () => {
  it("first call: created", async () => {
    const ensure = await loadWithFlag(true);
    const result = await ensure("owner-1");
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.workspace).toMatchObject({ id: "personal-owner-1", type: "personal", ownerUserId: "owner-1" });
    }
  });

  it("second call: existing, same workspace, no duplicate document", async () => {
    const ensure = await loadWithFlag(true);
    const first = await ensure("owner-1");
    const second = await ensure("owner-1");
    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    if (first.status === "created" && second.status === "existing") {
      expect(second.workspace).toEqual(first.workspace);
    }
    expect(workspaceDocs.size).toBe(1);
  });

  it("repeated sequential calls (3x): same id, same owner, same timestamps, exactly one document, no rewrite", async () => {
    const ensure = await loadWithFlag(true);
    const r1 = await ensure("owner-1");
    const r2 = await ensure("owner-1");
    const r3 = await ensure("owner-1");
    const workspaces = [r1, r2, r3].map((r) => (r as any).workspace);
    expect(workspaces[0]).toEqual(workspaces[1]);
    expect(workspaces[1]).toEqual(workspaces[2]);
    expect(workspaceDocs.size).toBe(1);
    // createdAt/updatedAt genuinely unchanged, not merely "equal by
    // coincidence" — same object identity path (never re-written).
    expect(workspaces[0].createdAt).toEqual(workspaces[2].createdAt);
    expect(workspaces[0].updatedAt).toEqual(workspaces[2].updatedAt);
  });
});

describe("ensurePersonalWorkspace — concurrency (same user)", () => {
  it("10 simultaneous calls for the same uid: exactly one document, every caller resolves to the same canonical workspace", async () => {
    const ensure = await loadWithFlag(true);
    readDelayEnabled.value = true;

    const results = await Promise.all(Array.from({ length: 10 }, () => ensure("owner-1")));

    const createdCount = results.filter((r) => r.status === "created").length;
    const existingCount = results.filter((r) => r.status === "existing").length;
    const failedCount = results.filter((r) => r.status !== "created" && r.status !== "existing").length;

    expect(createdCount).toBe(1);
    expect(existingCount).toBe(9);
    expect(failedCount).toBe(0);
    expect(workspaceDocs.size).toBe(1);

    const workspaces = results.map((r) => (r as any).workspace);
    const uniqueIds = new Set(workspaces.map((w) => w.id));
    const uniqueOwners = new Set(workspaces.map((w) => w.ownerUserId));
    expect(uniqueIds).toEqual(new Set(["personal-owner-1"]));
    expect(uniqueOwners).toEqual(new Set(["owner-1"]));
    // Every caller — winner and losers alike — sees byte-for-byte the same document.
    const first = JSON.stringify(workspaces[0]);
    expect(workspaces.every((w) => JSON.stringify(w) === first)).toBe(true);
  });
});

describe("ensurePersonalWorkspace — cross-user concurrency", () => {
  it("User A and User B provisioning concurrently: distinct workspaces, no ownership crossover", async () => {
    const ensure = await loadWithFlag(true);
    readDelayEnabled.value = true;

    const calls = [
      ...Array.from({ length: 5 }, () => ensure("owner-a")),
      ...Array.from({ length: 5 }, () => ensure("owner-b")),
    ];
    const results = await Promise.all(calls);

    expect(workspaceDocs.size).toBe(2);
    expect(workspaceDocs.has("workspaces/personal-owner-a")).toBe(true);
    expect(workspaceDocs.has("workspaces/personal-owner-b")).toBe(true);

    const aResults = results.slice(0, 5) as any[];
    const bResults = results.slice(5) as any[];
    expect(aResults.every((r) => r.workspace.ownerUserId === "owner-a")).toBe(true);
    expect(bResults.every((r) => r.workspace.ownerUserId === "owner-b")).toBe(true);
    expect(aResults.filter((r) => r.status === "created")).toHaveLength(1);
    expect(bResults.filter((r) => r.status === "created")).toHaveLength(1);
  });
});

describe("ensurePersonalWorkspace — ALREADY_EXISTS conflict handling (fail closed, never overwrite)", () => {
  it("ALREADY_EXISTS + valid existing doc: existing (success)", async () => {
    const ensure = await loadWithFlag(true);
    seed("owner-1");
    const result = await ensure("owner-1");
    expect(result.status).toBe("existing");
  });

  it("ALREADY_EXISTS + wrong owner: conflict, existing document untouched", async () => {
    const ensure = await loadWithFlag(true);
    seed("owner-1", { ownerUserId: "someone-else" });
    const before = workspaceDocs.get("workspaces/personal-owner-1");
    const result = await ensure("owner-1");
    expect(result).toEqual({ status: "conflict", reason: "wrong_owner" });
    expect(workspaceDocs.get("workspaces/personal-owner-1")).toEqual(before);
  });

  it("ALREADY_EXISTS + wrong type (team): conflict, existing document untouched", async () => {
    const ensure = await loadWithFlag(true);
    seed("owner-1", { type: "team", createdByUserId: "owner-1" }); // Phase 8B: well-formed team shape now requires createdByUserId
    const before = workspaceDocs.get("workspaces/personal-owner-1");
    const result = await ensure("owner-1");
    expect(result).toEqual({ status: "conflict", reason: "wrong_type" });
    expect(workspaceDocs.get("workspaces/personal-owner-1")).toEqual(before);
  });

  it("ALREADY_EXISTS + malformed schema (missing required fields): conflict, untouched", async () => {
    const ensure = await loadWithFlag(true);
    workspaceDocs.set("workspaces/personal-owner-1", { schemaVersion: 1, id: "personal-owner-1" }); // missing type/name/ownerUserId
    const before = workspaceDocs.get("workspaces/personal-owner-1");
    const result = await ensure("owner-1");
    expect(result).toEqual({ status: "conflict", reason: "malformed" });
    expect(workspaceDocs.get("workspaces/personal-owner-1")).toEqual(before);
  });

  it("ALREADY_EXISTS + mismatched embedded id: conflict, untouched", async () => {
    const ensure = await loadWithFlag(true);
    seed("owner-1", { id: "personal-impostor" });
    const before = workspaceDocs.get("workspaces/personal-owner-1");
    const result = await ensure("owner-1");
    expect(result).toEqual({ status: "conflict", reason: "malformed" });
    expect(workspaceDocs.get("workspaces/personal-owner-1")).toEqual(before);
  });

  it("ALREADY_EXISTS + unsupported schemaVersion: conflict, untouched", async () => {
    const ensure = await loadWithFlag(true);
    seed("owner-1", { schemaVersion: 2 });
    const before = workspaceDocs.get("workspaces/personal-owner-1");
    const result = await ensure("owner-1");
    expect(result).toEqual({ status: "conflict", reason: "malformed" });
    expect(workspaceDocs.get("workspaces/personal-owner-1")).toEqual(before);
  });
});

describe("ensurePersonalWorkspace — failure semantics (never a broad automatic retry)", () => {
  it("create_failed (non-ALREADY_EXISTS write error): reported, not retried", async () => {
    jest.resetModules();
    workspaceDocs.clear();
    jest.doMock("@/lib/env", () => ({ PERSONAL_WORKSPACE_PROVISIONING_ENABLED: true }));
    jest.doMock("@/lib/firebase/admin", () => ({
      adminDb: {
        collection: () => ({
          doc: () => ({
            create: jest.fn().mockImplementation(async () => {
              throw new Error("simulated write outage");
            }),
            get: jest.fn(),
          }),
        }),
      },
    }));
    jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
    const { ensurePersonalWorkspace } = await import("@/lib/workspaces/ensurePersonalWorkspace");
    const result = await ensurePersonalWorkspace("owner-1");
    expect(result).toEqual({ status: "create_failed" });
  });

  it("read-after-ALREADY_EXISTS failure: lookup_failed, not silently treated as success or legacy", async () => {
    jest.resetModules();
    workspaceDocs.clear();
    jest.doMock("@/lib/env", () => ({ PERSONAL_WORKSPACE_PROVISIONING_ENABLED: true }));
    jest.doMock("@/lib/firebase/admin", () => ({
      adminDb: {
        collection: () => ({
          doc: () => ({
            create: jest.fn().mockImplementation(async () => {
              throw alreadyExistsError();
            }),
            get: jest.fn().mockImplementation(async () => {
              throw new Error("simulated read outage");
            }),
          }),
        }),
      },
    }));
    jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
    const { ensurePersonalWorkspace } = await import("@/lib/workspaces/ensurePersonalWorkspace");
    const result = await ensurePersonalWorkspace("owner-1");
    expect(result).toEqual({ status: "lookup_failed" });
  });

  it("not_found immediately after ALREADY_EXISTS (deleted in the gap): lookup_failed, not created and not silently re-created", async () => {
    jest.resetModules();
    workspaceDocs.clear();
    jest.doMock("@/lib/env", () => ({ PERSONAL_WORKSPACE_PROVISIONING_ENABLED: true }));
    jest.doMock("@/lib/firebase/admin", () => ({
      adminDb: {
        collection: () => ({
          doc: () => ({
            create: jest.fn().mockImplementation(async () => {
              throw alreadyExistsError();
            }),
            get: jest.fn().mockImplementation(async () => ({ exists: false })),
          }),
        }),
      },
    }));
    jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
    const { ensurePersonalWorkspace } = await import("@/lib/workspaces/ensurePersonalWorkspace");
    const result = await ensurePersonalWorkspace("owner-1");
    expect(result).toEqual({ status: "lookup_failed" });
  });
});

describe("Structural: no run/history/export/governance mutation import anywhere in the provisioning module", () => {
  it("ensurePersonalWorkspace.ts imports nothing from lib/firestore/runs.ts or any governance/export module", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "lib/workspaces/ensurePersonalWorkspace.ts"), "utf8");
    const forbidden = ["firestore/runs", "governance/", "adaptiveSchema/", "verification/", "video/"];
    for (const term of forbidden) {
      expect(source).not.toContain(term);
    }
  });

  it("exports exactly ensurePersonalWorkspace — no run/backfill helper alongside it", () => {
    const mod = require("@/lib/workspaces/ensurePersonalWorkspace");
    expect(Object.keys(mod)).toEqual(["ensurePersonalWorkspace"]);
  });
});

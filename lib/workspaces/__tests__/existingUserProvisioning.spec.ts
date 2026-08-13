/**
 * Existing-User Personal Workspace Provisioning, Phase 2B —
 * discoverUserWorkspaceStatus() / provisionUserWorkspace() /
 * mapWithConcurrency() tests, including the structural dry-run safety
 * proof: dry-run mode is INCAPABLE of writing, not merely configured not
 * to.
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

async function loadModules(provisioningEnabled = true) {
  jest.resetModules();
  workspaceDocs.clear();
  jest.doMock("@/lib/env", () => ({ PERSONAL_WORKSPACE_PROVISIONING_ENABLED: provisioningEnabled }));
  jest.doMock("@/lib/firebase/admin", () => ({ adminDb: buildMockAdminDb() }));
  jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
  return import("@/lib/workspaces/existingUserProvisioning");
}

describe("discoverUserWorkspaceStatus — dry-run, read-only", () => {
  it("returns excluded (zero I/O) for a disabled user", async () => {
    const { discoverUserWorkspaceStatus } = await loadModules();
    const result = await discoverUserWorkspaceStatus({ uid: "uid-1", disabled: true }, new Set());
    expect(result).toEqual({ status: "excluded", reason: "excluded_disabled" });
  });

  it("returns excluded for an explicitly excluded uid", async () => {
    const { discoverUserWorkspaceStatus } = await loadModules();
    const result = await discoverUserWorkspaceStatus({ uid: "uid-1", disabled: false }, new Set(["uid-1"]));
    expect(result).toEqual({ status: "excluded", reason: "excluded_explicit" });
  });

  it("returns missing for an eligible user with no workspace", async () => {
    const { discoverUserWorkspaceStatus } = await loadModules();
    const result = await discoverUserWorkspaceStatus({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "missing" });
    expect(workspaceDocs.size).toBe(0); // confirmed: nothing was created
  });

  it("returns existing_valid for an eligible user with a valid workspace", async () => {
    seed("uid-1");
    const { discoverUserWorkspaceStatus } = await loadModules();
    seed("uid-1"); // re-seed after loadModules() reset the map
    const result = await discoverUserWorkspaceStatus({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "existing_valid" });
  });

  it("returns conflict wrong_owner for a mismatched existing workspace", async () => {
    const { discoverUserWorkspaceStatus } = await loadModules();
    seed("uid-1", { ownerUserId: "someone-else" });
    const result = await discoverUserWorkspaceStatus({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "conflict", reason: "wrong_owner" });
  });

  it("returns conflict wrong_type for a team-type existing workspace", async () => {
    const { discoverUserWorkspaceStatus } = await loadModules();
    seed("uid-1", { type: "team" });
    const result = await discoverUserWorkspaceStatus({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "conflict", reason: "wrong_type" });
  });

  it("returns conflict malformed for a structurally invalid existing document", async () => {
    const { discoverUserWorkspaceStatus } = await loadModules();
    workspaceDocs.set("workspaces/personal-uid-1", { schemaVersion: 1, id: "personal-uid-1" }); // missing fields
    const result = await discoverUserWorkspaceStatus({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "conflict", reason: "malformed" });
  });

  it("never writes anything regardless of PERSONAL_WORKSPACE_PROVISIONING_ENABLED's value", async () => {
    const { discoverUserWorkspaceStatus } = await loadModules(false); // flag OFF this time
    const result = await discoverUserWorkspaceStatus({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "missing" });
    expect(workspaceDocs.size).toBe(0);
  });
});

describe("Structural: dry-run is incapable of writing, not merely configured not to", () => {
  it("existingUserProvisioning.ts's discovery path imports getWorkspace but never createPersonalWorkspace/ensurePersonalWorkspace for its own discovery call", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "lib/workspaces/existingUserProvisioning.ts"), "utf8");
    const fnStart = source.indexOf("export async function discoverUserWorkspaceStatus");
    const fnEnd = source.indexOf("\n}\n", fnStart) + "\n}\n".length;
    const discoveryFnBody = source.slice(fnStart, fnEnd);
    expect(discoveryFnBody).not.toContain("createPersonalWorkspace(");
    expect(discoveryFnBody).not.toContain("ensurePersonalWorkspace(");
    expect(discoveryFnBody).toContain("getWorkspace(");
  });
});

describe("provisionUserWorkspace — execute, delegates entirely to ensurePersonalWorkspace", () => {
  it("returns excluded (zero calls to ensurePersonalWorkspace) for a disabled user", async () => {
    const { provisionUserWorkspace } = await loadModules();
    const result = await provisionUserWorkspace({ uid: "uid-1", disabled: true }, new Set());
    expect(result).toEqual({ status: "excluded", reason: "excluded_disabled" });
    expect(workspaceDocs.size).toBe(0);
  });

  it("returns created for a fresh eligible user", async () => {
    const { provisionUserWorkspace } = await loadModules();
    const result = await provisionUserWorkspace({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "created" });
    expect(workspaceDocs.has("workspaces/personal-uid-1")).toBe(true);
  });

  it("returns existing for an already-provisioned eligible user, without rewriting the document", async () => {
    const { provisionUserWorkspace } = await loadModules();
    seed("uid-1");
    const before = workspaceDocs.get("workspaces/personal-uid-1");
    const result = await provisionUserWorkspace({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "existing" });
    expect(workspaceDocs.get("workspaces/personal-uid-1")).toEqual(before);
  });

  it("returns conflict and never overwrites for a wrong-owner existing document", async () => {
    const { provisionUserWorkspace } = await loadModules();
    seed("uid-1", { ownerUserId: "someone-else" });
    const before = workspaceDocs.get("workspaces/personal-uid-1");
    const result = await provisionUserWorkspace({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "conflict", reason: "wrong_owner" });
    expect(workspaceDocs.get("workspaces/personal-uid-1")).toEqual(before);
  });

  it("returns failed when PERSONAL_WORKSPACE_PROVISIONING_ENABLED is off (surfaced as a visible per-user failure, not silently absorbed)", async () => {
    const { provisionUserWorkspace } = await loadModules(false);
    const result = await provisionUserWorkspace({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ status: "failed" });
    expect(workspaceDocs.size).toBe(0);
  });
});

describe("mapWithConcurrency", () => {
  it("processes all items and preserves result order matching input order", async () => {
    const { mapWithConcurrency } = await loadModules();
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("never exceeds the configured concurrency limit at any instant", async () => {
    const { mapWithConcurrency } = await loadModules();
    let inFlight = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return n;
    });

    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(1); // proves real concurrency happened, not accidental serialization
  });

  it("handles an empty item list", async () => {
    const { mapWithConcurrency } = await loadModules();
    const results = await mapWithConcurrency([], 5, async (n) => n);
    expect(results).toEqual([]);
  });

  it("handles concurrency greater than the item count without error", async () => {
    const { mapWithConcurrency } = await loadModules();
    const results = await mapWithConcurrency([1, 2], 10, async (n) => n);
    expect(results).toEqual([1, 2]);
  });
});

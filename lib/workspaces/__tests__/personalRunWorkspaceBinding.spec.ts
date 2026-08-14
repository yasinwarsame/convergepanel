/**
 * Workspace-Aware Writes for New Personal Adaptive Runs, Phase 3 —
 * resolvePersonalRunWorkspaceBinding() tests: every outcome, and the
 * structural proof that ensurePersonalWorkspace() is never referenced.
 */

const workspaceDocs = new Map<string, Record<string, unknown>>();

function buildMockAdminDb() {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: jest.fn().mockImplementation(async () => {
          const key = `${name}/${id}`;
          return { exists: workspaceDocs.has(key), data: () => workspaceDocs.get(key) };
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
  jest.doMock("@/lib/firebase/admin", () => ({ adminDb: buildMockAdminDb() }));
  jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
  return import("@/lib/workspaces/personalRunWorkspaceBinding");
}

describe("resolvePersonalRunWorkspaceBinding", () => {
  it("flag_off when writesEnabled is false, regardless of anything else — zero I/O", async () => {
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "uid-1", writesEnabled: false, workspacesEnabled: false, hasTeam: false });
    expect(result).toEqual({ outcome: "flag_off" });
  });

  it("invalid_configuration when RW=true but W=false, for a NON-team user — never proceeds to workspace resolution", async () => {
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "uid-1", writesEnabled: true, workspacesEnabled: false, hasTeam: false });
    expect(result).toEqual({ outcome: "invalid_configuration", reason: "workspaces_disabled_but_writes_enabled" });
  });

  it("team_user when the caller reports hasTeam=true — not a failure, just not applicable", async () => {
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "uid-1", writesEnabled: true, workspacesEnabled: true, hasTeam: true });
    expect(result).toEqual({ outcome: "team_user" });
    expect(workspaceDocs.size).toBe(0); // never even attempted a workspace lookup
  });

  it("REGRESSION (Phase 3A independent review): a TEAM user with writesEnabled=true and workspacesEnabled=false gets team_user, NEVER invalid_configuration — the Personal-only configuration invariant must never hard-reject a request Phase 3 was never going to bind in the first place. Team scope-exclusion is checked before the Personal-only config check, not after", async () => {
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "team-uid", writesEnabled: true, workspacesEnabled: false, hasTeam: true });
    expect(result).toEqual({ outcome: "team_user" });
    expect(result).not.toEqual(expect.objectContaining({ outcome: "invalid_configuration" }));
    expect(workspaceDocs.size).toBe(0); // never even attempted a workspace lookup
  });

  it("bound when a valid Personal Workspace exists for a non-team user", async () => {
    seed("uid-1");
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    seed("uid-1"); // re-seed after loadModule() reset the map
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "uid-1", writesEnabled: true, workspacesEnabled: true, hasTeam: false });
    expect(result).toEqual({ outcome: "bound", workspaceId: "personal-uid-1" });
  });

  it("resolution_failed:not_found when no Workspace document exists", async () => {
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "uid-1", writesEnabled: true, workspacesEnabled: true, hasTeam: false });
    expect(result).toEqual({ outcome: "resolution_failed", reason: "not_found" });
  });

  it("resolution_failed:malformed when the document is structurally invalid", async () => {
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    workspaceDocs.set("workspaces/personal-uid-1", { schemaVersion: 1, id: "personal-uid-1" }); // missing fields
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "uid-1", writesEnabled: true, workspacesEnabled: true, hasTeam: false });
    expect(result).toEqual({ outcome: "resolution_failed", reason: "malformed" });
  });

  it("resolution_failed:wrong_owner when the deterministic document belongs to someone else", async () => {
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    seed("uid-1", { ownerUserId: "someone-else" });
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "uid-1", writesEnabled: true, workspacesEnabled: true, hasTeam: false });
    expect(result).toEqual({ outcome: "resolution_failed", reason: "wrong_owner" });
  });

  it("resolution_failed:wrong_type when the document is a non-personal Workspace", async () => {
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    seed("uid-1", { type: "team" });
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "uid-1", writesEnabled: true, workspacesEnabled: true, hasTeam: false });
    expect(result).toEqual({ outcome: "resolution_failed", reason: "wrong_type" });
  });

  it("resolution_failed:lookup_failed when the underlying Firestore read throws", async () => {
    jest.resetModules();
    workspaceDocs.clear();
    jest.doMock("@/lib/firebase/admin", () => ({
      adminDb: {
        collection: () => ({
          doc: () => ({ get: jest.fn().mockRejectedValue(new Error("simulated transient failure")) }),
        }),
      },
    }));
    jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
    const { resolvePersonalRunWorkspaceBinding } = await import("@/lib/workspaces/personalRunWorkspaceBinding");
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "uid-1", writesEnabled: true, workspacesEnabled: true, hasTeam: false });
    expect(result).toEqual({ outcome: "resolution_failed", reason: "lookup_failed" });
  });

  it("resolution_failed:invalid_uid for a structurally invalid uid", async () => {
    const { resolvePersonalRunWorkspaceBinding } = await loadModule();
    const result = await resolvePersonalRunWorkspaceBinding({ uid: "not/a/valid/uid", writesEnabled: true, workspacesEnabled: true, hasTeam: false });
    expect(result).toEqual({ outcome: "resolution_failed", reason: "invalid_uid" });
  });
});

describe("Structural: never auto-provisions", () => {
  it("personalRunWorkspaceBinding.ts never IMPORTS ensurePersonalWorkspace or createPersonalWorkspace — structurally incapable of calling them, not merely configured not to", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "lib/workspaces/personalRunWorkspaceBinding.ts"), "utf8");
    const importLines = source.split("\n").filter((line: string) => line.trim().startsWith("import "));
    const importSection = importLines.join("\n");
    expect(importSection).not.toContain("ensurePersonalWorkspace");
    expect(importSection).not.toContain("createPersonalWorkspace");
    expect(importSection).toContain("getWorkspace");
  });
});

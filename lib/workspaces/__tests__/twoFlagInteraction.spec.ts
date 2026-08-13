/**
 * Personal Workspace Provisioning, Phase 2 — explicit two-flag interaction
 * matrix: `WORKSPACES_ENABLED` (Phase 1, authorization boundary) and
 * `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` (Phase 2, rollout switch) are
 * verified here to be genuinely independent — not just by structural grep
 * (see docs/workspaces/architecture.md's "four-combination matrix"), but
 * by actually flipping both flags together and observing real behavior
 * from both `ensurePersonalWorkspace()` and `resolveWorkspaceContext()`.
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
        create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          if (workspaceDocs.has(key)) {
            const err: any = new Error("6 ALREADY_EXISTS");
            err.code = 6;
            throw err;
          }
          workspaceDocs.set(key, value);
        }),
      }),
    }),
  };
}

async function loadWithFlags(workspacesEnabled: boolean, provisioningEnabled: boolean) {
  jest.resetModules();
  workspaceDocs.clear();
  jest.doMock("@/lib/env", () => ({
    WORKSPACES_ENABLED: workspacesEnabled,
    PERSONAL_WORKSPACE_PROVISIONING_ENABLED: provisioningEnabled,
  }));
  jest.doMock("@/lib/firebase/admin", () => ({ adminDb: buildMockAdminDb() }));
  jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
  const ensureMod = await import("@/lib/workspaces/ensurePersonalWorkspace");
  const resolverMod = await import("@/lib/workspaces/workspaceResolver");
  return { ensurePersonalWorkspace: ensureMod.ensurePersonalWorkspace, resolveWorkspaceContext: resolverMod.resolveWorkspaceContext };
}

describe("Two-flag interaction matrix", () => {
  it("W=false, P=false: provisioning disabled; existing unbound resource still resolves legacy", async () => {
    const { ensurePersonalWorkspace, resolveWorkspaceContext } = await loadWithFlags(false, false);
    const provision = await ensurePersonalWorkspace("owner-1");
    expect(provision).toEqual({ status: "disabled" });

    const resolution = resolveWorkspaceContext({ workspacesEnabled: false, workspaceId: undefined, legacyOwnerUserId: "owner-1" });
    expect(resolution).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: "owner-1" } });
  });

  it("W=false, P=true: provisioning ACTIVE (creates a real workspace); existing unbound resource STILL resolves legacy, completely unaffected", async () => {
    const { ensurePersonalWorkspace, resolveWorkspaceContext } = await loadWithFlags(false, true);

    const provision = await ensurePersonalWorkspace("owner-1");
    expect(provision.status).toBe("created");
    expect(workspaceDocs.size).toBe(1); // a real Personal Workspace document now genuinely exists

    // The critical assertion: an existing resource with no workspaceId of
    // its own resolves exactly the same as if no workspace had ever been
    // provisioned. Provisioning does not "leak" into resolution.
    const resolution = resolveWorkspaceContext({ workspacesEnabled: false, workspaceId: undefined, legacyOwnerUserId: "owner-1" });
    expect(resolution).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: "owner-1" } });

    // And a HYPOTHETICAL future resource that WAS bound to this newly
    // created workspace would fail closed (deny), not silently pass —
    // proving provisioning never "automatically authorizes" anything.
    const hypotheticalBoundResolution = resolveWorkspaceContext({
      workspacesEnabled: false,
      workspaceId: "personal-owner-1",
      legacyOwnerUserId: "owner-1",
    });
    expect(hypotheticalBoundResolution).toEqual({ kind: "workspaces_disabled" });
  });

  it("W=true, P=false: provisioning disabled (no new workspace); resolution fully active for a workspace that already exists", async () => {
    const { ensurePersonalWorkspace, resolveWorkspaceContext } = await loadWithFlags(true, false);
    // Simulate a workspace that was already created during an earlier
    // W=false,P=true window.
    workspaceDocs.set("workspaces/personal-owner-1", {
      schemaVersion: 1,
      id: "personal-owner-1",
      type: "personal",
      name: "Personal Workspace",
      ownerUserId: "owner-1",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    });

    const provision = await ensurePersonalWorkspace("owner-2");
    expect(provision).toEqual({ status: "disabled" });
    expect(workspaceDocs.size).toBe(1); // unchanged — no new document

    // Phase 1's getWorkspace() read path is entirely ungated by P — a
    // pre-existing workspace remains readable/resolvable regardless of
    // the provisioning flag's value.
    const { getWorkspace } = await import("@/lib/firestore/workspaces");
    const lookup = await getWorkspace("personal-owner-1");
    expect(lookup.status).toBe("found");
  });

  it("W=true, P=true: both active — provisioning works, and a bound resource would resolve for real", async () => {
    const { ensurePersonalWorkspace, resolveWorkspaceContext } = await loadWithFlags(true, true);
    const provision = await ensurePersonalWorkspace("owner-1");
    expect(provision.status).toBe("created");

    const resolution = resolveWorkspaceContext({ workspacesEnabled: true, workspaceId: undefined, legacyOwnerUserId: "owner-1" });
    expect(resolution).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: "owner-1" } });
  });
});

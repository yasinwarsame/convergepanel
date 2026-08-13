/**
 * Workspace Compatibility Foundation, Phase 1 — resolveWorkspaceContext()
 * (pure) and resolveWorkspaceContextForResource() (async wrapper) tests.
 * Covers the program's required unit test matrix and the "legacy downgrade"
 * security invariant: an invalid workspaceId must never fall back to
 * legacy ownership.
 */

import { resolveWorkspaceContext } from "@/lib/workspaces/workspaceResolver";
import type { GetWorkspaceResult } from "@/lib/firestore/workspaces";

const OWNER_UID = "owner-1";

function foundLookup(overrides: Partial<GetWorkspaceResult & { status: "found" }> = {}): GetWorkspaceResult {
  return {
    status: "found",
    workspace: {
      schemaVersion: 1,
      id: "ws-1",
      type: "personal",
      name: "Personal Workspace",
      ownerUserId: OWNER_UID,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
    ...overrides,
  } as GetWorkspaceResult;
}

describe("resolveWorkspaceContext — pure", () => {
  describe("feature flag disabled", () => {
    it("always resolves legacy, even when a workspaceId is present and would otherwise resolve", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: false,
        workspaceId: "ws-1",
        legacyOwnerUserId: OWNER_UID,
        workspaceLookup: foundLookup(),
      });
      expect(result).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: OWNER_UID } });
    });

    it("resolves legacy when workspaceId is absent, as expected", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: false,
        workspaceId: undefined,
        legacyOwnerUserId: OWNER_UID,
      });
      expect(result).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: OWNER_UID } });
    });
  });

  describe("feature flag enabled — workspaceId absent", () => {
    it("resolves legacy for undefined workspaceId", () => {
      const result = resolveWorkspaceContext({ workspacesEnabled: true, workspaceId: undefined, legacyOwnerUserId: OWNER_UID });
      expect(result).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: OWNER_UID } });
    });

    it("resolves legacy for null workspaceId", () => {
      const result = resolveWorkspaceContext({ workspacesEnabled: true, workspaceId: null, legacyOwnerUserId: OWNER_UID });
      expect(result).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: OWNER_UID } });
    });

    it("resolves legacy for an empty-string workspaceId", () => {
      const result = resolveWorkspaceContext({ workspacesEnabled: true, workspaceId: "", legacyOwnerUserId: OWNER_UID });
      expect(result).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: OWNER_UID } });
    });
  });

  describe("feature flag enabled — workspaceId present and valid", () => {
    it("resolves to a workspace context matching the looked-up workspace's own owner, not the legacy owner field", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: true,
        workspaceId: "ws-1",
        legacyOwnerUserId: "some-other-legacy-uid",
        workspaceLookup: foundLookup(),
      });
      expect(result).toEqual({
        kind: "resolved",
        context: { mode: "workspace", workspaceId: "ws-1", workspaceType: "personal", ownerUserId: OWNER_UID },
      });
    });
  });

  describe("feature flag enabled — workspaceId present but missing workspace (never falls back to legacy)", () => {
    it("resolves not_found, and the result carries no legacy context at all", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: true,
        workspaceId: "ws-missing",
        legacyOwnerUserId: OWNER_UID,
        workspaceLookup: { status: "not_found" },
      });
      expect(result).toEqual({ kind: "not_found" });
      expect(result).not.toHaveProperty("context");
    });
  });

  describe("feature flag enabled — workspaceId malformed (never falls back to legacy)", () => {
    it("resolves malformed when the lookup itself reports malformed", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: true,
        workspaceId: "ws-broken",
        legacyOwnerUserId: OWNER_UID,
        workspaceLookup: { status: "malformed" },
      });
      expect(result).toEqual({ kind: "malformed" });
    });

    it("resolves malformed when the caller omits the required lookup result entirely (caller bug, not a legacy fallback)", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: true,
        workspaceId: "ws-1",
        legacyOwnerUserId: OWNER_UID,
        // workspaceLookup intentionally omitted
      });
      expect(result).toEqual({ kind: "malformed" });
    });

    it("resolves malformed when the found workspace's own id does not match the requested workspaceId", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: true,
        workspaceId: "ws-requested",
        legacyOwnerUserId: OWNER_UID,
        workspaceLookup: foundLookup({ workspace: { ...foundLookup().workspace!, id: "ws-different" } } as any),
      });
      expect(result).toEqual({ kind: "malformed" });
    });
  });

  describe("feature flag enabled — internal lookup failure (never falls back to legacy)", () => {
    it("resolves lookup_failed on read_failed", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: true,
        workspaceId: "ws-1",
        legacyOwnerUserId: OWNER_UID,
        workspaceLookup: { status: "read_failed" },
      });
      expect(result).toEqual({ kind: "lookup_failed" });
    });

    it("resolves lookup_failed on firestore_unavailable", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: true,
        workspaceId: "ws-1",
        legacyOwnerUserId: OWNER_UID,
        workspaceLookup: { status: "firestore_unavailable" },
      });
      expect(result).toEqual({ kind: "lookup_failed" });
    });
  });

  describe("future team workspace — well-formed but unsupported in Phase 1", () => {
    it("resolves unsupported_workspace_type for type: \"team\", never resolved and never legacy", () => {
      const result = resolveWorkspaceContext({
        workspacesEnabled: true,
        workspaceId: "team-ws",
        legacyOwnerUserId: OWNER_UID,
        workspaceLookup: foundLookup({ workspace: { ...foundLookup().workspace!, id: "team-ws", type: "team" } } as any),
      });
      expect(result).toEqual({ kind: "unsupported_workspace_type" });
    });
  });
});

describe("resolveWorkspaceContextForResource — async wrapper", () => {
  const workspaceDocs = new Map<string, Record<string, unknown>>();
  const flagValue = { value: false };

  beforeEach(() => {
    workspaceDocs.clear();
    flagValue.value = false;
    jest.resetModules();
  });

  function seedWorkspace(id: string, overrides: Record<string, unknown> = {}) {
    workspaceDocs.set(id, {
      schemaVersion: 1,
      id,
      type: "personal",
      name: "Personal Workspace",
      ownerUserId: OWNER_UID,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      ...overrides,
    });
  }

  async function loadWrapperWithFlag(enabled: boolean) {
    jest.doMock("@/lib/env", () => ({ WORKSPACES_ENABLED: enabled }));
    jest.doMock("@/lib/firestore/workspaces", () => ({
      getWorkspace: jest.fn(async (id: string) => {
        if (!workspaceDocs.has(id)) return { status: "not_found" };
        return { status: "found", workspace: workspaceDocs.get(id) };
      }),
    }));
    const mod = await import("@/lib/workspaces/workspaceResolver");
    return mod.resolveWorkspaceContextForResource;
  }

  it("does not read Firestore at all when workspaceId is absent, even with the flag enabled", async () => {
    const resolveFn = await loadWrapperWithFlag(true);
    const { getWorkspace } = await import("@/lib/firestore/workspaces");
    const result = await resolveFn({ workspaceId: undefined, legacyOwnerUserId: OWNER_UID });
    expect(result).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: OWNER_UID } });
    expect(getWorkspace).not.toHaveBeenCalled();
  });

  it("does not read Firestore at all when the flag is disabled, even with a workspaceId present", async () => {
    const resolveFn = await loadWrapperWithFlag(false);
    const { getWorkspace } = await import("@/lib/firestore/workspaces");
    seedWorkspace("ws-1");
    const result = await resolveFn({ workspaceId: "ws-1", legacyOwnerUserId: OWNER_UID });
    expect(result).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: OWNER_UID } });
    expect(getWorkspace).not.toHaveBeenCalled();
  });

  it("reads Firestore and resolves to a workspace context when the flag is enabled and workspaceId is present", async () => {
    const resolveFn = await loadWrapperWithFlag(true);
    seedWorkspace("ws-1");
    const result = await resolveFn({ workspaceId: "ws-1", legacyOwnerUserId: "irrelevant-legacy-uid" });
    expect(result).toEqual({
      kind: "resolved",
      context: { mode: "workspace", workspaceId: "ws-1", workspaceType: "personal", ownerUserId: OWNER_UID },
    });
  });

  it("resolves not_found (never legacy) for a workspaceId with no matching document", async () => {
    const resolveFn = await loadWrapperWithFlag(true);
    const result = await resolveFn({ workspaceId: "ws-missing", legacyOwnerUserId: OWNER_UID });
    expect(result).toEqual({ kind: "not_found" });
  });
});

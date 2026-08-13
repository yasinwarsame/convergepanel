/**
 * Workspace Compatibility Foundation, Phase 1 — checkWorkspaceAccess()
 * (pure) and authorizeWorkspaceResourceAccess() (async wrapper) tests,
 * including the program's required security threat model: workspace IDOR,
 * forged/cross-workspace access, and legacy-downgrade prevention.
 */

import { checkWorkspaceAccess } from "@/lib/workspaces/workspaceAccess";
import type { WorkspaceContext } from "@/lib/workspaces/types";

const OWNER_UID = "owner-1";
const OTHER_UID = "attacker-1";

describe("checkWorkspaceAccess — pure", () => {
  describe("legacy resource", () => {
    it("grants the owner", () => {
      const context: WorkspaceContext = { mode: "legacy", ownerUserId: OWNER_UID };
      expect(checkWorkspaceAccess(OWNER_UID, context)).toEqual({ granted: true });
    });

    it("denies a non-owner", () => {
      const context: WorkspaceContext = { mode: "legacy", ownerUserId: OWNER_UID };
      expect(checkWorkspaceAccess(OTHER_UID, context)).toEqual({ granted: false, reason: "not_owner" });
    });
  });

  describe("personal workspace resource", () => {
    it("grants the workspace owner", () => {
      const context: WorkspaceContext = { mode: "workspace", workspaceId: "ws-1", workspaceType: "personal", ownerUserId: OWNER_UID };
      expect(checkWorkspaceAccess(OWNER_UID, context)).toEqual({ granted: true });
    });

    it("denies a non-owner", () => {
      const context: WorkspaceContext = { mode: "workspace", workspaceId: "ws-1", workspaceType: "personal", ownerUserId: OWNER_UID };
      expect(checkWorkspaceAccess(OTHER_UID, context)).toEqual({ granted: false, reason: "not_owner" });
    });
  });

  describe("uid comparison is exact equality only — no prefix/substring/case behavior", () => {
    const context: WorkspaceContext = { mode: "workspace", workspaceId: "ws-1", workspaceType: "personal", ownerUserId: "owner-1" };

    it("denies an empty-string uid", () => {
      expect(checkWorkspaceAccess("", context)).toEqual({ granted: false, reason: "not_owner" });
    });

    it("denies a uid that is a case-different match", () => {
      expect(checkWorkspaceAccess("Owner-1", context)).toEqual({ granted: false, reason: "not_owner" });
    });

    it("denies a uid that is a substring of the real owner uid", () => {
      expect(checkWorkspaceAccess("owner", context)).toEqual({ granted: false, reason: "not_owner" });
    });

    it("denies a uid that has the real owner uid as a substring (superstring/prefix-extension)", () => {
      expect(checkWorkspaceAccess("owner-10", context)).toEqual({ granted: false, reason: "not_owner" });
    });

    it("denies a uid with incidental leading/trailing whitespace", () => {
      expect(checkWorkspaceAccess(" owner-1", context)).toEqual({ granted: false, reason: "not_owner" });
      expect(checkWorkspaceAccess("owner-1 ", context)).toEqual({ granted: false, reason: "not_owner" });
    });

    it("grants only the exact match", () => {
      expect(checkWorkspaceAccess("owner-1", context)).toEqual({ granted: true });
    });
  });
});

describe("authorizeWorkspaceResourceAccess — async wrapper, security threat model", () => {
  const workspaceDocs = new Map<string, Record<string, unknown>>();

  beforeEach(() => {
    workspaceDocs.clear();
    jest.resetModules();
  });

  function seedWorkspace(id: string, ownerUserId: string, overrides: Record<string, unknown> = {}) {
    workspaceDocs.set(id, {
      schemaVersion: 1,
      id,
      type: "personal",
      name: "Personal Workspace",
      ownerUserId,
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
    const mod = await import("@/lib/workspaces/workspaceAccess");
    return mod.authorizeWorkspaceResourceAccess;
  }

  it("legacy resource + owner: granted", async () => {
    const authorize = await loadWrapperWithFlag(true);
    const result = await authorize({ uid: OWNER_UID, workspaceId: undefined, legacyOwnerUserId: OWNER_UID });
    expect(result).toEqual({ granted: true, context: { mode: "legacy", ownerUserId: OWNER_UID } });
  });

  it("legacy resource + non-owner: denied", async () => {
    const authorize = await loadWrapperWithFlag(true);
    const result = await authorize({ uid: OTHER_UID, workspaceId: undefined, legacyOwnerUserId: OWNER_UID });
    expect(result).toEqual({ granted: false, reason: "not_owner" });
  });

  it("personal workspace + owner: granted", async () => {
    const authorize = await loadWrapperWithFlag(true);
    seedWorkspace("ws-1", OWNER_UID);
    const result = await authorize({ uid: OWNER_UID, workspaceId: "ws-1", legacyOwnerUserId: "unrelated-legacy-uid" });
    expect(result).toEqual({ granted: true, context: { mode: "workspace", workspaceId: "ws-1", workspaceType: "personal", ownerUserId: OWNER_UID } });
  });

  it("personal workspace + non-owner: denied", async () => {
    const authorize = await loadWrapperWithFlag(true);
    seedWorkspace("ws-1", OWNER_UID);
    const result = await authorize({ uid: OTHER_UID, workspaceId: "ws-1", legacyOwnerUserId: OWNER_UID });
    expect(result).toEqual({ granted: false, reason: "not_owner" });
  });

  describe("Threat: workspace IDOR — user supplies another user's workspace id", () => {
    it("denies access; the request contains a real, existing workspace id, but the caller does not own it", async () => {
      const authorize = await loadWrapperWithFlag(true);
      seedWorkspace("ws-victim", OWNER_UID);
      const result = await authorize({ uid: OTHER_UID, workspaceId: "ws-victim", legacyOwnerUserId: OTHER_UID });
      expect(result).toEqual({ granted: false, reason: "not_owner" });
    });
  });

  describe("Threat: cross-workspace access — owner of workspace A requests a resource bound to workspace B", () => {
    it("denies access even though the requester genuinely owns a DIFFERENT workspace", async () => {
      const authorize = await loadWrapperWithFlag(true);
      seedWorkspace("ws-a", "owner-a");
      seedWorkspace("ws-b", "owner-b");
      // owner-a is a real, valid owner of ws-a, but the resource being requested belongs to ws-b.
      const result = await authorize({ uid: "owner-a", workspaceId: "ws-b", legacyOwnerUserId: "owner-a" });
      expect(result).toEqual({ granted: false, reason: "not_owner" });
    });
  });

  describe("Threat: legacy downgrade — invalid workspace reference must never fall back to legacy owner check", () => {
    it("missing workspace: denies even when uid === legacyOwnerUserId (the legacy field is never consulted once workspaceId was present)", async () => {
      const authorize = await loadWrapperWithFlag(true);
      // No workspace seeded at all — workspaceId references nothing.
      const result = await authorize({ uid: OWNER_UID, workspaceId: "ws-missing", legacyOwnerUserId: OWNER_UID });
      expect(result).toEqual({ granted: false, reason: "workspace_not_found" });
    });

    it("malformed workspace: denies even when uid === legacyOwnerUserId", async () => {
      const authorize = await loadWrapperWithFlag(true);
      workspaceDocs.set("ws-broken", { schemaVersion: 1, id: "ws-broken" }); // missing required fields
      const result = await authorize({ uid: OWNER_UID, workspaceId: "ws-broken", legacyOwnerUserId: OWNER_UID });
      expect(result).toEqual({ granted: false, reason: "workspace_malformed" });
    });

    it("lookup failure: denies even when uid === legacyOwnerUserId", async () => {
      jest.doMock("@/lib/env", () => ({ WORKSPACES_ENABLED: true }));
      jest.doMock("@/lib/firestore/workspaces", () => ({
        getWorkspace: jest.fn(async () => ({ status: "read_failed" })),
      }));
      const { authorizeWorkspaceResourceAccess } = await import("@/lib/workspaces/workspaceAccess");
      const result = await authorizeWorkspaceResourceAccess({ uid: OWNER_UID, workspaceId: "ws-1", legacyOwnerUserId: OWNER_UID });
      expect(result).toEqual({ granted: false, reason: "lookup_failed" });
    });

    it("unsupported workspace type (future team workspace): denies even when uid === legacyOwnerUserId", async () => {
      const authorize = await loadWrapperWithFlag(true);
      seedWorkspace("team-ws", OWNER_UID, { type: "team" });
      const result = await authorize({ uid: OWNER_UID, workspaceId: "team-ws", legacyOwnerUserId: OWNER_UID });
      expect(result).toEqual({ granted: false, reason: "unsupported_workspace_type" });
    });
  });

  describe("Threat: flag-safety downgrade — WORKSPACES_ENABLED=false must never re-grant access via legacy ownership for an already workspace-bound resource", () => {
    it("denies with workspaces_disabled even when uid === legacyOwnerUserId AND uid is the real workspace owner", async () => {
      const authorize = await loadWrapperWithFlag(false);
      seedWorkspace("ws-1", OWNER_UID);
      const result = await authorize({ uid: OWNER_UID, workspaceId: "ws-1", legacyOwnerUserId: OWNER_UID });
      expect(result).toEqual({ granted: false, reason: "workspaces_disabled" });
      // The critical assertion: this must NEVER equal a granted legacy outcome.
      expect(result.granted).toBe(false);
    });

    it("denies with workspaces_disabled for a present-but-invalid workspaceId too (empty string), not legacy", async () => {
      const authorize = await loadWrapperWithFlag(false);
      const result = await authorize({ uid: OWNER_UID, workspaceId: "", legacyOwnerUserId: OWNER_UID });
      expect(result).toEqual({ granted: false, reason: "workspaces_disabled" });
    });
  });

  describe("Threat: forged/client-claimed ownership never suffices on its own", () => {
    it("access is granted or denied purely from server-resolved uid equality — supplying a workspaceId in the request never grants access by itself", async () => {
      const authorize = await loadWrapperWithFlag(true);
      seedWorkspace("ws-1", OWNER_UID);
      // The "attacker" supplies a real workspaceId but is not its owner, and
      // has no legitimate legacyOwnerUserId claim to it either.
      const result = await authorize({ uid: OTHER_UID, workspaceId: "ws-1", legacyOwnerUserId: OTHER_UID });
      expect(result.granted).toBe(false);
    });
  });

  describe("No implicit migration or workspace creation", () => {
    it("authorizeWorkspaceResourceAccess never calls a write function (module exports contain no create/set/update)", () => {
      const mod = require("@/lib/workspaces/workspaceAccess");
      expect(Object.keys(mod).sort()).toEqual(["authorizeWorkspaceResourceAccess", "checkWorkspaceAccess"]);
    });
  });
});

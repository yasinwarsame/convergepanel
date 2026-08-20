import { Timestamp } from "firebase-admin/firestore";
import { isWellFormedWorkspaceMembershipV1 } from "@/lib/workspaces/membershipTypes";

const NOW = Timestamp.now();

const VALID_ACTIVE: unknown = {
  schemaVersion: 1,
  id: "wm_" + "a".repeat(64),
  workspaceId: "ws-1",
  uid: "uid-1",
  role: "owner",
  status: "active",
  createdAt: NOW,
  updatedAt: NOW,
  invitedByUserId: null,
  removedAt: null,
  removedByUserId: null,
};

const VALID_REMOVED: unknown = {
  ...(VALID_ACTIVE as Record<string, unknown>),
  role: "member",
  status: "removed",
  invitedByUserId: "inviter-1",
  removedAt: NOW,
  removedByUserId: "remover-1",
};

describe("isWellFormedWorkspaceMembershipV1", () => {
  it("accepts a valid active founder membership (invitedByUserId: null)", () => {
    expect(isWellFormedWorkspaceMembershipV1(VALID_ACTIVE)).toBe(true);
  });

  it("accepts a valid removed membership with a real inviter", () => {
    expect(isWellFormedWorkspaceMembershipV1(VALID_REMOVED)).toBe(true);
  });

  it.each(["owner", "admin", "member", "reviewer", "viewer"])("accepts every frozen V1 role: %s", (role) => {
    expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), role })).toBe(true);
  });

  it("rejects an unrecognized role", () => {
    expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), role: "superadmin" })).toBe(false);
  });

  it("rejects an unrecognized status", () => {
    expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), status: "pending" })).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["missing schemaVersion", { ...(VALID_ACTIVE as Record<string, unknown>), schemaVersion: undefined }],
    ["wrong schemaVersion", { ...(VALID_ACTIVE as Record<string, unknown>), schemaVersion: 2 }],
    ["empty id", { ...(VALID_ACTIVE as Record<string, unknown>), id: "" }],
    ["empty workspaceId", { ...(VALID_ACTIVE as Record<string, unknown>), workspaceId: "" }],
    ["empty uid", { ...(VALID_ACTIVE as Record<string, unknown>), uid: "" }],
    ["non-Timestamp createdAt", { ...(VALID_ACTIVE as Record<string, unknown>), createdAt: "2026-01-01" }],
    ["non-Timestamp updatedAt", { ...(VALID_ACTIVE as Record<string, unknown>), updatedAt: 12345 }],
  ])("rejects: %s", (_label, input) => {
    expect(isWellFormedWorkspaceMembershipV1(input)).toBe(false);
  });

  describe("invitedByUserId", () => {
    it("rejects an empty-string invitedByUserId", () => {
      expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), invitedByUserId: "" })).toBe(false);
    });
    it("rejects a non-string, non-null invitedByUserId", () => {
      expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), invitedByUserId: 42 })).toBe(false);
    });
    it("rejects undefined invitedByUserId (must be explicit null, never a missing key)", () => {
      const { invitedByUserId, ...rest } = VALID_ACTIVE as Record<string, unknown>;
      expect(isWellFormedWorkspaceMembershipV1(rest)).toBe(false);
    });
  });

  describe("removal-field/status coherence", () => {
    it("rejects status:active with a non-null removedAt", () => {
      expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), removedAt: NOW })).toBe(false);
    });
    it("rejects status:active with a non-null removedByUserId", () => {
      expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), removedByUserId: "someone" })).toBe(false);
    });
    it("rejects status:removed with a null removedAt", () => {
      expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_REMOVED as Record<string, unknown>), removedAt: null })).toBe(false);
    });
    it("rejects status:removed with a null removedByUserId", () => {
      expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_REMOVED as Record<string, unknown>), removedByUserId: null })).toBe(false);
    });
    it("rejects removedAt/removedByUserId disagreeing (one null, one not)", () => {
      expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), removedAt: NOW, removedByUserId: null })).toBe(false);
      expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), removedAt: null, removedByUserId: "x" })).toBe(false);
    });
    it("rejects a non-Timestamp removedAt when status is removed", () => {
      expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_REMOVED as Record<string, unknown>), removedAt: "2026-01-01" })).toBe(false);
    });
  });

  it("accepts unknown/extra fields (open, forward-compatible schema)", () => {
    expect(isWellFormedWorkspaceMembershipV1({ ...(VALID_ACTIVE as Record<string, unknown>), futureField: 42 })).toBe(true);
  });
});

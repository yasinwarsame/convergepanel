/**
 * Workspace Compatibility Foundation (Phase 1) + Team Workspace Core
 * Foundation (Phase 8B) — isWellFormedWorkspaceV1() structural guard
 * tests. Phase 8B converted `WorkspaceV1` from a flat shape into a
 * `type`-discriminated union; every pre-existing Personal-shape test below
 * is preserved unchanged (Personal validity never required
 * `createdByUserId`) and new tests cover the Team variant's additional
 * requirement.
 */

import { isWellFormedWorkspaceV1 } from "@/lib/workspaces/types";

const VALID: unknown = {
  schemaVersion: 1,
  id: "ws-1",
  type: "personal",
  name: "Personal Workspace",
  ownerUserId: "owner-1",
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

const VALID_TEAM: unknown = {
  ...(VALID as Record<string, unknown>),
  type: "team",
  createdByUserId: "founder-1",
};

describe("isWellFormedWorkspaceV1", () => {
  it("accepts a well-formed personal workspace", () => {
    expect(isWellFormedWorkspaceV1(VALID)).toBe(true);
  });

  it("accepts a legacy-shaped personal workspace with no createdByUserId field at all — pre-Phase-8B production documents remain valid without migration", () => {
    expect(isWellFormedWorkspaceV1(VALID)).toBe(true);
    expect((VALID as Record<string, unknown>).createdByUserId).toBeUndefined();
  });

  it("accepts a well-formed team workspace with createdByUserId", () => {
    expect(isWellFormedWorkspaceV1(VALID_TEAM)).toBe(true);
  });

  it("rejects a team workspace missing createdByUserId entirely", () => {
    const { createdByUserId, ...rest } = VALID_TEAM as Record<string, unknown>;
    expect(isWellFormedWorkspaceV1(rest)).toBe(false);
  });

  it("rejects a team workspace with an empty createdByUserId", () => {
    expect(isWellFormedWorkspaceV1({ ...(VALID_TEAM as Record<string, unknown>), createdByUserId: "" })).toBe(false);
  });

  it("rejects a team workspace with a non-string createdByUserId", () => {
    expect(isWellFormedWorkspaceV1({ ...(VALID_TEAM as Record<string, unknown>), createdByUserId: 42 })).toBe(false);
    expect(isWellFormedWorkspaceV1({ ...(VALID_TEAM as Record<string, unknown>), createdByUserId: null })).toBe(false);
  });

  it("continues rejecting unsupported workspace types", () => {
    expect(isWellFormedWorkspaceV1({ ...(VALID as Record<string, unknown>), type: "enterprise" })).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "not-an-object"],
    ["an array", []],
    ["wrong schemaVersion", { ...VALID, schemaVersion: 2 }],
    ["missing schemaVersion", (() => { const { schemaVersion, ...rest } = VALID as any; return rest; })()],
    ["empty id", { ...VALID, id: "" }],
    ["non-string id", { ...VALID, id: 123 }],
    ["missing id key entirely", (() => { const { id, ...rest } = VALID as any; return rest; })()],
    ["invalid type value", { ...VALID, type: "enterprise" }],
    ["missing type key entirely", (() => { const { type, ...rest } = VALID as any; return rest; })()],
    ["non-string name", { ...VALID, name: 42 }],
    ["missing name key entirely", (() => { const { name, ...rest } = VALID as any; return rest; })()],
    ["empty ownerUserId", { ...VALID, ownerUserId: "" }],
    ["non-string ownerUserId", { ...VALID, ownerUserId: null }],
    ["missing ownerUserId key entirely", (() => { const { ownerUserId, ...rest } = VALID as any; return rest; })()],
    ["a completely empty object", {}],
    ["only unrelated keys", { foo: "bar" }],
  ])("rejects: %s", (_label, input) => {
    expect(isWellFormedWorkspaceV1(input)).toBe(false);
  });

  describe("deliberate compatibility policy", () => {
    it("accepts a document with unexpected/unknown additive future fields (open, forward-compatible schema)", () => {
      expect(isWellFormedWorkspaceV1({ ...VALID, settings: { theme: "dark" }, futureField: 42 })).toBe(true);
    });

    it("accepts malformed/nonsensical timestamps — createdAt/updatedAt are never authorization-relevant", () => {
      expect(isWellFormedWorkspaceV1({ ...VALID, createdAt: "not-a-real-date", updatedAt: 12345 })).toBe(true);
      expect(isWellFormedWorkspaceV1({ ...VALID, createdAt: null, updatedAt: undefined })).toBe(true);
    });

    it("accepts a partial document missing only non-security-relevant fields (timestamps)", () => {
      const { createdAt, updatedAt, ...partial } = VALID as any;
      expect(isWellFormedWorkspaceV1(partial)).toBe(true);
    });
  });
});

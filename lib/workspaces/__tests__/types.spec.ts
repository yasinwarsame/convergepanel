/**
 * Workspace Compatibility Foundation, Phase 1 — isWellFormedWorkspaceV1()
 * structural guard tests.
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

describe("isWellFormedWorkspaceV1", () => {
  it("accepts a well-formed personal workspace", () => {
    expect(isWellFormedWorkspaceV1(VALID)).toBe(true);
  });

  it("accepts a well-formed team workspace (shape validity, not authorization support)", () => {
    expect(isWellFormedWorkspaceV1({ ...VALID, type: "team" })).toBe(true);
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

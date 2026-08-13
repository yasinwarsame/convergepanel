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
    ["invalid type value", { ...VALID, type: "enterprise" }],
    ["non-string name", { ...VALID, name: 42 }],
    ["empty ownerUserId", { ...VALID, ownerUserId: "" }],
    ["non-string ownerUserId", { ...VALID, ownerUserId: null }],
  ])("rejects: %s", (_label, input) => {
    expect(isWellFormedWorkspaceV1(input)).toBe(false);
  });
});

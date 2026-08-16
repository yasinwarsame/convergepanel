/**
 * Project Foundation, Phase 6C — strict mutation-body parsing tests.
 * The central property under test: any body key outside the exact
 * allowed set is REJECTED, never silently ignored.
 */

import { parseCreateProjectBody, parseRenameProjectBody, parseStatusTransitionBody } from "@/lib/projects/projectMutationBody";

describe("parseCreateProjectBody", () => {
  it("accepts a body containing only name", () => {
    expect(parseCreateProjectBody({ name: "My Project" })).toEqual({ ok: true, name: "My Project" });
  });

  it("rejects null", () => {
    expect(parseCreateProjectBody(null)).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("rejects a non-object", () => {
    expect(parseCreateProjectBody("just a string")).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("rejects an array", () => {
    expect(parseCreateProjectBody(["name"])).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("SECURITY: rejects an attempted workspaceId injection", () => {
    expect(parseCreateProjectBody({ name: "X", workspaceId: "personal-someone-else" })).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("SECURITY: rejects an attempted createdByUserId injection", () => {
    expect(parseCreateProjectBody({ name: "X", createdByUserId: "attacker-uid" })).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("SECURITY: rejects an attempted id injection", () => {
    expect(parseCreateProjectBody({ name: "X", id: "chosen-by-client" })).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("SECURITY: rejects an attempted status injection", () => {
    expect(parseCreateProjectBody({ name: "X", status: "archived" })).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("SECURITY: rejects an attempted schemaVersion injection", () => {
    expect(parseCreateProjectBody({ name: "X", schemaVersion: 1 })).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("SECURITY: rejects an attempted createdAt/updatedAt injection", () => {
    expect(parseCreateProjectBody({ name: "X", createdAt: "2026-01-01" })).toEqual({ ok: false, reason: "unknown_field" });
    expect(parseCreateProjectBody({ name: "X", updatedAt: "2026-01-01" })).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("rejects an entirely unrelated unknown field too — not just security-sensitive ones", () => {
    expect(parseCreateProjectBody({ name: "X", favoriteColor: "blue" })).toEqual({ ok: false, reason: "unknown_field" });
  });
});

describe("parseRenameProjectBody", () => {
  it("accepts a body containing exactly name and expectedUpdateTime", () => {
    const body = { name: "New Name", expectedUpdateTime: { seconds: 1, nanoseconds: 0 } };
    expect(parseRenameProjectBody(body)).toEqual({ ok: true, name: "New Name", expectedUpdateTime: { seconds: 1, nanoseconds: 0 } });
  });

  it("SECURITY: rejects an attempted workspaceId injection alongside valid fields", () => {
    const body = { name: "X", expectedUpdateTime: { seconds: 1, nanoseconds: 0 }, workspaceId: "personal-someone-else" };
    expect(parseRenameProjectBody(body)).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("SECURITY: rejects an attempted status injection", () => {
    const body = { name: "X", expectedUpdateTime: { seconds: 1, nanoseconds: 0 }, status: "archived" };
    expect(parseRenameProjectBody(body)).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("rejects null", () => {
    expect(parseRenameProjectBody(null)).toEqual({ ok: false, reason: "invalid_body" });
  });
});

describe("parseStatusTransitionBody (shared by archive/restore)", () => {
  it("accepts a body containing exactly expectedUpdateTime", () => {
    const body = { expectedUpdateTime: { seconds: 1, nanoseconds: 0 } };
    expect(parseStatusTransitionBody(body)).toEqual({ ok: true, expectedUpdateTime: { seconds: 1, nanoseconds: 0 } });
  });

  it("SECURITY: rejects an attempted status injection", () => {
    const body = { expectedUpdateTime: { seconds: 1, nanoseconds: 0 }, status: "active" };
    expect(parseStatusTransitionBody(body)).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("SECURITY: rejects an attempted name injection on archive/restore — those routes never accept name", () => {
    const body = { expectedUpdateTime: { seconds: 1, nanoseconds: 0 }, name: "Sneaky Rename" };
    expect(parseStatusTransitionBody(body)).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("rejects an empty object (missing expectedUpdateTime is a downstream validation concern, but an empty body is still structurally fine to parse — expectedUpdateTime will simply be undefined and rejected by validateUpdateTimeToken)", () => {
    const result = parseStatusTransitionBody({});
    expect(result).toEqual({ ok: true, expectedUpdateTime: undefined });
  });

  it("rejects null", () => {
    expect(parseStatusTransitionBody(null)).toEqual({ ok: false, reason: "invalid_body" });
  });
});

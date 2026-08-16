/**
 * Projects Foundation, Phase 6B — isWellFormedProjectV1() tests.
 * Structural mirror of lib/workspaces/__tests__/types.spec.ts's own
 * Workspace validator tests.
 */

import { Timestamp } from "firebase-admin/firestore";
import { isWellFormedProjectV1 } from "@/lib/projects/types";

const NOW = Timestamp.now();

function validProject(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "proj-1",
    workspaceId: "personal-owner-1",
    name: "My Project",
    status: "active",
    createdByUserId: "owner-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("isWellFormedProjectV1", () => {
  it("accepts a fully valid document", () => {
    expect(isWellFormedProjectV1(validProject())).toBe(true);
  });

  it("rejects null", () => {
    expect(isWellFormedProjectV1(null)).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(isWellFormedProjectV1("not an object")).toBe(false);
  });

  it("rejects schemaVersion !== 1", () => {
    expect(isWellFormedProjectV1(validProject({ schemaVersion: 2 }))).toBe(false);
  });

  it("rejects missing schemaVersion", () => {
    const { schemaVersion, ...rest } = validProject();
    expect(isWellFormedProjectV1(rest)).toBe(false);
  });

  it("rejects non-string id", () => {
    expect(isWellFormedProjectV1(validProject({ id: 123 }))).toBe(false);
  });

  it("rejects empty id", () => {
    expect(isWellFormedProjectV1(validProject({ id: "" }))).toBe(false);
  });

  it("rejects non-string workspaceId", () => {
    expect(isWellFormedProjectV1(validProject({ workspaceId: 123 }))).toBe(false);
  });

  it("rejects empty workspaceId", () => {
    expect(isWellFormedProjectV1(validProject({ workspaceId: "" }))).toBe(false);
  });

  it("rejects non-string name", () => {
    expect(isWellFormedProjectV1(validProject({ name: 42 }))).toBe(false);
  });

  it("rejects empty name", () => {
    expect(isWellFormedProjectV1(validProject({ name: "" }))).toBe(false);
  });

  it("accepts status 'active'", () => {
    expect(isWellFormedProjectV1(validProject({ status: "active" }))).toBe(true);
  });

  it("accepts status 'archived'", () => {
    expect(isWellFormedProjectV1(validProject({ status: "archived" }))).toBe(true);
  });

  it("rejects an unrecognized status value", () => {
    expect(isWellFormedProjectV1(validProject({ status: "deleted" }))).toBe(false);
  });

  it("rejects non-string createdByUserId", () => {
    expect(isWellFormedProjectV1(validProject({ createdByUserId: 1 }))).toBe(false);
  });

  it("rejects empty createdByUserId", () => {
    expect(isWellFormedProjectV1(validProject({ createdByUserId: "" }))).toBe(false);
  });

  it("rejects a createdAt that is not a real Firestore Timestamp (e.g. an ISO string)", () => {
    expect(isWellFormedProjectV1(validProject({ createdAt: "2026-08-16T00:00:00.000Z" }))).toBe(false);
  });

  it("rejects a createdAt that looks like a Timestamp but isn't an instance (plain object)", () => {
    expect(isWellFormedProjectV1(validProject({ createdAt: { seconds: 1, nanoseconds: 0 } }))).toBe(false);
  });

  it("rejects a non-Timestamp updatedAt", () => {
    expect(isWellFormedProjectV1(validProject({ updatedAt: 12345 }))).toBe(false);
  });

  it("accepts unknown/extra fields (open, forward-compatible schema)", () => {
    expect(isWellFormedProjectV1(validProject({ futureField: "anything" }))).toBe(true);
  });

  it("does NOT validate embedded id against a Firestore document id — that is getProject()'s concern, not this pure guard's", () => {
    // isWellFormedProjectV1 has no document-id parameter at all; this test
    // documents that omission is deliberate, not an oversight.
    expect(isWellFormedProjectV1.length).toBe(1);
  });
});

/**
 * Projects Foundation, Phase 6B — getProject() tests. Mirrors the mocking
 * convention established in lib/firestore/__tests__/workspaces.spec.ts.
 */

import { Timestamp } from "firebase-admin/firestore";

const projectDocs = new Map<string, Record<string, unknown>>();
const firestoreUnavailableFlag = { value: false };
const throwOnRead = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (throwOnRead.value) throw new Error("simulated Firestore outage");
        const key = `${name}/${id}`;
        return { exists: projectDocs.has(key), data: () => projectDocs.get(key) };
      }),
    }),
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getProject } from "@/lib/firestore/projects";

const NOW = Timestamp.now();

function seedProject(id: string, overrides: Record<string, unknown> = {}) {
  projectDocs.set(`projects/${id}`, {
    schemaVersion: 1,
    id,
    workspaceId: "personal-owner-1",
    name: "My Project",
    status: "active",
    createdByUserId: "owner-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe("getProject", () => {
  beforeEach(() => {
    projectDocs.clear();
    firestoreUnavailableFlag.value = false;
    throwOnRead.value = false;
  });

  it("returns found with the well-formed project when the document exists", async () => {
    seedProject("proj-1");
    const result = await getProject("proj-1");
    expect(result).toEqual({
      status: "found",
      project: {
        schemaVersion: 1,
        id: "proj-1",
        workspaceId: "personal-owner-1",
        name: "My Project",
        status: "active",
        createdByUserId: "owner-1",
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
  });

  it("returns not_found when no document exists at that id", async () => {
    const result = await getProject("does-not-exist");
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns malformed when the document exists but is missing required fields", async () => {
    projectDocs.set("projects/broken", { schemaVersion: 1, id: "broken" });
    const result = await getProject("broken");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when schemaVersion is not the literal 1", async () => {
    seedProject("bad-version", { schemaVersion: 2 });
    const result = await getProject("bad-version");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when status is not exactly active|archived", async () => {
    seedProject("bad-status", { status: "deleted" });
    const result = await getProject("bad-status");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when createdAt is not a real Timestamp", async () => {
    seedProject("bad-createdat", { createdAt: "2026-08-16T00:00:00.000Z" });
    const result = await getProject("bad-createdat");
    expect(result).toEqual({ status: "malformed" });
  });

  it("SECURITY: returns malformed when the document's own id field does not match the Firestore document id it was fetched at (never accepted as found)", async () => {
    // Simulates a corrupted/tampered document: fetched at projects/proj-real,
    // but its own body claims to be a different project entirely.
    seedProject("proj-real", { id: "proj-impostor" });
    const result = await getProject("proj-real");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when the id key is entirely absent from the document", async () => {
    projectDocs.set("projects/no-id-key", {
      schemaVersion: 1,
      workspaceId: "personal-owner-1",
      name: "My Project",
      status: "active",
      createdByUserId: "owner-1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const result = await getProject("no-id-key");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await getProject("proj-1");
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("returns read_failed when the Firestore read throws", async () => {
    throwOnRead.value = true;
    const result = await getProject("proj-1");
    expect(result).toEqual({ status: "read_failed" });
  });
});

describe("Project Firestore read surface stays minimal", () => {
  it("this module contains no create/update/delete function — Phase 6C's concern, not Phase 6B's", () => {
    const source = require("fs").readFileSync(require.resolve("@/lib/firestore/projects"), "utf8");
    expect(source).not.toMatch(/\.create\(/);
    expect(source).not.toMatch(/\.set\(/);
    expect(source).not.toMatch(/\.update\(/);
    expect(source).not.toMatch(/\.add\(/);
  });
});

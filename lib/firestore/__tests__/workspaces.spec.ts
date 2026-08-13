/**
 * Workspace Compatibility Foundation, Phase 1 — getWorkspace() tests.
 * Mirrors the mocking convention established in
 * adaptiveHumanReviewAssignment.spec.ts (adjacent in this directory).
 */

const workspaceDocs = new Map<string, Record<string, unknown>>();
const firestoreUnavailableFlag = { value: false };
const throwOnRead = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (throwOnRead.value) throw new Error("simulated Firestore outage");
        const key = `${name}/${id}`;
        return { exists: workspaceDocs.has(key), data: () => workspaceDocs.get(key) };
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

import { getWorkspace } from "@/lib/firestore/workspaces";

function seedWorkspace(id: string, overrides: Record<string, unknown> = {}) {
  workspaceDocs.set(`workspaces/${id}`, {
    schemaVersion: 1,
    id,
    type: "personal",
    name: "Personal Workspace",
    ownerUserId: "owner-1",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  });
}

describe("getWorkspace", () => {
  beforeEach(() => {
    workspaceDocs.clear();
    firestoreUnavailableFlag.value = false;
    throwOnRead.value = false;
  });

  it("returns found with the well-formed workspace when the document exists", async () => {
    seedWorkspace("ws-1");
    const result = await getWorkspace("ws-1");
    expect(result).toEqual({
      status: "found",
      workspace: {
        schemaVersion: 1,
        id: "ws-1",
        type: "personal",
        name: "Personal Workspace",
        ownerUserId: "owner-1",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    });
  });

  it("returns not_found when no document exists at that id", async () => {
    const result = await getWorkspace("does-not-exist");
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns malformed (never found) when the document exists but is missing required fields", async () => {
    workspaceDocs.set("workspaces/broken", { schemaVersion: 1, id: "broken" }); // missing type/name/ownerUserId
    const result = await getWorkspace("broken");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when schemaVersion is not the literal 1", async () => {
    seedWorkspace("bad-version", { schemaVersion: 2 });
    const result = await getWorkspace("bad-version");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when ownerUserId is an empty string", async () => {
    seedWorkspace("no-owner", { ownerUserId: "" });
    const result = await getWorkspace("no-owner");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when the document's own id field does not match the Firestore document id it was fetched at (never accepted as found)", async () => {
    // Simulates a corrupted/tampered document: fetched at workspaces/ws-real,
    // but its own body claims to be a different workspace entirely.
    seedWorkspace("ws-real", { id: "ws-impostor" });
    const result = await getWorkspace("ws-real");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when the id key is entirely absent from the document (not just non-string)", async () => {
    workspaceDocs.set("workspaces/no-id-key", {
      schemaVersion: 1,
      type: "personal",
      name: "Personal Workspace",
      ownerUserId: "owner-1",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    });
    const result = await getWorkspace("no-id-key");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await getWorkspace("ws-1");
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("returns read_failed (never throws) when the read itself throws", async () => {
    throwOnRead.value = true;
    const result = await getWorkspace("ws-1");
    expect(result).toEqual({ status: "read_failed" });
  });

  it("accepts type: \"team\" as well-formed data (Phase 1 defers authorization, not shape validity)", async () => {
    seedWorkspace("team-ws", { type: "team" });
    const result = await getWorkspace("team-ws");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.workspace.type).toBe("team");
    }
  });
});

describe("Phase 1 has no workspace write path", () => {
  it("exports no create/update/delete function from lib/firestore/workspaces.ts", () => {
    const mod = require("@/lib/firestore/workspaces");
    const exportNames = Object.keys(mod);
    expect(exportNames).toEqual(["getWorkspace"]);
  });
});

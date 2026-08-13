/**
 * Workspace Compatibility Foundation, Phase 1 — getWorkspace() tests.
 * Mirrors the mocking convention established in
 * adaptiveHumanReviewAssignment.spec.ts (adjacent in this directory).
 */

import { Status } from "google-gax";

/**
 * Verified against the ACTUAL installed dependency, not assumed: this
 * repo's `firebase-admin@12.7.0` uses `@google-cloud/firestore@7.11.6`,
 * whose `write-batch.js` throws server errors via `wrapError(err, stack)`
 * (`util.js`) — which appends stack-trace context but returns the SAME
 * error object, leaving `.code` exactly as set by the underlying
 * `google-gax` `GoogleError` (`code?: Status`, a real numeric gRPC status
 * enum — `Status.ALREADY_EXISTS === 6`, imported directly here, not
 * hand-typed). This confirms `.code === 6` is the real, stable shape a
 * genuine `DocumentReference.create()` conflict throws — never a
 * mock-specific invention. `createPersonalWorkspace()`'s primary
 * detection (`code === 6`) is checked against this real numeric constant
 * below; the `code === "ALREADY_EXISTS"` / message-substring checks in
 * the implementation are pure secondary defense-in-depth, matching this
 * codebase's own established convention (`createAdaptiveHumanReviewHistory`
 * in `lib/firestore/runs.ts` uses the identical fallback chain).
 */
function alreadyExistsError() {
  const err: any = new Error(`${Status.ALREADY_EXISTS} ALREADY_EXISTS: Document already exists: projects/test/databases/(default)/documents/workspaces/x`);
  err.code = Status.ALREADY_EXISTS;
  return err;
}

const workspaceDocs = new Map<string, Record<string, unknown>>();
const firestoreUnavailableFlag = { value: false };
const throwOnRead = { value: false };
const throwOnCreate = { value: false as false | "generic" | "other_grpc_code" };

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (throwOnRead.value) throw new Error("simulated Firestore outage");
        const key = `${name}/${id}`;
        return { exists: workspaceDocs.has(key), data: () => workspaceDocs.get(key) };
      }),
      create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
        if (throwOnCreate.value === "generic") throw new Error("simulated write outage");
        if (throwOnCreate.value === "other_grpc_code") {
          // A DIFFERENT real gRPC status — proves detection doesn't
          // false-positive on just "any error with a numeric .code".
          const err: any = new Error(`${Status.PERMISSION_DENIED} PERMISSION_DENIED: Missing or insufficient permissions.`);
          err.code = Status.PERMISSION_DENIED;
          throw err;
        }
        const key = `${name}/${id}`;
        if (workspaceDocs.has(key)) throw alreadyExistsError();
        workspaceDocs.set(key, value);
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

import { getWorkspace, createPersonalWorkspace } from "@/lib/firestore/workspaces";
import { isWellFormedWorkspaceV1 } from "@/lib/workspaces/types";

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
    throwOnCreate.value = false;
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

describe("createPersonalWorkspace", () => {
  beforeEach(() => {
    workspaceDocs.clear();
    firestoreUnavailableFlag.value = false;
    throwOnRead.value = false;
    throwOnCreate.value = false;
  });

  it("creates a fresh Personal Workspace with server-derived values only", async () => {
    const result = await createPersonalWorkspace("owner-1");
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.workspace).toMatchObject({
        schemaVersion: 1,
        id: "personal-owner-1",
        type: "personal",
        name: "Personal Workspace",
        ownerUserId: "owner-1",
      });
      expect(result.workspace.createdAt).toBeDefined();
      expect(result.workspace.updatedAt).toBeDefined();
    }
    expect(workspaceDocs.has("workspaces/personal-owner-1")).toBe(true);
  });

  it("the created document passes isWellFormedWorkspaceV1() with no special bypass — creation and reading share the exact same schema", async () => {
    const result = await createPersonalWorkspace("owner-1");
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(isWellFormedWorkspaceV1(result.workspace)).toBe(true);
    }
    // And round-tripping through getWorkspace() (the real read path)
    // confirms the same: no divergence between what create writes and
    // what read is willing to accept as "found".
    const readBack = await getWorkspace("personal-owner-1");
    expect(readBack.status).toBe("found");
  });

  it("returns already_exists (never overwrites) when the deterministic id is already taken", async () => {
    await createPersonalWorkspace("owner-1");
    const before = workspaceDocs.get("workspaces/personal-owner-1");
    const result = await createPersonalWorkspace("owner-1");
    expect(result).toEqual({ status: "already_exists" });
    expect(workspaceDocs.get("workspaces/personal-owner-1")).toEqual(before); // untouched
  });

  it("returns invalid_uid without touching Firestore for a structurally invalid uid", async () => {
    const result = await createPersonalWorkspace("");
    expect(result).toEqual({ status: "invalid_uid" });
    expect(workspaceDocs.size).toBe(0);
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await createPersonalWorkspace("owner-1");
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("returns create_failed (never throws) for a non-ALREADY_EXISTS write failure", async () => {
    throwOnCreate.value = "generic";
    const result = await createPersonalWorkspace("owner-1");
    expect(result).toEqual({ status: "create_failed" });
  });

  it("returns create_failed — never mistaken for a duplicate — for a DIFFERENT real gRPC status code (PERMISSION_DENIED, code 7)", async () => {
    throwOnCreate.value = "other_grpc_code";
    const result = await createPersonalWorkspace("owner-1");
    expect(result).toEqual({ status: "create_failed" });
    expect(workspaceDocs.size).toBe(0);
  });

  it("two different uids create two independent documents with no crossover", async () => {
    const a = await createPersonalWorkspace("owner-a");
    const b = await createPersonalWorkspace("owner-b");
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    if (a.status === "created" && b.status === "created") {
      expect(a.workspace.id).toBe("personal-owner-a");
      expect(b.workspace.id).toBe("personal-owner-b");
      expect(a.workspace.ownerUserId).toBe("owner-a");
      expect(b.workspace.ownerUserId).toBe("owner-b");
    }
  });
});

describe("Workspace Firestore write surface stays minimal", () => {
  it("exports exactly getWorkspace + createPersonalWorkspace — no update/delete function anywhere", () => {
    const mod = require("@/lib/firestore/workspaces");
    const exportNames = Object.keys(mod).sort();
    expect(exportNames).toEqual(["createPersonalWorkspace", "getWorkspace"]);
  });
});

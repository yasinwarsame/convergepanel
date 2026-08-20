/**
 * Phase 8B.1 — `checkTeamWorkspaceOwnershipForUid()` tests. Renamed from
 * `getTeamWorkspaceOwnershipForUid()` and now returns a three-way
 * discriminated result (`"clear" | "owns_team_workspace" | "lookup_failed"`)
 * instead of a boolean — "lookup failed" and "owns nothing" must never
 * collapse into the same outcome (see the module's own doc comment).
 */

const firestoreUnavailableFlag = { value: false };
const queryShouldThrow = { value: false };
let queryDocs: Array<{ id: string; data: Record<string, unknown> }> = [];

const mockAdminDb: any = {
  collection: (name: string) => ({
    where: (field: string, op: string, value: unknown) => ({
      get: async () => {
        if (queryShouldThrow.value) throw new Error("simulated query failure");
        expect(name).toBe("workspaces");
        expect(field).toBe("ownerUserId");
        expect(op).toBe("==");
        return { docs: queryDocs.filter((d) => (d.data as any).ownerUserId === value).map((d) => ({ id: d.id, data: () => d.data })) };
      },
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

import { Timestamp } from "firebase-admin/firestore";
import { checkTeamWorkspaceOwnershipForUid } from "@/lib/workspaces/teamOwnerGuard";
import { logger } from "@/lib/logger";

const UID = "uid-1";
const NOW = Timestamp.now();

function teamDoc(id: string, overrides: Record<string, unknown> = {}) {
  return { id, data: { schemaVersion: 1, id, type: "team", name: "Team", ownerUserId: UID, createdByUserId: UID, createdAt: NOW, updatedAt: NOW, ...overrides } };
}

function personalDoc(id: string) {
  return { id, data: { schemaVersion: 1, id, type: "personal", name: "Personal", ownerUserId: UID, createdAt: NOW, updatedAt: NOW } };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryDocs = [];
  firestoreUnavailableFlag.value = false;
  queryShouldThrow.value = false;
});

describe("checkTeamWorkspaceOwnershipForUid", () => {
  it("reports clear when the uid owns nothing", async () => {
    const result = await checkTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ kind: "clear" });
  });

  it("reports owns_team_workspace when the uid owns a Team Workspace", async () => {
    queryDocs = [teamDoc("ws-team-1")];
    const result = await checkTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ kind: "owns_team_workspace", workspaceIds: ["ws-team-1"] });
  });

  it("reports clear from owning only a Personal Workspace", async () => {
    queryDocs = [personalDoc("personal-uid-1")];
    const result = await checkTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ kind: "clear" });
  });

  it("filters out a malformed document rather than trusting it", async () => {
    queryDocs = [{ id: "ws-bad", data: { ownerUserId: UID, type: "team" } }]; // missing required fields
    const result = await checkTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ kind: "clear" });
  });

  it("filters out a document whose embedded id disagrees with its Firestore doc id", async () => {
    const doc = teamDoc("ws-real-id");
    (doc.data as any).id = "ws-mismatched-id";
    queryDocs = [doc];
    const result = await checkTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ kind: "clear" });
  });

  it("reports both Team Workspaces when the uid owns more than one", async () => {
    queryDocs = [teamDoc("ws-team-1"), teamDoc("ws-team-2"), personalDoc("personal-uid-1")];
    const result = await checkTeamWorkspaceOwnershipForUid(UID);
    expect(result.kind).toBe("owns_team_workspace");
    if (result.kind === "owns_team_workspace") {
      expect(result.workspaceIds.sort()).toEqual(["ws-team-1", "ws-team-2"]);
    }
  });

  it("fails closed (lookup_failed, never clear) when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await checkTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ kind: "lookup_failed" });
    expect(logger.error).toHaveBeenCalled();
  });

  it("fails closed (lookup_failed, never clear) when the query throws", async () => {
    queryShouldThrow.value = true;
    const result = await checkTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ kind: "lookup_failed" });
    expect(logger.error).toHaveBeenCalled();
  });
});

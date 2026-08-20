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
import { getTeamWorkspaceOwnershipForUid } from "@/lib/workspaces/teamOwnerGuard";

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

describe("getTeamWorkspaceOwnershipForUid", () => {
  it("reports no ownership when the uid owns nothing", async () => {
    const result = await getTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
  });

  it("reports ownership when the uid owns a Team Workspace", async () => {
    queryDocs = [teamDoc("ws-team-1")];
    const result = await getTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ status: "ok", ownsTeamWorkspace: true, workspaceIds: ["ws-team-1"] });
  });

  it("does NOT report ownership from owning only a Personal Workspace", async () => {
    queryDocs = [personalDoc("personal-uid-1")];
    const result = await getTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
  });

  it("filters out a malformed document rather than trusting it", async () => {
    queryDocs = [{ id: "ws-bad", data: { ownerUserId: UID, type: "team" } }]; // missing required fields
    const result = await getTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
  });

  it("filters out a document whose embedded id disagrees with its Firestore doc id", async () => {
    const doc = teamDoc("ws-real-id");
    (doc.data as any).id = "ws-mismatched-id";
    queryDocs = [doc];
    const result = await getTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
  });

  it("reports both Team Workspaces when the uid owns more than one", async () => {
    queryDocs = [teamDoc("ws-team-1"), teamDoc("ws-team-2"), personalDoc("personal-uid-1")];
    const result = await getTeamWorkspaceOwnershipForUid(UID);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ownsTeamWorkspace).toBe(true);
      expect(result.workspaceIds.sort()).toEqual(["ws-team-1", "ws-team-2"]);
    }
  });

  it("reports firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await getTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("reports lookup_failed when the query throws", async () => {
    queryShouldThrow.value = true;
    const result = await getTeamWorkspaceOwnershipForUid(UID);
    expect(result).toEqual({ status: "lookup_failed" });
  });
});

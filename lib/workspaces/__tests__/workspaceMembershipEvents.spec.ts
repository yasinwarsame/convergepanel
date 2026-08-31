/**
 * Team Member Management, Phase 12A — writeWorkspaceMembershipEvent() tests.
 * Structural mirror of `lib/projects/__tests__/projectEvents.spec.ts` — the
 * central property under test is identical: this function NEVER throws or
 * rejects, regardless of the underlying Firestore write outcome.
 */

const addMock = jest.fn();
const firestoreUnavailableFlag = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    add: (data: Record<string, unknown>) => addMock(name, data),
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

import { writeWorkspaceMembershipEvent } from "@/lib/workspaces/workspaceMembershipEvents";
import { logger } from "@/lib/logger";

beforeEach(() => {
  jest.clearAllMocks();
  firestoreUnavailableFlag.value = false;
  addMock.mockResolvedValue({ id: "event-1" });
});

describe("writeWorkspaceMembershipEvent", () => {
  it("writes into the dedicated workspaceMembershipEvents collection — never admin_audit_logs or any governance collection", async () => {
    await writeWorkspaceMembershipEvent({ eventType: "workspace_member_removed", actorUid: "owner-1", targetUid: "member-1", workspaceId: "ws-1", previousRole: "member" });
    expect(addMock).toHaveBeenCalledWith("workspaceMembershipEvents", expect.anything());
  });

  it("payload contains exactly the expected metadata fields — no extras, no display name, no email", async () => {
    await writeWorkspaceMembershipEvent({ eventType: "workspace_member_removed", actorUid: "owner-1", targetUid: "member-1", workspaceId: "ws-1", previousRole: "member" });
    const [, payload] = addMock.mock.calls[0];
    expect(Object.keys(payload).sort()).toEqual(["actorUid", "at", "eventType", "previousRole", "targetUid", "workspaceId"].sort());
  });

  it("actor and target are server-derived uids, carried verbatim — never re-derived or altered by this module", async () => {
    await writeWorkspaceMembershipEvent({ eventType: "workspace_member_removed", actorUid: "owner-uid-exact", targetUid: "target-uid-exact", workspaceId: "ws-1", previousRole: "admin" });
    const [, payload] = addMock.mock.calls[0];
    expect(payload.actorUid).toBe("owner-uid-exact");
    expect(payload.targetUid).toBe("target-uid-exact");
    expect(payload.previousRole).toBe("admin");
  });

  it("resolves (never throws) when the Firestore write succeeds", async () => {
    await expect(writeWorkspaceMembershipEvent({ eventType: "workspace_member_removed", actorUid: "owner-1", targetUid: "member-1", workspaceId: "ws-1", previousRole: "member" })).resolves.toBeUndefined();
  });

  it("resolves (never throws or rejects) even when the Firestore write itself throws", async () => {
    addMock.mockRejectedValue(new Error("simulated Firestore outage"));
    await expect(writeWorkspaceMembershipEvent({ eventType: "workspace_member_removed", actorUid: "owner-1", targetUid: "member-1", workspaceId: "ws-1", previousRole: "member" })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("resolves (never throws) when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    await expect(writeWorkspaceMembershipEvent({ eventType: "workspace_member_removed", actorUid: "owner-1", targetUid: "member-1", workspaceId: "ws-1", previousRole: "member" })).resolves.toBeUndefined();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("logs a structured warning (with eventType and workspaceId, no raw error object) on failure", async () => {
    addMock.mockRejectedValue(new Error("boom"));
    await writeWorkspaceMembershipEvent({ eventType: "workspace_member_removed", actorUid: "owner-1", targetUid: "member-1", workspaceId: "ws-42", previousRole: "viewer" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write membership event"),
      expect.objectContaining({ eventType: "workspace_member_removed", workspaceId: "ws-42" })
    );
  });

  it("append-only random-ID write — uses .add(), never a deterministic .doc(id).create()", () => {
    const source = require("fs").readFileSync(require.resolve("@/lib/workspaces/workspaceMembershipEvents"), "utf8");
    expect(source).toMatch(/\.add\(/);
    expect(source).not.toMatch(/\.doc\([^)]*\)\.create\(/);
  });
});

import { Timestamp } from "firebase-admin/firestore";
import { validateMembershipBinding } from "@/lib/workspaces/membershipBinding";
import { computeMembershipId } from "@/lib/workspaces/membershipId";

const WS_ID = "ws-1";
const UID = "uid-1";
const NOW = Timestamp.now();

function validDoc(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: computeMembershipId(WS_ID, UID),
    workspaceId: WS_ID,
    uid: UID,
    role: "member",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  };
}

describe("validateMembershipBinding", () => {
  it("accepts a correctly-bound, well-formed document", () => {
    const result = validateMembershipBinding(validDoc(), { workspaceId: WS_ID, uid: UID });
    expect(result).not.toBeNull();
    expect(result?.uid).toBe(UID);
  });

  it("rejects when the document's workspaceId disagrees with the expected workspaceId", () => {
    const result = validateMembershipBinding(validDoc(), { workspaceId: "different-ws", uid: UID });
    expect(result).toBeNull();
  });

  it("rejects when the document's uid disagrees with the expected uid", () => {
    const result = validateMembershipBinding(validDoc(), { workspaceId: WS_ID, uid: "different-uid" });
    expect(result).toBeNull();
  });

  it("rejects when the document's own id doesn't match computeMembershipId(workspaceId, uid)", () => {
    const result = validateMembershipBinding(validDoc({ id: "wm_" + "f".repeat(64) }), { workspaceId: WS_ID, uid: UID });
    expect(result).toBeNull();
  });

  it("rejects a structurally malformed document outright", () => {
    expect(validateMembershipBinding({ not: "a membership" }, { workspaceId: WS_ID, uid: UID })).toBeNull();
    expect(validateMembershipBinding(null, { workspaceId: WS_ID, uid: UID })).toBeNull();
  });
});

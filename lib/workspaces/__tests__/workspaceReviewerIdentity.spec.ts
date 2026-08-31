/**
 * Approval Workflow, Phase 9B.6-R1C — resolveWorkspaceReviewerDisplayNames()
 * tests. The global `resolveReviewerDisplayNames()` is MOCKED here
 * specifically so tests can assert exactly which uids it was invoked
 * with — the security property under test is "a non-evidenced uid never
 * reaches the global resolver at all," not merely "the final output
 * happens to be masked."
 */

type StoredDoc = Record<string, unknown>;
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaceMemberships: new Map(),
};

function resetStores() {
  for (const store of Object.values(stores)) store.clear();
}

function asPersisted(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function makeDocRef(collectionName: string, docId: string) {
  return { __collection: collectionName, __id: docId };
}

const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (id: string) => makeDocRef(name, id) }),
  getAll: async (...refs: { __collection: string; __id: string }[]) => {
    return refs.map((ref) => {
      const data = stores[ref.__collection].get(ref.__id);
      return { exists: data !== undefined, data: () => data, id: ref.__id };
    });
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

const mockedResolveReviewerDisplayNames = jest.fn();
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: (...args: unknown[]) => mockedResolveReviewerDisplayNames(...args),
  REVIEWER_UNAVAILABLE_LABEL: "Reviewer unavailable",
}));

import { Timestamp } from "firebase-admin/firestore";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { resolveWorkspaceReviewerDisplayNames, REVIEWER_UNAVAILABLE_LABEL } from "@/lib/workspaces/workspaceReviewerIdentity";

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const OWNER_UID = "owner-1";
const NOW = Timestamp.now();

function seedMembership(uid: string, role: string, workspaceId: string = WS_ID, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  const status = (overrides.status as string | undefined) ?? "active";
  stores.workspaceMemberships.set(
    id,
    asPersisted({ schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: status === "removed" ? NOW : null, removedByUserId: status === "removed" ? OWNER_UID : null, ...overrides })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStores();
  mockedResolveReviewerDisplayNames.mockResolvedValue(new Map());
});

describe("resolveWorkspaceReviewerDisplayNames — evidenced members reach the global resolver", () => {
  it("active member: passed to the global resolver, resolved name returned", async () => {
    seedMembership(OWNER_UID, "owner");
    mockedResolveReviewerDisplayNames.mockResolvedValueOnce(new Map([[OWNER_UID, "Olivia Owner"]]));
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, [OWNER_UID]);
    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledWith([OWNER_UID], expect.any(Map), undefined, REVIEWER_UNAVAILABLE_LABEL);
    expect(result.get(OWNER_UID)).toBe("Olivia Owner");
  });

  it("removed member with legitimate membership evidence: still passed to the global resolver (historical attribution preserved)", async () => {
    seedMembership(OWNER_UID, "owner", WS_ID, { status: "removed" });
    mockedResolveReviewerDisplayNames.mockResolvedValueOnce(new Map([[OWNER_UID, "Former Owner"]]));
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, [OWNER_UID]);
    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledWith([OWNER_UID], expect.any(Map), undefined, REVIEWER_UNAVAILABLE_LABEL);
    expect(result.get(OWNER_UID)).toBe("Former Owner");
  });
});

describe("resolveWorkspaceReviewerDisplayNames — CRITICAL: non-evidenced uids never reach the global resolver", () => {
  it("no membership document at all: global resolver never called with this uid, safe fallback returned", async () => {
    const foreignUid = "foreign-user-uid";
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, [foreignUid]);
    expect(mockedResolveReviewerDisplayNames).not.toHaveBeenCalled();
    expect(result.get(foreignUid)).toBe(REVIEWER_UNAVAILABLE_LABEL);
  });

  it("membership exists but for a DIFFERENT workspace: global resolver never called for this uid in this workspace's context", async () => {
    const otherWorkspaceUid = "other-workspace-uid";
    seedMembership(otherWorkspaceUid, "reviewer", OTHER_WS_ID);
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, [otherWorkspaceUid]);
    expect(mockedResolveReviewerDisplayNames).not.toHaveBeenCalled();
    expect(result.get(otherWorkspaceUid)).toBe(REVIEWER_UNAVAILABLE_LABEL);
  });

  it("malformed membership document: fails closed, never resolved, never repaired", async () => {
    const malformedUid = "malformed-uid";
    stores.workspaceMemberships.set(computeMembershipId(WS_ID, malformedUid), { schemaVersion: 1 }); // missing required fields
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, [malformedUid]);
    expect(mockedResolveReviewerDisplayNames).not.toHaveBeenCalled();
    expect(result.get(malformedUid)).toBe(REVIEWER_UNAVAILABLE_LABEL);
  });

  it("membership document whose own embedded uid/workspaceId does not match its id (confused-deputy): fails closed", async () => {
    const uid = "confused-uid";
    // Deliberately store the doc keyed as if for `uid`, but with embedded fields for a different identity.
    stores.workspaceMemberships.set(computeMembershipId(WS_ID, uid), asPersisted({ schemaVersion: 1, id: computeMembershipId(WS_ID, uid), workspaceId: WS_ID, uid: "someone-else", role: "owner", status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null }));
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, [uid]);
    expect(mockedResolveReviewerDisplayNames).not.toHaveBeenCalled();
    expect(result.get(uid)).toBe(REVIEWER_UNAVAILABLE_LABEL);
  });
});

describe("resolveWorkspaceReviewerDisplayNames — batching, dedup, mixed input", () => {
  it("mixed batch: only evidenced uids are passed to the global resolver, deduplicated", async () => {
    seedMembership(OWNER_UID, "owner");
    const foreignUid = "foreign-uid";
    mockedResolveReviewerDisplayNames.mockResolvedValueOnce(new Map([[OWNER_UID, "Olivia Owner"]]));
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, [OWNER_UID, foreignUid, OWNER_UID]);
    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledTimes(1);
    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledWith([OWNER_UID], expect.any(Map), undefined, REVIEWER_UNAVAILABLE_LABEL);
    expect(result.get(OWNER_UID)).toBe("Olivia Owner");
    expect(result.get(foreignUid)).toBe(REVIEWER_UNAVAILABLE_LABEL);
  });

  it("empty input: returns empty map, zero Firestore/resolver calls", async () => {
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, []);
    expect(result.size).toBe(0);
    expect(mockedResolveReviewerDisplayNames).not.toHaveBeenCalled();
  });
});

describe("resolveWorkspaceReviewerDisplayNames — Workspace Audit Log, Phase TEAM-GOV-I1: optional fallbackLabel", () => {
  it("omitted fallbackLabel: defaults to REVIEWER_UNAVAILABLE_LABEL, identical to prior behavior (non-evidenced uid)", async () => {
    const foreignUid = "foreign-user-uid";
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, [foreignUid]);
    expect(result.get(foreignUid)).toBe(REVIEWER_UNAVAILABLE_LABEL);
  });

  it("custom fallbackLabel: used for a non-evidenced uid instead of REVIEWER_UNAVAILABLE_LABEL", async () => {
    const foreignUid = "foreign-user-uid";
    const result = await resolveWorkspaceReviewerDisplayNames(WS_ID, [foreignUid], "Unknown member");
    expect(result.get(foreignUid)).toBe("Unknown member");
    expect(result.get(foreignUid)).not.toBe(REVIEWER_UNAVAILABLE_LABEL);
  });

  it("custom fallbackLabel is forwarded as the underlying global resolver's own unresolvedLabel argument", async () => {
    seedMembership(OWNER_UID, "owner");
    await resolveWorkspaceReviewerDisplayNames(WS_ID, [OWNER_UID], "Unknown user");
    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledWith([OWNER_UID], expect.any(Map), undefined, "Unknown user");
  });

  it("two calls with different fallbackLabels for the same uid produce independently correct fallbacks (Audit Log's actor-vs-target split)", async () => {
    const foreignUid = "foreign-user-uid";
    const asActor = await resolveWorkspaceReviewerDisplayNames(WS_ID, [foreignUid], "Unknown user");
    const asTarget = await resolveWorkspaceReviewerDisplayNames(WS_ID, [foreignUid], "Unknown member");
    expect(asActor.get(foreignUid)).toBe("Unknown user");
    expect(asTarget.get(foreignUid)).toBe("Unknown member");
  });
});

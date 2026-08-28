/**
 * Team Project Backend, Phase 8C-A —
 * `authorizeTeamWorkspaceMutationInTransaction()` unit tests. Exercises
 * the primitive directly with a minimal fake `Transaction` (just `.get()`,
 * keyed by collection+docId) — this function never writes, so no buffered-
 * write fake is needed here; see `teamProjects.spec.ts` for the full
 * transactional create/update tests (including revocation races) that DO
 * need one.
 */

import { Timestamp } from "firebase-admin/firestore";

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => ({ __collection: name, __id: id }),
    }),
  },
}));

import { authorizeTeamWorkspaceMutationInTransaction } from "../authorizeTeamWorkspaceMutationInTransaction";
import { computeMembershipId } from "../membershipId";

const WS_ID = "ws-team-1";
const OWNER_UID = "owner-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";

type DocEntry = { exists: boolean; data?: Record<string, unknown> };

function makeTx(docs: Record<string, DocEntry>) {
  const getSpy = jest.fn(async (ref: { __collection: string; __id: string }) => {
    const key = `${ref.__collection}/${ref.__id}`;
    const entry = docs[key];
    if (!entry || !entry.exists) return { exists: false, data: () => undefined };
    return { exists: true, data: () => entry.data };
  });
  return { get: getSpy };
}

function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

function workspaceDoc(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: WS_ID,
    type: "team",
    name: "Acme Team",
    ownerUserId: OWNER_UID,
    createdByUserId: OWNER_UID,
    createdAt: ts(1000),
    updatedAt: ts(1000),
    ...overrides,
  };
}

function membershipDoc(uid: string, role: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: computeMembershipId(WS_ID, uid),
    workspaceId: WS_ID,
    uid,
    role,
    status: "active",
    createdAt: ts(1000),
    updatedAt: ts(1000),
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  };
}

function docsFor(args: { workspace?: Record<string, unknown> | null; memberships: Record<string, Record<string, unknown> | null> }) {
  const docs: Record<string, DocEntry> = {};
  docs[`workspaces/${WS_ID}`] = args.workspace ? { exists: true, data: args.workspace } : { exists: false };
  for (const [uid, data] of Object.entries(args.memberships)) {
    const id = computeMembershipId(WS_ID, uid);
    docs[`workspaceMemberships/${id}`] = data ? { exists: true, data } : { exists: false };
  }
  return docs;
}

describe("authorizeTeamWorkspaceMutationInTransaction", () => {
  it("grants Owner projects.create", async () => {
    const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner") } });
    const tx = makeTx(docs);
    const result = await authorizeTeamWorkspaceMutationInTransaction(tx as any, { uid: OWNER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result.ok).toBe(true);
  });

  it("deduplicates the owner-membership read when caller IS the owner (only one workspaceMemberships get())", async () => {
    const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner") } });
    const tx = makeTx(docs);
    await authorizeTeamWorkspaceMutationInTransaction(tx as any, { uid: OWNER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    const membershipGets = (tx.get as jest.Mock).mock.calls.filter((c) => c[0].__collection === "workspaceMemberships");
    expect(membershipGets.length).toBe(1);
  });

  it("grants Admin/Member projects.create and projects.manage; denies Reviewer/Viewer both", async () => {
    for (const role of ["admin", "member"]) {
      const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner"), [MEMBER_UID]: membershipDoc(MEMBER_UID, role) } });
      const tx = makeTx(docs);
      const createResult = await authorizeTeamWorkspaceMutationInTransaction(tx as any, { uid: MEMBER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
      expect(createResult.ok).toBe(true);
      const manageResult = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: MEMBER_UID, workspaceId: WS_ID, requiredCapability: "projects.manage" });
      expect(manageResult.ok).toBe(true);
    }
    for (const role of ["reviewer", "viewer"]) {
      const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner"), [REVIEWER_UID]: membershipDoc(REVIEWER_UID, role) } });
      const createResult = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: REVIEWER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
      expect(createResult).toEqual({ ok: false, reason: "insufficient_capability" });
      const manageResult = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: REVIEWER_UID, workspaceId: WS_ID, requiredCapability: "projects.manage" });
      expect(manageResult).toEqual({ ok: false, reason: "insufficient_capability" });
    }
  });

  it("denies workspace_not_found when the Workspace doc does not exist", async () => {
    const docs = docsFor({ workspace: null, memberships: {} });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: OWNER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "workspace_not_found" });
  });

  it("denies workspace_malformed on a structurally invalid workspace document", async () => {
    const docs = docsFor({ workspace: { id: WS_ID } as any, memberships: {} });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: OWNER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "workspace_malformed" });
  });

  it("denies workspace_malformed on an embedded id mismatch", async () => {
    const docs = docsFor({ workspace: workspaceDoc({ id: "some-other-id" }), memberships: {} });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: OWNER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "workspace_malformed" });
  });

  it("denies workspace_malformed when the Workspace is type: personal", async () => {
    const docs = docsFor({ workspace: { schemaVersion: 1, id: WS_ID, type: "personal", name: "x", ownerUserId: OWNER_UID, createdAt: ts(1), updatedAt: ts(1) }, memberships: {} });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: OWNER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "workspace_malformed" });
  });

  it("denies membership_not_found when caller has no membership document", async () => {
    const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner") } });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: MEMBER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "membership_not_found" });
  });

  it("denies membership_malformed on a structurally invalid caller membership document", async () => {
    const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner"), [MEMBER_UID]: { role: "member" } as any } });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: MEMBER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "membership_malformed" });
  });

  it("denies membership_malformed when the caller membership's own workspaceId/uid disagree with what was fetched (binding mismatch)", async () => {
    // A document physically stored at the caller's expected id, but whose
    // OWN embedded uid field claims a different identity — validateMembershipBinding must reject this.
    const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner"), [MEMBER_UID]: membershipDoc("someone-else", "member") } });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: MEMBER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "membership_malformed" });
  });

  it("denies membership_removed when caller membership status is removed", async () => {
    const docs = docsFor({
      workspace: workspaceDoc(),
      memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner"), [MEMBER_UID]: membershipDoc(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID }) },
    });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: MEMBER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "membership_removed" });
  });

  it("denies owner_integrity_violation when the workspace's stored owner has no membership document at all", async () => {
    const docs = docsFor({ workspace: workspaceDoc(), memberships: { [MEMBER_UID]: membershipDoc(MEMBER_UID, "member") } });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: MEMBER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "owner_integrity_violation" });
  });

  it("denies owner_integrity_violation when the owner's membership document has role !== owner", async () => {
    const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "admin"), [MEMBER_UID]: membershipDoc(MEMBER_UID, "member") } });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: MEMBER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "owner_integrity_violation" });
  });

  it("denies owner_integrity_violation when the CALLER is the workspace's stored owner but their own membership role is not owner (corrupted self state)", async () => {
    const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "admin") } });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: OWNER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "owner_integrity_violation" });
  });

  it("denies owner_integrity_violation even when the caller's OWN role/capability would otherwise be sufficient — the whole authorization fails closed", async () => {
    // Member requests projects.create (which Member has), but the
    // workspace's owner-integrity is broken — the entire result must deny,
    // never fall through to "well the caller's own role was fine".
    const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "member"), [MEMBER_UID]: membershipDoc(MEMBER_UID, "member") } });
    const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: MEMBER_UID, workspaceId: WS_ID, requiredCapability: "projects.create" });
    expect(result).toEqual({ ok: false, reason: "owner_integrity_violation" });
  });

  // ============================================
  // Owner-integrity hardening (10B.3.2B.2-H1) — Case A: a CALLER whose own
  // membership document claims role: "owner" while the genuine canonical
  // owner (workspace.ownerUserId) is someone else entirely. The genuine
  // owner's own membership document is untouched/valid throughout — this is
  // NOT the already-covered "canonical owner corrupted" (Case B) scenario
  // above, it's an attacker-controlled or corrupted SELF membership row
  // claiming an owner identity it does not hold.
  // ============================================

  describe("owner-integrity hardening — Case A: attacker membership falsely claims role: owner", () => {
    it("denies reviews.override to a non-owner uid whose own membership document says role: owner (owner_integrity_violation), even though the genuine canonical owner's membership is completely valid", async () => {
      const ATTACKER_UID = "attacker-1";
      const docs = docsFor({
        workspace: workspaceDoc(), // ownerUserId: OWNER_UID
        memberships: {
          [OWNER_UID]: membershipDoc(OWNER_UID, "owner"), // genuine owner — untouched, valid
          [ATTACKER_UID]: membershipDoc(ATTACKER_UID, "owner"), // corrupted/attacker-controlled self row
        },
      });
      const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: ATTACKER_UID, workspaceId: WS_ID, requiredCapability: "reviews.override" });
      expect(result).toEqual({ ok: false, reason: "owner_integrity_violation" });
    });

    it("does not merely deny reviews.override — the entire authorization fails closed, never falling back to any lower-privilege grant for the attacker's role: owner row", async () => {
      const ATTACKER_UID = "attacker-1";
      const docs = docsFor({
        workspace: workspaceDoc(),
        memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner"), [ATTACKER_UID]: membershipDoc(ATTACKER_UID, "owner") },
      });
      // research.read is a capability every real role (including Owner) holds — proving this isn't
      // merely a reviews.override-specific carve-out, the whole result denies for ANY capability.
      const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: ATTACKER_UID, workspaceId: WS_ID, requiredCapability: "research.read" });
      expect(result).toEqual({ ok: false, reason: "owner_integrity_violation" });
    });

    it("legitimate canonical Owner (uid === workspace.ownerUserId, role: owner) is unaffected by the hardening — still authorized exactly as before", async () => {
      const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner") } });
      const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: OWNER_UID, workspaceId: WS_ID, requiredCapability: "reviews.override" });
      expect(result.ok).toBe(true);
    });

    it("ordinary non-owner roles (Admin/Member/Reviewer/Viewer) are unaffected by the hardening — the new check only fires when a membership's OWN role field claims owner", async () => {
      const ADMIN_UID = "admin-1";
      for (const [uid, role, capability, expectAuthorized] of [
        [ADMIN_UID, "admin", "projects.create", true],
        [MEMBER_UID, "member", "projects.create", true],
        [REVIEWER_UID, "reviewer", "projects.create", false],
        ["viewer-1", "viewer", "projects.create", false],
      ] as const) {
        const docs = docsFor({ workspace: workspaceDoc(), memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner"), [uid]: membershipDoc(uid, role) } });
        const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid, workspaceId: WS_ID, requiredCapability: capability });
        expect(result.ok).toBe(expectAuthorized);
      }
    });

    it("a foreign-Workspace membership document claiming role: owner (wrong workspaceId binding) is denied at membership_malformed — the binding check runs before the new owner-integrity check, never reaching it", async () => {
      const ATTACKER_UID = "attacker-1";
      const docs = docsFor({
        workspace: workspaceDoc(),
        memberships: { [OWNER_UID]: membershipDoc(OWNER_UID, "owner"), [ATTACKER_UID]: { ...membershipDoc(ATTACKER_UID, "owner"), workspaceId: "some-other-ws" } },
      });
      const result = await authorizeTeamWorkspaceMutationInTransaction(makeTx(docs) as any, { uid: ATTACKER_UID, workspaceId: WS_ID, requiredCapability: "reviews.override" });
      expect(result).toEqual({ ok: false, reason: "membership_malformed" });
    });
  });
});

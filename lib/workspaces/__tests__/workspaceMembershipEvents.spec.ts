/**
 * Team Member Management, Phase 12A — `buildWorkspaceMembershipEventDocData()`
 * tests.
 *
 * Governance Audit Durability, Phase TEAM-GOV-I1C1 — REWRITTEN. This
 * module no longer performs any Firestore I/O of its own (the previous
 * `writeWorkspaceMembershipEvent()` async writer was deleted): the actual
 * write now happens via `tx.set()` inside `removeWorkspaceMembership()`'s
 * transaction (`lib/firestore/__tests__/workspaceMemberships.spec.ts`
 * covers that atomicity). This file now only proves the pure, zero-I/O
 * document-shape builder is correct.
 */

import { buildWorkspaceMembershipEventDocData } from "@/lib/workspaces/workspaceMembershipEvents";
import { Timestamp } from "firebase-admin/firestore";

describe("buildWorkspaceMembershipEventDocData", () => {
  const AT = Timestamp.now();

  it("payload contains exactly the expected metadata fields — no extras, no display name, no email", () => {
    const payload = buildWorkspaceMembershipEventDocData({ eventType: "workspace_member_removed", actorUid: "owner-1", targetUid: "member-1", workspaceId: "ws-1", previousRole: "member", at: AT });
    expect(Object.keys(payload).sort()).toEqual(["actorUid", "at", "eventType", "previousRole", "targetUid", "workspaceId"].sort());
  });

  it("actor and target are carried verbatim — never re-derived or altered by this module", () => {
    const payload = buildWorkspaceMembershipEventDocData({ eventType: "workspace_member_removed", actorUid: "owner-uid-exact", targetUid: "target-uid-exact", workspaceId: "ws-1", previousRole: "admin", at: AT });
    expect(payload.actorUid).toBe("owner-uid-exact");
    expect(payload.targetUid).toBe("target-uid-exact");
    expect(payload.previousRole).toBe("admin");
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.eventType).toBe("workspace_member_removed");
  });

  it("`at` is the exact caller-supplied Timestamp — never independently generated (proves single-clock-read consistency with the membership's own removedAt/updatedAt)", () => {
    const payload = buildWorkspaceMembershipEventDocData({ eventType: "workspace_member_removed", actorUid: "owner-1", targetUid: "member-1", workspaceId: "ws-1", previousRole: "member", at: AT });
    expect(payload.at).toBe(AT);
  });

  it("pure function: never throws, has no side effects, does not touch Firestore", () => {
    const fs = require("fs");
    const source = fs.readFileSync(require.resolve("@/lib/workspaces/workspaceMembershipEvents"), "utf8");
    const fnBody = source.match(/export function buildWorkspaceMembershipEventDocData\([\s\S]*/)?.[0] ?? "";
    expect(fnBody).not.toMatch(/adminDb|\.add\(|\.set\(|\.create\(|await /);
    expect(source).not.toMatch(/^import.*adminDb/m);
  });

  it("is synchronous — returns a plain object directly, not a Promise", () => {
    const result = buildWorkspaceMembershipEventDocData({ eventType: "workspace_member_removed", actorUid: "owner-1", targetUid: "member-1", workspaceId: "ws-1", previousRole: "member", at: AT });
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe("buildWorkspaceMembershipEventDocData — Project lifecycle events, Phase PROJECT-AUDIT-AR-I1", () => {
  const AT = Timestamp.now();

  it.each(["workspace_project_archived", "workspace_project_restored"] as const)("%s payload contains exactly {eventType, actorUid, workspaceId, projectId, projectName, at} — no target/role/status fields, no display name", (eventType) => {
    const payload = buildWorkspaceMembershipEventDocData({ eventType, actorUid: "owner-1", workspaceId: "ws-1", projectId: "proj-1", projectName: "Quarterly Diligence", at: AT });
    expect(Object.keys(payload).sort()).toEqual(["actorUid", "at", "eventType", "projectId", "projectName", "workspaceId"]);
    expect(payload).toEqual({ eventType, actorUid: "owner-1", workspaceId: "ws-1", projectId: "proj-1", projectName: "Quarterly Diligence", at: AT });
  });

  it("carries the Project name snapshot and identities verbatim — never re-derived, trimmed, or altered", () => {
    const payload = buildWorkspaceMembershipEventDocData({ eventType: "workspace_project_archived", actorUid: "actor-exact", workspaceId: "ws-exact", projectId: "proj-exact", projectName: "  Exact Name  ", at: AT });
    expect(payload).toMatchObject({ actorUid: "actor-exact", workspaceId: "ws-exact", projectId: "proj-exact", projectName: "  Exact Name  " });
    expect(payload.at).toBe(AT);
  });
});


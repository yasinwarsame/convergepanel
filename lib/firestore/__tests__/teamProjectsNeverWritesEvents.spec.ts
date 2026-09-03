/**
 * Team Project Backend, Phase 8C-A.1 (Section 12, Mutation O) — structural
 * proof that `lib/firestore/teamProjects.ts` (the transactional Firestore
 * write module) never uses the NON-transactional, best-effort
 * `projectEvents` writer (`writeProjectEvent` / `writeTeamProjectEventSafely`
 * / the `projectEvents` module or collection). That writer belongs
 * exclusively to the ROUTE layer, strictly after `createTeamProject()`/
 * `updateTeamProjectFields()` have already returned — i.e. strictly after
 * `runTransaction()` has already resolved. Firestore may internally retry a
 * transaction's callback on a write conflict; a plain `.add()` living
 * inside that callback would execute once per DISCARDED attempt, not just
 * once for the attempt that actually commits.
 *
 * Phase PROJECT-AUDIT-AR-I1 — the invariant is stated precisely rather
 * than as a blanket "never writes events": `updateTeamProjectFields()` now
 * DOES write the authoritative Workspace Audit event
 * (`workspaceMembershipEvents`, archive/restore only) — but ONLY via
 * `tx.set()` through the transaction handle, which is buffered and
 * committed solely with the winning attempt (`PROJECT LIFECYCLE CHANGE
 * COMMITTED IFF WORKSPACE AUDIT EVENT COMMITTED`). This file therefore
 * guards BOTH halves: (1) the non-transactional projectEvents writer never
 * enters this module, and (2) every event write in this module goes
 * through `tx.set()` — no `.add()`, and no non-transactional `.set()` on a
 * bare DocumentReference — so a discarded retry attempt can never persist
 * an event. Structural (grep) rather than runtime because the violation
 * literally requires adding a new import/call to the file first; the
 * runtime atomicity behavior itself is covered by `teamProjects.spec.ts`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const TEAM_PROJECTS_FILE = join(__dirname, "..", "teamProjects.ts");

/** Strips `/* ... *\/` block comments (this file's own doc comments legitimately discuss the forbidden function by name in prose) before checking for real code usage. Line comments are left alone — none of this file's `//` comments reference the forbidden names. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("lib/firestore/teamProjects.ts event-writing invariant", () => {
  const code = stripBlockComments(readFileSync(TEAM_PROJECTS_FILE, "utf8"));

  it("contains no CODE reference to the non-transactional projectEvents writer (doc-comment prose explaining the invariant is fine; an import or call is not)", () => {
    expect(code).not.toMatch(/writeProjectEvent/);
    expect(code).not.toMatch(/writeTeamProjectEventSafely/);
    expect(code).not.toMatch(/from\s+["']@\/lib\/projects\/projectEvents["']/);
    expect(code).not.toMatch(/from\s+["']@\/lib\/projects\/writeTeamProjectEventSafely["']/);
    expect(code).not.toMatch(/collection\(\s*["']projectEvents["']\s*\)/);
  });

  it("never performs a non-transactional event write: no `.add(` anywhere, and every `.set(` is `tx.set(`", () => {
    expect(code).not.toMatch(/\.add\(/);
    const setCalls = code.match(/\b\w+\.set\(/g) ?? [];
    expect(setCalls.length).toBeGreaterThan(0); // the AR-I1 audit write must exist
    for (const call of setCalls) expect(call).toBe("tx.set(");
  });

  it("the Workspace Audit event is written through the transaction handle from a freshly-allocated ref, never from a request-derived id", () => {
    expect(code).toMatch(/collection\("workspaceMembershipEvents"\)\.doc\(\)/);
    expect(code).toMatch(/tx\.set\(\s*eventRef/);
    expect(code).toMatch(/buildWorkspaceMembershipEventDocData\(/);
  });

  it("event provenance: every field of the Workspace Audit event is derived from TRANSACTION-READ state (authorized membership, validated Project, the Project's own `now`) — never from request arguments. Structural on purpose: the writer already proves project.workspaceId === args.workspaceId before writing, so a runtime test cannot tell the two apart; this guard is what makes the 'unvalidated source' mutation detectable.", () => {
    const call = code.match(/buildWorkspaceMembershipEventDocData\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(call).not.toBe("");
    expect(call).toMatch(/actorUid:\s*auth\.membership\.uid,/);
    expect(call).toMatch(/workspaceId:\s*project\.workspaceId,/);
    expect(call).toMatch(/projectId:\s*project\.id,/);
    expect(call).toMatch(/projectName:\s*project\.name,/);
    expect(call).toMatch(/at:\s*now,/);
    // The ONLY request-derived input is the server-side mutation discriminator, and only to pick the event type.
    expect(call).toMatch(/eventType:\s*args\.mutation\.kind === "archive" \? "workspace_project_archived" : "workspace_project_restored",/);
    expect(call).not.toMatch(/args\.(workspaceId|projectId|uid)\b|Timestamp\.now\(\)/);
  });
});

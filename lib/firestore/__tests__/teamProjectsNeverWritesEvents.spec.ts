/**
 * Team Project Backend, Phase 8C-A.1 (Section 12, Mutation O) — structural
 * proof that `lib/firestore/teamProjects.ts` (the transactional Firestore
 * write module) never references `writeProjectEvent`/`projectEvents` at
 * all. Event-writing belongs exclusively to the ROUTE layer, called
 * strictly after `createTeamProject()`/`updateTeamProjectFields()` have
 * already returned — i.e. strictly after `runTransaction()` has already
 * resolved. Firestore may internally retry a transaction's callback on a
 * write conflict; a project-event write living inside that callback would
 * execute once per DISCARDED attempt, not just once for the attempt that
 * actually commits. This is a structural test rather than a runtime
 * mutation test because the current architecture makes the violation
 * literally require adding a new import to this file first — there is no
 * existing code path or toggle that could trigger it at runtime without
 * that structural change, so the grep IS the meaningful, permanent
 * regression guard here (see Phase 8C-A.1's own allowance for this).
 */

import { readFileSync } from "fs";
import { join } from "path";

const TEAM_PROJECTS_FILE = join(__dirname, "..", "teamProjects.ts");

/** Strips `/* ... *\/` block comments (this file's own doc comments legitimately discuss the forbidden function by name in prose) before checking for real code usage. Line comments are left alone — none of this file's `//` comments reference the forbidden names. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("lib/firestore/teamProjects.ts never writes projectEvents itself", () => {
  it("contains no CODE reference to writeProjectEvent or the projectEvents module (doc-comment prose explaining the invariant is fine; an import or call is not)", () => {
    const code = stripBlockComments(readFileSync(TEAM_PROJECTS_FILE, "utf8"));
    expect(code).not.toMatch(/writeProjectEvent/);
    expect(code).not.toMatch(/from\s+["']@\/lib\/projects\/projectEvents["']/);
  });
});

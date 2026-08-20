/**
 * Team Project Backend, Phase 8C-A.1 (Section 11, Mutation J) — structural
 * proof that no Personal Project route (`app/api/user/projects/**`) ever
 * imports any Team-authorization module. Personal Project authorization
 * must remain exactly `resolvePersonalWorkspaceForOwner()`/
 * `resolveProjectForOwner()` — never `resolveWorkspaceAccess()`,
 * `authorizeTeamWorkspaceMutationInTransaction()`, or the
 * `lib/firestore/teamProjects.ts` write primitives. Mirrors
 * `lib/workspaces/__tests__/noLegacyTeamRoleReuse.spec.ts`'s own
 * grep-actual-source discipline (never merely trusting a doc comment).
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const PERSONAL_PROJECTS_DIR = join(__dirname, "..", "..", "..", "app", "api", "user", "projects");

const FORBIDDEN_PATTERNS = [
  /from\s+["']@\/lib\/workspaces\/resolveWorkspaceAccess["']/,
  /from\s+["']@\/lib\/workspaces\/authorizeTeamWorkspaceMutationInTransaction["']/,
  /from\s+["']@\/lib\/firestore\/teamProjects["']/,
  /resolveWorkspaceAccess\(/,
  /authorizeTeamWorkspaceMutationInTransaction\(/,
];

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  let files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files = files.concat(collectTsFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("Personal Project routes never invoke Team Workspace authorization", () => {
  it("no file under app/api/user/projects/ imports or calls resolveWorkspaceAccess/authorizeTeamWorkspaceMutationInTransaction/teamProjects", () => {
    const files = collectTsFiles(PERSONAL_PROJECTS_DIR);
    expect(files.length).toBeGreaterThan(0); // sanity — the directory scan itself must find real files
    const offenders = files.filter((f) => {
      const content = readFileSync(f, "utf8");
      return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(content));
    });
    expect(offenders).toEqual([]);
  });

  it("no file under app/api/user/projects/ reads a workspaceMemberships document (no Personal membership lookup)", () => {
    const files = collectTsFiles(PERSONAL_PROJECTS_DIR);
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("workspaceMemberships"));
    expect(offenders).toEqual([]);
  });
});

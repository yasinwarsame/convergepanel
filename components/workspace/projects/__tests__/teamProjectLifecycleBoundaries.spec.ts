/**
 * Phase PROJECT-UI-AR-I1 — structural boundary guards for the Team Project
 * lifecycle UI. Narrow on purpose: only code (block comments stripped) of
 * the specific production files this feature owns, and only the specific
 * imports/identifiers that would mean the client had crossed a boundary
 * the server owns (direct Firestore mutation, Workspace Audit writes) or
 * that Personal Project UI had started depending on the Team hook.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (rel: string) => strip(readFileSync(join(ROOT, rel), "utf8"));

const TEAM_LIFECYCLE_CLIENT_FILES = [
  "hooks/useTeamProjects.ts",
  "hooks/useTeamProjectLifecycle.ts",
  "components/workspace/projects/TeamProjectsShell.tsx",
  "components/workspace/projects/TeamProjectLifecycleRow.tsx",
  "components/workspace/projects/TeamArchiveProjectDialog.tsx",
  "components/workspace/projects/teamProjectMutationErrorCopy.ts",
];

const PERSONAL_LIFECYCLE_FILES = ["components/projects/ProjectLifecycleRow.tsx", "components/projects/ArchiveProjectDialog.tsx", "components/projects/ProjectsShell.tsx", "hooks/useProjectLifecycle.ts"];

describe("Team Project lifecycle client code never crosses the server-owned boundaries", () => {
  it.each(TEAM_LIFECYCLE_CLIENT_FILES)("%s does not import firebase/firestore or the Admin SDK, and never references the Workspace Audit collection or event types", (rel) => {
    const c = code(rel);
    expect(c).not.toMatch(/from\s+["']firebase\/firestore["']/);
    expect(c).not.toMatch(/from\s+["']firebase-admin/);
    expect(c).not.toMatch(/@\/lib\/firebase\/admin/);
    expect(c).not.toMatch(/workspaceMembershipEvents/);
    expect(c).not.toMatch(/workspace_project_(archived|restored)/);
    expect(c).not.toMatch(/\.collection\(/);
  });

  it("every lifecycle mutation goes through authedFetch against the existing archive/restore routes", () => {
    const c = code("hooks/useTeamProjectLifecycle.ts");
    expect(c).toMatch(/authedFetch\(/);
    expect(c).toMatch(/\/projects\/\$\{encodeURIComponent\(project\.id\)\}\/\$\{operation\}/);
    // The ONLY request body this hook ever builds for a lifecycle transition is the row's native token, verbatim.
    expect(c).toMatch(/body: JSON\.stringify\(\{ expectedUpdateTime: project\.updateTime \}\)/);
    expect(c).not.toMatch(/expectedUpdateTime: (project\.updatedAt|Date|new Date|\{)/);
    expect(c).not.toMatch(/Date\.now\(\)|new Date\(/);
  });
});

describe("Personal Project lifecycle UI does not depend on the Team lifecycle hook or components", () => {
  it.each(PERSONAL_LIFECYCLE_FILES)("%s has no Team lifecycle import", (rel) => {
    const c = code(rel);
    expect(c).not.toMatch(/useTeamProjectLifecycle|useTeamProjects|TeamProjectLifecycleRow|TeamArchiveProjectDialog|teamProjectMutationErrorCopy/);
  });
});

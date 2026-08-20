/**
 * Team Workspace Core Foundation, Phase 8B.2 — structural test proving
 * the Team Workspace foundation never imports the legacy
 * `teams/{teamId}` governance role vocabulary (`TeamMemberRole`,
 * `lib/governance/teamTypes.ts`). The two role systems are deliberately
 * distinct (see docs/team-workspaces-architecture-audit.md's finding that
 * they already don't interoperate) — this test greps actual source, not
 * merely trusting a doc comment, since an accidental `import type {
 * TeamMemberRole } from "@/lib/governance/teamTypes"` would silently
 * reintroduce coupling this foundation is built to avoid.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const WORKSPACES_LIB_DIR = join(__dirname, "..");
const WORKSPACES_API_DIRS = [join(__dirname, "..", "..", "..", "app", "api", "workspaces")];

/** Excludes `__tests__` directories — test files (including this one) legitimately reference the legacy names in doc comments/regex/assertions; only real implementation source matters here. */
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

describe("no legacy teams/{teamId} role vocabulary reuse", () => {
  it("no file under lib/workspaces/ imports from lib/governance/teamTypes", () => {
    const files = collectTsFiles(WORKSPACES_LIB_DIR);
    const offenders = files.filter((f) => {
      const content = readFileSync(f, "utf8");
      return /from\s+["']@\/lib\/governance\/teamTypes["']/.test(content) || /from\s+["'].*\/teamTypes["']/.test(content);
    });
    expect(offenders).toEqual([]);
  });

  it("no file under lib/workspaces/ references TeamMemberRole", () => {
    const files = collectTsFiles(WORKSPACES_LIB_DIR);
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("TeamMemberRole"));
    expect(offenders).toEqual([]);
  });

  it("no file under app/api/workspaces/ imports from lib/governance/teamTypes or lib/teams/teamApiAuth", () => {
    for (const dir of WORKSPACES_API_DIRS) {
      const files = collectTsFiles(dir);
      const offenders = files.filter((f) => {
        const content = readFileSync(f, "utf8");
        return /from\s+["']@\/lib\/governance\/teamTypes["']/.test(content) || /from\s+["']@\/lib\/teams\/teamApiAuth["']/.test(content);
      });
      expect(offenders).toEqual([]);
    }
  });
});

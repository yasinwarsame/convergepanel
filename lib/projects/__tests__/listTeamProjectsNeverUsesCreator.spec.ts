/**
 * Team Project Backend, Phase 8C-A.1 (Section 3, Mutation A) — structural
 * proof that the Team Project READ path cannot consult `createdByUserId`
 * for authorization. Unlike Mutation B (a write-side bypass, proven via a
 * genuine runtime mutation in `teamProjects.spec.ts`), a runtime mutation
 * for the read path is not meaningfully constructible without FIRST making
 * a structural change: `listTeamProjects()` never receives a `uid`
 * parameter at all — grep-confirmed below, and confirmed independently by
 * reading `GET /api/workspaces/[workspaceId]/projects`, which resolves
 * the caller's `uid` only for the Workspace-level `resolveWorkspaceAccess()`
 * gate, rate limiting, and event-actor attribution, never passing it into
 * `listTeamProjects()`. There is no caller identity in scope at the point
 * a Project is filtered/returned, so "read uses createdByUserId for
 * authorization" cannot happen today without first threading a new `uid`
 * parameter through the function signature — that IS the structural
 * invariant this test freezes.
 */

import { readFileSync } from "fs";
import { join } from "path";

const LIST_FILE = join(__dirname, "..", "listTeamProjects.ts");
const ROUTE_FILE = join(__dirname, "..", "..", "..", "app", "api", "workspaces", "[workspaceId]", "projects", "route.ts");

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Team Project read path never consults createdByUserId for authorization", () => {
  it("listTeamProjects()'s function signature has no uid parameter", () => {
    const code = stripBlockComments(readFileSync(LIST_FILE, "utf8"));
    const signatureMatch = code.match(/export async function listTeamProjects\(args: \{([^}]*)\}\)/);
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch![1]).not.toMatch(/\buid\b/);
  });

  it("listTeamProjects.ts contains no reference to createdByUserId in a conditional/comparison", () => {
    const code = stripBlockComments(readFileSync(LIST_FILE, "utf8"));
    // createdByUserId is allowed to appear only as part of the DTO/type
    // shape (ProjectV1), never compared against anything.
    const comparisonLines = code.split("\n").filter((line) => line.includes("createdByUserId") && /[=!]==?|\.includes\(/.test(line));
    expect(comparisonLines).toEqual([]);
  });

  it("GET /api/workspaces/[workspaceId]/projects never passes uid into listTeamProjects()", () => {
    const code = stripBlockComments(readFileSync(ROUTE_FILE, "utf8"));
    const callMatch = code.match(/listTeamProjects\(\{([^}]*)\}\)/);
    expect(callMatch).not.toBeNull();
    expect(callMatch![1]).not.toMatch(/\buid\b/);
  });
});

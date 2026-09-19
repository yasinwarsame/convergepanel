/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B-C1 — the concealment invariant.
 *
 * THE PROPERTY: the server deliberately refuses to tell an unauthorized caller
 * whether a Team Workspace or Project exists. Several structurally different
 * denials — no membership, membership removed, rollout not admitted, Workspace
 * malformed, Project absent, Project archived, capability missing — are all
 * concealed behind one answer. That concealment is only real if the CLIENT also
 * renders them indistinguishably; a mapper that says "This Project is archived"
 * hands back exactly the existence oracle the server just closed.
 *
 * WHY THIS FILE EXISTS: an independent review proved the property was
 * unguarded. Giving `team_workspace_not_found`, `project_not_found` and
 * `project_archived` their own existence-revealing sentences broke **zero** of
 * 199 tests. `tsc` enforces that the mapper's switch is EXHAUSTIVE, which makes
 * the branch look covered; nothing enforced that the branch VALUES are
 * identical. Exhaustiveness and uniformity are different properties.
 *
 * HOW THIS AVOIDS THE TRAP IT WAS WRITTEN TO FIX: the concealment class is NOT
 * derived from the mapper's own `case` grouping. If it were, moving a code out
 * of the group into its own leaking branch would shrink the derived class and
 * the equality assertion would pass vacuously — the same "validated against
 * itself" shape that produced the rejection-code defect one round earlier. The
 * class is instead a frozen literal, cross-checked against the SERVER's own
 * concealing helpers so that server-side drift is still caught.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { teamVideoCreateRejectionCopy } from "@/components/workspace/videos/TeamVideoComposerShell";
import type { TeamVideoCreateRejectionCode } from "@/hooks/useTeamVideoVerificationCreate";

/**
 * The concealment class, frozen deliberately rather than derived from the
 * mapper. Each entry is a denial the SERVER answers without disclosing whether
 * the resource exists:
 *
 *   not_found                 dedup branch — a matched row the caller may not read
 *   insufficient_capability   403 from teamProjectAuthorizationDeniedResponse
 *   team_workspace_not_found  404 from the same helper — non-member, removed
 *                             membership, malformed Workspace, rollout denied
 *   project_not_found         404 from runProjectAssociationTargetNotFoundResponse
 *   project_archived          409 from projectArchivedTargetResponse
 */
const CONCEALED: TeamVideoCreateRejectionCode[] = [
  "not_found",
  "insufficient_capability",
  "team_workspace_not_found",
  "project_not_found",
  "project_archived",
];

describe("the concealment class renders indistinguishably", () => {
  it("every concealed denial produces byte-identical copy", () => {
    const rendered = CONCEALED.map((code) => teamVideoCreateRejectionCopy(code));
    // One canonical answer, taken from a member of the class rather than
    // re-typed here, so the assertion cannot drift from the implementation
    // while still failing the moment the members disagree with each other.
    const canonical = teamVideoCreateRejectionCopy("insufficient_capability");
    expect(new Set(rendered).size).toBe(1);
    for (const [i, copy] of rendered.entries()) {
      expect(`${CONCEALED[i]} => ${copy}`).toBe(`${CONCEALED[i]} => ${canonical}`);
    }
  });

  it("the canonical answer is a real sentence, not an empty string", () => {
    // Positive control: without this, a mapper returning "" for everything
    // would satisfy the equality assertion above.
    //
    // Deliberately NOT pinned to specific wording. This invariant protects
    // indistinguishability, not phrasing — a consistent, non-leaking reword of
    // the shared answer is a legitimate copy change and must stay green, or the
    // test starts failing for reasons that have nothing to do with concealment.
    const canonical = teamVideoCreateRejectionCopy("insufficient_capability");
    expect(canonical.trim().length).toBeGreaterThan(20);
    expect(canonical.trim().endsWith(".")).toBe(true);
  });

  it.each(CONCEALED)("%s discloses no resource state", (code) => {
    const copy = teamVideoCreateRejectionCopy(code).toLowerCase();
    // Defence in depth, scoped to the concealment class ONLY — other arms
    // legitimately say "video", "plan" or "file" because those are the
    // caller's own and actionable.
    for (const leak of [
      "archiv", // "this Project is archived"
      "does not exist",
      "could not be found",
      "no longer a member",
      "removed from",
      "permission to",
      "capabilit",
      "research.create",
      "research.organize",
      "not admitted",
      "rollout",
    ]) {
      expect(copy).not.toContain(leak);
    }
  });

  it("names neither Project nor a specific resource", () => {
    // "Workspace" survives because the one concealed answer is phrased about
    // the Workspace the caller already addressed — it asserts nothing about
    // existence. "Project" must not appear at all: mentioning it would confirm
    // the Project in the URL is a real, distinguishable thing.
    for (const code of CONCEALED) {
      expect(teamVideoCreateRejectionCopy(code).toLowerCase()).not.toContain("project");
    }
  });
});

/**
 * COMPLETENESS — the other half of the invariant.
 *
 * The frozen list above is deliberately not derived from the mapper, so it
 * cannot shrink when a branch is mutated. But that same property means it could
 * be edited down by hand — delete one entry and the equality assertion happily
 * compares the remaining four. Proven: removing `not_found` from the table left
 * 9/9 green with production untouched.
 *
 * So the table is checked in the OPPOSITE direction, against the mapper's own
 * structure: every code the mapper actually routes to the canonical answer must
 * appear in the table, and nothing else may. The two derivations cross-check
 * each other — the frozen table catches a branch gaining unique copy, and the
 * source-derived set catches the table being trimmed or the mapper quietly
 * concealing something new.
 */
describe("the concealment class is complete", () => {
  const MAPPER = "components/workspace/videos/TeamVideoComposerShell.tsx";
  const src = readFileSync(join(process.cwd(), MAPPER), "utf8");
  const fn = src.slice(src.indexOf("export function teamVideoCreateRejectionCopy"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  /** Every `case "x": [case "y": ...] return "copy";` group in the mapper. */
  function groups(): { codes: string[]; copy: string }[] {
    const out: { codes: string[]; copy: string }[] = [];
    let pending: string[] = [];
    for (const line of body.split("\n")) {
      const c = /^\s*case\s+"([a-z_]+)":\s*$/.exec(line);
      if (c) {
        pending.push(c[1]);
        continue;
      }
      const r = /^\s*return\s+(["`])([\s\S]*?)\1;\s*$/.exec(line);
      if (r && pending.length > 0) {
        out.push({ codes: pending, copy: r[2] });
        pending = [];
      }
    }
    return out;
  }

  it("parses the mapper it claims to parse", () => {
    // Positive control: a failed slice or a changed shape would otherwise make
    // every assertion below pass against an empty set.
    const g = groups();
    expect(body).toContain("export function teamVideoCreateRejectionCopy");
    expect(g.length).toBeGreaterThan(5);
    expect(g.flatMap((x) => x.codes)).toEqual(expect.arrayContaining(CONCEALED));
  });

  it("every code the mapper conceals is in the table, and nothing else is", () => {
    const canonical = teamVideoCreateRejectionCopy("insufficient_capability");
    const derived = groups()
      .filter((g) => g.copy === canonical)
      .flatMap((g) => g.codes)
      .sort();
    expect(derived).toEqual([...CONCEALED].sort());
  });
});

/**
 * Drift detection. The frozen list above cannot shrink under a client-side
 * mutation — that is the point — but it could go stale if the SERVER starts
 * concealing a denial the client does not yet know to conceal. So the class is
 * cross-checked against the route's own concealing helpers.
 */
describe("the concealment class still matches what the server conceals", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const ROUTE = "app/api/workspaces/[workspaceId]/video-verifications/route.ts";

  /**
   * The helpers the route uses for a denial it refuses to explain. Read from
   * the modules the route ACTUALLY imports — `invalidRequestBodyResponse` and
   * friends live in a different module with identically named exports, so the
   * import line is the only reliable source of that mapping.
   */
  const CONCEALING_HELPERS = [
    "teamProjectAuthorizationDeniedResponse",
    "runProjectAssociationTargetNotFoundResponse",
    "projectArchivedTargetResponse",
  ];
  const HELPER_SOURCES = ["lib/projects/teamProjectErrorResponse.ts", "lib/projects/projectErrorResponse.ts"];

  const routeSrc = read(ROUTE);
  const helperSrc = HELPER_SOURCES.map(read).join("\n");

  function helperBody(name: string): string {
    const at = helperSrc.indexOf(`export function ${name}`);
    return at < 0 ? "" : helperSrc.slice(at, helperSrc.indexOf("\n}", at));
  }

  it("reads helpers the route genuinely reaches", () => {
    // Positive control: a silently-empty read would make the assertion below
    // pass with an empty set.
    for (const h of CONCEALING_HELPERS) {
      expect(helperBody(h).length).toBeGreaterThan(20);
      expect(routeSrc).toContain(`${h}(`);
    }
  });

  it("every code those helpers emit is in the client's concealment class", () => {
    const emitted = new Set<string>();
    for (const h of CONCEALING_HELPERS) {
      for (const m of helperBody(h).matchAll(/errorCode:\s*"([a-z_]+)"/g)) {
        emitted.add(m[1]);
      }
    }
    expect(emitted.size).toBeGreaterThan(2);
    const unconcealed = [...emitted].filter((c) => !CONCEALED.includes(c as TeamVideoCreateRejectionCode));
    expect(unconcealed).toEqual([]);
  });
});

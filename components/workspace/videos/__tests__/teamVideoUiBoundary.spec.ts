/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AE/§AF/§AG — the structural boundaries of the
 * Team Video UI, asserted at the SOURCE level so they survive any rewrite of
 * the behavioural mocks:
 *
 *   - no creation surface anywhere in I2;
 *   - no Personal Video wrapper, endpoint or export affordance;
 *   - the pure shared result view is mounted directly, with no actionsSurface;
 *   - no R5-I1 backend, index or Personal production file is touched.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const UI_FILES = [
  "components/workspace/videos/TeamWorkspaceVideosShell.tsx",
  "components/workspace/videos/TeamVideoListRow.tsx",
  "components/workspace/videos/TeamVideoDetailShell.tsx",
  "hooks/useTeamVideoVerificationList.ts",
  "hooks/useTeamVideoVerification.ts",
  "lib/workspaces/teamVideoDetailHref.ts",
  "app/workspace/team/[workspaceId]/videos/page.tsx",
  "app/workspace/team/[workspaceId]/videos/[verificationId]/page.tsx",
  "app/workspace/team/[workspaceId]/projects/[projectId]/videos/[verificationId]/page.tsx",
];

describe("no creation surface exists in R5-I2", () => {
  it.each(UI_FILES)("%s offers no upload or create affordance", (p) => {
    const code = stripComments(read(p));
    for (const forbidden of ["VideoUploader", "videos/new", "New Video", "Upload Video", "Verify Video", "Verify another", "extractFramesInBrowser"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("no create ROUTE was added", () => {
    expect(existsSync(join(process.cwd(), "app/workspace/team/[workspaceId]/videos/new"))).toBe(false);
    expect(existsSync(join(process.cwd(), "app/workspace/team/[workspaceId]/projects/[projectId]/videos/new"))).toBe(false);
  });

  it("the Workspace Videos shell takes no create capability hint at all", () => {
    const code = stripComments(read("components/workspace/videos/TeamWorkspaceVideosShell.tsx"));
    expect(code).not.toContain("canCreate");
    expect(code).not.toContain("research.create");
  });

  it("the Project Videos section renders no create control", () => {
    const shell = read("components/workspace/projects/TeamProjectDetailShell.tsx");
    const section = shell.slice(shell.indexOf('data-testid="team-project-videos-section"'));
    expect(section).not.toContain("New Video");
    expect(section).not.toContain("teamVideoCreateHref");
  });
});

describe("the Personal Video boundary", () => {
  it.each(UI_FILES)("%s never reaches a Personal endpoint", (p) => {
    const code = stripComments(read(p));
    expect(code).not.toContain("/api/user/");
    expect(code).not.toContain("/api/verify-video");
    expect(code).not.toContain("run-governance");
  });

  it("the Team detail shell mounts the PURE shared view, never the Personal wrapper", () => {
    const code = stripComments(read("components/workspace/videos/TeamVideoDetailShell.tsx"));
    expect(code).toContain('import VideoVerificationResultView from "@/components/verification/VideoVerificationResultView"');
    // The Personal wrapper's own module specifier must never be imported.
    expect(code).not.toContain('from "@/components/VideoVerificationResult"');
  });

  it("the Team detail shell passes NO actionsSurface, so no export/memo/verify-another appears", () => {
    const code = stripComments(read("components/workspace/videos/TeamVideoDetailShell.tsx"));
    expect(code).not.toContain("actionsSurface");
    for (const forbidden of ["generateVerificationMemo", "downloadTextFile", "VerificationActions", "onVerifyAnother", "clipboard"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("governanceSurface carries ONLY the already-stored status", () => {
    const code = stripComments(read("components/workspace/videos/TeamVideoDetailShell.tsx"));
    expect(code).toContain("governanceSurface");
    expect(code).toContain("payload.governanceStatus");
    expect(code).toContain("GovernanceChip");
    // A live lookup would need a transport; the shell has none.
    expect(code).not.toContain("authedFetch");
    expect(code).not.toContain("fetch(");
  });

  it("the tolerant stored detail mapper is never used to validate transport data", () => {
    for (const p of ["hooks/useTeamVideoVerificationList.ts", "hooks/useTeamVideoVerification.ts"]) {
      expect(stripComments(read(p))).not.toContain("mapStoredVideoVerificationToClientPayload");
    }
  });
});

describe("Team reads use the canonical R5-I1 endpoints only", () => {
  it("the list hook targets the Team-native list routes", () => {
    const code = stripComments(read("hooks/useTeamVideoVerificationList.ts"));
    expect(code).toContain("/api/workspaces/${w}/video-verifications");
    expect(code).toContain("/projects/${encodeURIComponent(address.projectId)}/video-verifications");
  });

  it("the detail hook targets the Team-native detail route via the shared builder", () => {
    const code = stripComments(read("hooks/useTeamVideoVerification.ts"));
    expect(code).toContain("teamVideoDetailApiUrl");
  });

  it.each(["hooks/useTeamVideoVerificationList.ts", "hooks/useTeamVideoVerification.ts"])("%s is read-only: GET, no-store, no mutation verb", (p) => {
    const code = stripComments(read(p));
    expect(code).toContain('method: "GET"');
    expect(code).toContain('cache: "no-store"');
    for (const verb of ['method: "POST"', 'method: "PUT"', 'method: "PATCH"', 'method: "DELETE"']) {
      expect(code).not.toContain(verb);
    }
  });

  it("neither hook encodes identity, role or capability into a request", () => {
    for (const p of ["hooks/useTeamVideoVerificationList.ts", "hooks/useTeamVideoVerification.ts"]) {
      const code = stripComments(read(p));
      for (const forbidden of ["params.set(\"uid\"", "params.set(\"role\"", "params.set(\"capability\"", "encodeURIComponent(uid)"]) {
        expect(code).not.toContain(forbidden);
      }
    }
  });
});

describe("no server or index file was reopened", () => {
  const FROZEN = [
    "app/api/workspaces/[workspaceId]/video-verifications/route.ts",
    "app/api/workspaces/[workspaceId]/projects/[projectId]/video-verifications/route.ts",
    "app/api/workspaces/[workspaceId]/video-verifications/[verificationId]/route.ts",
    "lib/workspaces/listTeamVideoVerifications.ts",
    "lib/workspaces/teamVideoVerificationResponse.ts",
    "lib/workspaces/teamVideoVerificationSummary.ts",
    "lib/workspaces/teamVideoVerificationsCursor.ts",
    "lib/workspaces/teamVideoVerificationRowValidation.ts",
    "lib/firestore/teamVideoVerifications.ts",
  ];

  it.each(FROZEN)("%s still exists and still carries its R5-I1 marker", (p) => {
    const src = read(p);
    expect(src.length).toBeGreaterThan(0);
    // R5-I2 is UI-only, so these files must still describe themselves as the
    // backend slice — a rewrite for UI convenience would show up here.
    expect(src).toMatch(/R5-I1|8C-E\.3\.3/);
  });

  it("the two Workspace Video index definitions are untouched", () => {
    const idx = JSON.parse(read("firestore.indexes.json")) as { indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order: string }> }> };
    const shapes = idx.indexes
      .filter((i) => i.collectionGroup === "videoVerifications")
      .map((i) => i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(","));
    expect(shapes).toContain("workspaceId:ASCENDING,timestamp:DESCENDING");
    expect(shapes).toContain("workspaceId:ASCENDING,projectId:ASCENDING,timestamp:DESCENDING");
    expect(shapes).toContain("FileName:ASCENDING,userId:ASCENDING,timestamp:DESCENDING");
    expect(shapes).toHaveLength(5);
  });
});

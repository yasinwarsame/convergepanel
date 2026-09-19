/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the creation boundary, asserted at the
 * SOURCE level so the I3-A split stays mechanically enforced now that a second
 * consumer exists.
 *
 * I3-A proved "the shared surface names no endpoint" with one wrapper in the
 * repository. The claim only becomes load-bearing when a SECOND wrapper lands,
 * because that is when someone could be tempted to teach the shared surface
 * about Workspaces. These assertions are the mirrored half the I3-A boundary
 * suite was written to gain: Personal owns exactly one endpoint, Team owns
 * exactly one endpoint, and neither is the other's.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const SURFACE = "components/verification/VideoUploaderSurface.tsx";
const CONTRACT = "lib/verification/videoUploadClientContract.ts";
const PERSONAL = "components/VideoUploader.tsx";
const TEAM_HOOK = "hooks/useTeamVideoVerificationCreate.ts";
const TEAM_SHELL = "components/workspace/videos/TeamVideoComposerShell.tsx";
const CREATE_HREF = "lib/workspaces/teamVideoCreateHref.ts";

describe("the shared surface stayed transport-neutral after a second consumer arrived", () => {
  const code = stripComments(read(SURFACE));

  it.each(["/api/verify-video", "/api/workspaces", "authedFetch", "getIdToken", "Authorization", "workspaceId", "projectId", "useAuth", "firebase"])(
    "still names no %s",
    (forbidden) => {
      expect(code).not.toContain(forbidden);
    }
  );

  it("still issues no network call of its own", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("still reaches the transport only through the injected callback", () => {
    expect(code).toContain("await submitPreparedVideo(prepared)");
  });
});

describe("the prepared-upload contract gained no Team concept", () => {
  const code = stripComments(read(CONTRACT));

  it.each(["workspaceId", "projectId", "token", "endpoint", "capabilit", "authedFetch", "admission"])("declares no %s", (forbidden) => {
    expect(code).not.toContain(forbidden);
  });

  it("is still types only", () => {
    expect(code).not.toContain("useState");
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("each wrapper owns exactly one endpoint", () => {
  const personal = stripComments(read(PERSONAL));
  const team = stripComments(read(TEAM_HOOK));

  it("Personal still posts to /api/verify-video", () => {
    expect(personal).toContain('"/api/verify-video"');
    expect(personal).toContain('method: "POST"');
  });

  it("Personal still reaches no Team endpoint", () => {
    expect(personal).not.toContain("/api/workspaces");
    expect(personal).not.toContain("workspaceId");
    expect(personal).not.toContain("projectId");
  });

  it("Team posts to the canonical Team Video collection", () => {
    expect(team).toContain("/api/workspaces/${encodeURIComponent(address.workspaceId)}/video-verifications");
    expect(team).toContain('method: "POST"');
  });

  it("Team NEVER names the Personal endpoint — no fallback, no reuse", () => {
    expect(team).not.toContain("/api/verify-video");
    expect(stripComments(read(TEAM_SHELL))).not.toContain("/api/verify-video");
  });

  it("Team owns its own authenticated identity", () => {
    expect(team).toContain("useAuth");
    expect(team).toContain("authedFetch");
  });
});

describe("W1 at the source level: the Team layer never enriches the prepared value", () => {
  const team = stripComments(read(TEAM_HOOK));

  it("routes every body through the single choke point", () => {
    expect(team).toContain("buildTeamVideoRequestBody(prepared, expectedProjectId)");
    // Exactly one place builds a body.
    expect(team.match(/JSON\.stringify\(/g) ?? []).toHaveLength(1);
  });

  it("never spreads the prepared value wholesale into a request", () => {
    // `...prepared` would carry every future field of the contract onto the wire
    // and make the choke point's field list meaningless.
    expect(team).not.toContain("...prepared");
  });

  it("never assigns onto the prepared value or its metadata", () => {
    expect(team).not.toMatch(/prepared\.[A-Za-z]+\s*=/);
    expect(team).not.toContain("Object.assign(prepared");
  });

  it("the shell hands the prepared value straight to the transport", () => {
    expect(stripComments(read(TEAM_SHELL))).toContain("await submit(prepared)");
  });
});

describe("the create address is built in one place", () => {
  const href = stripComments(read(CREATE_HREF));
  const shell = stripComments(read(TEAM_SHELL));

  it("is pure — no React, no network, no authorization", () => {
    for (const forbidden of ["useState", "fetch(", "capabilit", "uid"]) {
      expect(href).not.toContain(forbidden);
    }
  });

  it("encodes both segments", () => {
    expect(href).toContain("encodeURIComponent(args.workspaceId)");
    expect(href).toContain("encodeURIComponent(args.projectId)");
  });

  it("the composer navigates only through the canonical detail builder", () => {
    expect(shell).toContain("teamVideoDetailHref(");
    // No hand-assembled result route anywhere in the composer.
    expect(shell).not.toMatch(/`\/workspace\/team\/\$\{[^}]+\}\/videos\/\$\{/);
  });

  it("the composer never pushes — a submitted form must not stay in history", () => {
    expect(shell).toContain("router.replace(");
    expect(shell).not.toContain("router.push(");
  });
});

describe("no Personal-only concept leaked into the Team surface", () => {
  const shell = stripComments(read(TEAM_SHELL));

  it("names no Personal transport or copy", () => {
    for (const forbidden of ["/api/verify-video", "mergeApiSuccessToPayload", "personalVideoUploadErrorPresentation", "free plan"]) {
      expect(shell).not.toContain(forbidden);
    }
  });

  it("renders the shared surface rather than its own uploader markup", () => {
    expect(shell).toContain("VideoUploaderSurface");
    for (const moved of ["extractFramesInBrowser", "video-verification-acknowledged", "dragActive", "createObjectURL"]) {
      expect(shell).not.toContain(moved);
    }
  });
});

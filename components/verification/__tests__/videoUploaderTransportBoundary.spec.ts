/**
 * TEAM-VERIFICATION-PARITY-R5-I3-A §U — the transport boundary, asserted at the
 * SOURCE level so the split stays mechanically reviewable.
 *
 * The shared surface must name no endpoint and no identity; the Personal
 * wrapper must own exactly one endpoint and must never reach a Team one. In
 * R5-I3-B a Team wrapper joins this file with the mirrored assertion, at which
 * point "Team never posts to /api/verify-video" is one line rather than a
 * review convention.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments describe what the code must NOT do, so they are stripped first. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const SURFACE = "components/verification/VideoUploaderSurface.tsx";
const CONTRACT = "lib/verification/videoUploadClientContract.ts";
const PERSONAL = "components/VideoUploader.tsx";

describe("the shared surface is transport-neutral", () => {
  const code = stripComments(read(SURFACE));

  it.each([
    "/api/verify-video",
    "/api/workspaces",
    "/api/user/",
    "authedFetch",
    "getIdToken",
    "Authorization",
    "workspaceId",
    "projectId",
    "useAuth",
    "firebase",
  ])("names no %s", (forbidden) => {
    expect(code).not.toContain(forbidden);
  });

  it("issues no network call of its own", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain("XMLHttpRequest");
  });

  it("reaches the transport only through the injected callback", () => {
    expect(code).toContain("submitPreparedVideo");
    expect(code).toContain("await submitPreparedVideo(prepared)");
  });

  it("still owns the browser preparation it was given", () => {
    for (const owned of ["extractFramesInBrowser", "extractMp4Metadata", "video-verification-acknowledged", "submittingRef"]) {
      expect(code).toContain(owned);
    }
  });

  it("handles all three transport-neutral outcomes and inspects no HTTP status", () => {
    expect(code).toContain('outcome.status === "ok"');
    expect(code).toContain('outcome.status === "rejected"');
    // Anchored on status INSPECTION, not on bare numbers: the progress interval
    // is 500ms and Tailwind emits `duration-500`, so a numeric scan would fail
    // for reasons that have nothing to do with transport.
    for (const httpish of ["res.status", "response.status", "statusCode", "res.ok", "response.ok", ".json()"]) {
      expect(code).not.toContain(httpish);
    }
  });
});

describe("the prepared-upload contract carries no context", () => {
  const code = stripComments(read(CONTRACT));

  it.each(["workspaceId", "projectId", "token", "endpoint", "capabilit", "authedFetch"])("declares no %s", (forbidden) => {
    expect(code).not.toContain(forbidden);
  });

  it("is types only — no React, no network, no storage", () => {
    expect(code).not.toContain("useState");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain("localStorage");
  });
});

describe("the Personal wrapper owns exactly one endpoint", () => {
  const code = stripComments(read(PERSONAL));

  it("posts to the Personal endpoint", () => {
    expect(code).toContain('"/api/verify-video"');
    expect(code).toContain('method: "POST"');
  });

  it("never reaches a Team endpoint", () => {
    expect(code).not.toContain("/api/workspaces/");
    expect(code).not.toContain("workspaceId");
    expect(code).not.toContain("projectId");
  });

  it("owns Personal identity and the Personal success mapper", () => {
    for (const owned of ["useAuth", "getIdToken", "mergeApiSuccessToPayload"]) {
      expect(code).toContain(owned);
    }
  });

  it("renders the shared surface rather than its own uploader markup", () => {
    expect(code).toContain("VideoUploaderSurface");
    // The presentation moved out wholesale: none of it should remain here.
    for (const moved of ["extractFramesInBrowser", "video-verification-acknowledged", "dragActive", "createObjectURL"]) {
      expect(code).not.toContain(moved);
    }
  });

  it("keeps its public prop contract unchanged", () => {
    for (const prop of ["plan", "videoLimit", "videoRunsThisMonth", "onSuccess", "onUsageRefresh"]) {
      expect(code).toContain(prop);
    }
    expect(code).toContain("export default function VideoUploader");
  });
});

describe("no Team creation surface exists yet", () => {
  it.each([SURFACE, CONTRACT, PERSONAL])("%s adds no Team create affordance", (p) => {
    const code = stripComments(read(p));
    for (const forbidden of ["videos/new", "New Video", "useTeamVideoVerificationCreate", "TeamVideoComposer", "video-verifications"]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

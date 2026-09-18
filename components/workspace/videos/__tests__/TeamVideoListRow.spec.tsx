/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AM — the pure Team Video list row.
 *
 * The row is hookless and prop-driven, so `renderToStaticMarkup` exercises its
 * real render logic directly. The routing assertions matter most: the
 * destination must come from the ROW's own `projectId`, never from the page
 * scope that happens to be rendering it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamVideoListRow, teamVideoVerdictLabel } from "@/components/workspace/videos/TeamVideoListRow";
import type { TeamVideoListItem } from "@/hooks/useTeamVideoVerificationList";

const W = "ws-1";
const P = "proj-1";

function item(over: Partial<TeamVideoListItem> = {}): TeamVideoListItem {
  return {
    verificationId: "vid-1",
    fileName: "quarterly-briefing.mp4",
    verdict: "authentic_captured",
    contentType: "camera_footage",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    frameCount: 8,
    createdAt: "2026-09-10T10:00:00.000Z",
    workspaceId: W,
    projectId: null,
    project: null,
    ...over,
  };
}
const filed = (over: Partial<TeamVideoListItem> = {}) => item({ projectId: P, project: { id: P, name: "Launch", status: "active" }, ...over });

const render = (i: TeamVideoListItem, showProject = true) => renderToStaticMarkup(createElement(TeamVideoListRow, { workspaceId: W, item: i, showProject }));

describe("canonical routing comes from the row's own binding", () => {
  it("an Unfiled row opens the Workspace Unfiled detail address", () => {
    expect(render(item())).toContain('href="/workspace/team/ws-1/videos/vid-1"');
  });

  it("a filed row opens the PROJECT detail address, even in a Workspace-wide list", () => {
    const html = render(filed());
    expect(html).toContain('href="/workspace/team/ws-1/projects/proj-1/videos/vid-1"');
    expect(html).not.toContain('href="/workspace/team/ws-1/videos/vid-1"');
  });

  it("a filed row in a Project section resolves to the same Project address", () => {
    expect(render(filed(), false)).toContain('href="/workspace/team/ws-1/projects/proj-1/videos/vid-1"');
  });

  it("never links to a Personal or API route", () => {
    for (const i of [item(), filed()]) {
      const html = render(i);
      expect(html).not.toContain("/api/");
      expect(html).not.toContain("verify-video");
    }
  });
});

describe("verdict labels", () => {
  it.each([
    ["authentic_captured", "Authentic camera footage"],
    ["authentic_produced", "Legitimately produced"],
    ["likely_manipulated", "Likely manipulated"],
    ["inconclusive", "Inconclusive"],
    ["insufficient", "Insufficient data"],
    ["authentic", "Authentic"],
  ] as const)("%s renders as %s", (verdict, label) => {
    expect(teamVideoVerdictLabel(verdict)).toBe(label);
    expect(render(item({ verdict }))).toContain(label);
  });

  it("the legacy verdict is displayable, not treated as corrupt", () => {
    expect(render(item({ verdict: "authentic" }))).toContain("Authentic");
  });
});

describe("summary presentation", () => {
  it("shows the file name, consensus, confidence, evidence and frame count", () => {
    const html = render(item());
    expect(html).toContain("quarterly-briefing.mp4");
    expect(html).toContain("88/100 consensus");
    expect(html).toContain("High confidence");
    expect(html).toContain("Strong evidence");
    expect(html).toContain("8 frames");
  });

  it("uses a singular frame label for exactly one frame", () => {
    expect(render(item({ frameCount: 1 }))).toContain("1 frame");
    expect(render(item({ frameCount: 1 }))).not.toContain("1 frames");
  });

  it("renders the persisted governance chip only when a status exists", () => {
    // The shared GovernanceChip renders a short label plus an aria-label; the
    // raw stored token is never printed.
    expect(render(item({ governanceStatus: "needs_review" }))).toContain('aria-label="Governance: Review"');
    expect(render(item({ governanceStatus: "approved" }))).toContain("Governance:");
    const plain = render(item());
    expect(plain).not.toContain("Governance:");
  });

  it("renders the created date", () => {
    expect(render(item())).toContain('data-testid="team-video-row-created"');
  });
});

describe("Project labelling", () => {
  it("a Workspace-wide list labels an Unfiled row", () => {
    expect(render(item(), true)).toContain("Unfiled");
  });

  it("a Workspace-wide list names the Project of a filed row", () => {
    expect(render(filed(), true)).toContain("Launch");
  });

  it("a non-active Project shows an Archived indicator", () => {
    expect(render(filed({ project: { id: P, name: "Launch", status: "archived" } }), true)).toContain("Archived");
  });

  it("an active Project shows no Archived indicator", () => {
    expect(render(filed(), true)).not.toContain("Archived");
  });

  it("a Project's own section does not repeat the Project name", () => {
    const html = render(filed(), false);
    expect(html).not.toContain("Launch");
    expect(html).not.toContain("Unfiled");
  });
});

describe("disclosure", () => {
  it("never renders uploader, membership, evidence or accounting data", () => {
    const html = render(filed({ governanceStatus: "approved" }));
    for (const forbidden of ["userId", "userEmail", "uploader", "creator", "membership", "capabilit", "modelResults", "modelEvidence", "totalTokens", "supportRatio", "metadata"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("is a pure component: no hooks, no fetch, no storage in its source", () => {
    const src = require("fs").readFileSync(require("path").join(process.cwd(), "components/workspace/videos/TeamVideoListRow.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const forbidden of ["useState", "useEffect", "useAuth", "fetch(", "authedFetch", "localStorage", "sessionStorage"]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

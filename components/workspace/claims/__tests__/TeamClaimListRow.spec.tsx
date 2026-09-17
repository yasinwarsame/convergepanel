/**
 * TEAM-VERIFICATION-PARITY-R4-I2 §AE — `TeamClaimListRow`.
 *
 * The row is pure, and `teamClaimDetailHref` + `GovernanceChip` are REAL, so
 * these assertions are about the two things that actually matter: where a row
 * navigates, and what it is allowed to disclose.
 */

import { createElement } from "react";
import TestRenderer from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, ...rest }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className, ...rest }, children as never),
}));

import { TeamClaimListRow, teamClaimVerdictLabel } from "@/components/workspace/claims/TeamClaimListRow";
import type { TeamClaimListItem } from "@/hooks/useTeamClaimVerificationList";

const W = "ws-1";
const P = "proj-1";

function item(over: Partial<TeamClaimListItem> = {}): TeamClaimListItem {
  return {
    verificationId: "vcl-1",
    claim: "The sky is blue.",
    verdict: "confirmed",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    createdAt: "2026-09-10T10:00:00.000Z",
    workspaceId: W,
    projectId: null,
    project: null,
    ...over,
  };
}
const filed = (over: Partial<TeamClaimListItem> = {}) => item({ projectId: P, project: { id: P, name: "Launch Plan", status: "active" }, ...over });

function render(props: { item: TeamClaimListItem; showProject?: boolean }) {
  return TestRenderer.create(createElement(TeamClaimListRow, { workspaceId: W, item: props.item, showProject: props.showProject ?? true }));
}
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const href = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "a")[0].props.href as string;
function testIdText(r: TestRenderer.ReactTestRenderer, id: string): string {
  const nodes = r.root.findAll((n) => n.props?.["data-testid"] === id);
  return nodes.length === 0 ? "" : JSON.stringify(nodes[0].children);
}

describe("canonical routing", () => {
  it("links an Unfiled row to the Unfiled detail address", () => {
    expect(href(render({ item: item() }))).toBe("/workspace/team/ws-1/claims/vcl-1");
  });

  it("links a Project-bound row to its PROJECT detail address, never the Unfiled one", () => {
    const h = href(render({ item: filed() }));
    expect(h).toBe("/workspace/team/ws-1/projects/proj-1/claims/vcl-1");
    expect(h).not.toBe("/workspace/team/ws-1/claims/vcl-1");
  });

  it("encodes every segment through the shared href builder", () => {
    const h = href(render({ item: filed({ verificationId: "v/1", projectId: "p 1", project: { id: "p 1", name: "X", status: "active" } }) }));
    expect(h).toBe("/workspace/team/ws-1/projects/p%201/claims/v%2F1");
  });

  it("never links to a Personal route", () => {
    for (const it of [item(), filed()]) {
      const h = href(render({ item: it }));
      expect(h).not.toContain("/workspace/research/");
      expect(h).not.toContain("?tab=verify");
      expect(h.startsWith("/workspace/team/ws-1/")).toBe(true);
    }
  });
});

describe("presentation", () => {
  it("shows the claim, verdict, consensus, confidence and evidence quality", () => {
    const r = render({ item: item({ verdict: "partially_true", consensusScore: 64, confidenceLabel: "Medium", evidenceQuality: "mixed" }) });
    expect(testIdText(r, "team-claim-row-claim")).toContain("The sky is blue.");
    expect(text(r)).toContain("Partially true");
    expect(testIdText(r, "team-claim-row-consensus")).toContain("64");
    expect(testIdText(r, "team-claim-row-confidence")).toContain("Medium");
    expect(testIdText(r, "team-claim-row-evidence")).toContain("Mixed evidence");
  });

  it("renders the created date through the shared absolute formatter, never a raw ISO string", () => {
    const r = render({ item: item() });
    expect(testIdText(r, "team-claim-row-created")).not.toContain("2026-09-10T10:00:00.000Z");
    expect(testIdText(r, "team-claim-row-created")).not.toBe("");
  });

  it("renders the stored governance chip when a status exists", () => {
    expect(text(render({ item: item({ governanceStatus: "needs_review" }) }))).toContain("Review");
  });

  it("renders no governance chip when the status is absent", () => {
    const rendered = text(render({ item: item() }));
    expect(rendered).not.toContain("Governance:");
    expect(rendered).not.toContain("Approved");
    expect(rendered).not.toContain("Blocked");
  });

  it("labels a Workspace-wide Unfiled row `Unfiled`", () => {
    expect(testIdText(render({ item: item() }), "team-claim-row-project")).toContain("Unfiled");
  });

  it("labels a Workspace-wide filed row with its Project name", () => {
    expect(testIdText(render({ item: filed() }), "team-claim-row-project")).toContain("Launch Plan");
  });

  it("marks an archived Project", () => {
    expect(text(render({ item: filed({ project: { id: P, name: "Launch Plan", status: "archived" } }) }))).toContain("Archived");
  });

  it("omits the Project label inside a Project's own section", () => {
    const r = render({ item: filed(), showProject: false });
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claim-row-project")).toHaveLength(0);
    expect(text(r)).not.toContain("Launch Plan");
  });

  it("matches the detail view's verdict casing exactly", () => {
    expect(teamClaimVerdictLabel("confirmed")).toBe("Confirmed");
    expect(teamClaimVerdictLabel("disputed")).toBe("Disputed");
    expect(teamClaimVerdictLabel("partially_true")).toBe("Partially true");
    expect(teamClaimVerdictLabel("unverifiable")).toBe("Unverifiable");
  });
});

describe("disclosure boundary", () => {
  it("renders no creator, reviewer, raw id, model evidence or token usage", () => {
    const polluted = {
      ...filed(),
      // Fields a future server change might add — the row must ignore them.
      userId: "uid-creator",
      reviewerUid: "uid-reviewer",
      modelEvidence: [{ modelId: "chatgpt" }],
      auditBundle: { generatedAt: "x" },
      usage: { totalTokens: 1234 },
      origin: { runId: "run-secret" },
    } as unknown as TeamClaimListItem;
    const rendered = text(render({ item: polluted }));
    for (const forbidden of ["uid-creator", "uid-reviewer", "chatgpt", "auditBundle", "1234", "run-secret"]) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});

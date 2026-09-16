/**
 * TEAM-RESEARCH-PARITY-R3-R1 §K/§L — `TeamResearchReviewSummary`: the Team's
 * read-only review presentation. Presentation only; no fetch, no auth, no
 * mutation, no reviewer identity, and no Workspace review deep link (deferred:
 * Approval Workflow admission and reviews.read are not in the R1 Team DTO).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import TeamResearchReviewSummary from "@/components/workspace/projects/TeamResearchReviewSummary";
import type { TeamRunDetailReview } from "@/lib/research/teamRunDetailPresentation";

const CODE = readFileSync(join(process.cwd(), "components/workspace/projects/TeamResearchReviewSummary.tsx"), "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function render(review: TeamRunDetailReview | null) {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(createElement(TeamResearchReviewSummary, { review }));
  });
  return r;
}
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());

describe("TeamResearchReviewSummary", () => {
  it("renders the human-review status label, the conditions and the decision receipt conclusion + flags", () => {
    const r = render({ humanReviewStatus: "approved_with_conditions", conditions: ["Cite sources", "Limit scope"], decidedVia: "workspace_review", decisionReceipt: { conclusion: "Proceed with pilot", sourceBacked: true, humanReviewNeeded: false } });
    const t = text(r);
    expect(t).toContain("Approved with conditions");
    expect(t).toContain("Cite sources");
    expect(t).toContain("Limit scope");
    expect(t).toContain("Proceed with pilot");
    expect(t).toContain("Source-backed");
    expect(t).toContain("Human review not required");
  });

  it.each([
    ["unreviewed", "Awaiting review"],
    ["pending", "Under review"],
    ["approved", "Approved"],
    ["changes_requested", "Changes requested"],
    ["rejected", "Rejected"],
  ])("status %s → '%s' (the same Workspace review labels used elsewhere)", (status, label) => {
    expect(text(render({ humanReviewStatus: status, conditions: [], decidedVia: null, decisionReceipt: null }))).toContain(label);
  });

  it("partial review: no conditions and no receipt → only the status, nothing fabricated", () => {
    const t = text(render({ humanReviewStatus: "pending", conditions: [], decidedVia: null, decisionReceipt: null }));
    expect(t).toContain("Under review");
    expect(t).not.toContain("Conditions");
    expect(t).not.toContain("Decision receipt");
  });

  it("null review → renders nothing", () => {
    expect(render(null).toJSON()).toBeNull();
  });

  it("never renders the internal decidedVia enum, a reviewer identity or any link — including no Workspace review deep link", () => {
    const r = render({ humanReviewStatus: "approved", conditions: [], decidedVia: "multi_reviewer_owner_override", decisionReceipt: null });
    expect(text(r)).not.toContain("multi_reviewer_owner_override");
    expect(r.root.findAll((n) => n.type === "a")).toHaveLength(0);
    expect(CODE).not.toMatch(/\/workspace\/reviews/);
    expect(CODE).not.toMatch(/href=/);
  });

  it("is presentation-only: no fetch, no auth hook, no Firestore, no router, no mutation surface", () => {
    expect(CODE).not.toMatch(/authedFetch|fetch\(|useAuth|firebase|firestore|useRouter|next\/navigation|<button|<form|onClick/);
    const imports = CODE.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual([
      'import { getReviewStatusBadgeClass, getReviewStatusLabel } from "@/lib/workspaces/reviewQueuePresentation";',
      'import type { TeamRunDetailReview } from "@/lib/research/teamRunDetailPresentation";',
    ]);
  });
});

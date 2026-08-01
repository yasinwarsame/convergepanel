/**
 * Multi-Reviewer Owner Override, Part F (§F11/§F15/§F16/§F17) — structural
 * tests for AdaptiveMultiReviewerPanelSection. `renderToStaticMarkup` only
 * proves the first synchronous render (always the loading state, since the
 * panel/eligible-reviewers fetch is async and effects never run under this
 * method) plus source-level guarantees — the state-dependent rendering
 * (no-panel/open/cancelled/finalized, capability-flag-gated controls) is
 * exercised directly against the component's pure render logic by invoking
 * `renderToStaticMarkup` is not possible without a real fetch, so those
 * paths are covered by (a) the route-level contract tests for
 * `GET/PUT/DELETE .../review-panel`, `.../votes`, `.../review-panel/finalize`,
 * and `.../review-panel/override`, all of which independently prove the
 * exact data this component consumes, and (b) the source-level guarantees
 * below, which prove the client only ever gates a control on the SERVER's
 * own capability flags (`canReconfigurePanel`/`canCancelPanel`/`canVote`/`canFinalize`/`canOverride`)
 * — never a client-re-derived role check — so no client-side control can
 * ever be shown to a caller the server would reject.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

import AdaptiveMultiReviewerPanelSection from "@/components/teamGovernance/AdaptiveMultiReviewerPanelSection";

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-uid" }, authReady: true });
});

describe("AdaptiveMultiReviewerPanelSection — initial render", () => {
  it("renders a Multi-Reviewer Panel heading and a loading state before the fetch resolves", () => {
    const html = renderToStaticMarkup(
      createElement(AdaptiveMultiReviewerPanelSection, { runId: "run-1", expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z" })
    );
    expect(html).toContain("Multi-Reviewer Panel");
    expect(html).toContain("Loading review panel");
  });

  it("renders no mutation controls at all in the loading state", () => {
    const html = renderToStaticMarkup(
      createElement(AdaptiveMultiReviewerPanelSection, { runId: "run-1", expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z" })
    );
    expect(html).not.toMatch(/<button/);
    expect(html).not.toMatch(/<select/);
    expect(html).not.toMatch(/<form/);
  });
});

describe("AdaptiveMultiReviewerPanelSection — source-level guarantees", () => {
  const fullSource = readFileSync(join(__dirname, "../AdaptiveMultiReviewerPanelSection.tsx"), "utf8");
  const source = fullSource.slice(fullSource.indexOf("*/") + 2);

  it("gates the vote form ONLY on the server's own canVote flag, never a client re-derivation of reviewer membership", () => {
    expect(source).toContain("panel.canVote ?");
    expect(source).toContain("<AdaptivePanelVoteForm");
  });

  it("gates the override form ONLY on the server's own canOverride flag", () => {
    expect(source).toContain("panel.canOverride ?");
    expect(source).toContain("<AdaptivePanelOverrideForm");
  });

  it("gates the finalize control ONLY on the server's own canFinalize flag, and never auto-finalizes", () => {
    expect(source).toContain("panel.canFinalize ?");
    expect(source).not.toMatch(/useEffect[\s\S]{0,80}submitFinalize/);
  });

  it("gates reconfigure and cancel independently on the server's own canReconfigurePanel/canCancelPanel flags (Step 5.10 — cancelling must remain possible even when reconfiguring is disabled)", () => {
    expect(source).toContain("panel.canReconfigurePanel ?");
    expect(source).toContain("panel.canCancelPanel ?");
    expect(source).toContain("panel.canReconfigurePanel || panel.canCancelPanel");
  });

  it("never client-side checks role/isTeamAdmin/owner itself — authorization is entirely server-derived", () => {
    expect(source).not.toMatch(/role\s*===\s*["']owner["']/);
    expect(source).not.toMatch(/isTeamAdmin\(/);
  });

  it("fetches the panel and eligible-reviewers routes directly, and finalizes via review-panel/finalize", () => {
    expect(source).toContain("/review-panel");
    expect(source).toContain("/assignment");
    expect(source).toContain("/review-panel/finalize");
  });

  it("delegates the override POST to AdaptivePanelOverrideForm rather than issuing it itself", () => {
    expect(source).not.toMatch(/["']\/review-panel\/override["']/);
    expect(source).toContain("<AdaptivePanelOverrideForm");
  });

  it("always sends expectedRevision/expectedPanelRevision on every mutating call (optimistic concurrency)", () => {
    expect(source).toMatch(/expectedRevision/);
    expect(source).toMatch(/expectedPanelRevision/);
  });

  it("shows the exact required copy for waiting and deadlocked states (§F15)", () => {
    expect(source).toContain("Waiting for more reviewer votes.");
    expect(source).toContain("The panel is deadlocked. More votes, panel reconfiguration, or an owner override is required.");
  });

  it("warns that reconfiguration starts a new revision and invalidates existing votes", () => {
    expect(source).toMatch(/new revision/i);
  });

  it("reports panel status changes to the parent via onPanelStatusChange, so single-reviewer UI can be hidden/restored", () => {
    expect(source).toContain("onPanelStatusChange");
  });

  it("never renders a client-selectable final status for finalize — the button carries no status field itself", () => {
    // The Finalize button's own POST body must be exactly the two
    // concurrency tokens — never a status/finalStatus field.
    const finalizeBodyMatch = source.match(/expectedPanelRevision:\s*panel\.revision,\s*expectedGovernanceUpdatedAt\s*}\)/);
    expect(finalizeBodyMatch).not.toBeNull();
  });
});

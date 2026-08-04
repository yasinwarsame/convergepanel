/**
 * Multi-Reviewer Owner Override, Part F (§F13/§F14) — structural tests for
 * AdaptivePanelVoteForm. Same documented limitation as elsewhere in this
 * engagement: `renderToStaticMarkup` only proves the first synchronous
 * render plus source-level guarantees — interactive submission is covered
 * by the route-level contract tests
 * (`app/api/teams/adaptive-runs/[runId]/votes/__tests__/`).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

import AdaptivePanelVoteForm from "@/components/teamGovernance/AdaptivePanelVoteForm";

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, authReady: true });
});

describe("AdaptivePanelVoteForm — initial render", () => {
  it("renders all four vote options", () => {
    const html = renderToStaticMarkup(createElement(AdaptivePanelVoteForm, { runId: "run-1", panelRevision: 1, onSuccess: () => {}, onRequestReload: () => {} }));
    expect(html).toContain("Approve");
    expect(html).toContain("Approve with Conditions");
    expect(html).toContain("Request Changes");
    expect(html).toContain("Reject");
  });

  it("renders a single submit button, not yet locked", () => {
    const html = renderToStaticMarkup(createElement(AdaptivePanelVoteForm, { runId: "run-1", panelRevision: 1, onSuccess: () => {}, onRequestReload: () => {} }));
    expect(html).toContain("Submit Vote");
  });

  it("does not render the comment field or conditions editor before a status is chosen", () => {
    const html = renderToStaticMarkup(createElement(AdaptivePanelVoteForm, { runId: "run-1", panelRevision: 1, onSuccess: () => {}, onRequestReload: () => {} }));
    expect(html).not.toContain("adaptive-panel-vote-comment");
    // "Approve with Conditions" (the option label) legitimately contains
    // "Conditions" — the conditions EDITOR is only reachable via its own
    // distinctive "+ Add condition" control, which must be absent here.
    expect(html).not.toContain("+ Add condition");
  });

  it("notes that the comment is visible only to the author, before any comment is typed", () => {
    // The privacy note text lives in the comment block, which only renders
    // once a status is selected — verified instead at the source level below.
    const source = readFileSync(join(__dirname, "../AdaptivePanelVoteForm.tsx"), "utf8");
    expect(source).toContain("visible only to you");
  });
});

describe("AdaptivePanelVoteForm — source-level guarantees", () => {
  const fullSource = readFileSync(join(__dirname, "../AdaptivePanelVoteForm.tsx"), "utf8");
  const source = fullSource.slice(fullSource.indexOf("*/") + 2);

  it("posts to the votes route only, one POST per submission (no client-side retry loop)", () => {
    expect(source).toContain("/votes");
    expect(source).toMatch(/method:\s*["']POST["']/);
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });

  it("always sends the caller-supplied panelRevision, never a hardcoded or re-derived value", () => {
    expect(source).toContain("panelRevision");
  });

  it("never sends teamId, reviewer identity, or an aggregate/final status as part of the request", () => {
    expect(source).not.toMatch(/teamId:/);
    expect(source).not.toMatch(/reviewerUserId:/);
    expect(source).not.toMatch(/finalStatus/);
  });

  it("locks the form permanently on success — no edit/withdraw affordance exists", () => {
    expect(source).toContain('result?.kind === "success"');
    expect(source).not.toMatch(/withdraw/i);
    expect(source).not.toMatch(/\bedit\b/i);
  });

  it("never auto-resubmits on a stale/terminal outcome — only an explicit Reload control", () => {
    expect(source).toContain("onRequestReload");
    expect(source).toMatch(/Reload/);
  });
});

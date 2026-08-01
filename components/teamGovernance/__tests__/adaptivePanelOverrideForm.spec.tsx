/**
 * Multi-Reviewer Owner Override, Part F (§F17/§F18/§F19) — structural
 * tests for AdaptivePanelOverrideForm.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

import AdaptivePanelOverrideForm from "@/components/teamGovernance/AdaptivePanelOverrideForm";

const BASE_PROPS = {
  runId: "run-1",
  expectedPanelRevision: 1,
  expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
  onSuccess: () => {},
  onRequestReload: () => {},
};

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-uid" }, authReady: true });
});

describe("AdaptivePanelOverrideForm — initial render", () => {
  it("renders an Owner Override heading and a warning that it bypasses the panel's vote", () => {
    const html = renderToStaticMarkup(createElement(AdaptivePanelOverrideForm, BASE_PROPS));
    expect(html).toContain("Owner Override");
    expect(html).toContain("bypasses the panel");
    expect(html).toContain("own vote");
  });

  it("renders a required justification field", () => {
    const html = renderToStaticMarkup(createElement(AdaptivePanelOverrideForm, BASE_PROPS));
    expect(html).toContain("Justification (required)");
  });

  it("renders a status selector with all four statuses", () => {
    const html = renderToStaticMarkup(createElement(AdaptivePanelOverrideForm, BASE_PROPS));
    expect(html).toContain("Approved");
    expect(html).toContain("Approved with Conditions");
    expect(html).toContain("Changes Requested");
    expect(html).toContain("Rejected");
  });

  it("renders an explicit confirmation checkbox", () => {
    const html = renderToStaticMarkup(createElement(AdaptivePanelOverrideForm, BASE_PROPS));
    expect(html).toMatch(/type="checkbox"/);
    expect(html).toContain("I understand this overrides the panel");
  });

  it("states that reviewer votes remain visible and unchanged", () => {
    const html = renderToStaticMarkup(createElement(AdaptivePanelOverrideForm, BASE_PROPS));
    expect(html).toContain("never edited or deleted");
  });

  it("never renders the conditions editor before approved_with_conditions is selected", () => {
    const html = renderToStaticMarkup(createElement(AdaptivePanelOverrideForm, BASE_PROPS));
    expect(html).not.toContain("+ Add condition");
  });
});

describe("AdaptivePanelOverrideForm — source-level guarantees", () => {
  const fullSource = readFileSync(join(__dirname, "../AdaptivePanelOverrideForm.tsx"), "utf8");
  const source = fullSource.slice(fullSource.indexOf("*/") + 2);

  it("posts to the override route only, one POST per submission, never auto-retried", () => {
    expect(source).toContain("/review-panel/override");
    expect(source).toMatch(/method:\s*["']POST["']/);
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });

  it("always sends expectedPanelRevision and expectedGovernanceUpdatedAt as concurrency tokens", () => {
    expect(source).toContain("expectedPanelRevision");
    expect(source).toContain("expectedGovernanceUpdatedAt");
  });

  it("never sends teamId, actor identity, or a client-chosen finalDecisionId", () => {
    expect(source).not.toMatch(/teamId:/);
    expect(source).not.toMatch(/actorUserId:/);
    expect(source).not.toMatch(/finalDecisionId/);
  });

  it("cannot submit without the confirmation checkbox being checked (gated in validation)", () => {
    expect(source).toContain("if (!confirmed)");
  });

  it("locks the form permanently on success", () => {
    expect(source).toContain('result?.kind === "success"');
  });

  it("never auto-resubmits on a stale/terminal outcome — only an explicit Reload control", () => {
    expect(source).toContain("onRequestReload");
    expect(source).toMatch(/Reload/);
  });
});

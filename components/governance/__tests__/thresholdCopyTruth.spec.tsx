/**
 * Step 6 D5.1 — the Governance Dashboard must not promise an auto-approval
 * threshold the evaluator does not enforce. `evaluateGovernance` never reads
 * `minConsensusToApprove` (see lib/governance/__tests__/evaluateGovernance.spec.ts),
 * so no copy may describe it as deciding approval.
 *
 * The upsell list is rendered for real. The policy editor only renders after
 * an authenticated policy fetch, so its labels are pinned in the component
 * source instead — exact strings, plus the absence of every "auto-approv…"
 * phrasing anywhere in the file.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
const STABLE_AUTH = { user: { uid: "u1", email: "u1@example.test", getIdToken: async () => "t" }, loading: false, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => STABLE_AUTH }));
const STABLE_PLAN = { loading: false, governanceDashboardEligible: false, governancePolicyEditable: false };
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => STABLE_PLAN }));

const GovernanceDashboard = require("@/components/governance/GovernanceDashboard").default;

const SOURCE = readFileSync(join(__dirname, "..", "GovernanceDashboard.tsx"), "utf8");

describe("Governance Dashboard threshold copy (D5.1)", () => {
  it("the rendered upsell offers review thresholds, not auto-approval", () => {
    const html = renderToStaticMarkup(createElement(GovernanceDashboard));
    expect(html).toContain("Configure consensus thresholds for governance review");
    expect(html.toLowerCase()).not.toContain("auto-approv");
  });

  it("the general approval field says it is stored and not enforced", () => {
    expect(SOURCE).toContain("Approval threshold (stored, not currently enforced)");
    expect(SOURCE).toContain("changing it does not currently change any decision.");
  });

  it("no copy in the component says auto-approve / auto-approval / auto-approved", () => {
    expect(SOURCE.toLowerCase().match(/auto-approv\w*/g)).toBeNull();
  });

  it("the stored field stays editable and validated (no silent removal)", () => {
    expect(SOURCE).toContain("value={policy.minConsensusToApprove}");
    expect(SOURCE).toContain("Approval threshold must be greater than or equal to the review threshold.");
  });
});

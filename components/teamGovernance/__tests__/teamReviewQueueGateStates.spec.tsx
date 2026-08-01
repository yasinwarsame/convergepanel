/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — structural tests for
 * TeamReviewQueue's SYNCHRONOUS gate states only (authenticating, no team,
 * insufficient role) via `renderToStaticMarkup`.
 *
 * Documented limitation: `renderToStaticMarkup` performs a single
 * synchronous render pass with no effect flushing and no re-render after
 * an async fetch resolves — so the loaded/empty/no-filter-match/service-
 * unavailable states (which depend on `useEffect` + a resolved fetch) are
 * NOT reachable through this method and are not asserted here. Those data
 * states are fully covered at the API-contract level by
 * `app/api/teams/runs/__tests__/teamRunsListVersioned.spec.ts`. If a DOM
 * testing library is ever added to this repo, a real mount-and-await test
 * should be added to cover the fetch-dependent states through the actual
 * component tree.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedUseUserPlan = jest.fn();
jest.mock("@/hooks/useUserPlan", () => ({
  useUserPlan: () => mockedUseUserPlan(),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import TeamReviewQueue from "@/components/teamGovernance/TeamReviewQueue";

function baseUserPlan(overrides: Record<string, unknown> = {}) {
  return { teamRole: null, loading: false, teamId: null, ...overrides };
}

beforeEach(() => {
  mockedUseAuth.mockReset();
  mockedUseUserPlan.mockReset();
});

describe("TeamReviewQueue — synchronous gate states", () => {
  it("shows a loading state while auth is not ready", () => {
    mockedUseAuth.mockReturnValue({ user: null, loading: true, authReady: false });
    mockedUseUserPlan.mockReturnValue(baseUserPlan());
    const html = renderToStaticMarkup(createElement(TeamReviewQueue));
    expect(html).toContain("Loading");
  });

  it("shows a sign-in-required state when there is no user", () => {
    mockedUseAuth.mockReturnValue({ user: null, loading: false, authReady: true });
    mockedUseUserPlan.mockReturnValue(baseUserPlan());
    const html = renderToStaticMarkup(createElement(TeamReviewQueue));
    expect(html).toContain("Sign in required");
  });

  it("shows a no-team state when the user has no team", () => {
    mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, loading: false, authReady: true });
    mockedUseUserPlan.mockReturnValue(baseUserPlan({ teamId: null }));
    const html = renderToStaticMarkup(createElement(TeamReviewQueue));
    expect(html).toContain("No team");
  });

  it("shows an insufficient-permissions state for a plain member", () => {
    mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, loading: false, authReady: true });
    mockedUseUserPlan.mockReturnValue(baseUserPlan({ teamId: "team-1", teamRole: "member" }));
    const html = renderToStaticMarkup(createElement(TeamReviewQueue));
    expect(html).toContain("Insufficient permissions");
  });

  it("never renders a decision control in any gate state", () => {
    mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, loading: false, authReady: true });
    mockedUseUserPlan.mockReturnValue(baseUserPlan({ teamId: "team-1", teamRole: "member" }));
    const html = renderToStaticMarkup(createElement(TeamReviewQueue));
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Reject");
  });
});

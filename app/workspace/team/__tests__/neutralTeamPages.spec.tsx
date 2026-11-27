/**
 * ZCA L-4 — the 11 Team Workspace pages without a Project (D-4 #8–#14, #22–#25) are NEUTRAL shells.
 *
 * Their former per-page Server Component specs (gate + props) moved to where the decision now lives:
 *   - access:            app/api/workspaces/[workspaceId]/__tests__/route.spec.ts
 *   - capabilities/props: components/workspace/__tests__/TeamWorkspacePage.spec.tsx
 * Here, for every page: the server render resolves no identity, reads no cookie and no workspace data,
 * is a plain (non-async) component, renders identical neutral markup for any params, and hands the
 * client only URL params plus the identity-free values listed per page.
 */
const mockIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({ resolveServerComponentIdentity: (...a: unknown[]) => mockIdentity(...a) }));
const mockAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockAccess(...a) }));
const mockCookies = jest.fn();
jest.mock("next/headers", () => ({ cookies: (...a: unknown[]) => mockCookies(...a), headers: (...a: unknown[]) => mockCookies(...a) }));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), WORKSPACE_GOVERNANCE_SUMMARY_ENABLED: true, WORKSPACE_REVIEW_INTEGRITY_METRICS_ENABLED: false }));
const mockPageProps: unknown[] = [];
jest.mock("@/components/workspace/TeamWorkspacePage", () => ({ __esModule: true, default: (p: unknown) => { mockPageProps.push(p); return null; } }));

import { readFileSync } from "fs";
import { join } from "path";

const DIR = join(__dirname, "..", "[workspaceId]");
type Case = { sub: string; params: Record<string, string>; searchParams?: Record<string, string>; expected: Record<string, unknown> };
const CASES: Case[] = [
  { sub: "", params: { workspaceId: "ws-1" }, expected: { kind: "overview", workspaceId: "ws-1" } },
  { sub: "audit", params: { workspaceId: "ws-1" }, expected: { kind: "audit", workspaceId: "ws-1", showGovernanceSummary: true, showReviewIntegrityMetrics: false } },
  { sub: "claims", params: { workspaceId: "ws-1" }, expected: { kind: "claims", workspaceId: "ws-1" } },
  { sub: "claims/[verificationId]", params: { workspaceId: "ws-1", verificationId: "v-1" }, expected: { kind: "claimDetail", workspaceId: "ws-1", verificationId: "v-1" } },
  { sub: "claims/new", params: { workspaceId: "ws-1" }, expected: { kind: "claimNew", workspaceId: "ws-1", originTarget: null } },
  { sub: "members", params: { workspaceId: "ws-1" }, expected: { kind: "members", workspaceId: "ws-1" } },
  { sub: "projects", params: { workspaceId: "ws-1" }, expected: { kind: "projects", workspaceId: "ws-1" } },
  { sub: "research/[runId]", params: { workspaceId: "ws-1", runId: "r-1" }, expected: { kind: "researchDetail", workspaceId: "ws-1", runId: "r-1" } },
  { sub: "videos", params: { workspaceId: "ws-1" }, expected: { kind: "videos", workspaceId: "ws-1" } },
  { sub: "videos/new", params: { workspaceId: "ws-1" }, expected: { kind: "videoNew", workspaceId: "ws-1" } },
  { sub: "videos/[verificationId]", params: { workspaceId: "ws-1", verificationId: "v-2" }, expected: { kind: "videoDetail", workspaceId: "ws-1", verificationId: "v-2" } },
];
const load = (sub: string) => require(`@/app/workspace/team/[workspaceId]/${sub ? sub + "/" : ""}page`).default as (p: unknown) => unknown;

beforeEach(() => { jest.clearAllMocks(); mockPageProps.length = 0; });

describe.each(CASES)("team page '$sub'", ({ sub, params, searchParams, expected }) => {
  it("hands the client exactly the URL params and identity-free values, and nothing else", () => {
    const Page = load(sub);
    const el = Page({ params, searchParams }) as { props: unknown };
    expect(el).not.toBeInstanceOf(Promise);
    expect(el.props).toEqual(expected);
  });
  it("resolves no identity, reads no cookie, reads no workspace", () => {
    load(sub)({ params, searchParams });
    expect(mockIdentity).not.toHaveBeenCalled();
    expect(mockCookies).not.toHaveBeenCalled();
    expect(mockAccess).not.toHaveBeenCalled();
  });
  it("its source imports no identity, cookie or workspace-data module", () => {
    const src = readFileSync(join(DIR, sub, "page.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/resolveServerComponentIdentity|next\/headers|resolveWorkspaceAccess|reportReviewActivation|projectAssignmentUiAdmission|getProject/);
  });
});

describe("claims/new — the origin handoff query stays a server-side, identity-free check", () => {
  const Page = () => load("claims/new");
  it("a malformed handoff → notFound() before anything else", () => {
    let caught: unknown;
    try { Page()({ params: { workspaceId: "ws-1" }, searchParams: { originRunId: "r-only" } }); } catch (e) { caught = e; }
    expect((caught as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
    expect(mockPageProps).toEqual([]);
  });
  it("a valid locator pair passes through as originTarget", () => {
    const el = Page()({ params: { workspaceId: "ws-1" }, searchParams: { originRunId: "run-9", originClaimId: "claim-3" } }) as { props: { originTarget: unknown } };
    expect(el.props.originTarget).toEqual({ runId: "run-9", claimId: "claim-3" });
  });
});

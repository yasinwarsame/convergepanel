/**
 * ZCA L-5 — the seven Team Project pages (D-4 #15–#21) are NEUTRAL shells. Their former per-page Server
 * Component specs (gate + props) moved to:
 *   - Project gate: app/api/workspaces/[workspaceId]/projects/[projectId]/__tests__/getRoute.spec.ts
 *   - access:       app/api/workspaces/[workspaceId]/__tests__/route.spec.ts
 *   - client gate, active rule and exact props: components/workspace/__tests__/TeamWorkspaceProjectPages.spec.tsx
 */
const mockIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({ resolveServerComponentIdentity: (...a: unknown[]) => mockIdentity(...a) }));
const mockAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockAccess(...a) }));
const mockGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockGetProject(...a) }));
const mockCookies = jest.fn();
jest.mock("next/headers", () => ({ cookies: (...a: unknown[]) => mockCookies(...a), headers: (...a: unknown[]) => mockCookies(...a) }));
jest.mock("@/components/workspace/TeamWorkspacePage", () => ({ __esModule: true, default: () => null }));

import { readFileSync } from "fs";
import { join } from "path";

const DIR = join(__dirname, "..", "[workspaceId]", "projects", "[projectId]");
const P = { workspaceId: "ws-1", projectId: "p-1" };
const CASES: Array<{ sub: string; params: Record<string, string>; expected: Record<string, unknown> }> = [
  { sub: "", params: P, expected: { kind: "projectDetail", ...P } },
  { sub: "claims/new", params: P, expected: { kind: "projectClaimNew", ...P } },
  { sub: "claims/[verificationId]", params: { ...P, verificationId: "v-1" }, expected: { kind: "projectClaimDetail", ...P, verificationId: "v-1" } },
  { sub: "research/new", params: P, expected: { kind: "projectResearchNew", ...P } },
  { sub: "research/[runId]", params: { ...P, runId: "r-1" }, expected: { kind: "projectResearchDetail", ...P, runId: "r-1" } },
  { sub: "videos/new", params: P, expected: { kind: "projectVideoNew", ...P } },
  { sub: "videos/[verificationId]", params: { ...P, verificationId: "v-2" }, expected: { kind: "projectVideoDetail", ...P, verificationId: "v-2" } },
];
const load = (sub: string) => require(`@/app/workspace/team/[workspaceId]/projects/[projectId]/${sub ? sub + "/" : ""}page`).default as (p: unknown) => { props: unknown };

beforeEach(() => jest.clearAllMocks());

describe.each(CASES)("project page '$sub'", ({ sub, params, expected }) => {
  it("hands the client exactly the URL params (and its kind), synchronously", () => {
    const el = load(sub)({ params });
    expect(el).not.toBeInstanceOf(Promise);
    expect(el.props).toEqual(expected);
  });
  it("resolves no identity, reads no cookie, workspace or Project", () => {
    load(sub)({ params });
    expect(mockIdentity).not.toHaveBeenCalled();
    expect(mockCookies).not.toHaveBeenCalled();
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockGetProject).not.toHaveBeenCalled();
  });
  it("its source imports no identity, cookie, workspace or Project module", () => {
    const src = readFileSync(join(DIR, sub, "page.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/resolveServerComponentIdentity|next\/headers|resolveWorkspaceAccess|firestore\/projects|assignee|reportReviewActivation|projectAssignmentUiAdmission/);
  });
});

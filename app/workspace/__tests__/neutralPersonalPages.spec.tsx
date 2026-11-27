/**
 * ZCA L-6 — the six Personal workspace pages (D-4 #1–#5, #7) are NEUTRAL shells. Their former Server
 * Component gate specs moved to the endpoint specs (workspace-ui-gate, user/projects/[projectId] GET,
 * workspace-reviews-target) and components/workspace/__tests__/PersonalWorkspacePage.spec.tsx.
 */
const mockIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({ resolveServerComponentIdentity: (...a: unknown[]) => mockIdentity(...a) }));
const mockCookies = jest.fn();
jest.mock("next/headers", () => ({ cookies: (...a: unknown[]) => mockCookies(...a), headers: (...a: unknown[]) => mockCookies(...a) }));
jest.mock("@/components/workspace/PersonalWorkspacePage", () => ({ __esModule: true, default: () => null }));

import { readFileSync } from "fs";
import { join } from "path";

const CASES: Array<{ file: string; mod: string; args: Record<string, unknown>; expected: Record<string, unknown> }> = [
  { file: "page.tsx", mod: "@/app/workspace/page", args: {}, expected: { kind: "workspaceHome" } },
  { file: "projects/page.tsx", mod: "@/app/workspace/projects/page", args: {}, expected: { kind: "projects" } },
  { file: "projects/[projectId]/page.tsx", mod: "@/app/workspace/projects/[projectId]/page", args: { params: { projectId: "p-1" } }, expected: { kind: "projectDetail", projectId: "p-1" } },
  { file: "research/[runId]/page.tsx", mod: "@/app/workspace/research/[runId]/page", args: { params: { runId: "run%2F1" } }, expected: { kind: "research", runId: "run%2F1" } },
  { file: "reviews/page.tsx", mod: "@/app/workspace/reviews/page", args: { searchParams: {} }, expected: { kind: "reviews", workspace: null } },
  { file: "team/page.tsx", mod: "@/app/workspace/team/page", args: {}, expected: { kind: "teamLanding" } },
];
const load = (mod: string) => require(mod).default as (p: unknown) => { props: unknown };
beforeEach(() => jest.clearAllMocks());

describe.each(CASES)("$file", ({ file, mod, args, expected }) => {
  it("hands the client only its kind and URL params, synchronously", () => {
    const el = load(mod)(args);
    expect(el).not.toBeInstanceOf(Promise);
    expect(el.props).toEqual(expected);
  });
  it("resolves no identity and reads no cookie", () => {
    load(mod)(args);
    expect(mockIdentity).not.toHaveBeenCalled();
    expect(mockCookies).not.toHaveBeenCalled();
  });
  it("its source imports no identity, cookie, rollout, workspace or Project module", () => {
    const src = readFileSync(join(__dirname, "..", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/resolveServerComponentIdentity|next\/headers|Rollout|Eligibility|resolvePersonalWorkspaceForOwner|resolveProjectForOwner|resolveViewerTeamWorkspaceSelection|resolveTeamRunWorkspaceAccess|@\/lib\/env/);
  });
});

describe("URL-only checks that stay in the server render", () => {
  it("research: a blank / whitespace run id is not a run (notFound before anything else)", () => {
    for (const runId of ["", "   "]) {
      let caught: unknown;
      try { load("@/app/workspace/research/[runId]/page")({ params: { runId } }); } catch (e) { caught = e; }
      expect((caught as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
    }
  });
  it("reviews: ?workspace= is forwarded (first value of a repeated param; empty → null)", () => {
    const P = load("@/app/workspace/reviews/page");
    expect(P({ searchParams: { workspace: ["ws-a", "ws-b"] } }).props).toEqual({ kind: "reviews", workspace: "ws-a" });
    expect(P({ searchParams: { workspace: "" } }).props).toEqual({ kind: "reviews", workspace: null });
  });
  it("every page stays force-dynamic", () => {
    for (const { file } of CASES) expect(readFileSync(join(__dirname, "..", file), "utf8")).toContain('export const dynamic = "force-dynamic";');
  });
});

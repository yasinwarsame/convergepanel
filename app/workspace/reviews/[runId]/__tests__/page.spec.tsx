/**
 * ZCA L-3 — `/workspace/reviews/[runId]` is a NEUTRAL shell (D-4 page #6).
 *
 * The former route-gate and content cases moved to where the decision now lives:
 *   - gate (admission, concealment, 401/503): app/api/user/workspace-review-runs/[runId]/__tests__/route.spec.ts
 *   - content and identity transitions: components/workspace/__tests__/WorkspaceRunDetailClient.spec.tsx
 *
 * Here: the server render resolves no identity, reads no data, and its markup is identical for every
 * visitor, whatever cookie the browser holds and whichever run is requested.
 */
const mockGetWorkspaceRunDetail = jest.fn();
jest.mock("@/lib/workspaces/workspaceRunDetail", () => ({ getWorkspaceRunDetail: (...a: unknown[]) => mockGetWorkspaceRunDetail(...a) }));
// ZCA L-8 deleted lib/auth/resolveServerComponentIdentity; a page that re-imported it would fail to build, and the
// source checks below (and the static oracle) forbid the import.
const mockCookies = jest.fn();
jest.mock("next/headers", () => ({ cookies: (...a: unknown[]) => mockCookies(...a), headers: (...a: unknown[]) => mockCookies(...a) }));
// On the server there is no Firebase user: the client half renders its neutral loading state.
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("next/navigation", () => ({ ...jest.requireActual("next/navigation"), useRouter: () => ({ replace: jest.fn() }), usePathname: () => "/workspace/reviews/x" }));

import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceRunDetailPage from "@/app/workspace/reviews/[runId]/page";

const render = (runId: string) => renderToStaticMarkup(WorkspaceRunDetailPage({ params: { runId } }) as never);

describe("/workspace/reviews/[runId] — neutral server render (ZCA L-3)", () => {
  it("resolves no identity, reads no cookie and reads no run", () => {
    render("run-1");
    expect(mockCookies).not.toHaveBeenCalled();
    expect(mockGetWorkspaceRunDetail).not.toHaveBeenCalled();
  });

  it("is a plain (non-async) component: there is nothing for it to await", () => {
    expect(WorkspaceRunDetailPage({ params: { runId: "run-1" } })).not.toBeInstanceOf(Promise);
  });

  it("renders the identical neutral loading markup for every run id", () => {
    const a = render("run-1");
    expect(a).toContain('data-testid="authorized-page-loading"');
    expect(render("another-run")).toBe(a);
    expect(a).not.toMatch(/run-1|Back to reviews|Approved|Created|Last reviewed/);
  });

  it("the page module imports no identity, cookie or server data module", () => {
    const src = readFileSync(join(__dirname, "..", "page.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/resolveServerComponentIdentity|next\/headers|workspaceRunDetail"|approvalWorkflowRollout|@\/lib\/env/);
  });
});

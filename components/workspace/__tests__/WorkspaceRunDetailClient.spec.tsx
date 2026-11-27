/**
 * ZCA L-3 — the client half of `/workspace/reviews/[runId]`: content (ported from the former server-page
 * spec) and the identity rules of useAuthorizedResource / AuthorizedPageGate.
 */
type FakeUser = { uid: string; getIdToken: () => Promise<string> };
const AUTH: { user: FakeUser | null; authReady: boolean } = { user: null, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockAuthedFetch(...a) }));
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/workspace/reviews/run-1",
}));
jest.mock("@/components/workspace/WorkspaceRunReviewSection", () => () => null);
// next/link's prefetch observer needs browser globals; a plain anchor keeps the rendered href.
jest.mock("next/link", () => {
  const { createElement: h } = jest.requireActual("react");
  return { __esModule: true, default: ({ href, children, prefetch: _p, ...rest }: Record<string, unknown>) => h("a", { href, ...rest }, children) };
});

import { Component, createElement, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import WorkspaceRunDetailClient from "@/components/workspace/WorkspaceRunDetailClient";

const user = (uid: string): FakeUser => ({ uid, getIdToken: async () => `token-${uid}` });
const DETAIL = (over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  workspaceId: "ws-1",
  workspaceName: "Acme Research",
  projectId: null,
  projectName: null,
  runLabel: "What are the top acquisition risks?",
  reviewStatus: "approved_with_conditions",
  createdAt: "2026-08-01T00:00:00.000Z",
  reviewedAt: "2026-08-05T00:00:00.000Z",
  ...over,
});
const ok = (detail: unknown) => ({ status: 200, json: async () => ({ ok: true, detail }) });
const status = (s: number) => ({ status: s, json: async () => ({}) });
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

class Boundary extends Component<{ children?: ReactNode; onError: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { this.props.onError(e); }
  render() { return this.state.failed ? null : this.props.children; }
}

let renderer: TestRenderer.ReactTestRenderer;
let caught: unknown;
async function mount(runId = "run-1") {
  caught = undefined;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Boundary, { onError: (e: unknown) => { caught = e; } }, createElement(WorkspaceRunDetailClient, { runId })));
  });
}
async function rerender(runId = "run-1") {
  await act(async () => {
    renderer.update(createElement(Boundary, { onError: (e: unknown) => { caught = e; } }, createElement(WorkspaceRunDetailClient, { runId })));
  });
}
const text = () => JSON.stringify(renderer.toJSON());

beforeEach(() => {
  jest.clearAllMocks();
  AUTH.user = null;
  AUTH.authReady = true;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => (console.error as jest.Mock).mockRestore?.());

describe("identity rules", () => {
  it("no Firebase user (signed out locally): nothing is requested, nothing is shown, sign-in is required", async () => {
    await mount();
    expect(mockAuthedFetch).not.toHaveBeenCalled();
    expect(text()).toContain("authorized-page-loading");
    expect(mockReplace).toHaveBeenCalledWith("/login?next=%2Fworkspace%2Freviews%2Frun-1");
  });

  it("Firebase not ready: nothing is requested", async () => {
    AUTH.authReady = false;
    AUTH.user = user("a");
    await mount();
    expect(mockAuthedFetch).not.toHaveBeenCalled();
  });

  it("requests the run with the bearer helper for the signed-in user only", async () => {
    AUTH.user = user("a");
    mockAuthedFetch.mockResolvedValue(ok(DETAIL()));
    await mount();
    expect(mockAuthedFetch).toHaveBeenCalledWith("/api/user/workspace-review-runs/run-1", expect.objectContaining({ user: AUTH.user, method: "GET" }));
    expect(text()).toContain("Acme Research");
  });

  it("SECURITY: A's late answer is never rendered once the user is B", async () => {
    AUTH.user = user("a");
    const aAnswer = deferred<unknown>();
    mockAuthedFetch.mockReturnValueOnce(aAnswer.promise);
    await mount();
    AUTH.user = user("b");
    mockAuthedFetch.mockResolvedValueOnce(ok(DETAIL({ workspaceName: "B Workspace" })));
    await rerender();
    await act(async () => { aAnswer.resolve(ok(DETAIL({ workspaceName: "A SECRET Workspace" }))); });
    expect(text()).toContain("B Workspace");
    expect(text()).not.toContain("A SECRET");
  });

  it("SECURITY: A's data disappears at once when A signs out (no stale render)", async () => {
    AUTH.user = user("a");
    mockAuthedFetch.mockResolvedValue(ok(DETAIL({ workspaceName: "A SECRET Workspace" })));
    await mount();
    expect(text()).toContain("A SECRET");
    AUTH.user = null;
    await rerender();
    expect(text()).not.toContain("A SECRET");
  });

  it("SECURITY: after A → B, A's stored data is not returned even before B's answer arrives", async () => {
    AUTH.user = user("a");
    mockAuthedFetch.mockResolvedValueOnce(ok(DETAIL({ workspaceName: "A SECRET Workspace" })));
    await mount();
    AUTH.user = user("b");
    mockAuthedFetch.mockReturnValueOnce(new Promise(() => undefined)); // B's answer never arrives
    await rerender();
    expect(text()).not.toContain("A SECRET");
    expect(text()).toContain("authorized-page-loading");
  });

  it("404 (every denial) → the page's real notFound()", async () => {
    AUTH.user = user("a");
    mockAuthedFetch.mockResolvedValue(status(404));
    await mount();
    expect((caught as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
  });

  it("401 (bearer refused) → a neutral notice, no data", async () => {
    AUTH.user = user("a");
    mockAuthedFetch.mockResolvedValue(status(401));
    await mount();
    expect(text()).toContain("authorized-page-unauthorized");
  });

  it.each([[503], [500]])("%s → a neutral retryable error", async (s) => {
    AUTH.user = user("a");
    mockAuthedFetch.mockResolvedValue(status(s));
    await mount();
    expect(text()).toContain("authorized-page-unavailable");
  });

  it("a malformed 200 body is not rendered (unavailable)", async () => {
    AUTH.user = user("a");
    mockAuthedFetch.mockResolvedValue({ status: 200, json: async () => ({ ok: true, detail: { workspaceName: 7 } }) });
    await mount();
    expect(text()).toContain("authorized-page-unavailable");
  });
});

describe("content (ported from the former server-page spec)", () => {
  async function renderOk(over: Record<string, unknown> = {}) {
    AUTH.user = user("a");
    mockAuthedFetch.mockResolvedValue(ok(DETAIL(over)));
    await mount();
    return text();
  }
  it("renders the Workspace name and run label", async () => {
    const t = await renderOk();
    expect(t).toContain("Acme Research");
    expect(t).toContain("What are the top acquisition risks?");
  });
  it("approved_with_conditions renders distinctly from plain Approved", async () => {
    expect(await renderOk()).toContain("Approved with conditions");
  });
  it("never renders raw runId/workspaceId as visible text", async () => {
    const t = await renderOk();
    expect(t).not.toMatch(/"run-1"/);
    expect(t).not.toMatch(/"ws-1"/);
  });
  it("null dates never render as 'Invalid Date'", async () => {
    expect(await renderOk({ createdAt: null, reviewedAt: null })).not.toContain("Invalid Date");
  });
  it("renders no mutation control text", async () => {
    const t = await renderOk();
    for (const word of ["\"Assign\"", "\"Reassign\"", "\"Approve\"", "\"Reject\"", "\"Request changes\"", "\"Resubmit\"", "\"Vote\"", "\"Finalize\"", "\"Override\""]) expect(t).not.toContain(word);
  });
  it("links back to /workspace/reviews scoped (and encoded) to the run's own Workspace", async () => {
    expect(await renderOk()).toContain('"href":"/workspace/reviews?workspace=ws-1"');
    jest.clearAllMocks();
    expect(await renderOk({ workspaceId: "ws/with space" })).toContain(`"href":"/workspace/reviews?workspace=${encodeURIComponent("ws/with space")}"`);
  });
});

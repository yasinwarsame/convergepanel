/**
 * TEAM-RESEARCH-PARITY-R3 §J/§K/§L/§N/§V/§W/§Y — `TeamResearchDetailShell`.
 *
 * The shell, the Team interpreter, the shared R2 interpreter, `Breadcrumb` and
 * `WorkspaceNav` are REAL. `useAuth` and `authedFetch` are controlled
 * boundaries; `PersistedResearchResultView` is stubbed to record what reaches
 * it (its own real-render suites, and `TeamResearchDetailShellRealRender.spec`,
 * prove the painted result body).
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));

const USER_A = { uid: "uid-a" };
const USER_B = { uid: "uid-b" };
let auth: { user: { uid: string } | null; authReady: boolean } = { user: USER_A, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

const viewProps: Record<string, unknown>[] = [];
jest.mock("@/components/research/PersistedResearchResultView", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    viewProps.push(props);
    return require("react").createElement("div", { "data-testid": "persisted-result-view", "data-run-id": (props.presentation as { runId: string }).runId });
  },
}));

import TeamResearchDetailShell, { type TeamResearchDetailShellProps } from "@/components/workspace/projects/TeamResearchDetailShell";

const WS = "ws-1";
const PROJECT = "proj-1";
const RUN = "run-1";

const PROJECT_PROPS: TeamResearchDetailShellProps = { workspaceId: WS, workspaceName: "Acme Team", runId: RUN, project: { id: PROJECT, name: "Launch Plan" }, showAudit: true };
const UNFILED_PROPS: TeamResearchDetailShellProps = { workspaceId: WS, workspaceName: "Acme Team", runId: RUN, project: null, showAudit: false };

function body(over: Record<string, unknown> = {}, team: Record<string, unknown> = {}) {
  return {
    ok: true,
    runId: RUN,
    viewerRole: "team_member",
    question: "What changed?",
    selectedModels: ["chatgpt", "claude"],
    status: "complete",
    results: [
      { modelId: "chatgpt", status: "ok", rawText: "one" },
      { modelId: "claude", status: "ok", rawText: "two" },
    ],
    synthesisCache: null,
    governance: null,
    governanceStatus: null,
    adaptive: { status: "absent", output: null, humanReview: null, reviewRouting: "unknown" },
    legacyAdaptive: { status: "absent", output: null },
    team: {
      workspaceId: WS,
      projectId: PROJECT,
      project: { id: PROJECT, name: "Launch Plan", status: "active" },
      assignee: null,
      createdAt: "2026-09-02T10:00:00.000Z",
      completedAt: null,
      origin: null,
      review: null,
      ...team,
    },
    ...over,
  };
}
const unfiledBody = (over: Record<string, unknown> = {}, team: Record<string, unknown> = {}) => body({ ...over, runId: over.runId ?? RUN }, { projectId: null, project: null, ...team });

const response = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(props: TeamResearchDetailShellProps) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(TeamResearchDetailShell, props));
  });
  await flush();
  return renderer;
}

async function update(r: TestRenderer.ReactTestRenderer, props: TeamResearchDetailShellProps) {
  await act(async () => {
    r.update(createElement(TeamResearchDetailShell, props));
  });
  await flush();
}

const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const urls = () => mockedAuthedFetch.mock.calls.map((c) => c[0] as string);
const lastView = () => viewProps[viewProps.length - 1];

beforeEach(() => {
  jest.clearAllMocks();
  viewProps.length = 0;
  auth = { user: USER_A, authReady: true };
});

describe("transport (§F/§H/§J)", () => {
  it("Project address → exactly one GET to the R1 endpoint WITH ?projectId, via authedFetch, never the Personal endpoint", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(PROJECT_PROPS);
    expect(urls()).toEqual([`/api/workspaces/${WS}/runs/${RUN}?projectId=${PROJECT}`]);
    const init = mockedAuthedFetch.mock.calls[0][1] as Record<string, unknown>;
    expect(init.method).toBe("GET");
    expect(init.user).toBe(USER_A);
    expect(init.forceTokenRefresh).toBeUndefined();
  });

  it("Unfiled address → the R1 endpoint WITHOUT projectId", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, unfiledBody()));
    await mount(UNFILED_PROPS);
    expect(urls()).toEqual([`/api/workspaces/${WS}/runs/${RUN}`]);
  });

  it("every dynamic value is percent-encoded exactly once", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404, { ok: false }));
    await mount({ ...PROJECT_PROPS, workspaceId: "w/1 x", runId: "r?1", project: { id: "p&1", name: "P" } });
    expect(urls()).toEqual(["/api/workspaces/w%2F1%20x/runs/r%3F1?projectId=p%261"]);
  });

  it("no request of any kind targets the Personal run endpoint or a synthesis endpoint", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(PROJECT_PROPS);
    for (const u of urls()) {
      expect(u.startsWith("/api/workspaces/")).toBe(true);
      expect(u).not.toContain("/api/user/runs");
      expect(u).not.toContain("synthesize");
    }
  });

  it("auth not ready → no request and a loading state; signed out → no request", async () => {
    auth = { user: USER_A, authReady: false };
    const r = await mount(PROJECT_PROPS);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(text(r)).toContain("Loading this research");
    auth = { user: null, authReady: true };
    await mount(PROJECT_PROPS);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });
});

describe("401 contract (§K)", () => {
  it("first 401 → exactly one forced token refresh on the same URL; a refreshed 200 renders", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(401, { ok: false, errorCode: "unauthorized" })).mockResolvedValueOnce(response(200, body()));
    const r = await mount(PROJECT_PROPS);
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(urls()[0]).toBe(urls()[1]);
    expect((mockedAuthedFetch.mock.calls[1][1] as Record<string, unknown>).forceTokenRefresh).toBe(true);
    expect(viewProps).toHaveLength(1);
    expect(text(r)).not.toContain("verify your session");
  });

  it("second 401 → auth/session state (never unavailable), and no third request", async () => {
    mockedAuthedFetch.mockResolvedValue(response(401, { ok: false, errorCode: "auth_error" }));
    const r = await mount(PROJECT_PROPS);
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(text(r)).toContain("We couldn't verify your session");
    expect(text(r)).not.toContain("isn't available");
    expect(viewProps).toHaveLength(0);
  });
});

describe("error contract (§L)", () => {
  async function unavailableTree(status: number, json: unknown) {
    mockedAuthedFetch.mockResolvedValue(response(status, json));
    const r = await mount(PROJECT_PROPS);
    return text(r);
  }

  it("403 insufficient_capability, 404 run_not_found and 404 team_workspace_not_found render ONE byte-identical unavailable state", async () => {
    const a = await unavailableTree(403, { ok: false, errorCode: "insufficient_capability" });
    const b = await unavailableTree(404, { ok: false, errorCode: "run_not_found", message: "This run could not be found." });
    const c = await unavailableTree(404, { ok: false, errorCode: "team_workspace_not_found" });
    expect(a).toContain("This research isn't available");
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(viewProps).toHaveLength(0);
  });

  it("503 → transient and retryable (never a permanent unavailable claim)", async () => {
    mockedAuthedFetch.mockResolvedValue(response(503, { ok: false, errorCode: "team_workspace_unavailable" }));
    const r = await mount(PROJECT_PROPS);
    expect(text(r)).toContain("We couldn't load this research");
    expect(text(r)).not.toContain("isn't available");
    expect(r.root.findAll((n) => n.type === "button" && JSON.stringify(n.children).includes("Try again"))).toHaveLength(1);
  });

  it("a network failure → transient", async () => {
    mockedAuthedFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await mount(PROJECT_PROPS);
    expect(text(r)).toContain("We couldn't load this research");
  });

  it("Retry repeats the same GET only — no other request, no execution", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(503, { ok: false })).mockResolvedValueOnce(response(200, body()));
    const r = await mount(PROJECT_PROPS);
    const button = r.root.find((n) => n.type === "button" && JSON.stringify(n.children).includes("Try again"));
    await act(async () => {
      button.props.onClick();
    });
    await flush();
    expect(urls()).toEqual([`/api/workspaces/${WS}/runs/${RUN}?projectId=${PROJECT}`, `/api/workspaces/${WS}/runs/${RUN}?projectId=${PROJECT}`]);
    for (const call of mockedAuthedFetch.mock.calls) expect((call[1] as Record<string, unknown>).method).toBe("GET");
    expect(viewProps).toHaveLength(1);
  });

  it("a malformed successful 200 → malformed state, not unavailable", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, { ok: true }));
    const r = await mount(PROJECT_PROPS);
    expect(text(r)).toContain("This research couldn't be displayed");
    expect(viewProps).toHaveLength(0);
  });
});

describe("Team response identity and roles (§E/§W)", () => {
  it.each(["team_member", "team_reviewer"])("%s → renders the shared persisted result view", async (role) => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ viewerRole: role })));
    await mount(PROJECT_PROPS);
    expect(viewProps).toHaveLength(1);
    expect((lastView().presentation as { viewerRole: string }).viewerRole).toBe(role);
  });

  it.each(["owner", "personal_reviewer", undefined, "admin"])("viewerRole %p on a Team address → malformed, nothing rendered", async (role) => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ viewerRole: role })));
    const r = await mount(PROJECT_PROPS);
    expect(viewProps).toHaveLength(0);
    expect(text(r)).toContain("couldn't be displayed");
  });

  it("wrong team.workspaceId → malformed; wrong runId → malformed", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { workspaceId: "ws-other" })));
    const a = await mount(PROJECT_PROPS);
    expect(text(a)).toContain("couldn't be displayed");
    mockedAuthedFetch.mockResolvedValue(response(200, body({ runId: "run-other" })));
    const b = await mount(PROJECT_PROPS);
    expect(text(b)).toContain("couldn't be displayed");
    expect(viewProps).toHaveLength(0);
  });
});

describe("route containment (§F/§H/§V/§W)", () => {
  it("Project address: a response for a DIFFERENT Project never renders — concealed as unavailable", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: "proj-other" })));
    const r = await mount(PROJECT_PROPS);
    expect(viewProps).toHaveLength(0);
    expect(text(r)).toContain("This research isn't available");
    expect(text(r)).not.toContain("What changed?");
  });

  it("Project address: an Unfiled run never renders", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, unfiledBody()));
    const r = await mount(PROJECT_PROPS);
    expect(viewProps).toHaveLength(0);
    expect(text(r)).toContain("This research isn't available");
  });

  it("Unfiled address: team.projectId === null renders", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, unfiledBody()));
    await mount(UNFILED_PROPS);
    expect(viewProps).toHaveLength(1);
  });

  it("Unfiled address: a Project-bound response NEVER paints its result body, question or chrome — including an in-progress one", async () => {
    for (const status of ["complete", "running"]) {
      viewProps.length = 0;
      mockedAuthedFetch.mockResolvedValue(response(200, body({ status })));
      const r = await mount(UNFILED_PROPS);
      expect(viewProps).toHaveLength(0);
      expect(text(r)).toContain("This research isn't available");
      expect(text(r)).not.toContain("What changed?");
      expect(text(r)).not.toContain("Launch Plan");
    }
  });
});

describe("race / stale-response protection (§Y)", () => {
  it("run A → run B: a late A response never paints after B", async () => {
    const a = deferred<ReturnType<typeof response>>();
    const b = deferred<ReturnType<typeof response>>();
    mockedAuthedFetch.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const r = await mount(PROJECT_PROPS);
    await update(r, { ...PROJECT_PROPS, runId: "run-2" });
    await act(async () => {
      b.resolve(response(200, body({ runId: "run-2", question: "Question B" })));
    });
    await flush();
    await act(async () => {
      a.resolve(response(200, body({ question: "Question A" })));
    });
    await flush();
    expect(viewProps.map((p) => (p.presentation as { runId: string }).runId)).toEqual(["run-2"]);
    expect(text(r)).toContain("Question B");
    expect(text(r)).not.toContain("Question A");
    expect(mockedAuthedFetch.mock.calls[0][1]).toMatchObject({ signal: expect.objectContaining({ aborted: true }) });
  });

  it("workspace A → workspace B: a late A response never paints", async () => {
    const a = deferred<ReturnType<typeof response>>();
    const b = deferred<ReturnType<typeof response>>();
    mockedAuthedFetch.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const r = await mount(UNFILED_PROPS);
    await update(r, { ...UNFILED_PROPS, workspaceId: "ws-2" });
    await act(async () => {
      a.resolve(response(200, unfiledBody({ question: "From A" })));
    });
    await flush();
    expect(viewProps).toHaveLength(0);
    expect(text(r)).not.toContain("From A");
    await act(async () => {
      b.resolve(response(200, unfiledBody({ question: "From B" }, { workspaceId: "ws-2" })));
    });
    await flush();
    expect(text(r)).toContain("From B");
  });

  it("uid A → uid B: A's late response never paints; a new read runs as B", async () => {
    const a = deferred<ReturnType<typeof response>>();
    mockedAuthedFetch.mockImplementationOnce(() => a.promise).mockResolvedValueOnce(response(200, body({ question: "Seen by B" })));
    const r = await mount(PROJECT_PROPS);
    auth = { user: USER_B, authReady: true };
    await update(r, PROJECT_PROPS);
    await act(async () => {
      a.resolve(response(200, body({ question: "Seen by A" })));
    });
    await flush();
    expect(text(r)).not.toContain("Seen by A");
    expect(text(r)).toContain("Seen by B");
    expect((mockedAuthedFetch.mock.calls[1][1] as Record<string, unknown>).user).toBe(USER_B);
  });

  // TEAM-RESEARCH-PARITY-R4-T1 — Project identity is part of request ownership.
  // SAME Workspace, SAME runId, SAME uid: only the Project changes, so neither the
  // run, Workspace nor uid guard can be what rejects the stale read. Response
  // containment alone cannot either: A's late body is valid for A's own address.
  describe("Project A → Project B (same Workspace, same run, same uid)", () => {
    const PROJECT_A_PROPS: TeamResearchDetailShellProps = { ...PROJECT_PROPS, project: { id: "proj-a", name: "Project A" } };
    const PROJECT_B_PROPS: TeamResearchDetailShellProps = { ...PROJECT_PROPS, project: { id: "proj-b", name: "Project B" } };
    const projectABody = () => body({ question: "Question A" }, { projectId: "proj-a", project: { id: "proj-a", name: "Project A", status: "active" } });
    const projectBBody = () => body({ question: "Question B" }, { projectId: "proj-b", project: { id: "proj-b", name: "Project B", status: "active" } });
    const URL_A = `/api/workspaces/${WS}/runs/${RUN}?projectId=proj-a`;
    const URL_B = `/api/workspaces/${WS}/runs/${RUN}?projectId=proj-b`;

    it("Project A → Project B: a new ?projectId=proj-b read starts, B paints, and A's late response never paints", async () => {
      const a = deferred<ReturnType<typeof response>>();
      const b = deferred<ReturnType<typeof response>>();
      mockedAuthedFetch.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);

      const r = await mount(PROJECT_A_PROPS);
      expect(urls()).toEqual([URL_A]);
      const signalA = (mockedAuthedFetch.mock.calls[0][1] as { signal: AbortSignal }).signal;
      expect(signalA.aborted).toBe(false);

      await update(r, PROJECT_B_PROPS);
      // A is still unresolved; the Project change alone started a NEW read for B and aborted A.
      expect(urls()).toEqual([URL_A, URL_B]);
      expect((mockedAuthedFetch.mock.calls[1][1] as Record<string, unknown>).user).toBe(USER_A);
      expect(signalA.aborted).toBe(true);
      expect((mockedAuthedFetch.mock.calls[1][1] as { signal: AbortSignal }).signal.aborted).toBe(false);
      expect(viewProps).toHaveLength(0);
      expect(text(r)).toContain("Loading this research");

      await act(async () => {
        b.resolve(response(200, projectBBody()));
      });
      await flush();
      expect(text(r)).toContain("Question B");

      await act(async () => {
        a.resolve(response(200, projectABody()));
      });
      await flush();

      // Only B's presentation ever reached the persisted view — A's never did, before or after.
      expect(viewProps.map((p) => (p.presentation as { question: string }).question)).toEqual(["Question B"]);
      expect(viewProps.every((p) => (p.presentation as { runId: string }).runId === RUN)).toBe(true);
      const final = text(r);
      expect(final).toContain("Question B");
      expect(final).toContain("Project B");
      expect(final).toContain(`/workspace/team/${WS}/projects/proj-b`);
      expect(final).not.toContain("Question A");
      expect(final).not.toContain("Project A");
      expect(final).not.toContain("proj-a");
      expect(r.root.findAllByProps({ "data-testid": "persisted-result-view" })).toHaveLength(1);
      expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    });

    it("Project A → Project B: A resolving while B is still in flight paints nothing; B then paints alone", async () => {
      const a = deferred<ReturnType<typeof response>>();
      const b = deferred<ReturnType<typeof response>>();
      mockedAuthedFetch.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);

      const r = await mount(PROJECT_A_PROPS);
      await update(r, PROJECT_B_PROPS);
      expect(urls()).toEqual([URL_A, URL_B]);

      await act(async () => {
        a.resolve(response(200, projectABody()));
      });
      await flush();
      expect(viewProps).toHaveLength(0);
      expect(text(r)).not.toContain("Question A");
      expect(text(r)).toContain("Loading this research");

      await act(async () => {
        b.resolve(response(200, projectBBody()));
      });
      await flush();
      expect(viewProps.map((p) => (p.presentation as { question: string }).question)).toEqual(["Question B"]);
      expect(text(r)).toContain("Question B");
      expect(text(r)).not.toContain("Question A");
      expect(text(r)).not.toContain("proj-a");
    });
  });
});

describe("result status (§M)", () => {
  it("queued / running → in-progress state, no result view, no auto-refresh request", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ status: "running" })));
    const r = await mount(PROJECT_PROPS);
    expect(text(r)).toContain("This research is still in progress. Refresh this page to check again.");
    expect(viewProps).toHaveLength(0);
    await flush();
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("failed / error → failed state", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ status: "error" })));
    const r = await mount(PROJECT_PROPS);
    expect(text(r)).toContain("didn't finish successfully");
    expect(viewProps).toHaveLength(0);
  });
});

describe("shared view delegation (§Q/§R/§S) + explicit P0 ancillary policy (R3-R1 §J/§K/§O)", () => {
  it("hands the interpreted presentation plus an EXPLICIT delegated_read_only policy, and NO Personal action, NO execution target", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(PROJECT_PROPS);
    const props = lastView();
    expect(Object.keys(props).sort()).toEqual(["adaptiveAncillaryPresentation", "presentation"]);
    expect(props.onVerifyClaim).toBeUndefined();
    expect(props.onRunFollowUp).toBeUndefined();
    expect(props.readOnlyExecutionTarget).toBeUndefined();
    expect((props.presentation as { runId: string; question: string }).question).toBe("What changed?");
    const policy = props.adaptiveAncillaryPresentation as { kind: string; exportSurface: unknown; reviewGovernanceSurface: unknown };
    expect(policy.kind).toBe("delegated_read_only");
    // Team export intentionally absent: an explicit null, never undefined-by-accident and never a Personal component.
    expect("exportSurface" in policy).toBe(true);
    expect(policy.exportSurface).toBeNull();
  });

  it("the policy is delegated for BOTH Team roles — the caller chooses it, never the viewer role", async () => {
    for (const role of ["team_member", "team_reviewer"]) {
      viewProps.length = 0;
      mockedAuthedFetch.mockResolvedValue(response(200, body({ viewerRole: role })));
      await mount(PROJECT_PROPS);
      expect((lastView().adaptiveAncillaryPresentation as { kind: string }).kind).toBe("delegated_read_only");
    }
  });

  it("review present in the DTO → the review position is the Team's own read-only summary carrying exactly the parsed review", async () => {
    const review = { humanReviewStatus: "approved_with_conditions", conditions: ["Cite sources"], decidedVia: "workspace_review", decisionReceipt: { conclusion: "Ship it", sourceBacked: true, humanReviewNeeded: false } };
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { review })));
    await mount(PROJECT_PROPS);
    const surface = (lastView().adaptiveAncillaryPresentation as { reviewGovernanceSurface: { type: { name?: string }; props: Record<string, unknown> } }).reviewGovernanceSurface;
    expect(surface).not.toBeNull();
    expect(surface.type.name).toBe("TeamResearchReviewSummary");
    expect(surface.props.review).toEqual({ humanReviewStatus: "approved_with_conditions", conditions: ["Cite sources"], decidedVia: "workspace_review", decisionReceipt: { conclusion: "Ship it", sourceBacked: true, humanReviewNeeded: false } });
  });

  it("review absent → reviewGovernanceSurface is null (nothing rendered, never a Personal fallback)", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { review: null })));
    await mount(PROJECT_PROPS);
    expect((lastView().adaptiveAncillaryPresentation as { reviewGovernanceSurface: unknown }).reviewGovernanceSurface).toBeNull();
  });

  it("Unfiled address uses the identical delegated policy", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, unfiledBody()));
    await mount(UNFILED_PROPS);
    expect((lastView().adaptiveAncillaryPresentation as { kind: string; exportSurface: unknown }).kind).toBe("delegated_read_only");
    expect((lastView().adaptiveAncillaryPresentation as { exportSurface: unknown }).exportSurface).toBeNull();
  });
});

describe("Team chrome (§N/§AA)", () => {
  it("Project address, ready: Breadcrumb → h1 question → WorkspaceNav (Projects current, Audit shown) → result view, with every parent linked", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount(PROJECT_PROPS);
    const main = r.toJSON() as TestRenderer.ReactTestRendererJSON;
    const kinds = (main.children as TestRenderer.ReactTestRendererJSON[]).map((c) => (c.props["aria-label"] ? `${c.type}:${c.props["aria-label"]}` : c.props["data-testid"] ? c.props["data-testid"] : c.type));
    expect(kinds).toEqual(["nav:Breadcrumb", "div", "nav:Workspace", "persisted-result-view"]);
    const hrefs = r.root.findAll((n) => n.type === "a").map((n) => n.props.href);
    expect(hrefs).toEqual(expect.arrayContaining([`/workspace/team/${WS}`, `/workspace/team/${WS}/projects`, `/workspace/team/${WS}/projects/${PROJECT}`, `/workspace/team/${WS}/members`, `/workspace/team/${WS}/audit`]));
    const h1 = r.root.findAll((n) => n.type === "h1");
    expect(h1).toHaveLength(1);
    expect(h1[0].children).toEqual(["What changed?"]);
    const current = r.root.findAll((n) => n.props["aria-current"] === "page").map((n) => JSON.stringify(n.children));
    expect(current).toEqual(expect.arrayContaining(['["What changed?"]', '["Projects"]']));
    for (const href of hrefs) expect(href).not.toMatch(/^\/workspace\/research\//);
  });

  it("the ready Project chrome is identical to the pre-R3 server page chrome (breadcrumb, heading, nav)", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { assignee: { uid: "u2", displayName: "Bao", state: "active" } })));
    const r = await mount({ ...PROJECT_PROPS, workspaceName: "Acme Team", project: { id: PROJECT, name: "ABC Acquisition" } });
    const children = (r.toJSON() as TestRenderer.ReactTestRendererJSON).children as TestRenderer.ReactTestRendererJSON[];
    // Frozen from the pre-R3 page render (complete_ordinary capture): the first three children, verbatim.
    expect(JSON.stringify(children.slice(0, 3))).toBe(PRE_R3_COMPLETE_ORDINARY_CHROME);
  });

  it("Unfiled address, ready: Workspace-level breadcrumb (no Projects segment) and Overview as the current nav tab; no Audit without the hint", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, unfiledBody()));
    const r = await mount(UNFILED_PROPS);
    const breadcrumb = r.root.find((n) => n.props["aria-label"] === "Breadcrumb");
    const crumbHrefs = breadcrumb.findAll((n) => n.type === "a").map((n) => n.props.href);
    // Desktop Workspace segment + mobile parent — both the Workspace, never a Projects or Project segment.
    expect(crumbHrefs).toEqual([`/workspace/team/${WS}`, `/workspace/team/${WS}`]);
    const nav = r.root.find((n) => n.props["aria-label"] === "Workspace");
    expect(nav.findAll((n) => n.type === "a").map((n) => n.props.href)).not.toContain(`/workspace/team/${WS}/audit`);
    const current = r.root.findAll((n) => n.props["aria-current"] === "page").map((n) => JSON.stringify(n.children));
    expect(current).toEqual(expect.arrayContaining(['["What changed?"]', '["Overview"]']));
  });

  it("no breadcrumb, no heading and no Workspace/Project name on loading, unavailable, transient, auth or malformed states — only the Workspace nav", async () => {
    const cases: Array<() => void> = [
      () => mockedAuthedFetch.mockImplementation(() => new Promise(() => {})),
      () => mockedAuthedFetch.mockResolvedValue(response(404, { ok: false })),
      () => mockedAuthedFetch.mockResolvedValue(response(503, { ok: false })),
      () => mockedAuthedFetch.mockResolvedValue(response(401, { ok: false })),
      () => mockedAuthedFetch.mockResolvedValue(response(200, { ok: true })),
    ];
    for (const setup of cases) {
      mockedAuthedFetch.mockReset();
      setup();
      const r = await mount(PROJECT_PROPS);
      expect(r.root.findAll((n) => n.props["aria-label"] === "Breadcrumb")).toHaveLength(0);
      expect(r.root.findAll((n) => n.type === "h1")).toHaveLength(0);
      expect(text(r)).not.toContain("Launch Plan");
      expect(text(r)).not.toContain("Acme Team");
      expect(r.root.findAll((n) => n.props["aria-label"] === "Workspace")).toHaveLength(1);
    }
  });

  it("in-progress keeps the full chrome (breadcrumb + heading + nav) above the in-progress state", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ status: "queued" })));
    const r = await mount(PROJECT_PROPS);
    expect(r.root.findAll((n) => n.props["aria-label"] === "Breadcrumb")).toHaveLength(1);
    expect(r.root.findAll((n) => n.type === "h1")).toHaveLength(1);
  });
});

describe("Team metadata (§N/§O/§P)", () => {
  it("assignee active → 'Assigned to <displayName>'; the raw uid is never rendered", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { assignee: { uid: "uid-secret-bao", displayName: "Bao", state: "active" } })));
    const r = await mount(PROJECT_PROPS);
    const line = r.root.find((n) => n.props["data-testid"] === "team-run-assignee");
    const lineText = (function collect(node: TestRenderer.ReactTestInstance | string): string {
      return typeof node === "string" ? node : node.children.map((c) => collect(c as TestRenderer.ReactTestInstance | string)).join("");
    })(line);
    expect(lineText).toBe("Assigned to Bao");
    expect(text(r)).not.toContain("uid-secret-bao");
    expect(text(r)).not.toContain("No longer eligible");
  });

  it("assignee stale → 'No longer eligible' marker", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { assignee: { uid: "uid-bao", displayName: "Bao", state: "stale" } })));
    const r = await mount(PROJECT_PROPS);
    expect(text(r)).toContain("No longer eligible");
  });

  it("assignee null or malformed → no line, and never a uid", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { assignee: { uid: "uid-only", state: "active" } })));
    const r = await mount(PROJECT_PROPS);
    expect(r.root.findAll((n) => n.props["data-testid"] === "team-run-assignee")).toHaveLength(0);
    expect(text(r)).not.toContain("uid-only");
  });

  it("personal_research origin → a provenance line only: no source id, no link to a Personal artifact", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { origin: { kind: "personal_research", sourceCreatedAt: "2026-08-01T00:00:00.000Z", sourceCompletedAt: null, runId: "SECRET-personal-run" } })));
    const r = await mount(PROJECT_PROPS);
    expect(text(r)).toContain("Added from Personal research");
    expect(text(r)).not.toContain("SECRET-personal-run");
    for (const a of r.root.findAll((n) => n.type === "a")) expect(a.props.href).not.toMatch(/^\/workspace\/research\//);
  });

  it("no origin → no provenance line; a review summary never adds a mutation control", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { review: { humanReviewStatus: "pending", conditions: null, decidedVia: null, decisionReceipt: null } })));
    const r = await mount(PROJECT_PROPS);
    expect(r.root.findAll((n) => n.props["data-testid"] === "team-run-origin")).toHaveLength(0);
    const buttons = r.root.findAll((n) => n.type === "button");
    expect(buttons).toHaveLength(0);
  });
});

/**
 * The first three children of `<main>` rendered by the PRE-R3 Project detail
 * page for the `complete_ordinary` case (Workspace "Acme Team", Project
 * "ABC Acquisition", question "What changed?", assignee Bao active, audit
 * shown) — captured from `main` @ 3d0ad1de before the page was changed.
 */
const PRE_R3_COMPLETE_ORDINARY_CHROME = "[{\"type\":\"nav\",\"props\":{\"aria-label\":\"Breadcrumb\",\"className\":\"mb-3\"},\"children\":[{\"type\":\"ol\",\"props\":{\"className\":\"hidden sm:flex sm:items-center sm:gap-1.5\"},\"children\":[{\"type\":\"li\",\"props\":{\"className\":\"flex items-center gap-1.5\"},\"children\":[{\"type\":\"a\",\"props\":{\"href\":\"/workspace/team/ws-1\",\"className\":\"truncate max-w-[12rem] text-cp-muted transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded\"},\"children\":[\"Acme Team\"]}]},{\"type\":\"li\",\"props\":{\"className\":\"flex items-center gap-1.5\"},\"children\":[{\"type\":\"span\",\"props\":{\"className\":\"text-cp-faint\",\"aria-hidden\":\"true\"},\"children\":[\"/\"]},{\"type\":\"a\",\"props\":{\"href\":\"/workspace/team/ws-1/projects\",\"className\":\"truncate max-w-[12rem] text-cp-muted transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded\"},\"children\":[\"Projects\"]}]},{\"type\":\"li\",\"props\":{\"className\":\"flex items-center gap-1.5\"},\"children\":[{\"type\":\"span\",\"props\":{\"className\":\"text-cp-faint\",\"aria-hidden\":\"true\"},\"children\":[\"/\"]},{\"type\":\"a\",\"props\":{\"href\":\"/workspace/team/ws-1/projects/proj-1\",\"className\":\"truncate max-w-[12rem] text-cp-muted transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded\"},\"children\":[\"ABC Acquisition\"]}]},{\"type\":\"li\",\"props\":{\"className\":\"flex items-center gap-1.5\"},\"children\":[{\"type\":\"span\",\"props\":{\"className\":\"text-cp-faint\",\"aria-hidden\":\"true\"},\"children\":[\"/\"]},{\"type\":\"span\",\"props\":{\"className\":\"truncate max-w-[12rem] font-semibold text-cp-text\",\"aria-current\":\"page\",\"title\":\"What changed?\"},\"children\":[\"What changed?\"]}]}]},{\"type\":\"div\",\"props\":{\"className\":\"flex sm:hidden\"},\"children\":[{\"type\":\"a\",\"props\":{\"href\":\"/workspace/team/ws-1/projects/proj-1\",\"className\":\"inline-flex items-center gap-1 text-sm font-medium text-cp-muted transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded\"},\"children\":[{\"type\":\"span\",\"props\":{\"aria-hidden\":\"true\"},\"children\":[\"←\"]},\"ABC Acquisition\"]}]}]},{\"type\":\"div\",\"props\":{\"className\":\"mb-6\"},\"children\":[{\"type\":\"h1\",\"props\":{\"className\":\"text-xl font-semibold text-cp-text break-words\"},\"children\":[\"What changed?\"]},{\"type\":\"p\",\"props\":{\"className\":\"mt-1 text-sm text-cp-muted\",\"data-testid\":\"team-run-assignee\"},\"children\":[\"Assigned to \",{\"type\":\"span\",\"props\":{\"className\":\"font-medium text-cp-text\"},\"children\":[\"Bao\"]}]}]},{\"type\":\"nav\",\"props\":{\"aria-label\":\"Workspace\",\"className\":\"mb-6 flex gap-4 border-b border-cp-border-soft text-sm\"},\"children\":[{\"type\":\"a\",\"props\":{\"href\":\"/workspace/team/ws-1\",\"className\":\"px-1 pb-2 text-cp-muted hover:text-cp-text\"},\"children\":[\"Overview\"]},{\"type\":\"span\",\"props\":{\"aria-current\":\"page\",\"className\":\"border-b-2 border-cp-accent px-1 pb-2 font-medium text-cp-text\"},\"children\":[\"Projects\"]},{\"type\":\"a\",\"props\":{\"href\":\"/workspace/team/ws-1/members\",\"className\":\"px-1 pb-2 text-cp-muted hover:text-cp-text\"},\"children\":[\"Members\"]},{\"type\":\"a\",\"props\":{\"href\":\"/workspace/team/ws-1/audit\",\"className\":\"px-1 pb-2 text-cp-muted hover:text-cp-text\"},\"children\":[\"Audit Log\"]}]}]";

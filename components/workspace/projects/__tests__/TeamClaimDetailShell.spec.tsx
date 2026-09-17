/**
 * TEAM-VERIFICATION-PARITY-R4-I1 §G–§R/§W/§X — `TeamClaimDetailShell`.
 *
 * The hook, the href builders, `Breadcrumb`, `WorkspaceNav`, `GovernanceChip`
 * and the Project-label rule are REAL. `useAuth`, `authedFetch` and the router
 * are controlled boundaries; the shared R2 `ClaimVerificationResultView` is
 * stubbed to record exactly what reaches it (its own R2 suites prove the
 * painted body), and the PERSONAL `ClaimVerificationResult` wrapper is mocked
 * to a component that fails the test if it is ever mounted.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));

const pushed: string[] = [];
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: (href: string) => pushed.push(href) }) }));

const USER_A = { uid: "uid-a" };
let auth: { user: { uid: string } | null; authReady: boolean } = { user: USER_A, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

const viewProps: Record<string, unknown>[] = [];
jest.mock("@/components/verification/ClaimVerificationResultView", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    viewProps.push(props);
    const React = require("react");
    return React.createElement(
      "div",
      { "data-testid": "claim-result-view" },
      React.createElement("span", { key: "notice" }, (props.noticeSurface as never) ?? null),
      React.createElement("span", { key: "governance" }, (props.governanceSurface as never) ?? null),
      React.createElement("span", { key: "actions" }, (props.actionsSurface as never) ?? null)
    );
  },
}));

/** Mounting the Personal wrapper is a boundary violation, not a rendering choice. */
const personalWrapperMounts: number[] = [];
jest.mock("@/components/ClaimVerificationResult", () => ({
  __esModule: true,
  default: () => {
    personalWrapperMounts.push(1);
    return null;
  },
}));

import TeamClaimDetailShell, { teamClaimProjectLabel, type TeamClaimDetailShellProps } from "@/components/workspace/projects/TeamClaimDetailShell";
import { formatAbsoluteDate } from "@/lib/workspaces/reviewQueuePresentation";

const W = "ws-1";
const P = "proj-1";
const V = "vcl-1";
const RUN = "run-9";

const UNFILED_PROPS: TeamClaimDetailShellProps = { workspaceId: W, workspaceName: "Acme Team", verificationId: V, project: null, showAudit: false };
const PROJECT_PROPS: TeamClaimDetailShellProps = { workspaceId: W, workspaceName: "Acme Team", verificationId: V, project: { id: P, name: "Launch Plan" }, showAudit: true };

function payload(over: Record<string, unknown> = {}) {
  return {
    verificationId: V,
    claim: "The sky is blue.",
    verdict: "confirmed",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    modelEvidence: [],
    aggregateSummary: { totalModels: 3, modelsAgreeAccurate: 3, modelsAgreeInaccurate: 0, modelsPartial: 0, modelsUnverifiable: 0 },
    whereModelsAgree: [],
    whereModelsDisagree: [],
    auditBundle: { generatedAt: "2026-09-10T10:00:00.000Z", consensusScore: 88, evidenceQuality: "strong" },
    ...over,
  };
}

function body(teamOver: Record<string, unknown> = {}, payloadOver: Record<string, unknown> = {}) {
  return {
    ok: true,
    payload: payload(payloadOver),
    team: { workspaceId: W, projectId: null, project: null, createdAt: "2026-09-10T10:00:00.000Z", ...teamOver },
  };
}
const filedBody = (payloadOver: Record<string, unknown> = {}, projectOver: Record<string, unknown> = {}) =>
  body({ projectId: P, project: { id: P, name: "Launch Plan", status: "active", ...projectOver } }, payloadOver);

const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const focusedTags: string[] = [];
function nodeMock(element: { type: unknown }) {
  const tag = typeof element.type === "string" ? element.type : "component";
  return { focus: () => focusedTags.push(tag) };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(props: TeamClaimDetailShellProps) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(TeamClaimDetailShell, props), { createNodeMock: nodeMock });
  });
  await flush();
  return renderer;
}

async function update(r: TestRenderer.ReactTestRenderer, props: TeamClaimDetailShellProps) {
  await act(async () => {
    r.update(createElement(TeamClaimDetailShell, props));
  });
  await flush();
}

const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const urls = () => mockedAuthedFetch.mock.calls.map((c) => c[0] as string);
const lastView = () => viewProps[viewProps.length - 1];

/** Finds the rendered source-research button and clicks it. */
async function clickSource(r: TestRenderer.ReactTestRenderer) {
  const btn = r.root.findAll((n) => n.props?.["data-testid"] === "team-claim-source-research")[0];
  await act(async () => {
    (btn.props.onClick as () => void)();
  });
  await flush();
}

/** Flattens a rendered node's visible text. */
function nodeText(n: TestRenderer.ReactTestInstance | string): string {
  if (typeof n === "string") return n;
  return n.children.map((c) => nodeText(c as TestRenderer.ReactTestInstance | string)).join("");
}

/** Reads a testid's rendered text content. */
function testIdText(r: TestRenderer.ReactTestRenderer, id: string): string {
  const node = r.root.findAll((n) => n.props?.["data-testid"] === id)[0];
  return JSON.stringify(node.children);
}

beforeEach(() => {
  jest.clearAllMocks();
  viewProps.length = 0;
  personalWrapperMounts.length = 0;
  pushed.length = 0;
  focusedTags.length = 0;
  auth = { user: USER_A, authReady: true };
});

describe("rendering the Claim", () => {
  it("renders an Unfiled Claim at the Unfiled address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount(UNFILED_PROPS);
    expect(urls()).toEqual(["/api/workspaces/ws-1/verifications/vcl-1"]);
    expect(text(r)).toContain("claim-result-view");
    expect(lastView().data).toEqual(expect.objectContaining({ claim: "The sky is blue." }));
  });

  it("renders a Project-bound Claim at the Project address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, filedBody()));
    const r = await mount(PROJECT_PROPS);
    expect(urls()).toEqual(["/api/workspaces/ws-1/verifications/vcl-1?projectId=proj-1"]);
    expect(text(r)).toContain("claim-result-view");
  });

  it("uses the shared R2 view and never the Personal wrapper", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED_PROPS);
    expect(viewProps).toHaveLength(1);
    expect(personalWrapperMounts).toHaveLength(0);
  });

  it("makes no Personal or governance network call", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { governanceStatus: "approved" })));
    await mount(UNFILED_PROPS);
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    for (const u of urls()) {
      expect(u).not.toContain("/api/user/");
      expect(u).not.toContain("run-governance");
      expect(u).not.toContain("/api/governance/");
      expect(u).not.toContain("panel-history");
    }
  });

  it("performs no write of any kind", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED_PROPS);
    for (const call of mockedAuthedFetch.mock.calls) {
      expect((call[1] as { method: string }).method).toBe("GET");
      expect((call[1] as { body?: unknown }).body).toBeUndefined();
    }
  });
});

describe("route containment", () => {
  it("renders no Claim body for a Project-bound response at the Unfiled address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, filedBody()));
    const r = await mount(UNFILED_PROPS);
    expect(viewProps).toHaveLength(0);
    expect(text(r)).not.toContain("claim-result-view");
    expect(text(r)).toContain("Claim not found.");
  });

  it("renders no Claim body for an Unfiled response at a Project address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount(PROJECT_PROPS);
    expect(viewProps).toHaveLength(0);
    expect(text(r)).toContain("Claim not found.");
  });

  it("renders no Claim body for a response filed in a different Project", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ projectId: "proj-other", project: { id: "proj-other", name: "Other", status: "active" } })));
    const r = await mount(PROJECT_PROPS);
    expect(viewProps).toHaveLength(0);
    expect(text(r)).toContain("Claim not found.");
  });

  it("never auto-navigates to a Claim's real location on containment failure", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, filedBody()));
    await mount(UNFILED_PROPS);
    expect(pushed).toEqual([]);
  });
});

describe("Project label semantics", () => {
  it("labels a genuinely unfiled Claim `Unfiled`", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount(UNFILED_PROPS);
    expect(testIdText(r, "team-claim-project-label")).toContain("Unfiled");
  });

  it("labels a filed Claim with its Project name", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, filedBody()));
    const r = await mount(PROJECT_PROPS);
    expect(testIdText(r, "team-claim-project-label")).toContain("Launch Plan");
  });

  it("labels a filed Claim whose Project is unresolvable `Project unavailable`, NEVER `Unfiled`", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ projectId: P, project: null })));
    const r = await mount(PROJECT_PROPS);
    const label = testIdText(r, "team-claim-project-label");
    expect(label).toContain("Project unavailable");
    expect(label).not.toContain("Unfiled");
  });

  it("is decided by the pure rule, independent of rendering", () => {
    expect(teamClaimProjectLabel({ workspaceId: W, projectId: null, project: null, createdAt: "x" })).toBe("Unfiled");
    expect(teamClaimProjectLabel({ workspaceId: W, projectId: P, project: null, createdAt: "x" })).toBe("Project unavailable");
    expect(teamClaimProjectLabel({ workspaceId: W, projectId: P, project: { id: P, name: "Launch Plan", status: "active" }, createdAt: "x" })).toBe("Launch Plan");
  });

  it("keeps an archived Project readable and marks its status", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, filedBody({}, { status: "archived" })));
    const r = await mount(PROJECT_PROPS);
    expect(text(r)).toContain("claim-result-view");
    expect(text(r)).toContain("Archived");
    expect(testIdText(r, "team-claim-project-label")).toContain("Launch Plan");
  });

  it("renders the created date through the shared absolute formatter, not a raw timestamp", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount(UNFILED_PROPS);
    const rendered = testIdText(r, "team-claim-created-at");
    // Exactly what every other Team/Project surface would print for this ISO.
    expect(rendered).toContain(formatAbsoluteDate("2026-09-10T10:00:00.000Z") as string);
    expect(rendered).not.toContain("2026-09-10T10:00:00.000Z");
  });

  it("renders no created-at line when the stored timestamp is unusable", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ createdAt: "not-a-date" })));
    const r = await mount(UNFILED_PROPS);
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claim-created-at")).toHaveLength(0);
  });
});

describe("governance boundary", () => {
  it("renders the stored status into the shared view's governance slot", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { governanceStatus: "needs_review" })));
    const r = await mount(UNFILED_PROPS);
    expect(lastView().governanceSurface).toBeTruthy();
    expect(text(r)).toContain("Review");
  });

  it("renders no governance surface when the status is absent", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED_PROPS);
    expect(lastView().governanceSurface).toBeUndefined();
  });

  it("never infers a governance status", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount(UNFILED_PROPS);
    expect(text(r)).not.toContain("Approved");
    expect(text(r)).not.toContain("Blocked");
  });
});

describe("actions boundary", () => {
  it("passes no actions or notice surface, so no export/clipboard/Verify-another ships", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount(UNFILED_PROPS);
    expect(lastView().actionsSurface).toBeUndefined();
    expect(lastView().noticeSurface).toBeUndefined();
    const rendered = text(r);
    expect(rendered).not.toContain("Verify another");
    expect(rendered).not.toContain("Download");
    expect(rendered).not.toContain("Copy");
    expect(rendered).not.toContain("memo");
  });
});

describe("breadcrumb relationships", () => {
  /** Each crumb as [label, href] — the EDGE, not merely the participant. */
  function edges(r: TestRenderer.ReactTestRenderer): Array<[string, string | undefined]> {
    const nav = r.root.findAll((n) => n.props?.["aria-label"] === "Breadcrumb")[0];
    const list = nav.findAll((n) => n.type === "ol")[0];
    return list.findAll((n) => n.type === "li").map((li) => {
      const link = li.findAll((n) => n.type === "a");
      return [labelOf(li), link.length ? (link[0].props.href as string) : undefined];
    });
  }
  function labelOf(li: TestRenderer.ReactTestInstance): string {
    const strings: string[] = [];
    const walk = (n: unknown) => {
      if (typeof n === "string") strings.push(n);
      else if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object" && "children" in (n as Record<string, unknown>)) walk((n as { children: unknown }).children);
    };
    walk(li.children);
    return strings.filter((s) => s !== "/").join("");
  }

  it("links Workspace -> Claims -> Claim on the Unfiled address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount(UNFILED_PROPS);
    expect(edges(r)).toEqual([
      ["Acme Team", "/workspace/team/ws-1"],
      // R4-I2 ships /workspace/team/{W}/claims; until then this crumb carries
      // no href rather than pointing at a route this slice does not deploy.
      ["Claims", undefined],
      ["The sky is blue.", undefined],
    ]);
  });

  it("links Workspace -> Projects -> Project -> Claim on the Project address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, filedBody()));
    const r = await mount(PROJECT_PROPS);
    expect(edges(r)).toEqual([
      ["Acme Team", "/workspace/team/ws-1"],
      ["Projects", "/workspace/team/ws-1/projects"],
      ["Launch Plan", "/workspace/team/ws-1/projects/proj-1"],
      ["The sky is blue.", undefined],
    ]);
  });

  it("renders no breadcrumb at all when the Claim was not loaded", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404));
    const r = await mount(UNFILED_PROPS);
    expect(r.root.findAll((n) => n.props?.["aria-label"] === "Breadcrumb")).toHaveLength(0);
  });
});

describe("error presentation", () => {
  it("shows the exact concealed copy on 404 and announces it to assistive technology", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404));
    const r = await mount(UNFILED_PROPS);
    // Concealment copy and the safe way back, unchanged.
    expect(text(r)).toContain("Claim not found.");
    expect(text(r)).toContain("/workspace/team/ws-1");
    // R4-I1-C1: the not-found state appears ASYNCHRONOUSLY after a fetch, so it
    // must be announced exactly like every other result-state error. Asserting
    // the alert CONTAINS the not-found copy — not merely that some alert exists
    // somewhere — is what makes this assertion specific to this container.
    const alerts = r.root.findAll((n) => n.props?.role === "alert");
    expect(alerts).toHaveLength(1);
    expect(nodeText(alerts[0])).toContain("Claim not found.");
  });

  it.each([
    [403, "permission"],
    [500, "Something went wrong while reading this claim"],
    [503, "please try again"],
  ])("renders an alert for HTTP %s", async (status, needle) => {
    mockedAuthedFetch.mockResolvedValue(response(status as number));
    const r = await mount(UNFILED_PROPS);
    expect(r.root.findAll((n) => n.props?.role === "alert").length).toBeGreaterThan(0);
    expect(text(r).toLowerCase()).toContain(String(needle).toLowerCase());
  });

  it("renders an auth alert after two 401s", async () => {
    mockedAuthedFetch.mockResolvedValue(response(401));
    const r = await mount(UNFILED_PROPS);
    expect(text(r)).toContain("verify your session");
    expect(r.root.findAll((n) => n.props?.role === "alert").length).toBeGreaterThan(0);
  });

  it("never presents a server failure as an empty success", async () => {
    for (const status of [500, 503]) {
      viewProps.length = 0;
      mockedAuthedFetch.mockResolvedValue(response(status));
      const r = await mount(UNFILED_PROPS);
      expect(viewProps).toHaveLength(0);
      expect(text(r)).not.toContain("Claim not found.");
      expect(text(r)).toContain("couldn");
    }
  });

  it("offers a read-only retry on a transient failure", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200, body()));
    const r = await mount(UNFILED_PROPS);
    const btn = r.root.findAll((n) => n.type === "button" && JSON.stringify(n.children).includes("Try again"))[0];
    await act(async () => {
      (btn.props.onClick as () => void)();
    });
    await flush();
    expect(text(r)).toContain("claim-result-view");
    expect(mockedAuthedFetch.mock.calls.every((c) => (c[1] as { method: string }).method === "GET")).toBe(true);
  });
});

describe("focus management", () => {
  it("moves focus to the Claim heading after a successful load", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED_PROPS);
    expect(focusedTags).toEqual(["h1"]);
  });

  it("does not steal focus when the Claim could not be loaded", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404));
    await mount(UNFILED_PROPS);
    expect(focusedTags).toEqual([]);
  });

  it("does not re-focus on an unrelated state change", async () => {
    mockedAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes("/runs/") ? response(404) : response(200, body({}, { sourceResearch: { type: "deep_research_claim", runId: RUN, claimId: "v1:a:0:x" } })))
    );
    const r = await mount(UNFILED_PROPS);
    expect(focusedTags).toEqual(["h1"]);
    await clickSource(r);
    expect(focusedTags).toEqual(["h1"]);
  });
});

describe("source research affordance", () => {
  const withSource = (over: Record<string, unknown> = {}) => body(over, { sourceResearch: { type: "deep_research_claim", runId: RUN, claimId: "v1:a:0:x" } });

  it("renders no affordance when sourceResearch is null", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { sourceResearch: null })));
    const r = await mount(UNFILED_PROPS);
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claim-source-research")).toHaveLength(0);
  });

  it("renders no affordance when sourceResearch is absent", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount(UNFILED_PROPS);
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claim-source-research")).toHaveLength(0);
  });

  it("renders the affordance when sourceResearch is present", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, withSource()));
    const r = await mount(UNFILED_PROPS);
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claim-source-research")).toHaveLength(1);
  });

  it("performs no source lookup on mount — only on click", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, withSource()));
    await mount(UNFILED_PROPS);
    expect(urls().filter((u) => u.includes("/runs/"))).toEqual([]);
  });

  it("resolves the source run WITHOUT projectId and navigates to an Unfiled Research address", async () => {
    mockedAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes("/runs/") ? response(200, { ok: true, team: { workspaceId: W, projectId: null } }) : response(200, withSource()))
    );
    const r = await mount(UNFILED_PROPS);
    await clickSource(r);
    expect(urls().filter((u) => u.includes("/runs/"))).toEqual(["/api/workspaces/ws-1/runs/run-9"]);
    expect(pushed).toEqual(["/workspace/team/ws-1/research/run-9"]);
  });

  it("builds a Project Research address from the source run's OWN current projectId", async () => {
    // The Claim is filed in proj-1; the source run currently lives in proj-2.
    // The address must follow the RUN, never the Claim.
    mockedAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes("/runs/") ? response(200, { ok: true, team: { workspaceId: W, projectId: "proj-2" } }) : response(200, filedBody({ sourceResearch: { type: "deep_research_claim", runId: RUN, claimId: "v1:a:0:x" } })))
    );
    const r = await mount(PROJECT_PROPS);
    await clickSource(r);
    expect(urls().filter((u) => u.includes("/runs/"))).toEqual(["/api/workspaces/ws-1/runs/run-9"]);
    expect(pushed).toEqual(["/workspace/team/ws-1/projects/proj-2/research/run-9"]);
  });

  it("never uses a Personal research route", async () => {
    mockedAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes("/runs/") ? response(200, { ok: true, team: { workspaceId: W, projectId: null } }) : response(200, withSource()))
    );
    const r = await mount(UNFILED_PROPS);
    await clickSource(r);
    for (const u of [...urls(), ...pushed]) {
      expect(u).not.toContain("/api/user/");
      expect(u).not.toContain("/workspace/research/");
      expect(u).not.toContain("?tab=verify");
    }
  });

  it.each([[404], [403]])("shows one neutral unavailable state for a concealed %s and never navigates", async (status) => {
    mockedAuthedFetch.mockImplementation((url: string) => Promise.resolve(url.includes("/runs/") ? response(status as number) : response(200, withSource())));
    const r = await mount(UNFILED_PROPS);
    await clickSource(r);
    expect(text(r)).toContain("Source research is no longer available.");
    expect(pushed).toEqual([]);
  });

  it("does not navigate when the source run belongs to another Workspace", async () => {
    mockedAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes("/runs/") ? response(200, { ok: true, team: { workspaceId: "ws-other", projectId: null } }) : response(200, withSource()))
    );
    const r = await mount(UNFILED_PROPS);
    await clickSource(r);
    expect(pushed).toEqual([]);
    expect(text(r)).toContain("Source research is no longer available.");
  });

  it("permits retry after an infrastructure failure", async () => {
    mockedAuthedFetch.mockImplementation((url: string) => Promise.resolve(url.includes("/runs/") ? response(503) : response(200, withSource())));
    const r = await mount(UNFILED_PROPS);
    await clickSource(r);
    expect(text(r)).toContain("couldn't open the source research");
    expect(pushed).toEqual([]);

    mockedAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes("/runs/") ? response(200, { ok: true, team: { workspaceId: W, projectId: null } }) : response(200, withSource()))
    );
    await clickSource(r);
    expect(pushed).toEqual(["/workspace/team/ws-1/research/run-9"]);
  });

  it("a stale source lookup can never navigate after the Claim context changes", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockImplementation((url: string) => (url.includes("/runs/") ? slow.promise : Promise.resolve(response(200, withSource()))));

    const r = await mount(UNFILED_PROPS);
    await clickSource(r);
    // The viewer moves to a different Claim while A's source lookup is open.
    await update(r, { ...UNFILED_PROPS, verificationId: "vcl-2" });

    await act(async () => {
      slow.resolve(response(200, { ok: true, team: { workspaceId: W, projectId: null } }));
      await slow.promise;
    });
    await flush();

    expect(pushed).toEqual([]);
  });
});

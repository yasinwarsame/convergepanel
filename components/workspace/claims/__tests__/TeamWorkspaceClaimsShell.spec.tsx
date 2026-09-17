/**
 * TEAM-VERIFICATION-PARITY-R4-I2 §AF — `TeamWorkspaceClaimsShell`.
 *
 * The list hook, `TeamClaimListRow`, `Breadcrumb`, `WorkspaceNav`,
 * `SectionState` and `teamClaimDetailHref` are all REAL — only `useAuth` and
 * `authedFetch` are controlled. That makes the scope-switch assertions
 * meaningful: they prove the shell asks the SERVER for `?scope=unfiled` rather
 * than filtering an "all" response.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, ...rest }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className, ...rest }, children as never),
}));

const USER_A = { uid: "uid-a" };
let auth: { user: { uid: string } | null; authReady: boolean } = { user: USER_A, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import TeamWorkspaceClaimsShell from "@/components/workspace/claims/TeamWorkspaceClaimsShell";

const W = "ws-1";
const P = "proj-1";
const PROPS = { workspaceId: W, workspaceName: "Acme Team", showAudit: true };

function item(over: Record<string, unknown> = {}) {
  return {
    verificationId: "vcl-1",
    claim: "The sky is blue.",
    verdict: "confirmed",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    createdAt: "2026-09-10T10:00:00.000Z",
    workspaceId: W,
    projectId: null,
    project: null,
    ...over,
  };
}
const filed = (over: Record<string, unknown> = {}) => item({ projectId: P, project: { id: P, name: "Launch Plan", status: "active" }, ...over });
const body = (items: unknown[], scope = "all", over: Record<string, unknown> = {}) => ({ ok: true, items, hasMore: false, scope, ...over });
const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(TeamWorkspaceClaimsShell, PROPS));
  });
  await flush();
  return r;
}

const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());

/** Flattens a rendered node's visible text (test instances are circular; JSON.stringify is not safe on them). */
function nodeText(n: TestRenderer.ReactTestInstance | string): string {
  if (typeof n === "string") return n;
  return n.children.map((c) => nodeText(c as TestRenderer.ReactTestInstance | string)).join("");
}
const urls = () => mockedAuthedFetch.mock.calls.map((c) => c[0] as string);

async function clickTestId(r: TestRenderer.ReactTestRenderer, id: string) {
  const n = r.root.findAll((x) => x.props?.["data-testid"] === id)[0];
  await act(async () => {
    (n.props.onClick as () => void)();
  });
  await flush();
}

async function clickText(r: TestRenderer.ReactTestRenderer, label: string) {
  const n = r.root.findAll((x) => x.type === "button" && nodeText(x).includes(label))[0];
  await act(async () => {
    (n.props.onClick as () => void)();
  });
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  auth = { user: USER_A, authReady: true };
});

describe("chrome", () => {
  it("renders the Claims heading with Claims as the active nav item", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    const r = await mount();
    const nav = r.root.findAll((n) => n.props?.["aria-label"] === "Workspace")[0];
    const current = nav.findAll((n) => n.props?.["aria-current"] === "page");
    expect(nodeText(current[0])).toContain("Claims");
    expect(text(r)).toContain("Claims");
  });

  it("breadcrumbs Workspace -> Claims, with Claims as the current segment", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    const r = await mount();
    const bc = r.root.findAll((n) => n.props?.["aria-label"] === "Breadcrumb")[0];
    const lis = bc.findAll((n) => n.type === "ol")[0].findAll((n) => n.type === "li");
    expect(lis).toHaveLength(2);
    expect(lis[0].findAll((n) => n.type === "a")[0].props.href).toBe("/workspace/team/ws-1");
    expect(nodeText(lis[1])).toContain("Claims");
    expect(lis[1].findAll((n) => n.type === "a")).toHaveLength(0);
  });

  it("ships no create control and no counts", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([item()])));
    const r = await mount();
    const rendered = text(r);
    for (const forbidden of ["Verify a claim", "New claim", "Start", "claims)", "(1)"]) expect(rendered).not.toContain(forbidden);
  });
});

describe("server-backed scope", () => {
  it("defaults to All and calls the All endpoint", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    const r = await mount();
    expect(urls()).toEqual(["/api/workspaces/ws-1/verifications"]);
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claims-filter-all")[0].props["aria-pressed"]).toBe(true);
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claims-filter-unfiled")[0].props["aria-pressed"]).toBe(false);
  });

  it("selecting Unfiled issues the server scope request, not a client-side filter", async () => {
    mockedAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes("scope=unfiled") ? response(200, body([item()], "unfiled")) : response(200, body([item(), filed({ verificationId: "vcl-2" })])))
    );
    const r = await mount();
    expect(urls()).toEqual(["/api/workspaces/ws-1/verifications"]);
    await clickTestId(r, "team-claims-filter-unfiled");
    expect(urls()[1]).toBe("/api/workspaces/ws-1/verifications?scope=unfiled");
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claims-filter-unfiled")[0].props["aria-pressed"]).toBe(true);
  });

  it("clears the previous scope's rows on switch", async () => {
    mockedAuthedFetch.mockImplementation((url: string) =>
      url.includes("scope=unfiled") ? Promise.resolve(response(200, body([], "unfiled"))) : Promise.resolve(response(200, body([filed({ claim: "ALL-ONLY CLAIM" })])))
    );
    const r = await mount();
    expect(text(r)).toContain("ALL-ONLY CLAIM");
    await clickTestId(r, "team-claims-filter-unfiled");
    expect(text(r)).not.toContain("ALL-ONLY CLAIM");
    expect(text(r)).toContain("No unfiled claims.");
  });
});

describe("rows", () => {
  it("links a filed row to its Project detail address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([filed()])));
    const r = await mount();
    const row = r.root.findAll((n) => n.props?.["data-testid"] === "team-claim-row")[0];
    expect(row.props.href).toBe("/workspace/team/ws-1/projects/proj-1/claims/vcl-1");
  });

  it("links an Unfiled row to the Unfiled detail address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([item()])));
    const r = await mount();
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claim-row")[0].props.href).toBe("/workspace/team/ws-1/claims/vcl-1");
  });
});

describe("states", () => {
  it("renders a loading state before the first response", async () => {
    mockedAuthedFetch.mockReturnValue(new Promise(() => {}));
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(createElement(TeamWorkspaceClaimsShell, PROPS));
    });
    expect(text(r)).toContain("Loading claims…");
  });

  it("renders the All empty copy", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    expect(text(await mount())).toContain("No claims in this Workspace yet.");
  });

  it("renders the Unfiled empty copy", async () => {
    mockedAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes("scope=unfiled") ? response(200, body([], "unfiled")) : response(200, body([])))
    );
    const r = await mount();
    await clickTestId(r, "team-claims-filter-unfiled");
    expect(text(r)).toContain("No unfiled claims.");
  });

  it("renders an alert on an initial failure and never an empty success", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, { ok: false, errorCode: "internal_error" }));
    const r = await mount();
    expect(r.root.findAll((n) => n.props?.role === "alert").length).toBeGreaterThan(0);
    expect(text(r)).not.toContain("No claims in this Workspace yet.");
  });

  it("retries an initial failure", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(503, { ok: false, errorCode: "team_workspace_unavailable" })).mockResolvedValueOnce(response(200, body([item()])));
    const r = await mount();
    expect(text(r)).toContain("Couldn't load claims right now.");
    await clickText(r, "Try again");
    expect(text(r)).toContain("The sky is blue.");
  });

  it("conceals a denied Workspace without revealing whether it exists", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404, { ok: false, errorCode: "team_workspace_not_found" }));
    const r = await mount();
    expect(text(r)).toContain("Claims are no longer available here.");
    expect(text(r)).not.toContain("ws-1 ");
  });

  it("loads more and appends", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, body([item()], "all", { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(200, body([item({ verificationId: "vcl-2", claim: "Second claim." })])));
    const r = await mount();
    await clickText(r, "Load more");
    expect(text(r)).toContain("The sky is blue.");
    expect(text(r)).toContain("Second claim.");
  });

  it("keeps already-rendered rows when load-more fails", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, body([item()], "all", { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(500, { ok: false, errorCode: "internal_error" }));
    const r = await mount();
    await clickText(r, "Load more");
    expect(text(r)).toContain("The sky is blue.");
    expect(text(r)).toContain("We couldn't display these claims safely.");
  });
});

describe("boundaries", () => {
  it("makes no Personal or governance request and never writes", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([item({ governanceStatus: "approved" })])));
    await mount();
    for (const u of urls()) {
      expect(u).not.toContain("/api/user/");
      expect(u).not.toContain("run-governance");
      expect(u).not.toContain("/api/governance/");
      expect(u).not.toContain("panel-history");
    }
    for (const call of mockedAuthedFetch.mock.calls) {
      expect((call[1] as { method: string }).method).toBe("GET");
      expect((call[1] as { body?: unknown }).body).toBeUndefined();
    }
  });
});

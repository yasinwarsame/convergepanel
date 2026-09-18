/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AN — `TeamWorkspaceVideosShell`.
 *
 * The list hook, `TeamVideoListRow`, `Breadcrumb`, `WorkspaceNav`,
 * `SectionState` and `teamVideoDetailHref` are all REAL — only `useAuth` and
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

import TeamWorkspaceVideosShell from "@/components/workspace/videos/TeamWorkspaceVideosShell";

const W = "ws-1";
const P = "proj-1";
const PROPS = { workspaceId: W, workspaceName: "Acme Team", showAudit: true };

function item(over: Record<string, unknown> = {}) {
  return {
    verificationId: "vid-1",
    fileName: "clip.mp4",
    verdict: "authentic_captured",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    frameCount: 8,
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

async function mount(props: Record<string, unknown> = PROPS) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(TeamWorkspaceVideosShell, props as never));
  });
  await flush();
  return r;
}

const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const urls = () => mockedAuthedFetch.mock.calls.map((c) => c[0] as string);

function nodeText(n: TestRenderer.ReactTestInstance | string): string {
  if (typeof n === "string") return n;
  return n.children.map((c) => nodeText(c as TestRenderer.ReactTestInstance | string)).join("");
}

async function clickTestId(r: TestRenderer.ReactTestRenderer, id: string) {
  const n = r.root.findAll((x) => x.props?.["data-testid"] === id)[0];
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
  it("renders the Workspace → Videos breadcrumb and the Videos heading", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    const r = await mount();
    const html = text(r);
    expect(html).toContain("Acme Team");
    expect(html).toContain("Videos");
    expect(html).toContain('"href":"/workspace/team/ws-1"');
  });

  it("marks Videos as the active navigation destination", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    const r = await mount();
    const current = r.root.findAll((x) => x.props?.["aria-current"] === "page");
    expect(current.map((n) => nodeText(n))).toContain("Videos");
  });

  it("passes showAudit through to the nav", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    expect(text(await mount({ ...PROPS, showAudit: false }))).not.toContain("Audit Log");
    jest.clearAllMocks();
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    expect(text(await mount({ ...PROPS, showAudit: true }))).toContain("Audit Log");
  });
});

describe("All / Unfiled selects the SERVER scope", () => {
  it("defaults to All and requests the Workspace list", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([item()])));
    const r = await mount();
    expect(urls()).toEqual(["/api/workspaces/ws-1/video-verifications"]);
    const pressed = r.root.findAll((x) => x.props?.["data-testid"] === "team-videos-filter-all")[0];
    expect(pressed.props["aria-pressed"]).toBe(true);
  });

  it("switching to Unfiled issues the server scope request, not a client filter", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, body([item(), filed({ verificationId: "vid-2" })]))).mockResolvedValueOnce(response(200, body([item()], "unfiled")));
    const r = await mount();
    await clickTestId(r, "team-videos-filter-unfiled");
    expect(urls()[1]).toBe("/api/workspaces/ws-1/video-verifications?scope=unfiled");
  });

  it("switching back to All returns to the All request", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, body([item()])))
      .mockResolvedValueOnce(response(200, body([item()], "unfiled")))
      .mockResolvedValueOnce(response(200, body([item()])));
    const r = await mount();
    await clickTestId(r, "team-videos-filter-unfiled");
    await clickTestId(r, "team-videos-filter-all");
    expect(urls()).toEqual([
      "/api/workspaces/ws-1/video-verifications",
      "/api/workspaces/ws-1/video-verifications?scope=unfiled",
      "/api/workspaces/ws-1/video-verifications",
    ]);
  });

  it("the filter group is an accessible toggle group", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    const r = await mount();
    const group = r.root.findAll((x) => x.props?.role === "group")[0];
    expect(group.props["aria-label"]).toBe("Filter videos");
    const unfiled = r.root.findAll((x) => x.props?.["data-testid"] === "team-videos-filter-unfiled")[0];
    expect(unfiled.props["aria-pressed"]).toBe(false);
  });
});

describe("list states", () => {
  it("loading", async () => {
    mockedAuthedFetch.mockReturnValue(new Promise(() => {}));
    expect(text(await mount())).toContain("Loading videos…");
  });

  it("empty All", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    expect(text(await mount())).toContain("No videos in this Workspace yet.");
  });

  it("empty Unfiled uses its own copy", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, body([]))).mockResolvedValueOnce(response(200, body([], "unfiled")));
    const r = await mount();
    await clickTestId(r, "team-videos-filter-unfiled");
    expect(text(r)).toContain("No unfiled videos.");
  });

  it("an initial error uses video-specific copy, never claim copy", async () => {
    mockedAuthedFetch.mockResolvedValue(response(503, { errorCode: "team_workspace_unavailable" }));
    const r = await mount();
    // Scoped to the alert itself: the nav legitimately links to Claims, so a
    // whole-document search for "claim" would fail for the wrong reason.
    const alert = r.root.findAll((x) => x.props?.role === "alert")[0];
    const copy = nodeText(alert);
    expect(copy).toContain("Couldn't load videos right now. Please try again.");
    expect(copy.toLowerCase()).not.toContain("claim");
  });

  it("rows render and route from their own binding", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([item(), filed({ verificationId: "vid-2" })])));
    const html = text(await mount());
    expect(html).toContain('"href":"/workspace/team/ws-1/videos/vid-1"');
    expect(html).toContain('"href":"/workspace/team/ws-1/projects/proj-1/videos/vid-2"');
  });

  it("Workspace-wide rows show the Project column", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([filed()])));
    expect(text(await mount())).toContain("Launch Plan");
  });

  it("pagination appears only when there is more", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([item()], "all", { hasMore: true, nextCursor: "c1" })));
    expect(text(await mount())).toMatch(/load more/i);
  });
});

describe("no creation surface", () => {
  it("renders no New Video control for any caller", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([item()])));
    const html = text(await mount());
    expect(html).not.toContain("New Video");
    expect(html).not.toContain("Upload");
    expect(html).not.toContain("videos/new");
  });

  it("accepts no create capability prop at all", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body([])));
    // Passing a create hint must not conjure a control — the prop does not exist.
    const html = text(await mount({ ...PROPS, canCreateVideo: true }));
    expect(html).not.toContain("New Video");
  });
});

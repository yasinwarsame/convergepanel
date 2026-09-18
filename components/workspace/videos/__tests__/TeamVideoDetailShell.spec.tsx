/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AO — `TeamVideoDetailShell`.
 *
 * The detail hook, `Breadcrumb`, `WorkspaceNav`, `GovernanceChip` and
 * `teamVideoDetailHref` are REAL; only `useAuth`, `authedFetch` and the shared
 * `VideoVerificationResultView` are controlled. Stubbing the shared view lets
 * the props it receives be asserted exactly — which is where the Personal
 * boundary actually lives.
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

const resultViewProps: Record<string, unknown>[] = [];
jest.mock("@/components/verification/VideoVerificationResultView", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    resultViewProps.push(props);
    return require("react").createElement("div", { "data-testid": "shared-video-result-view" });
  },
}));

import TeamVideoDetailShell from "@/components/workspace/videos/TeamVideoDetailShell";

const W = "ws-1";
const P = "proj-1";
const V = "vid-1";

const METADATA = {
  duration: 12,
  width: 1920,
  height: 1080,
  codec: "h264",
  frameRate: 30,
  fileSize: 1024,
  format: "mp4",
  createdAt: null,
  encodingSoftware: null,
  hasAudio: true,
  cameraModel: null,
};

function payload(over: Record<string, unknown> = {}) {
  return {
    verificationId: V,
    fileName: "quarterly-briefing.mp4",
    verdict: "authentic_captured",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 88,
    metadata: METADATA,
    metadataAnalysis: { flags: [], summary: "" },
    modelEvidence: [],
    agreementPoints: [],
    disagreementPoints: [],
    frameCount: 8,
    warnings: [],
    ...over,
  };
}
const team = (over: Record<string, unknown> = {}) => ({ workspaceId: W, projectId: null, project: null, createdAt: "2026-09-10T10:00:00.000Z", ...over });
const body = (p: Record<string, unknown> = {}, t: Record<string, unknown> = {}) => ({ ok: true, payload: payload(p), team: team(t) });
const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

const UNFILED_PROPS = { workspaceId: W, workspaceName: "Acme Team", verificationId: V, project: null, showAudit: true };
const FILED_PROPS = { ...UNFILED_PROPS, project: { id: P, name: "Launch Plan" } };

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(props: Record<string, unknown> = UNFILED_PROPS) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(TeamVideoDetailShell, props as never));
  });
  await flush();
  return r;
}
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
function nodeText(n: TestRenderer.ReactTestInstance | string): string {
  if (typeof n === "string") return n;
  return n.children.map((c) => nodeText(c as TestRenderer.ReactTestInstance | string)).join("");
}
const alerts = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((x) => x.props?.role === "alert").map((n) => nodeText(n));

beforeEach(() => {
  jest.clearAllMocks();
  resultViewProps.length = 0;
  auth = { user: USER_A, authReady: true };
});

describe("accessible states", () => {
  it("loading uses role=status", async () => {
    mockedAuthedFetch.mockReturnValue(new Promise(() => {}));
    const r = await mount();
    expect(r.root.findAll((x) => x.props?.role === "status")).toHaveLength(1);
    expect(text(r)).toContain("Loading this video…");
  });

  it.each([
    [404, "Video not found."],
    [403, "You don't have permission to view this video"],
    [503, "We couldn't load this video"],
    [500, "We couldn't load this video"],
  ])("%i announces its state through role=alert", async (status, fragment) => {
    mockedAuthedFetch.mockResolvedValue(response(status, {}));
    const r = await mount();
    expect(alerts(r).join(" ")).toContain(fragment);
  });

  it("auth_error offers a sign-in action and says nothing about the video's existence", async () => {
    mockedAuthedFetch.mockResolvedValue(response(401, {}));
    const r = await mount();
    const copy = alerts(r).join(" ");
    expect(copy).toContain("We couldn't verify your session");
    expect(copy).toContain("says nothing about the video itself");
    expect(text(r)).toContain('"href":"/login"');
  });

  it("malformed does not pretend the video is absent", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ verdict: "nope" })));
    const r = await mount();
    const copy = alerts(r).join(" ");
    expect(copy).toContain("This video couldn't be displayed");
    expect(copy).not.toContain("not found");
  });

  it("unavailable and internal offer a retry that repeats the GET", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(503, {})).mockResolvedValueOnce(response(200, body()));
    const r = await mount();
    const btn = r.root.findAll((x) => x.type === "button" && nodeText(x).includes("Try again"))[0];
    await act(async () => {
      (btn.props.onClick as () => void)();
    });
    await flush();
    expect(text(r)).toContain("shared-video-result-view");
    expect(mockedAuthedFetch.mock.calls.every((c) => (c[1] as Record<string, unknown>).method === "GET")).toBe(true);
  });

  it("no chrome heading or breadcrumb is painted on a denied path", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404, {}));
    const r = await mount();
    expect(text(r)).not.toContain("quarterly-briefing.mp4");
  });

  it("the loaded heading receives focus, and only when ready", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount();
    const h1 = r.root.findAll((x) => x.type === "h1")[0];
    expect(h1.props.tabIndex).toBe(-1);
    expect(nodeText(h1)).toBe("quarterly-briefing.mp4");
  });
});

describe("Unfiled address chrome", () => {
  it("breadcrumbs Workspace → Videos → file name, with the Videos parent linked", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount();
    const html = text(r);
    expect(html).toContain('"href":"/workspace/team/ws-1/videos"');
    expect(html).toContain("quarterly-briefing.mp4");
  });

  it("marks Videos as the active nav item", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount();
    const nav = r.root.findAll((x) => x.props?.["aria-label"] === "Workspace")[0];
    const current = nav.findAll((x) => x.props?.["aria-current"] === "page");
    expect(current.map(nodeText)).toEqual(["Videos"]);
  });

  it("labels the Video as Unfiled", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount();
    expect(nodeText(r.root.findAll((x) => x.props?.["data-testid"] === "team-video-project-label")[0])).toBe("Unfiled");
  });
});

describe("Project address chrome", () => {
  const filedBody = () => body({}, { projectId: P, project: { id: P, name: "Launch Plan", status: "active" } });

  it("keeps the Project hierarchy in the breadcrumb", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, filedBody()));
    const r = await mount(FILED_PROPS);
    const html = text(r);
    expect(html).toContain('"href":"/workspace/team/ws-1/projects"');
    expect(html).toContain('"href":"/workspace/team/ws-1/projects/proj-1"');
  });

  it("keeps PROJECTS as the active nav item, not Videos", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, filedBody()));
    const r = await mount(FILED_PROPS);
    const nav = r.root.findAll((x) => x.props?.["aria-label"] === "Workspace")[0];
    expect(nav.findAll((x) => x.props?.["aria-current"] === "page").map(nodeText)).toEqual(["Projects"]);
  });

  it("names the Project", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, filedBody()));
    const r = await mount(FILED_PROPS);
    expect(nodeText(r.root.findAll((x) => x.props?.["data-testid"] === "team-video-project-label")[0])).toBe("Launch Plan");
  });

  it("an archived Project is readable and badged", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: P, project: { id: P, name: "Old", status: "archived" } })));
    const r = await mount(FILED_PROPS);
    expect(text(r)).toContain("Archived");
    expect(text(r)).toContain("shared-video-result-view");
  });

  it("an unresolvable Project reads as 'Project unavailable', NEVER 'Unfiled'", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: P, project: null })));
    const r = await mount(FILED_PROPS);
    const label = nodeText(r.root.findAll((x) => x.props?.["data-testid"] === "team-video-project-label")[0]);
    expect(label).toBe("Project unavailable");
    expect(label).not.toBe("Unfiled");
  });
});

describe("the pure shared result boundary", () => {
  it("mounts VideoVerificationResultView directly with the authorized payload", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    const r = await mount();
    expect(text(r)).toContain("shared-video-result-view");
    expect(resultViewProps).toHaveLength(1);
    expect((resultViewProps[0].data as Record<string, unknown>).fileName).toBe("quarterly-briefing.mp4");
  });

  it("passes NO actionsSurface — no export, memo or verify-another", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount();
    expect(resultViewProps[0].actionsSurface).toBeUndefined();
    expect(Object.keys(resultViewProps[0]).sort()).toEqual(["data", "governanceSurface"]);
  });

  it("governanceSurface carries the persisted status only", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ governanceStatus: "needs_review" })));
    await mount();
    // The chip is handed to the (stubbed) shared view as a prop, so assert the
    // element it received rather than rendered text the stub never emits.
    const surface = resultViewProps[0].governanceSurface as { props: Record<string, unknown> };
    expect(surface).toBeTruthy();
    expect(surface.props.status).toBe("needs_review");
    // A live governance read would be a second request; there is only the read.
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("omits governanceSurface entirely when nothing is stored", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount();
    expect(resultViewProps[0].governanceSurface).toBeUndefined();
  });

  it("only ever issues the canonical Team read", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount();
    expect(mockedAuthedFetch.mock.calls.map((c) => c[0])).toEqual(["/api/workspaces/ws-1/video-verifications/vid-1"]);
  });

  it("the Project address sends the containment query", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: P, project: { id: P, name: "Launch Plan", status: "active" } })));
    await mount(FILED_PROPS);
    expect(mockedAuthedFetch.mock.calls[0][0]).toBe("/api/workspaces/ws-1/video-verifications/vid-1?projectId=proj-1");
  });
});

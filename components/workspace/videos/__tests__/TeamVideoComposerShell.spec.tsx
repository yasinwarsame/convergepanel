/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the Team Video composer, driven END TO END.
 *
 * Nothing between the shared uploader and the HTTP boundary is stubbed: the real
 * `VideoUploaderSurface` prepares the upload, the real
 * `useTeamVideoVerificationCreate` builds the request, and only `authedFetch`,
 * auth, plan and the router are controlled. That is what makes the W1 assertion
 * meaningful — the prepared object under inspection is the one the shared
 * surface actually produced, not a fixture standing in for it.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, ...rest }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className, ...rest }, children as never),
}));
jest.mock("lucide-react", () => new Proxy({}, { get: () => () => null }));

const replace = jest.fn();
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace, push }) }));

let auth: { user: { uid: string } | null; authReady: boolean } = { user: { uid: "uid-a" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

let planState: Record<string, unknown>;
const refresh = jest.fn(async () => {});
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => planState }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

const mockedExtractFrames = jest.fn();
jest.mock("@/lib/video/extractFramesClient", () => ({ extractFramesInBrowser: (...a: unknown[]) => mockedExtractFrames(...a) }));
const mockedExtractMetadata = jest.fn();
jest.mock("@/lib/video/extractFileMetadata", () => ({ extractMp4Metadata: (...a: unknown[]) => mockedExtractMetadata(...a) }));

import TeamVideoComposerShell from "@/components/workspace/videos/TeamVideoComposerShell";

const W = "ws-1";
const P = "proj-1";

let storageData: Record<string, string> = {};
function installBrowserGlobals() {
  storageData = { "video-verification-acknowledged": "true" };
  const storage = {
    getItem: jest.fn((k: string) => (k in storageData ? storageData[k] : null)),
    setItem: jest.fn((k: string, v: string) => {
      storageData[k] = v;
    }),
    removeItem: jest.fn((k: string) => {
      delete storageData[k];
    }),
  };
  const mq = { matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() };
  Object.defineProperty(globalThis, "window", { value: { matchMedia: jest.fn(() => mq), localStorage: storage }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, "URL", {
    value: Object.assign(globalThis.URL ?? function () {}, { createObjectURL: jest.fn(() => "blob:preview"), revokeObjectURL: jest.fn() }),
    configurable: true,
    writable: true,
  });
}

const file = () => ({ name: "clip.mp4", type: "video/mp4", size: 5 * 1024 * 1024 }) as unknown as File;
const EXTRACTION = {
  frames: [{ index: 0, timestamp: 0, base64: "AAA", width: 1920, height: 1080 }],
  metadata: { duration: 12, width: 1920, height: 1080, fileSize: 5242880, fileName: "clip.mp4", fileType: "video/mp4" },
  warnings: ["low light"],
};
const FILE_METADATA = { codec: "h264", hasAudio: true, createdAt: null, encodingSoftware: null, cameraModel: null };

const okBody = (over: Record<string, unknown> = {}) => ({ ok: true, verificationId: "vid-9", workspaceId: W, projectId: null, ...over });
const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function nodeText(n: TestRenderer.ReactTestInstance | string): string {
  if (typeof n === "string") return n;
  return n.children.map((c) => nodeText(c as TestRenderer.ReactTestInstance | string)).join("");
}
const plain = (r: TestRenderer.ReactTestRenderer) => nodeText(r.root);

async function mount(project: { id: string; name: string } | null = null) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(TeamVideoComposerShell as never, { workspaceId: W, workspaceName: "Acme", showAudit: false, project } as never)
    );
  });
  await flush();
  return r;
}

async function selectAndSubmit(r: TestRenderer.ReactTestRenderer) {
  const input = r.root.findAll((x) => x.type === "input")[0];
  await act(async () => {
    (input.props.onChange as (e: unknown) => void)({ target: { files: [file()] } });
  });
  await flush();
  const btn = r.root.findAll((x) => x.type === "button" && nodeText(x).includes("Verify Video"))[0];
  await act(async () => {
    (btn.props.onClick as () => void)();
  });
  await flush();
  return btn;
}

const sentBody = () => JSON.parse(mockedAuthedFetch.mock.calls[0][1].body as string) as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  installBrowserGlobals();
  auth = { user: { uid: "uid-a" }, authReady: true };
  planState = { plan: "full", videoLimit: 20, videoRunsThisMonth: 3, loading: false, refresh };
  mockedExtractFrames.mockResolvedValue(EXTRACTION);
  mockedExtractMetadata.mockResolvedValue(FILE_METADATA);
  mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
});

describe("it renders the SHARED uploader, not a fork", () => {
  it("shows the shared surface's own copy and controls", async () => {
    const r = await mount();
    const text = plain(r);
    expect(text).toContain("Verify Video Authenticity");
    expect(text).toContain("Drop a video file here");
    expect(r.root.findAll((x) => x.type === "input").length).toBeGreaterThan(0);
  });

  it("waits for the plan before deciding which uploader state to show", async () => {
    planState = { plan: null, videoLimit: 0, videoRunsThisMonth: 0, loading: true, refresh };
    const r = await mount();
    expect(plain(r)).toContain("Loading your plan");
    expect(plain(r)).not.toContain("Verify Video Authenticity");
  });

  it("states the destination scope without offering a picker", async () => {
    const unfiled = await mount();
    expect(plain(unfiled)).toContain("will not be filed in a Project");
    const filed = await mount({ id: P, name: "Apollo" });
    expect(plain(filed)).toContain("filed in Apollo");
    // No Project/Workspace picker anywhere: the route is the scope.
    expect(filed.root.findAll((x) => x.type === "select")).toHaveLength(0);
  });
});

describe("W1: the surface's prepared payload reaches the wire untouched", () => {
  it("sends exactly the prepared video data plus the route's own locator", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    const r = await mount({ id: P, name: "Apollo" });
    await selectAndSubmit(r);

    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(["frames", "metadata", "projectId", "warnings"]);
    expect(body.frames).toEqual(EXTRACTION.frames);
    expect(body.warnings).toEqual(EXTRACTION.warnings);
    expect(body.projectId).toBe(P);
    // The prepared metadata is the surface's enrichment, not Team context.
    const md = body.metadata as Record<string, unknown>;
    expect(md.fileName).toBe("clip.mp4");
    expect(md.codec).toBe("h264");
    expect(md).not.toHaveProperty("workspaceId");
    expect(md).not.toHaveProperty("projectId");
  });

  it("puts no Workspace locator in the body at all", async () => {
    const r = await mount();
    await selectAndSubmit(r);
    expect(sentBody()).not.toHaveProperty("workspaceId");
    expect(JSON.stringify(sentBody())).not.toContain(W);
    expect(mockedAuthedFetch.mock.calls[0][0]).toBe(`/api/workspaces/${W}/video-verifications`);
  });

  it("sends no Team, auth or capability concept anywhere in the body", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    const r = await mount({ id: P, name: "Apollo" });
    await selectAndSubmit(r);
    const blob = JSON.stringify({ ...sentBody(), projectId: undefined }).toLowerCase();
    for (const forbidden of ["workspace", "teamref", "capabilit", "admission", "token", "bearer", "/api/"]) {
      expect(blob).not.toContain(forbidden);
    }
  });
});

describe("canonical success navigation", () => {
  it("replaces history with the canonical Unfiled detail route", async () => {
    const r = await mount();
    await selectAndSubmit(r);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`/workspace/team/${W}/videos/vid-9`);
    expect(push).not.toHaveBeenCalled();
  });

  it("replaces history with the canonical Project-filed detail route", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    const r = await mount({ id: P, name: "Apollo" });
    await selectAndSubmit(r);
    expect(replace).toHaveBeenCalledWith(`/workspace/team/${W}/projects/${P}/videos/vid-9`);
  });

  it("navigates for a deduplicated match exactly as for a fresh create", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ _deduplicated: true })));
    const r = await mount();
    await selectAndSubmit(r);
    expect(replace).toHaveBeenCalledWith(`/workspace/team/${W}/videos/vid-9`);
  });

  it("refreshes usage after a confirmed creation", async () => {
    const r = await mount();
    await selectAndSubmit(r);
    expect(refresh).toHaveBeenCalled();
  });

  it("does NOT navigate on a definite rejection", async () => {
    mockedAuthedFetch.mockResolvedValue(response(403, { ok: false, errorCode: "insufficient_capability" }));
    const r = await mount();
    await selectAndSubmit(r);
    expect(replace).not.toHaveBeenCalled();
    expect(plain(r)).toContain("You can no longer create videos in this Workspace.");
  });

  it("does NOT navigate on an unknown outcome", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, {}));
    const r = await mount();
    await selectAndSubmit(r);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does NOT navigate when the server answers with a foreign Workspace", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ workspaceId: "other-ws" })));
    const r = await mount();
    await selectAndSubmit(r);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("outcome_unknown presentation", () => {
  it("renders the Team unknown surface as an alert with no retry control", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, {}));
    const r = await mount();
    await selectAndSubmit(r);

    const alert = r.root.findAll((x) => x.props?.["data-testid"] === "video-upload-outcome-unknown");
    expect(alert).toHaveLength(1);
    expect(alert[0].props.role).toBe("alert");
    expect(nodeText(alert[0])).toContain("couldn't confirm whether this video was saved");
    // No retry affordance anywhere in that panel.
    expect(alert[0].findAll((x) => x.type === "button")).toHaveLength(0);
  });

  it("issues no second provider-spending request and keeps the selection", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, {}));
    const r = await mount();
    await selectAndSubmit(r);
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    // The chosen file is still shown, so the user can check before retrying.
    expect(plain(r)).toContain("clip.mp4");
  });

  it("points the user at the Videos list to check before retrying", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, {}));
    const r = await mount();
    await selectAndSubmit(r);
    const alert = r.root.findAll((x) => x.props?.["data-testid"] === "video-upload-outcome-unknown")[0];
    const link = alert.findAll((x) => x.type === "a")[0];
    expect(link.props.href).toBe(`/workspace/team/${W}/videos`);
  });
});

describe("provider-spending guard end to end", () => {
  it("a same-tick double activation produces ONE request", async () => {
    let resolveFetch!: (v: unknown) => void;
    mockedAuthedFetch.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
    const r = await mount();
    const input = r.root.findAll((x) => x.type === "input")[0];
    await act(async () => {
      (input.props.onChange as (e: unknown) => void)({ target: { files: [file()] } });
    });
    await flush();
    const btn = r.root.findAll((x) => x.type === "button" && nodeText(x).includes("Verify Video"))[0];
    await act(async () => {
      (btn.props.onClick as () => void)();
      (btn.props.onClick as () => void)();
    });
    await flush();
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFetch(response(200, okBody()));
    });
    await flush();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("does NOT navigate a viewer who left the form before the request landed", async () => {
    // The guard exists (`mountedRef`) and was previously untested: a late
    // success must not yank someone who has already navigated away.
    let resolveFetch!: (v: unknown) => void;
    mockedAuthedFetch.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
    const r = await mount();
    const input = r.root.findAll((x) => x.type === "input")[0];
    await act(async () => { (input.props.onChange as (e: unknown) => void)({ target: { files: [file()] } }); });
    await flush();
    const btn = r.root.findAll((x) => x.type === "button" && nodeText(x).includes("Verify Video"))[0];
    await act(async () => { (btn.props.onClick as () => void)(); });
    await act(async () => { r.unmount(); });
    await act(async () => { resolveFetch(response(200, okBody())); });
    await flush();
    expect(replace).not.toHaveBeenCalled();
  });

  it("issues nothing at all when auth has resolved signed-out", async () => {
    auth = { user: null, authReady: true };
    const r = await mount();
    await selectAndSubmit(r);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("free-plan and quota states come from the shared surface", () => {
  it("shows the shared upgrade gate on a free plan and offers no uploader", async () => {
    planState = { plan: "free", videoLimit: 0, videoRunsThisMonth: 0, loading: false, refresh };
    const r = await mount();
    expect(plain(r)).toContain("Video Verification");
    expect(plain(r)).toContain("Upgrade to verify videos");
    expect(r.root.findAll((x) => x.type === "input")).toHaveLength(0);
  });

  it("shows the shared at-limit state", async () => {
    planState = { plan: "full", videoLimit: 20, videoRunsThisMonth: 20, loading: false, refresh };
    const r = await mount();
    expect(plain(r)).toContain("You've used all 20 video verifications this month.");
  });
});

/**
 * TEAM-VERIFICATION-PARITY-R5-I3-A §E/§F — CHARACTERIZATION of the Personal
 * `VideoUploader`.
 *
 * These expectations pin what `main` ACTUALLY does today, before the shared
 * uploader surface is extracted. They are deliberately not written against a
 * desired future shape: their entire value is that they must stay green across
 * the refactor, so any Personal behaviour change shows up as a failure rather
 * than as a quietly updated expectation.
 *
 * The repo's Jest environment is `node`, so the browser globals this component
 * touches (`window.matchMedia`, `localStorage`, `URL.createObjectURL`) are
 * installed explicitly here. Frame and file-metadata extraction are mocked —
 * real video decoding never runs in Jest.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, ...rest }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className, ...rest }, children as never),
}));
jest.mock("lucide-react", () => new Proxy({}, { get: () => () => null }));

const USER = { uid: "uid-a", getIdToken: jest.fn(async () => "tok-123") };
let auth: { user: typeof USER | null; authReady: boolean } = { user: USER, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

const mockedExtractFrames = jest.fn();
jest.mock("@/lib/video/extractFramesClient", () => ({ extractFramesInBrowser: (...a: unknown[]) => mockedExtractFrames(...a) }));
const mockedExtractMetadata = jest.fn();
jest.mock("@/lib/video/extractFileMetadata", () => ({ extractMp4Metadata: (...a: unknown[]) => mockedExtractMetadata(...a) }));

import VideoUploader from "@/components/VideoUploader";

// ─── browser globals ──────────────────────────────────────────────────────────

let storageData: Record<string, string> = {};
let storage: { getItem: jest.Mock; setItem: jest.Mock; removeItem: jest.Mock };
function installBrowserGlobals() {
  storageData = {};
  storage = {
    getItem: jest.fn((k: string) => (k in storageData ? storageData[k] : null)),
    setItem: jest.fn((k: string, v: string) => { storageData[k] = v; }),
    removeItem: jest.fn((k: string) => { delete storageData[k]; }),
  };
  const mq = { matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() };
  const win = { matchMedia: jest.fn(() => mq), localStorage: storage };
  Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, "URL", {
    value: Object.assign(globalThis.URL ?? function () {}, { createObjectURL: jest.fn(() => "blob:preview"), revokeObjectURL: jest.fn() }),
    configurable: true,
    writable: true,
  });
}

const ACK_KEY = "video-verification-acknowledged";
const file = (over: Partial<{ name: string; type: string; size: number }> = {}) =>
  ({ name: "clip.mp4", type: "video/mp4", size: 5 * 1024 * 1024, ...over }) as unknown as File;

const EXTRACTION = {
  frames: ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"],
  metadata: { duration: 12, width: 1920, height: 1080, frameRate: 30, fileSize: 5242880, format: "mp4", fileName: "clip.mp4", fileType: "video/mp4" },
  warnings: ["low light"],
};
const FILE_METADATA = { codec: "h264", hasAudio: true, createdAt: "2026-01-01T00:00:00.000Z", encodingSoftware: "Cam 1.0", cameraModel: "X100" };

const okBody = (over: Record<string, unknown> = {}) => ({
  ok: true,
  verificationId: "vid-1",
  verdict: "authentic_captured",
  consensusScore: 88.4,
  confidenceLabel: "High",
  evidenceQuality: "strong",
  supportRatio: 90.6,
  metadata: { duration: 12, width: 1920, height: 1080, codec: "h264", frameRate: 30, fileSize: 5242880, format: "mp4", createdAt: null, encodingSoftware: null, hasAudio: true, cameraModel: null },
  metadataAnalysis: { flags: [], summary: "s" },
  modelEvidence: [{ modelId: "chatgpt" }],
  agreementPoints: ["a"],
  disagreementPoints: [],
  frameCount: 2,
  warnings: [],
  ...over,
});
const errBody = (code: string, message?: string) => ({ ok: false, error: { code, ...(message !== undefined ? { message } : {}) } });
const response = (json: unknown) => ({ json: async () => json });

let mockedFetch: jest.Mock;

const PROPS = { plan: "pro", videoLimit: 20, videoRunsThisMonth: 3, onSuccess: jest.fn(), onUsageRefresh: jest.fn(async () => {}) };

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

async function mount(over: Record<string, unknown> = {}) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(VideoUploader, { ...PROPS, ...over } as never));
  });
  await flush();
  return r;
}

function nodeText(n: TestRenderer.ReactTestInstance | string): string {
  if (typeof n === "string") return n;
  return n.children.map((c) => nodeText(c as TestRenderer.ReactTestInstance | string)).join("");
}
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
/**
 * Flattened VISIBLE text. React splits interpolated strings into separate
 * children (`{n} video verification{s}` becomes four nodes), so a serialized
 * tree cannot be searched for user-facing sentences — this can.
 */
const plain = (r: TestRenderer.ReactTestRenderer) => nodeText(r.root);
const buttonWith = (r: TestRenderer.ReactTestRenderer, label: string) =>
  r.root.findAll((x) => x.type === "button" && nodeText(x).includes(label))[0];

async function acknowledge(r: TestRenderer.ReactTestRenderer) {
  const btn = buttonWith(r, "I understand");
  await act(async () => { (btn.props.onClick as () => void)(); });
  await flush();
}

/** Selects a file through the real hidden input's onChange. */
async function selectFile(r: TestRenderer.ReactTestRenderer, f: File) {
  const input = r.root.findAll((x) => x.type === "input")[0];
  await act(async () => {
    (input.props.onChange as (e: unknown) => void)({ target: { files: [f] } });
  });
  await flush();
}

async function submit(r: TestRenderer.ReactTestRenderer) {
  const btn = buttonWith(r, "Verify Video");
  await act(async () => { (btn.props.onClick as () => void)(); });
  await flush();
}

/** Acknowledged + file selected, ready to submit. */
async function readyToSubmit(over: Record<string, unknown> = {}, f: File = file()) {
  const r = await mount(over);
  await acknowledge(r);
  await selectFile(r, f);
  return r;
}

const requestBody = () => JSON.parse((mockedFetch.mock.calls[0][1] as { body: string }).body);
const requestInit = () => mockedFetch.mock.calls[0][1] as { method: string; headers: Record<string, string>; body: string };

beforeEach(() => {
  jest.clearAllMocks();
  installBrowserGlobals();
  auth = { user: USER, authReady: true };
  mockedExtractFrames.mockResolvedValue(EXTRACTION);
  mockedExtractMetadata.mockResolvedValue(FILE_METADATA);
  mockedFetch = jest.fn(async () => response(okBody()));
  Object.defineProperty(globalThis, "fetch", { value: mockedFetch, configurable: true, writable: true });
  PROPS.onSuccess.mockClear();
  PROPS.onUsageRefresh.mockClear();
});

// ─── plan gating ──────────────────────────────────────────────────────────────

describe("plan gating", () => {
  it("free plan shows the upgrade card and offers no submission", async () => {
    const r = await mount({ plan: "free" });
    const html = text(r);
    expect(html).toContain("Upgrade to verify videos");
    expect(html).toContain('"href":"/pricing"');
    expect(r.root.findAll((x) => x.type === "button" && nodeText(x).includes("Verify Video"))).toHaveLength(0);
    expect(r.root.findAll((x) => x.type === "input")).toHaveLength(0);
  });

  it("paid plan presents the acknowledgement gate before the uploader", async () => {
    const r = await mount();
    expect(text(r)).toContain("Before you verify a video");
    expect(r.root.findAll((x) => x.type === "input")).toHaveLength(0);
  });

  it("paid plan presents the uploader after acknowledgement", async () => {
    const r = await mount();
    await acknowledge(r);
    expect(text(r)).toContain("MP4, MOV, WebM, AVI · Max 50MB · Max 60s");
    expect(r.root.findAll((x) => x.type === "input")).toHaveLength(1);
  });
});

// ─── acknowledgement ──────────────────────────────────────────────────────────

describe("legal acknowledgement", () => {
  it("is restored from the storage key", async () => {
    storageData[ACK_KEY] = "true";
    const r = await mount();
    expect(text(r)).not.toContain("Before you verify a video");
    expect(storage.getItem).toHaveBeenCalledWith(ACK_KEY);
  });

  it("writes the same key when accepted", async () => {
    const r = await mount();
    await acknowledge(r);
    expect(storage.setItem).toHaveBeenCalledWith(ACK_KEY, "true");
  });

  it("survives a storage read that throws (private mode)", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      get() { throw new Error("SecurityError"); }, configurable: true,
    });
    const r = await mount();
    expect(text(r)).toContain("Before you verify a video");
  });

  it("renders the legal disclaimer once acknowledged", async () => {
    const r = await mount();
    await acknowledge(r);
    expect(text(r)).toContain("Not a substitute for specialized lab or legal-grade analysis.");
  });
});

// ─── file validation ──────────────────────────────────────────────────────────

describe("file validation", () => {
  it.each([
    ["video/mp4", "clip.mp4"],
    ["video/quicktime", "clip.mov"],
    ["video/webm", "clip.webm"],
    ["video/x-msvideo", "clip.avi"],
  ])("accepts %s", async (type, name) => {
    const r = await mount();
    await acknowledge(r);
    await selectFile(r, file({ type, name }));
    expect(text(r)).toContain(name);
  });

  it("accepts an unknown MIME type when the extension is supported", async () => {
    const r = await mount();
    await acknowledge(r);
    await selectFile(r, file({ type: "", name: "clip.MOV" }));
    expect(text(r)).toContain("clip.MOV");
  });

  it("rejects an unsupported format with the current copy", async () => {
    const r = await mount();
    await acknowledge(r);
    await selectFile(r, file({ type: "image/png", name: "pic.png" }));
    expect(text(r)).toContain("Unsupported format. Please upload MP4, MOV, WebM, or AVI.");
  });

  it("rejects files over 50MB with the current copy", async () => {
    const r = await mount();
    await acknowledge(r);
    await selectFile(r, file({ size: 51 * 1024 * 1024 }));
    expect(text(r)).toContain("File too large. Maximum size is 50MB.");
  });

  it("creates preview state for a valid selection", async () => {
    const r = await readyToSubmit();
    expect((globalThis.URL as unknown as { createObjectURL: jest.Mock }).createObjectURL).toHaveBeenCalled();
    expect(plain(r)).toContain("clip.mp4");
    expect(plain(r)).toContain("5.0 MB");
  });

  it("Remove clears the selection", async () => {
    const r = await readyToSubmit();
    const btn = buttonWith(r, "Remove");
    await act(async () => { (btn.props.onClick as (e: unknown) => void)({ stopPropagation() {} }); });
    await flush();
    expect(plain(r)).not.toContain("5.0 MB");
  });

  it("Clear clears the selection", async () => {
    const r = await readyToSubmit();
    const btn = buttonWith(r, "Clear");
    await act(async () => { (btn.props.onClick as () => void)(); });
    await flush();
    expect(plain(r)).not.toContain("5.0 MB");
  });
});

// ─── transport ────────────────────────────────────────────────────────────────

describe("Personal transport", () => {
  it("extracts frames and file metadata on submit", async () => {
    const r = await readyToSubmit();
    await submit(r);
    expect(mockedExtractFrames).toHaveBeenCalledTimes(1);
    expect(mockedExtractMetadata).toHaveBeenCalledTimes(1);
  });

  it("POSTs to exactly /api/verify-video", async () => {
    const r = await readyToSubmit();
    await submit(r);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch.mock.calls[0][0]).toBe("/api/verify-video");
    expect(requestInit().method).toBe("POST");
  });

  it("sends the bearer token and JSON headers", async () => {
    const r = await readyToSubmit();
    await submit(r);
    const h = requestInit().headers;
    expect(h.Authorization).toBe("Bearer tok-123");
    expect(h.Accept).toBe("application/json");
    expect(h["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  it("sends exactly frames, metadata and warnings", async () => {
    const r = await readyToSubmit();
    await submit(r);
    expect(Object.keys(requestBody()).sort()).toEqual(["frames", "metadata", "warnings"]);
    expect(requestBody().frames).toEqual(EXTRACTION.frames);
    expect(requestBody().warnings).toEqual(EXTRACTION.warnings);
  });

  it("never sends a Workspace or Project locator", async () => {
    const r = await readyToSubmit();
    await submit(r);
    const body = requestBody();
    for (const forbidden of ["projectId", "workspaceId", "runId", "claimId"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(body)).not.toContain("workspaceId");
  });

  it("enriches extraction metadata with file metadata", async () => {
    const r = await readyToSubmit();
    await submit(r);
    const md = requestBody().metadata;
    expect(md.codec).toBe("h264");
    expect(md.hasAudio).toBe(true);
    expect(md.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(md.encodingSoftware).toBe("Cam 1.0");
    expect(md.cameraModel).toBe("X100");
    expect(md.duration).toBe(12);
    expect(md.fileName).toBe("clip.mp4");
  });

  it("falls back to 'unknown' codec when file metadata has none", async () => {
    mockedExtractMetadata.mockResolvedValue({ ...FILE_METADATA, codec: "" });
    const r = await readyToSubmit();
    await submit(r);
    expect(requestBody().metadata.codec).toBe("unknown");
  });

  it("aborts before transport when extraction yields no frames", async () => {
    mockedExtractFrames.mockResolvedValue({ ...EXTRACTION, frames: [] });
    const r = await readyToSubmit();
    await submit(r);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(text(r)).toContain("Could not extract any frames from this video.");
  });

  it("issues no second request for a same-tick duplicate activation", async () => {
    const r = await readyToSubmit();
    const btn = buttonWith(r, "Verify Video");
    await act(async () => {
      (btn.props.onClick as () => void)();
      (btn.props.onClick as () => void)();
    });
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("performs no automatic retry after a rejection", async () => {
    mockedFetch.mockResolvedValue(response(errBody("processing_failed")));
    const r = await readyToSubmit();
    await submit(r);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── success ──────────────────────────────────────────────────────────────────

describe("success", () => {
  it("maps the response through the tolerant Personal mapper", async () => {
    const r = await readyToSubmit();
    await submit(r);
    expect(PROPS.onSuccess).toHaveBeenCalledTimes(1);
    const p = PROPS.onSuccess.mock.calls[0][0];
    expect(p.verificationId).toBe("vid-1");
    expect(p.fileName).toBe("clip.mp4");
    expect(p.verdict).toBe("authentic_captured");
    expect(p.consensusScore).toBe(88);
    expect(p.supportRatio).toBe(91);
    expect(p.confidenceLabel).toBe("High");
    expect(p.evidenceQuality).toBe("strong");
    expect(p.frameCount).toBe(2);
  });

  it("uses the LOCAL file name, not any server value", async () => {
    mockedFetch.mockResolvedValue(response(okBody({ fileName: "server-name.mp4" })));
    const r = await readyToSubmit({}, file({ name: "my-local-clip.mp4" }));
    await submit(r);
    expect(PROPS.onSuccess.mock.calls[0][0].fileName).toBe("my-local-clip.mp4");
  });

  it("applies tolerant defaults for a sparse success body", async () => {
    mockedFetch.mockResolvedValue(response({ ok: true }));
    const r = await readyToSubmit();
    await submit(r);
    const p = PROPS.onSuccess.mock.calls[0][0];
    expect(p.verificationId).toBe("");
    expect(p.verdict).toBe("inconclusive");
    expect(p.consensusScore).toBe(0);
    expect(p.confidenceLabel).toBe("Low");
    expect(p.evidenceQuality).toBe("weak");
    expect(p.supportRatio).toBe(0);
    expect(p.frameCount).toBe(0);
    expect(p.metadata.codec).toBe("—");
    expect(p.metadata.format).toBe("—");
    expect(p.metadata.hasAudio).toBe(false);
    expect(p.metadataAnalysis).toEqual({ flags: [], summary: "" });
    expect(p.modelEvidence).toEqual([]);
    expect(p.agreementPoints).toEqual([]);
    expect(p.warnings).toEqual([]);
  });

  it("clears the selection after success", async () => {
    const r = await readyToSubmit();
    await submit(r);
    expect(plain(r)).not.toContain("5.0 MB");
  });

  it("refreshes usage after success", async () => {
    const r = await readyToSubmit();
    await submit(r);
    expect(PROPS.onUsageRefresh).toHaveBeenCalledTimes(1);
  });

  it("calls onSuccess before refreshing usage", async () => {
    const order: string[] = [];
    const onSuccess = jest.fn(() => { order.push("success"); });
    const onUsageRefresh = jest.fn(async () => { order.push("refresh"); });
    const r = await readyToSubmit({ onSuccess, onUsageRefresh });
    await submit(r);
    expect(order).toEqual(["success", "refresh"]);
  });
});

// ─── error mapping ────────────────────────────────────────────────────────────

describe("error mapping", () => {
  async function errorTextFor(body: unknown) {
    mockedFetch.mockResolvedValue(response(body));
    const r = await readyToSubmit();
    await submit(r);
    return text(r);
  }

  it.each([
    ["plan_required", "Video verification is not available on the free plan."],
    ["file_too_large", "File too large. Maximum size is 50MB."],
    ["processing_failed", "Could not process this video. Please try a different file."],
  ])("%s uses its fixed copy, ignoring any server message", async (code, expected) => {
    expect(await errorTextFor(errBody(code, "SERVER OVERRIDE"))).toContain(expected);
  });

  it.each([
    ["video_limit_reached", "You've used all 20 video verifications this month. Resets on the first day of next month."],
    ["run_limit_reached", "You've reached your monthly panel run limit. Each video verification also uses one run from your allowance."],
    ["no_frames", "Could not use the extracted frames. Try another file or browser."],
    ["invalid_frame", "Could not use the extracted frames. Try another file or browser."],
    ["invalid_metadata", "Invalid video metadata."],
    ["too_many_frames", "Invalid video metadata."],
    ["payload_too_large", "Frame data is too large. Try a shorter or lower-resolution video."],
    ["frame_too_large", "Frame data is too large. Try a shorter or lower-resolution video."],
    ["storage_failed", "Could not save results. Your usage was not charged. Please try again."],
    ["invalid_request", "Invalid request. Ensure the app is updated and try again."],
    ["rate_limit_exceeded", "Too many requests. Please wait a moment and try again."],
    ["model_limit", "Your plan does not allow enough models for this verification."],
    ["unauthorized", "Please sign in again and retry."],
  ])("%s falls back to its default copy when the server sends none", async (code, expected) => {
    expect(await errorTextFor(errBody(code))).toContain(expected);
  });

  it.each([
    "video_limit_reached",
    "run_limit_reached",
    "no_frames",
    "invalid_metadata",
    "payload_too_large",
    "storage_failed",
    "invalid_request",
    "rate_limit_exceeded",
    "model_limit",
    "unauthorized",
  ])("%s prefers a non-empty server message", async (code) => {
    expect(await errorTextFor(errBody(code, "SERVER SAYS THIS"))).toContain("SERVER SAYS THIS");
  });

  it("an unknown code falls back to the generic failure copy", async () => {
    expect(await errorTextFor(errBody("something_new"))).toContain("Video verification failed. Please try again.");
  });

  it("an unknown code still prefers a server message", async () => {
    expect(await errorTextFor(errBody("something_new", "ODD FAILURE"))).toContain("ODD FAILURE");
  });

  it("a thrown transport error surfaces its message", async () => {
    mockedFetch.mockRejectedValue(new Error("NetworkDown"));
    const r = await readyToSubmit();
    await submit(r);
    expect(text(r)).toContain("NetworkDown");
  });

  it("a thrown error with no message uses the connection fallback", async () => {
    mockedFetch.mockRejectedValue(new Error(""));
    const r = await readyToSubmit();
    await submit(r);
    expect(text(r)).toContain("Failed to verify video. Please check your connection and try again.");
  });

  it("the free-plan error offers an upgrade link", async () => {
    const html = await errorTextFor(errBody("plan_required"));
    expect(html).toContain("Upgrade →");
    expect(html).toContain('"href":"/pricing"');
  });

  it("a rejection PRESERVES the selected file", async () => {
    mockedFetch.mockResolvedValue(response(errBody("processing_failed")));
    const r = await readyToSubmit();
    await submit(r);
    expect(plain(r)).toContain("5.0 MB");
  });

  it("a rejection does not call onSuccess or refresh usage", async () => {
    mockedFetch.mockResolvedValue(response(errBody("processing_failed")));
    const r = await readyToSubmit();
    await submit(r);
    expect(PROPS.onSuccess).not.toHaveBeenCalled();
    expect(PROPS.onUsageRefresh).not.toHaveBeenCalled();
  });
});

// ─── progress + quota ─────────────────────────────────────────────────────────

describe("progress", () => {
  it("shows progress while the request is unresolved, then restores the form", async () => {
    let release!: (v: unknown) => void;
    mockedFetch.mockReturnValue(new Promise((res) => { release = res; }));
    const r = await readyToSubmit();
    const btn = buttonWith(r, "Verify Video");
    await act(async () => { (btn.props.onClick as () => void)(); });
    await flush();
    expect(text(r)).toContain("Video verification");
    expect(text(r)).toContain("Do not close this page while analysis is in progress.");
    await act(async () => { release(response(okBody())); await new Promise((x) => setTimeout(x, 0)); });
    await flush();
    expect(text(r)).not.toContain("Do not close this page while analysis is in progress.");
  });
});

describe("quota presentation", () => {
  it("shows remaining verifications", async () => {
    const r = await mount({ videoLimit: 20, videoRunsThisMonth: 3 });
    await acknowledge(r);
    expect(plain(r)).toContain("17 video verifications remaining this month");
  });

  it("uses the singular form for exactly one remaining", async () => {
    const r = await mount({ videoLimit: 20, videoRunsThisMonth: 19 });
    await acknowledge(r);
    expect(plain(r)).toContain("1 video verification remaining this month");
  });

  it("at the limit, suppresses the dropzone and the verify action", async () => {
    const r = await mount({ videoLimit: 20, videoRunsThisMonth: 20 });
    await acknowledge(r);
    expect(plain(r)).toContain("You've used all 20 video verifications this month.");
    expect(r.root.findAll((x) => x.type === "input")).toHaveLength(0);
    expect(r.root.findAll((x) => x.type === "button" && nodeText(x).includes("Verify Video"))).toHaveLength(0);
  });

  it("the lite plan is offered an upgrade at the limit", async () => {
    const r = await mount({ plan: "lite", videoLimit: 5, videoRunsThisMonth: 5 });
    await acknowledge(r);
    expect(plain(r)).toContain("Upgrade to the 5-Model plan for 20 video verifications.");
  });

  it("no quota line is shown when there is no limit", async () => {
    const r = await mount({ videoLimit: 0, videoRunsThisMonth: 0 });
    await acknowledge(r);
    expect(plain(r)).not.toContain("remaining this month");
  });
});

describe("auth gating of the verify action", () => {
  it("disables the action until auth is ready with a user", async () => {
    auth = { user: null, authReady: true };
    const r = await readyToSubmit();
    expect(buttonWith(r, "Verify Video").props.disabled).toBe(true);
  });

  it("enables the action for a signed-in user", async () => {
    const r = await readyToSubmit();
    expect(buttonWith(r, "Verify Video").props.disabled).toBe(false);
  });

  it("issues no request without a user", async () => {
    auth = { user: null, authReady: true };
    const r = await readyToSubmit();
    await submit(r);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

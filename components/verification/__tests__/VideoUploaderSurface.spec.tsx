/**
 * TEAM-VERIFICATION-PARITY-R5-I3-A §W — the shared, transport-neutral uploader
 * surface.
 *
 * These tests drive the surface with a plain callback instead of any real
 * transport, which is the point: if the surface ever needed to know an endpoint,
 * an auth object or a Workspace, these could not be written this way.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, ...rest }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className, ...rest }, children as never),
}));
jest.mock("lucide-react", () => new Proxy({}, { get: () => () => null }));

const mockedExtractFrames = jest.fn();
jest.mock("@/lib/video/extractFramesClient", () => ({ extractFramesInBrowser: (...a: unknown[]) => mockedExtractFrames(...a) }));
const mockedExtractMetadata = jest.fn();
jest.mock("@/lib/video/extractFileMetadata", () => ({ extractMp4Metadata: (...a: unknown[]) => mockedExtractMetadata(...a) }));

import VideoUploaderSurface from "@/components/verification/VideoUploaderSurface";
import type { PreparedVideoUpload, VideoUploadSubmitOutcome } from "@/lib/verification/videoUploadClientContract";

let storageData: Record<string, string> = {};
function installBrowserGlobals() {
  storageData = { "video-verification-acknowledged": "true" };
  const storage = {
    getItem: jest.fn((k: string) => (k in storageData ? storageData[k] : null)),
    setItem: jest.fn((k: string, v: string) => { storageData[k] = v; }),
    removeItem: jest.fn((k: string) => { delete storageData[k]; }),
  };
  const mq = { matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() };
  Object.defineProperty(globalThis, "window", { value: { matchMedia: jest.fn(() => mq), localStorage: storage }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, "URL", {
    value: Object.assign(globalThis.URL ?? function () {}, { createObjectURL: jest.fn(() => "blob:preview"), revokeObjectURL: jest.fn() }),
    configurable: true, writable: true,
  });
}

const file = (over: Partial<{ name: string; type: string; size: number }> = {}) =>
  ({ name: "clip.mp4", type: "video/mp4", size: 5 * 1024 * 1024, ...over }) as unknown as File;

const EXTRACTION = {
  frames: [{ index: 0, timestamp: 0, base64: "AAA", width: 1920, height: 1080 }],
  metadata: { duration: 12, width: 1920, height: 1080, fileSize: 5242880, fileName: "clip.mp4", fileType: "video/mp4" },
  warnings: ["low light"],
};
const FILE_METADATA = { codec: "h264", hasAudio: true, createdAt: "2026-01-01T00:00:00.000Z", encodingSoftware: "Cam 1.0", cameraModel: "X100" };

type Success = { id: string };
let submit: jest.Mock;
const onSuccess = jest.fn();
const onUsageRefresh = jest.fn(async () => {});

const PROPS = () => ({
  plan: "pro",
  videoLimit: 20,
  videoRunsThisMonth: 3,
  submissionEnabled: true,
  submitPreparedVideo: submit,
  onSuccess,
  onUsageRefresh,
});

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}
async function mount(over: Record<string, unknown> = {}) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(VideoUploaderSurface as never, { ...PROPS(), ...over } as never));
  });
  await flush();
  return r;
}
function nodeText(n: TestRenderer.ReactTestInstance | string): string {
  if (typeof n === "string") return n;
  return n.children.map((c) => nodeText(c as TestRenderer.ReactTestInstance | string)).join("");
}
const plain = (r: TestRenderer.ReactTestRenderer) => nodeText(r.root);
const buttonWith = (r: TestRenderer.ReactTestRenderer, label: string) =>
  r.root.findAll((x) => x.type === "button" && nodeText(x).includes(label))[0];

async function selectFile(r: TestRenderer.ReactTestRenderer, f: File = file()) {
  const input = r.root.findAll((x) => x.type === "input")[0];
  await act(async () => { (input.props.onChange as (e: unknown) => void)({ target: { files: [f] } }); });
  await flush();
}
async function ready(over: Record<string, unknown> = {}) {
  const r = await mount(over);
  await selectFile(r);
  return r;
}
async function doSubmit(r: TestRenderer.ReactTestRenderer) {
  const btn = buttonWith(r, "Verify Video");
  await act(async () => { (btn.props.onClick as () => void)(); });
  await flush();
}
const prepared = (): PreparedVideoUpload => submit.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  installBrowserGlobals();
  mockedExtractFrames.mockResolvedValue(EXTRACTION);
  mockedExtractMetadata.mockResolvedValue(FILE_METADATA);
  submit = jest.fn(async (): Promise<VideoUploadSubmitOutcome<Success>> => ({ status: "ok", value: { id: "v1" } }));
  onSuccess.mockClear();
  onUsageRefresh.mockClear();
});

describe("browser preparation feeds the caller's transport", () => {
  it("invokes the supplied callback exactly once", async () => {
    const r = await ready();
    await doSubmit(r);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("passes the extracted frames through unchanged", async () => {
    const r = await ready();
    await doSubmit(r);
    expect(prepared().frames).toEqual(EXTRACTION.frames);
  });

  it("passes warnings through unchanged", async () => {
    const r = await ready();
    await doSubmit(r);
    expect(prepared().warnings).toEqual(["low light"]);
  });

  it("carries the local fileName and fileType, and enriches metadata", async () => {
    const r = await ready();
    await doSubmit(r);
    const md = prepared().metadata;
    expect(prepared().fileName).toBe("clip.mp4");
    expect(md.fileName).toBe("clip.mp4");
    expect(md.fileType).toBe("video/mp4");
    expect(md.codec).toBe("h264");
    expect(md.hasAudio).toBe(true);
    expect(md.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(md.encodingSoftware).toBe("Cam 1.0");
    expect(md.cameraModel).toBe("X100");
    expect(md.duration).toBe(12);
  });

  it("the prepared object carries no transport or authorization data", async () => {
    const r = await ready();
    await doSubmit(r);
    expect(Object.keys(prepared()).sort()).toEqual(["fileName", "frames", "metadata", "warnings"]);
    const serialized = JSON.stringify(prepared());
    for (const forbidden of ["workspaceId", "projectId", "token", "uid", "endpoint", "capabilit", "plan"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not submit when extraction yields no frames", async () => {
    mockedExtractFrames.mockResolvedValue({ ...EXTRACTION, frames: [] });
    const r = await ready();
    await doSubmit(r);
    expect(submit).not.toHaveBeenCalled();
    expect(plain(r)).toContain("Could not extract any frames from this video.");
  });
});

describe("outcome handling", () => {
  it("ok calls onSuccess with the transport's typed value and clears the selection", async () => {
    const r = await ready();
    await doSubmit(r);
    expect(onSuccess).toHaveBeenCalledWith({ id: "v1" });
    expect(plain(r)).not.toContain("5.0 MB");
  });

  it("ok refreshes usage", async () => {
    const r = await ready();
    await doSubmit(r);
    expect(onUsageRefresh).toHaveBeenCalledTimes(1);
  });

  it("rejected renders the supplied copy and PRESERVES the selection", async () => {
    submit.mockResolvedValue({ status: "rejected", message: "Nope, try another file." });
    const r = await ready();
    await doSubmit(r);
    expect(plain(r)).toContain("Nope, try another file.");
    expect(plain(r)).toContain("5.0 MB");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onUsageRefresh).not.toHaveBeenCalled();
  });

  it("rejected shows an upgrade link only when the transport asks for one", async () => {
    submit.mockResolvedValue({ status: "rejected", message: "Paid plans only.", showUpgrade: true });
    const withUpgrade = await ready();
    await doSubmit(withUpgrade);
    expect(plain(withUpgrade)).toContain("Upgrade →");

    jest.clearAllMocks();
    installBrowserGlobals();
    mockedExtractFrames.mockResolvedValue(EXTRACTION);
    mockedExtractMetadata.mockResolvedValue(FILE_METADATA);
    submit = jest.fn(async () => ({ status: "rejected", message: "Paid plans only." }));
    const without = await ready({ submitPreparedVideo: submit });
    await doSubmit(without);
    expect(plain(without)).not.toContain("Upgrade →");
  });

  it("outcome_unknown renders a dedicated alert", async () => {
    submit.mockResolvedValue({ status: "outcome_unknown" });
    const r = await ready();
    await doSubmit(r);
    const alert = r.root.findAll((x) => x.props?.["data-testid"] === "video-upload-outcome-unknown");
    expect(alert).toHaveLength(1);
    expect(alert[0].props.role).toBe("alert");
    expect(nodeText(alert[0])).toContain("couldn't confirm");
  });

  it("outcome_unknown renders caller-supplied copy when given", async () => {
    submit.mockResolvedValue({ status: "outcome_unknown" });
    const r = await ready({ outcomeUnknownSurface: createElement("p", null, "Check your Workspace videos first.") });
    await doSubmit(r);
    expect(plain(r)).toContain("Check your Workspace videos first.");
  });

  it("outcome_unknown NEVER resubmits automatically", async () => {
    submit.mockResolvedValue({ status: "outcome_unknown" });
    const r = await ready();
    await doSubmit(r);
    await flush();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("outcome_unknown PRESERVES the selection and offers no retry control", async () => {
    submit.mockResolvedValue({ status: "outcome_unknown" });
    const r = await ready();
    await doSubmit(r);
    expect(plain(r)).toContain("5.0 MB");
    const alert = r.root.findAll((x) => x.props?.["data-testid"] === "video-upload-outcome-unknown")[0];
    expect(alert.findAll((x) => x.type === "button")).toHaveLength(0);
  });

  it("outcome_unknown calls neither onSuccess nor onUsageRefresh", async () => {
    submit.mockResolvedValue({ status: "outcome_unknown" });
    const r = await ready();
    await doSubmit(r);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onUsageRefresh).not.toHaveBeenCalled();
  });

  it("a thrown transport error surfaces its message and preserves the selection", async () => {
    submit.mockRejectedValue(new Error("Boom"));
    const r = await ready();
    await doSubmit(r);
    expect(plain(r)).toContain("Boom");
    expect(plain(r)).toContain("5.0 MB");
  });
});

describe("single activation", () => {
  it("a same-tick double activation produces ONE callback invocation", async () => {
    const r = await ready();
    const btn = buttonWith(r, "Verify Video");
    await act(async () => {
      (btn.props.onClick as () => void)();
      (btn.props.onClick as () => void)();
    });
    await flush();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("the surface never transports on its own", () => {
  it("free plan invokes no callback and offers no input", async () => {
    const r = await mount({ plan: "free" });
    expect(submit).not.toHaveBeenCalled();
    expect(r.root.findAll((x) => x.type === "input")).toHaveLength(0);
    expect(plain(r)).toContain("Upgrade to verify videos");
  });

  it("at the quota limit there is no verify action at all", async () => {
    const r = await mount({ videoLimit: 5, videoRunsThisMonth: 5 });
    expect(r.root.findAll((x) => x.type === "button" && nodeText(x).includes("Verify Video"))).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("submissionEnabled=false disables the action and blocks submission", async () => {
    const r = await ready({ submissionEnabled: false });
    expect(buttonWith(r, "Verify Video").props.disabled).toBe(true);
    await doSubmit(r);
    expect(submit).not.toHaveBeenCalled();
  });
});

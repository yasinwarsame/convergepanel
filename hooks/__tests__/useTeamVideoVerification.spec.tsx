/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AL — `useTeamVideoVerification`.
 *
 * The payload interpreter is REAL and is exercised directly, because it is the
 * network boundary that keeps the shared pure `VideoVerificationResultView`
 * from ever receiving malformed transport data. `useAuth` and `authedFetch` are
 * controlled boundaries; the hook runs inside a probe component so React's real
 * effect ordering — and therefore the generation guard and abort behaviour — is
 * under test.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const USER_A = { uid: "uid-a" };
let auth: { user: { uid: string } | null; authReady: boolean } = { user: USER_A, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import { useTeamVideoVerification, interpretTeamVideoDetailResponse, type TeamVideoDetailState } from "@/hooks/useTeamVideoVerification";
import { teamVideoDetailApiUrl } from "@/lib/workspaces/teamVideoDetailHref";

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

const MODEL_ROW = {
  modelId: "chatgpt",
  modelName: "ChatGPT",
  status: "ok",
  verdict: "authentic_captured",
  confidence: "high",
  summary: "ok",
  visualIndicators: ["a"],
  metadataIndicators: [],
  manipulationSignals: [],
  authenticitySignals: [],
  compressionNotes: [],
  limitations: [],
};

function payload(over: Record<string, unknown> = {}) {
  return {
    verificationId: V,
    fileName: "clip.mp4",
    verdict: "authentic_captured",
    contentType: "camera_footage",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 88,
    metadata: METADATA,
    metadataAnalysis: { flags: [{ field: "codec", observation: "fine", severity: "info" }], summary: "s" },
    modelEvidence: [MODEL_ROW],
    agreementPoints: ["x"],
    disagreementPoints: [],
    frameCount: 8,
    warnings: [],
    ...over,
  };
}

function teamEnvelope(over: Record<string, unknown> = {}) {
  return { workspaceId: W, projectId: null, project: null, createdAt: "2026-09-10T10:00:00.000Z", ...over };
}

const body = (p: Record<string, unknown> = {}, t: Record<string, unknown> = {}) => ({ ok: true, payload: payload(p), team: teamEnvelope(t) });
const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Props = { workspaceId: string; verificationId: string; expectedProjectId: string | null };
const states: TeamVideoDetailState[] = [];
let retryFn: () => void = () => {};
function Probe(props: Props) {
  const { state, retry } = useTeamVideoVerification(props);
  states.push(state);
  retryFn = retry;
  return null;
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(props: Props) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(Probe, props));
  });
  await flush();
  return r;
}
async function update(r: TestRenderer.ReactTestRenderer, props: Props) {
  await act(async () => {
    r.update(createElement(Probe, props));
  });
  await flush();
}
const last = () => states[states.length - 1];
const UNFILED: Props = { workspaceId: W, verificationId: V, expectedProjectId: null };
const FILED: Props = { workspaceId: W, verificationId: V, expectedProjectId: P };
const interpret = (b: unknown, addr = { workspaceId: W, projectId: null as string | null, verificationId: V }) => interpretTeamVideoDetailResponse(b, addr);

beforeEach(() => {
  jest.clearAllMocks();
  states.length = 0;
  auth = { user: USER_A, authReady: true };
});

describe("request URL", () => {
  it("Unfiled address sends no projectId", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED);
    expect(mockedAuthedFetch.mock.calls[0][0]).toBe("/api/workspaces/ws-1/video-verifications/vid-1");
  });

  it("Project address sends the encoded containment query", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: P, project: { id: P, name: "Launch", status: "active" } })));
    await mount(FILED);
    expect(mockedAuthedFetch.mock.calls[0][0]).toBe("/api/workspaces/ws-1/video-verifications/vid-1?projectId=proj-1");
  });

  it("never calls a Personal route", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED);
    const url = mockedAuthedFetch.mock.calls[0][0] as string;
    expect(url).not.toContain("/api/user/");
    expect(url).not.toContain("/api/verify-video");
    expect(teamVideoDetailApiUrl({ workspaceId: "w s", projectId: "p/1", verificationId: "v 1" })).toBe(
      "/api/workspaces/w%20s/video-verifications/v%201?projectId=p%2F1"
    );
  });

  it("auth not yet resolved: stays on loading with zero requests", async () => {
    auth = { user: USER_A, authReady: false };
    await mount(UNFILED);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(last()).toEqual({ kind: "loading" });
  });
});

/**
 * R5-I2-C1. The signed-out case is TERMINAL. A Team Video detail page is
 * server-gated, so it can be admitted under a session that the client provider
 * then resolves as signed-out; leaving the surface on "Loading this video…"
 * would hang it forever. Each case asserts the resulting STATE — asserting only
 * that no request was made is exactly the hole that let this ship.
 */
describe("signed-out is a terminal state, not an indefinite load", () => {
  it("authReady with no user -> auth_error, and zero requests", async () => {
    auth = { user: null, authReady: true };
    await mount(UNFILED);
    expect(last()).toEqual({ kind: "auth_error" });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });

  it("never settles on loading once auth has resolved signed-out", async () => {
    auth = { user: null, authReady: true };
    await mount(UNFILED);
    expect(last().kind).not.toBe("loading");
  });

  it("says NOTHING about whether the video exists", async () => {
    auth = { user: null, authReady: true };
    await mount(UNFILED);
    for (const forbidden of ["not_found", "forbidden", "unavailable", "malformed", "ready"]) {
      expect(last().kind).not.toBe(forbidden);
    }
  });

  it("holds for the Project address too", async () => {
    auth = { user: null, authReady: true };
    await mount(FILED);
    expect(last()).toEqual({ kind: "auth_error" });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });

  it("attempts no forced token refresh without a user", async () => {
    auth = { user: null, authReady: true };
    await mount(UNFILED);
    expect(mockedAuthedFetch.mock.calls.filter((c) => (c[1] as Record<string, unknown>)?.forceTokenRefresh)).toHaveLength(0);
  });

  it("signing OUT mid-flight aborts the request and lands on auth_error", async () => {
    const d = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(d.promise);
    const r = await mount(UNFILED);
    const signal = (mockedAuthedFetch.mock.calls[0][1] as { signal: AbortSignal }).signal;

    auth = { user: null, authReady: true };
    await update(r, UNFILED);
    expect(signal.aborted).toBe(true);
    expect(last()).toEqual({ kind: "auth_error" });

    // A late success for the signed-in identity must never restore the page.
    await act(async () => {
      d.resolve(response(200, body()));
      await new Promise((res) => setTimeout(res, 0));
    });
    await flush();
    expect(last()).toEqual({ kind: "auth_error" });
  });

  it("signing IN afterwards leaves auth_error and issues that identity's read", async () => {
    auth = { user: null, authReady: true };
    const r = await mount(UNFILED);
    expect(last()).toEqual({ kind: "auth_error" });

    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    auth = { user: { uid: "uid-b" }, authReady: true };
    await update(r, UNFILED);
    expect(last().kind).toBe("ready");
    expect(mockedAuthedFetch.mock.calls.map((c) => c[0])).toEqual(["/api/workspaces/ws-1/video-verifications/vid-1"]);
  });
});

describe("HTTP status mapping", () => {
  it.each([
    [403, "forbidden"],
    [404, "not_found"],
    [500, "internal"],
    [503, "unavailable"],
    [502, "unavailable"],
    [400, "not_found"],
  ])("%i -> %s", async (status, kind) => {
    mockedAuthedFetch.mockResolvedValue(response(status, {}));
    await mount(UNFILED);
    expect(last().kind).toBe(kind);
  });

  it("a transport failure is unavailable", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("offline"));
    await mount(UNFILED);
    expect(last().kind).toBe("unavailable");
  });

  it("one forced refresh on the first 401, then success", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(401, {})).mockResolvedValueOnce(response(200, body()));
    await mount(UNFILED);
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect((mockedAuthedFetch.mock.calls[1][1] as Record<string, unknown>).forceTokenRefresh).toBe(true);
    expect(last().kind).toBe("ready");
  });

  it("a second 401 is auth_error with no third request", async () => {
    mockedAuthedFetch.mockResolvedValue(response(401, {}));
    await mount(UNFILED);
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(last().kind).toBe("auth_error");
  });

  it("retry repeats the GET only", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(503, {})).mockResolvedValueOnce(response(200, body()));
    await mount(UNFILED);
    expect(last().kind).toBe("unavailable");
    await act(async () => {
      retryFn();
    });
    await flush();
    expect(last().kind).toBe("ready");
    expect(mockedAuthedFetch.mock.calls.every((c) => (c[1] as Record<string, unknown>).method === "GET")).toBe(true);
  });
});

describe("late responses never paint", () => {
  it.each([
    ["Workspace change", { workspaceId: "ws-2", verificationId: V, expectedProjectId: null } as Props],
    ["Project change", { workspaceId: W, verificationId: V, expectedProjectId: P } as Props],
    ["verification change", { workspaceId: W, verificationId: "vid-2", expectedProjectId: null } as Props],
  ])("%s aborts and ignores the previous read", async (_l, next) => {
    const d = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(d.promise).mockResolvedValue(response(404, {}));
    const r = await mount(UNFILED);
    const signal = (mockedAuthedFetch.mock.calls[0][1] as { signal: AbortSignal }).signal;
    await update(r, next);
    expect(signal.aborted).toBe(true);
    await act(async () => {
      d.resolve(response(200, body()));
      await new Promise((res) => setTimeout(res, 0));
    });
    await flush();
    // The stale success must not have overwritten the new address's state.
    expect(last().kind).toBe("not_found");
  });
});

describe("route containment", () => {
  it("a foreign workspaceId is not_found, never rendered", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { workspaceId: "ws-other" })));
    await mount(UNFILED);
    expect(last().kind).toBe("not_found");
  });

  it("a filed Video on the Unfiled address is not_found", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: P, project: { id: P, name: "L", status: "active" } })));
    await mount(UNFILED);
    expect(last().kind).toBe("not_found");
  });

  it("a Video filed elsewhere on a Project address is not_found", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: "other", project: { id: "other", name: "O", status: "active" } })));
    await mount(FILED);
    expect(last().kind).toBe("not_found");
  });

  it("containment failures are never auto-corrected by a redirect", () => {
    expect(interpret(body({}, { workspaceId: "ws-other" })).kind).toBe("out_of_scope");
    expect(interpret(body({}, { projectId: P, project: { id: P, name: "L", status: "active" } })).kind).toBe("out_of_scope");
  });
});

describe("Project label semantics", () => {
  it("Unfiled: projectId null and project null is ready", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED);
    const s = last();
    expect(s.kind).toBe("ready");
    expect(s.kind === "ready" && s.team.projectId).toBeNull();
  });

  it("filed with a resolved Project is ready with the label", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: P, project: { id: P, name: "Launch", status: "active" } })));
    await mount(FILED);
    const s = last();
    expect(s.kind === "ready" && s.team.project?.name).toBe("Launch");
  });

  it("filed with an ARCHIVED Project is ready and reports the real status", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: P, project: { id: P, name: "Old", status: "archived" } })));
    await mount(FILED);
    const s = last();
    expect(s.kind === "ready" && s.team.project?.status).toBe("archived");
  });

  it("filed + project null is ACCEPTED — Project unavailable, never Unfiled", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({}, { projectId: P, project: null })));
    await mount(FILED);
    const s = last();
    expect(s.kind).toBe("ready");
    expect(s.kind === "ready" && s.team.projectId).toBe(P);
    expect(s.kind === "ready" && s.team.project).toBeNull();
  });

  it("Unfiled + a Project DTO is internally inconsistent -> malformed", () => {
    expect(interpret(body({}, { projectId: null, project: { id: P, name: "L", status: "active" } })).kind).toBe("malformed");
  });

  it("a Project DTO whose id disagrees with the binding is malformed", () => {
    // Internally inconsistent envelope, so malformed rather than merely
    // out-of-address: the response contradicts itself, not just this route.
    expect(
      interpretTeamVideoDetailResponse(body({}, { projectId: P, project: { id: "other", name: "O", status: "active" } }), {
        workspaceId: W,
        projectId: P,
        verificationId: V,
      }).kind
    ).toBe("malformed");
  });
});

describe("full payload validation — the shared pure view is never handed bad data", () => {
  it("a well-formed payload is ready", () => {
    expect(interpret(body()).kind).toBe("ready");
  });

  it.each([
    ["missing verificationId", { verificationId: "" }],
    ["verificationId of a DIFFERENT video", { verificationId: "vid-other" }],
    ["missing fileName", { fileName: "" }],
    ["unknown verdict", { verdict: "nope" }],
    ["empty contentType", { contentType: "" }],
    ["NaN consensusScore", { consensusScore: Number.NaN }],
    ["bad confidenceLabel", { confidenceLabel: "high" }],
    ["bad evidenceQuality", { evidenceQuality: "great" }],
    ["NaN supportRatio", { supportRatio: Number.NaN }],
    ["missing supportRatio", { supportRatio: undefined }],
    ["negative frameCount", { frameCount: -1 }],
    ["non-integer frameCount", { frameCount: 1.5 }],
    ["agreementPoints not strings", { agreementPoints: [1] }],
    ["disagreementPoints not an array", { disagreementPoints: "x" }],
    ["warnings not strings", { warnings: [{}] }],
    ["unknown governanceStatus", { governanceStatus: "pending" }],
    ["unparseable timestampIso", { timestampIso: "nope" }],
    ["modelEvidence not an array", { modelEvidence: {} }],
  ])("%s -> malformed", (_l, over) => {
    expect(interpret(body(over as Record<string, unknown>)).kind).toBe("malformed");
  });

  it.each([
    ["missing duration", { duration: undefined }],
    ["non-numeric width", { width: "1920" }],
    ["non-string codec", { codec: 264 }],
    ["NaN frameRate", { frameRate: Number.NaN }],
    ["non-boolean hasAudio", { hasAudio: "yes" }],
    ["cameraModel not string|null", { cameraModel: 5 }],
    ["createdAt not string|null", { createdAt: 5 }],
  ])("malformed metadata (%s) -> malformed", (_l, over) => {
    expect(interpret(body({ metadata: { ...METADATA, ...(over as Record<string, unknown>) } })).kind).toBe("malformed");
  });

  it("metadata that is not an object at all -> malformed", () => {
    expect(interpret(body({ metadata: null })).kind).toBe("malformed");
  });

  it.each([
    ["flags not an array", { flags: "x", summary: "s" }],
    ["a flag missing field", { flags: [{ observation: "o", severity: "info" }], summary: "s" }],
    ["a flag with unknown severity", { flags: [{ field: "f", observation: "o", severity: "critical" }], summary: "s" }],
    ["summary not a string", { flags: [], summary: 5 }],
  ])("malformed metadataAnalysis (%s) -> malformed", (_l, analysis) => {
    expect(interpret(body({ metadataAnalysis: analysis })).kind).toBe("malformed");
  });

  it.each([
    ["missing modelId", { modelId: "" }],
    ["non-string summary", { summary: 5 }],
    ["visualIndicators not strings", { visualIndicators: [1] }],
    ["metadataIndicators not an array", { metadataIndicators: "x" }],
    ["manipulationSignals not an array", { manipulationSignals: null }],
    ["authenticitySignals not strings", { authenticitySignals: [{}] }],
    ["productionSignals present but not strings", { productionSignals: [1] }],
    ["deceptionIndicators present but not an array", { deceptionIndicators: "x" }],
    ["compressionNotes not an array", { compressionNotes: 5 }],
    ["limitations not strings", { limitations: [null] }],
    ["non-string verdict", { verdict: 1 }],
    ["non-string confidence", { confidence: 1 }],
  ])("a malformed modelEvidence row (%s) -> malformed", (_l, over) => {
    expect(interpret(body({ modelEvidence: [{ ...MODEL_ROW, ...(over as Record<string, unknown>) }] })).kind).toBe("malformed");
  });

  it("optional model arrays may be absent", () => {
    const row = { ...MODEL_ROW };
    expect(interpret(body({ modelEvidence: [row] })).kind).toBe("ready");
  });

  it("an empty modelEvidence array is acceptable", () => {
    expect(interpret(body({ modelEvidence: [] })).kind).toBe("ready");
  });

  it.each([
    ["ok not true", { ok: false, payload: payload(), team: teamEnvelope() }],
    ["no team", { ok: true, payload: payload() }],
    ["no payload", { ok: true, team: teamEnvelope() }],
    ["not an object", null],
    ["team.createdAt unparseable", { ok: true, payload: payload(), team: teamEnvelope({ createdAt: "nope" }) }],
    ["team.workspaceId empty", { ok: true, payload: payload(), team: teamEnvelope({ workspaceId: "" }) }],
    ["team.projectId empty string", { ok: true, payload: payload(), team: teamEnvelope({ projectId: "" }) }],
  ])("malformed envelope (%s) -> malformed", (_l, b) => {
    expect(interpret(b).kind).toBe("malformed");
  });

  it("governanceStatus may be absent or null", () => {
    expect(interpret(body({ governanceStatus: null })).kind).toBe("ready");
    expect(interpret(body({ governanceStatus: "approved" })).kind).toBe("ready");
  });

  it("a malformed 2xx surfaces as malformed, NOT as a missing video", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ verdict: "nope" })));
    await mount(UNFILED);
    expect(last().kind).toBe("malformed");
  });
});

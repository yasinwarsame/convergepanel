/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — `useTeamVideoVerificationCreate`.
 *
 * This hook runs three vision models and spends quota with no idempotency key,
 * so the assertions that matter most are the negative ones: what it must NOT
 * send, what it must NOT retry, and what it must NOT call a rejection.
 *
 * `useAuth` and `authedFetch` are the only controlled boundaries; the body
 * construction, the two-vocabulary error classification and the success
 * containment checks are all real.
 *
 * W1 — the consumer boundary carried forward from I3-A is proven here by
 * capturing BOTH sides: the `PreparedVideoUpload` handed in, and the HTTP body
 * that went out. The prepared object must come through untouched while the
 * Team locators travel separately.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const USER_A = { uid: "uid-a" };
let auth: { user: { uid: string } | null; authReady: boolean } = { user: USER_A, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import {
  useTeamVideoVerificationCreate,
  buildTeamVideoRequestBody,
  REJECTION_CODES as REJECTION_CODE_SET,
  type TeamVideoCreateAddress,
  type UseTeamVideoVerificationCreateResult,
} from "@/hooks/useTeamVideoVerificationCreate";
import type { PreparedVideoUpload } from "@/lib/verification/videoUploadClientContract";

const W = "ws-1";
const P = "proj-1";
const UNFILED: TeamVideoCreateAddress = { kind: "workspace", workspaceId: W };
const FILED: TeamVideoCreateAddress = { kind: "project", workspaceId: W, projectId: P };

const prepared = (): PreparedVideoUpload => ({
  fileName: "clip.mp4",
  frames: [{ index: 0, timestamp: 0, base64: "AAA", width: 1920, height: 1080 }] as PreparedVideoUpload["frames"],
  metadata: {
    duration: 12,
    width: 1920,
    height: 1080,
    fileSize: 5242880,
    fileName: "clip.mp4",
    fileType: "video/mp4",
    codec: "h264",
    hasAudio: true,
    createdAt: null,
    encodingSoftware: null,
    cameraModel: null,
  },
  warnings: ["low light"],
});

const okBody = (over: Record<string, unknown> = {}) => ({ ok: true, verificationId: "vid-1", workspaceId: W, projectId: null, ...over });
const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let hook: UseTeamVideoVerificationCreateResult;
function Probe(props: { address: TeamVideoCreateAddress }) {
  hook = useTeamVideoVerificationCreate(props);
  return null;
}

async function mount(address: TeamVideoCreateAddress) {
  await act(async () => {
    TestRenderer.create(createElement(Probe, { address }));
  });
}

const lastCall = () => mockedAuthedFetch.mock.calls[mockedAuthedFetch.mock.calls.length - 1];
const sentUrl = () => lastCall()[0] as string;
const sentInit = () => lastCall()[1] as Record<string, unknown>;
const sentBody = () => JSON.parse(sentInit().body as string) as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  auth = { user: USER_A, authReady: true };
  mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
});

describe("the Team endpoint and locators", () => {
  it("POSTs to the canonical Team Video collection for the Workspace", async () => {
    await mount(UNFILED);
    await act(async () => {
      await hook.submit(prepared());
    });
    expect(sentUrl()).toBe(`/api/workspaces/${W}/video-verifications`);
    expect(sentInit().method).toBe("POST");
  });

  it("never reaches the Personal endpoint", async () => {
    await mount(UNFILED);
    await act(async () => {
      await hook.submit(prepared());
    });
    expect(sentUrl()).not.toContain("/api/verify-video");
    for (const call of mockedAuthedFetch.mock.calls) {
      expect(call[0]).toContain("/api/workspaces/");
    }
  });

  it("percent-encodes the Workspace locator", async () => {
    await mount({ kind: "workspace", workspaceId: "ws/1 x" });
    await act(async () => {
      await hook.submit(prepared());
    });
    expect(sentUrl()).toBe("/api/workspaces/ws%2F1%20x/video-verifications");
  });

  it("OMITS projectId entirely for the Unfiled address", async () => {
    await mount(UNFILED);
    await act(async () => {
      await hook.submit(prepared());
    });
    expect(Object.keys(sentBody()).sort()).toEqual(["frames", "metadata", "warnings"]);
    expect(sentBody()).not.toHaveProperty("projectId");
  });

  it("sends the route's own projectId for the Project address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    await mount(FILED);
    await act(async () => {
      await hook.submit(prepared());
    });
    expect(Object.keys(sentBody()).sort()).toEqual(["frames", "metadata", "projectId", "warnings"]);
    expect(sentBody().projectId).toBe(P);
  });

  it("sends the Workspace locator in the URL and never in the body", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    await mount(FILED);
    await act(async () => {
      await hook.submit(prepared());
    });
    expect(sentBody()).not.toHaveProperty("workspaceId");
    expect(JSON.stringify(sentBody())).not.toContain(W);
  });

  it("requires an authenticated caller before issuing anything", async () => {
    auth = { user: null, authReady: true };
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "rejected", code: "unauthorized" });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });
});

/**
 * W1 — the property the shared contract proof deliberately does not attempt.
 */
describe("W1: Team context never enters the prepared payload", () => {
  it("passes the prepared object through without mutating it", async () => {
    await mount(FILED);
    const value = prepared();
    const before = JSON.parse(JSON.stringify(value));
    await act(async () => {
      await hook.submit(value);
    });
    // The very object the shared surface produced is unchanged, key-for-key.
    expect(value).toEqual(before);
    expect(Object.keys(value).sort()).toEqual(["fileName", "frames", "metadata", "warnings"]);
    expect(value).not.toHaveProperty("workspaceId");
    expect(value).not.toHaveProperty("projectId");
  });

  it("adds no Team, auth, capability or routing field to any part of the prepared value", async () => {
    await mount(FILED);
    const value = prepared();
    await act(async () => {
      await hook.submit(value);
    });
    const blob = JSON.stringify(value).toLowerCase();
    for (const forbidden of ["workspace", "projectid", "teamref", "token", "capabilit", "admission", "endpoint", "/api/"]) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it("carries the Team locator in the REQUEST while the prepared value stays neutral", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    await mount(FILED);
    const value = prepared();
    await act(async () => {
      await hook.submit(value);
    });
    // Outgoing request: prepared video data PLUS the route's own locator.
    expect(sentBody().projectId).toBe(P);
    expect(sentBody().frames).toEqual(value.frames);
    expect(sentBody().metadata).toEqual(value.metadata);
    expect(sentBody().warnings).toEqual(value.warnings);
    // The prepared value itself: still no locator.
    expect(value).not.toHaveProperty("projectId");
  });

  it("the choke point reads prepared fields and never mutates its input", () => {
    const value = prepared();
    const before = JSON.parse(JSON.stringify(value));
    const body = buildTeamVideoRequestBody(value, P);
    expect(value).toEqual(before);
    expect(body).not.toBe(value as unknown);
    expect(body.frames).toBe(value.frames);
    expect(Object.keys(body).sort()).toEqual(["frames", "metadata", "projectId", "warnings"]);
    expect(Object.keys(buildTeamVideoRequestBody(value, null)).sort()).toEqual(["frames", "metadata", "warnings"]);
  });

  it("never sends the local fileName as a top-level request field", async () => {
    await mount(UNFILED);
    await act(async () => {
      await hook.submit(prepared());
    });
    // `fileName` reaches the server inside metadata, exactly as Personal sends it.
    expect(sentBody()).not.toHaveProperty("fileName");
    expect((sentBody().metadata as Record<string, unknown>).fileName).toBe("clip.mp4");
  });
});

describe("provider-spending safety", () => {
  it("issues exactly ONE request for a same-tick double activation", async () => {
    const d = deferred<unknown>();
    mockedAuthedFetch.mockReturnValue(d.promise);
    await mount(UNFILED);
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = hook.submit(prepared());
      second = hook.submit(prepared());
    });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      d.resolve(response(200, okBody()));
      await first;
    });
    expect(await second).toEqual({ status: "already_submitting" });
  });

  it("retries a 401 exactly once with a forced refresh and the identical body", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(401, { errorCode: "unauthorized" })).mockResolvedValueOnce(response(200, okBody()));
    await mount(UNFILED);
    await act(async () => {
      await hook.submit(prepared());
    });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(mockedAuthedFetch.mock.calls[0][1].forceTokenRefresh).toBeUndefined();
    expect(mockedAuthedFetch.mock.calls[1][1].forceTokenRefresh).toBe(true);
    expect(mockedAuthedFetch.mock.calls[1][1].body).toBe(mockedAuthedFetch.mock.calls[0][1].body);
  });

  it("stops at auth_error after a second 401 — never a third request", async () => {
    mockedAuthedFetch.mockResolvedValue(response(401, { errorCode: "unauthorized" }));
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "rejected", code: "auth_error" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
  });

  it.each([500, 502, 503, 504])("treats HTTP %s as outcome_unknown, never a rejection", async (status) => {
    mockedAuthedFetch.mockResolvedValue(response(status, { errorCode: "internal_error" }));
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "outcome_unknown" });
  });

  it("treats a transport failure as outcome_unknown", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "outcome_unknown" });
  });

  it("never parses a 5xx body — an unread body cannot be misread as a rejection", async () => {
    const json = jest.fn(async () => ({ errorCode: "insufficient_capability" }));
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 500, json });
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "outcome_unknown" });
    expect(json).not.toHaveBeenCalled();
  });
});

describe("both server error vocabularies", () => {
  it.each([
    [403, "insufficient_capability"],
    [404, "not_found"],
    [503, "team_workspaces_disabled"],
  ])("classifies Team-shaped %s %s — rejection below 500, unknown at or above it", async (status, code) => {
    // 503 here carries a Team errorCode; the >=500 guard runs first, so only
    // the two sub-500 codes can reach classification.
    mockedAuthedFetch.mockResolvedValue(response(status as number, { ok: false, errorCode: code }));
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual(status === 503 ? { status: "outcome_unknown" } : { status: "rejected", code });
  });

  it.each([
    [403, "plan_required"],
    [429, "video_limit_reached"],
    [429, "run_limit_reached"],
    [403, "model_limit"],
    [429, "rate_limit_exceeded"],
    [400, "no_frames"],
    [400, "invalid_metadata"],
    [400, "file_too_large"],
    [413, "payload_too_large"],
    [400, "invalid_request"],
  ])("classifies Personal-shaped %s %s as a definite rejection", async (status, code) => {
    mockedAuthedFetch.mockResolvedValue(response(status as number, { ok: false, error: { code, message: "x" } }));
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "rejected", code });
  });

  it("treats an unrecognised sub-500 code as outcome_unknown, not a rejection", async () => {
    mockedAuthedFetch.mockResolvedValue(response(418, { ok: false, errorCode: "teapot" }));
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "outcome_unknown" });
  });
});

describe("success containment", () => {
  it("returns the server-authoritative locators for an Unfiled create", async () => {
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "ok", verificationId: "vid-1", workspaceId: W, projectId: null, deduplicated: false });
  });

  it("reports a deduplicated match as a success", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ _deduplicated: true })));
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toMatchObject({ status: "ok", deduplicated: true, verificationId: "vid-1" });
  });

  it.each([
    ["a non-object body", "not json"],
    ["ok !== true", { ok: false, verificationId: "v", workspaceId: W, projectId: null }],
    ["a missing verificationId", { ok: true, workspaceId: W, projectId: null }],
    ["an empty verificationId", { ok: true, verificationId: "", workspaceId: W, projectId: null }],
    ["a foreign workspaceId", { ok: true, verificationId: "v", workspaceId: "other", projectId: null }],
    ["an unexpected projectId", { ok: true, verificationId: "v", workspaceId: W, projectId: "sneaky" }],
  ])("reports %s as outcome_unknown rather than navigating", async (_label, body) => {
    mockedAuthedFetch.mockResolvedValue(response(200, body));
    await mount(UNFILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "outcome_unknown" });
  });

  it("requires the Project address's own projectId to come back", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: null })));
    await mount(FILED);
    let outcome;
    await act(async () => {
      outcome = await hook.submit(prepared());
    });
    expect(outcome).toEqual({ status: "outcome_unknown" });
  });
});

/**
 * THE ROOT-CAUSE TEST.
 *
 * Every other assertion in this file enumerates codes that are already in
 * `REJECTION_CODES` — which is why the first version of this hook silently
 * omitted `team_workspace_not_found`, the DOMINANT Team authorization denial,
 * and shipped a set validated only against itself. A set that agrees with a
 * list copied from the same set proves nothing.
 *
 * This block derives the expected vocabulary from the ROUTE instead: it reads
 * the POST handler and the denial helpers it actually calls, extracts every
 * sub-500 error code they can emit, and requires the hook to classify each one.
 * If someone adds a denial to the route, this fails until the hook learns it.
 */
describe("the rejection vocabulary is derived from the ROUTE, not from itself", () => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  const ROUTE = "app/api/workspaces/[workspaceId]/video-verifications/route.ts";
  /** The denial helpers POST reaches, directly or through `mapGateDenial`. */
  const HELPER_FILES = ["lib/projects/teamProjectErrorResponse.ts", "lib/projects/projectErrorResponse.ts"];

  /**
   * Pair a code with its status WITHIN ONE `return` statement.
   *
   * A character-window regex pairs them across statement boundaries — it
   * reported `team_workspaces_disabled` (503-only) as sub-500 by borrowing a
   * neighbouring 4xx. Splitting on `return` keeps every pairing inside the
   * emission it belongs to.
   */
  function emissions(code: string): { code: string; status: number }[] {
    const out: { code: string; status: number }[] = [];
    for (const chunk of code.split(/\breturn\b/).slice(1)) {
      const status = /status:\s*(\d{3})/.exec(chunk);
      if (!status) continue;
      const c = /errorCode:\s*"([a-z_]+)"/.exec(chunk) ?? /\bcode:\s*"([a-z_]+)"/.exec(chunk);
      if (!c) continue;
      out.push({ code: c[1], status: Number(status[1]) });
    }
    return out;
  }

  const routeSrc = src(ROUTE);
  const postSlice = routeSrc.slice(routeSrc.indexOf("export async function POST"), routeSrc.indexOf("export async function GET"));
  const helperSrc = HELPER_FILES.map(src).join("\n");

  /** Only the helpers POST actually invokes — not every export of those modules. */
  const REACHED_HELPERS = [
    "teamProjectAuthorizationDeniedResponse",
    "runProjectAssociationTargetNotFoundResponse",
    "projectArchivedTargetResponse",
    "invalidRequestBodyResponse",
    "unexpectedFieldResponse",
  ];

  function helperBody(name: string): string {
    const at = helperSrc.indexOf(`export function ${name}`);
    if (at < 0) return "";
    return helperSrc.slice(at, helperSrc.indexOf("\n}", at));
  }

  it("reaches the denial helpers this test claims it does", () => {
    // Positive control: without this the extraction below could silently read
    // nothing and every assertion would pass vacuously.
    expect(postSlice.length).toBeGreaterThan(2000);
    expect(postSlice).toContain("mapGateDenial");
    expect(postSlice).toContain("teamProjectAuthorizationDeniedResponse");
    for (const h of REACHED_HELPERS) {
      // Positive control: each helper this test reads must exist AND be wired
      // into this route — directly in POST, or through `mapGateDenial`, which
      // is module-level rather than inside the POST slice.
      expect(helperBody(h).length).toBeGreaterThan(20);
      expect(routeSrc).toContain(`${h}(`);
    }
    // ...and POST must actually reach the gate mapper.
    expect(postSlice).toContain("mapGateDenial(gate1)");
    expect(postSlice).toContain("mapGateDenial(gate2)");
    expect(routeSrc).toContain("case \"project_not_found\":");
    expect(routeSrc).toContain("case \"project_archived\":");
  });

  it("classifies EVERY sub-500 code the route can emit", () => {
    const all = [...emissions(postSlice), ...REACHED_HELPERS.flatMap((h) => emissions(helperBody(h)))];
    const subFive = [...new Set(all.filter((e) => e.status < 500).map((e) => e.code))].sort();

    // Sanity: the extraction found a real, non-trivial vocabulary.
    expect(subFive.length).toBeGreaterThan(8);
    expect(subFive).toContain("team_workspace_not_found");
    expect(subFive).toContain("plan_required");

    const unclassified = subFive.filter((c) => !REJECTION_CODE_SET.has(c));
    expect(unclassified).toEqual([]);
  });

  it("claims no code the route cannot emit below 500", () => {
    const all = [...emissions(routeSrc), ...REACHED_HELPERS.flatMap((h) => emissions(helperBody(h)))];
    const subFive = new Set(all.filter((e) => e.status < 500).map((e) => e.code));
    // `unauthorized` and `auth_error` are this hook's OWN client-side outcomes:
    // the signed-out precondition and the terminal second 401.
    const clientOwned = new Set(["unauthorized", "auth_error"]);
    const phantom = [...REJECTION_CODE_SET].filter((c) => !subFive.has(c) && !clientOwned.has(c));
    expect(phantom).toEqual([]);
  });
});

/**
 * TEAM-VERIFICATION-PARITY-R4-I1 §E/§F/§G/§W — `useTeamClaimVerification`.
 *
 * The href builder and the response interpreter are REAL. `useAuth` and
 * `authedFetch` are controlled boundaries. The hook is exercised through a
 * tiny probe component so React's real effect/commit ordering — and therefore
 * the generation guard and unmount behaviour — is what is under test.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const USER_A = { uid: "uid-a" };
const USER_B = { uid: "uid-b" };
let auth: { user: { uid: string } | null; authReady: boolean } = { user: USER_A, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import {
  useTeamClaimVerification,
  interpretTeamClaimDetailResponse,
  type TeamClaimDetailState,
  type UseTeamClaimVerificationArgs,
} from "@/hooks/useTeamClaimVerification";

const W = "ws-1";
const P = "proj-1";
const V = "vcl-1";

const UNFILED: UseTeamClaimVerificationArgs = { workspaceId: W, verificationId: V, expectedProjectId: null };
const FILED: UseTeamClaimVerificationArgs = { workspaceId: W, verificationId: V, expectedProjectId: P };

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

const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const states: TeamClaimDetailState[] = [];
let retryFn: (() => void) | null = null;

function Probe(props: UseTeamClaimVerificationArgs) {
  const { state, retry } = useTeamClaimVerification(props);
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

async function mount(props: UseTeamClaimVerificationArgs) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe, props));
  });
  await flush();
  return renderer;
}

async function update(r: TestRenderer.ReactTestRenderer, props: UseTeamClaimVerificationArgs) {
  await act(async () => {
    r.update(createElement(Probe, props));
  });
  await flush();
}

const last = () => states[states.length - 1];
const urls = () => mockedAuthedFetch.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  jest.clearAllMocks();
  states.length = 0;
  retryFn = null;
  auth = { user: USER_A, authReady: true };
});

describe("endpoint selection", () => {
  it("reads the Unfiled endpoint without projectId", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED);
    expect(urls()).toEqual(["/api/workspaces/ws-1/verifications/vcl-1"]);
  });

  it("reads the Project endpoint with ?projectId=", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ projectId: P, project: { id: P, name: "Launch", status: "active" } })));
    await mount(FILED);
    expect(urls()).toEqual(["/api/workspaces/ws-1/verifications/vcl-1?projectId=proj-1"]);
  });

  it("issues a GET and never a write, and never touches a Personal route", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED);
    for (const call of mockedAuthedFetch.mock.calls) {
      expect((call[1] as { method: string }).method).toBe("GET");
      expect((call[1] as { body?: unknown }).body).toBeUndefined();
      expect(call[0] as string).not.toContain("/api/user/");
      expect(call[0] as string).not.toContain("run-governance");
    }
  });

  it("does not request until auth is ready", async () => {
    auth = { user: null, authReady: false };
    await mount(UNFILED);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(last()).toEqual({ kind: "loading" });
  });

  it("stays on loading while auth is unresolved even with a user present", async () => {
    auth = { user: USER_A, authReady: false };
    await mount(UNFILED);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(last()).toEqual({ kind: "loading" });
  });
});

/**
 * TEAM-CLAIM-DETAIL-AUTH-H1. The signed-out case is TERMINAL. A Team Claim
 * detail page is server-gated, so it can be admitted under a session the client
 * provider then resolves as signed-out; leaving the surface on "Loading this
 * claim…" would hang it forever. Each case asserts the resulting STATE —
 * asserting only that no request was made cannot distinguish a correct terminal
 * state from an indefinite load. This mirrors the Production-stable Team Video
 * detail contract exactly.
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

  it("is a SESSION state, never a statement about the Claim", async () => {
    auth = { user: null, authReady: true };
    await mount(UNFILED);
    for (const forbidden of ["loading", "not_found", "forbidden", "unavailable", "internal", "malformed", "ready"]) {
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
    const a = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(a.promise);
    const r = await mount(UNFILED);
    const signal = (mockedAuthedFetch.mock.calls[0][1] as { signal: AbortSignal }).signal;

    auth = { user: null, authReady: true };
    await update(r, UNFILED);
    expect(signal.aborted).toBe(true);
    expect(last()).toEqual({ kind: "auth_error" });

    // A late success for the signed-in identity must never restore the page.
    await act(async () => {
      a.resolve(response(200, body()));
      await new Promise((res) => setTimeout(res, 0));
    });
    await flush();
    expect(last()).toEqual({ kind: "auth_error" });
  });

  it("signing IN afterwards recovers without a reload", async () => {
    auth = { user: null, authReady: true };
    const r = await mount(UNFILED);
    expect(last()).toEqual({ kind: "auth_error" });

    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    auth = { user: USER_B, authReady: true };
    await update(r, UNFILED);
    expect(last().kind).toBe("ready");
    expect(mockedAuthedFetch.mock.calls.map((c) => c[0])).toEqual([`/api/workspaces/${W}/verifications/${V}`]);
  });
});

describe("success", () => {
  it("exposes the authorized payload and team block", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body()));
    await mount(UNFILED);
    expect(last()).toEqual({
      kind: "ready",
      payload: expect.objectContaining({ claim: "The sky is blue.", verdict: "confirmed" }),
      team: { workspaceId: W, projectId: null, project: null, createdAt: "2026-09-10T10:00:00.000Z" },
    });
  });
});

describe("auth retry", () => {
  it("performs exactly one forced token refresh on 401 and then succeeds", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200, body()));
    await mount(UNFILED);
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect((mockedAuthedFetch.mock.calls[0][1] as { forceTokenRefresh?: boolean }).forceTokenRefresh).toBeUndefined();
    expect((mockedAuthedFetch.mock.calls[1][1] as { forceTokenRefresh?: boolean }).forceTokenRefresh).toBe(true);
    expect(last().kind).toBe("ready");
  });

  it("terminates on a second 401 with auth_error and does not retry endlessly", async () => {
    mockedAuthedFetch.mockResolvedValue(response(401));
    await mount(UNFILED);
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(last()).toEqual({ kind: "auth_error" });
  });
});

describe("error mapping", () => {
  it.each([
    [403, "forbidden"],
    [404, "not_found"],
    [500, "internal"],
    [503, "unavailable"],
  ])("maps HTTP %s to %s", async (status, kind) => {
    mockedAuthedFetch.mockResolvedValue(response(status as number));
    await mount(UNFILED);
    expect(last()).toEqual({ kind });
  });

  it("maps a transport failure to the retryable unavailable state", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    await mount(UNFILED);
    expect(last()).toEqual({ kind: "unavailable" });
  });

  it("never renders a server failure as a successful empty result", async () => {
    for (const status of [500, 503]) {
      states.length = 0;
      mockedAuthedFetch.mockResolvedValue(response(status));
      await mount(UNFILED);
      expect(last().kind).not.toBe("ready");
      expect(last().kind).not.toBe("not_found");
    }
  });

  it("retry repeats the read only, and succeeds on the second attempt", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200, body()));
    await mount(UNFILED);
    expect(last()).toEqual({ kind: "unavailable" });
    await act(async () => {
      retryFn?.();
    });
    await flush();
    expect(last().kind).toBe("ready");
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(mockedAuthedFetch.mock.calls.every((c) => (c[1] as { method: string }).method === "GET")).toBe(true);
  });
});

describe("malformed success bodies", () => {
  it.each([
    ["ok is not true", { ...body(), ok: false }],
    ["team missing", { ok: true, payload: payload() }],
    ["team.workspaceId not a string", body({ workspaceId: 7 })],
    ["team.projectId neither null nor string", body({ projectId: 7 })],
    ["team.createdAt missing", { ok: true, payload: payload(), team: { workspaceId: W, projectId: null, project: null } }],
    ["payload missing", { ok: true, team: { workspaceId: W, projectId: null, project: null, createdAt: "x" } }],
    ["claim empty", body({}, { claim: "" })],
    ["verdict missing", body({}, { verdict: undefined })],
    ["consensusScore not finite", body({}, { consensusScore: Number.NaN })],
    ["modelEvidence not an array", body({}, { modelEvidence: {} })],
    ["auditBundle missing", body({}, { auditBundle: undefined })],
    ["body is null", null],
    ["body is an array", []],
  ])("rejects %s as malformed", async (_label, json) => {
    mockedAuthedFetch.mockResolvedValue(response(200, json));
    await mount(UNFILED);
    expect(last()).toEqual({ kind: "malformed" });
  });
});

describe("route containment", () => {
  it("rejects a foreign Workspace in the response", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ workspaceId: "ws-other" })));
    await mount(UNFILED);
    expect(last()).toEqual({ kind: "not_found" });
  });

  it("rejects a Project-bound Claim at the Unfiled address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ projectId: P, project: { id: P, name: "Launch", status: "active" } })));
    await mount(UNFILED);
    expect(last()).toEqual({ kind: "not_found" });
  });

  it("rejects an Unfiled Claim at a Project address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ projectId: null })));
    await mount(FILED);
    expect(last()).toEqual({ kind: "not_found" });
  });

  it("rejects a Claim filed in a different Project", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ projectId: "proj-other", project: { id: "proj-other", name: "Other", status: "active" } })));
    await mount(FILED);
    expect(last()).toEqual({ kind: "not_found" });
  });

  it("accepts the matching Project address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, body({ projectId: P, project: { id: P, name: "Launch", status: "active" } })));
    await mount(FILED);
    expect(last().kind).toBe("ready");
  });
});

describe("interpretTeamClaimDetailResponse (pure)", () => {
  it("is the containment decision itself, independent of transport", () => {
    expect(interpretTeamClaimDetailResponse(body({ projectId: P }), { workspaceId: W, projectId: null }).kind).toBe("out_of_scope");
    expect(interpretTeamClaimDetailResponse(body(), { workspaceId: W, projectId: null }).kind).toBe("ready");
    expect(interpretTeamClaimDetailResponse(body({ workspaceId: "nope" }), { workspaceId: W, projectId: null }).kind).toBe("out_of_scope");
  });
});

describe("race safety", () => {
  it("discards a stale response after the Claim id changes", async () => {
    const a = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(a.promise).mockResolvedValueOnce(response(200, { ...body(), payload: payload({ claim: "B claim" }) }));

    const r = await mount(UNFILED);
    await update(r, { ...UNFILED, verificationId: "vcl-2" });

    await act(async () => {
      a.resolve(response(200, { ...body(), payload: payload({ claim: "A claim" }) }));
      await a.promise;
    });
    await flush();

    expect(last().kind).toBe("ready");
    expect((last() as { payload: { claim: string } }).payload.claim).toBe("B claim");
  });

  it("discards a stale response after the Workspace changes", async () => {
    const a = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(a.promise).mockResolvedValueOnce(response(200, { ...body({ workspaceId: "ws-2" }), payload: payload({ claim: "B claim" }) }));

    const r = await mount(UNFILED);
    await update(r, { ...UNFILED, workspaceId: "ws-2" });

    await act(async () => {
      a.resolve(response(200, body()));
      await a.promise;
    });
    await flush();

    expect((last() as { payload: { claim: string } }).payload.claim).toBe("B claim");
  });

  it("discards a stale response after the signed-in identity changes", async () => {
    const a = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(a.promise).mockResolvedValueOnce(response(200, { ...body(), payload: payload({ claim: "B claim" }) }));

    const r = await mount(UNFILED);
    auth = { user: USER_B, authReady: true };
    await update(r, UNFILED);

    await act(async () => {
      a.resolve(response(200, { ...body(), payload: payload({ claim: "A claim" }) }));
      await a.promise;
    });
    await flush();

    expect((last() as { payload: { claim: string } }).payload.claim).toBe("B claim");
  });

  it("commits nothing after unmount", async () => {
    const a = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(a.promise);

    const r = await mount(UNFILED);
    const beforeUnmount = states.length;
    await act(async () => {
      r.unmount();
    });

    await act(async () => {
      a.resolve(response(200, body()));
      await a.promise;
    });
    await flush();

    expect(states.length).toBe(beforeUnmount);
  });
});

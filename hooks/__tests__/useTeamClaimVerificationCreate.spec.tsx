/**
 * TEAM-VERIFICATION-PARITY-R4-I3 §AJ — `useTeamClaimVerificationCreate`.
 *
 * This hook spends quota and runs providers with no idempotency key, so the
 * assertions that matter most are the negative ones: what it must NOT send, and
 * what it must NOT retry. `useAuth` and `authedFetch` are the only controlled
 * boundaries; the body construction and outcome classification are real.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const USER_A = { uid: "uid-a" };
let auth: { user: { uid: string } | null; authReady: boolean } = { user: USER_A, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import {
  useTeamClaimVerificationCreate,
  type TeamClaimCreateAddress,
  type TeamClaimCreateOutcome,
  type UseTeamClaimVerificationCreateResult,
} from "@/hooks/useTeamClaimVerificationCreate";
import type { ModelId } from "@/lib/types";

const W = "ws-1";
const P = "proj-1";
const UNFILED: TeamClaimCreateAddress = { kind: "workspace", workspaceId: W };
const FILED: TeamClaimCreateAddress = { kind: "project", workspaceId: W, projectId: P };

const MODELS: ModelId[] = ["chatgpt", "claude"];
const CLAIM = "The sky is blue.";

const okBody = (over: Record<string, unknown> = {}) => ({ ok: true, verificationId: "vcl-1", workspaceId: W, projectId: null, ...over });
const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let hook: UseTeamClaimVerificationCreateResult;
function Probe(props: { address: TeamClaimCreateAddress }) {
  hook = useTeamClaimVerificationCreate(props);
  return null;
}

async function mount(address: TeamClaimCreateAddress) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(Probe, { address }));
  });
  return r;
}

async function submit(payload: { claim?: string; selectedModels?: ModelId[] } = {}): Promise<TeamClaimCreateOutcome> {
  let outcome!: TeamClaimCreateOutcome;
  await act(async () => {
    outcome = await hook.submit({ claim: payload.claim ?? CLAIM, selectedModels: payload.selectedModels ?? MODELS });
  });
  return outcome;
}

const bodyOf = (i = 0) => JSON.parse((mockedAuthedFetch.mock.calls[i][1] as { body: string }).body);
const urls = () => mockedAuthedFetch.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  jest.clearAllMocks();
  auth = { user: USER_A, authReady: true };
});

describe("ordinary request body — Unfiled", () => {
  it("POSTs the Team endpoint with exactly {claim, models}", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    await mount(UNFILED);
    await submit();
    expect(urls()).toEqual(["/api/workspaces/ws-1/verifications"]);
    expect((mockedAuthedFetch.mock.calls[0][1] as { method: string }).method).toBe("POST");
    expect(Object.keys(bodyOf()).sort()).toEqual(["claim", "models"]);
    expect(bodyOf()).toEqual({ claim: CLAIM, models: MODELS });
  });

  it("OMITS projectId entirely rather than sending null", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    await mount(UNFILED);
    await submit();
    // Absence is the server's ordinary contract for Unfiled.
    expect(Object.prototype.hasOwnProperty.call(bodyOf(), "projectId")).toBe(false);
    expect((mockedAuthedFetch.mock.calls[0][1] as { body: string }).body).not.toContain("projectId");
  });
});

describe("ordinary request body — Project", () => {
  it("sends the route-bound projectId", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    await mount(FILED);
    await submit();
    expect(Object.keys(bodyOf()).sort()).toEqual(["claim", "models", "projectId"]);
    expect(bodyOf().projectId).toBe(P);
  });

  it("takes projectId from the address, so no caller input can refile the Claim", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    await mount(FILED);
    // The submit signature accepts only claim + models; there is no projectId input.
    await act(async () => {
      await (hook.submit as unknown as (a: Record<string, unknown>) => Promise<unknown>)({
        claim: CLAIM,
        selectedModels: MODELS,
        projectId: "attacker-project",
      });
    });
    expect(bodyOf().projectId).toBe(P);
    expect((mockedAuthedFetch.mock.calls[0][1] as { body: string }).body).not.toContain("attacker-project");
  });
});

describe("origin-linked fields are never sent", () => {
  it.each([UNFILED, FILED])("sends no runId/claimId/origin/uid for %p", async (address) => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: address.kind === "project" ? P : null })));
    await mount(address);
    await submit();
    const raw = (mockedAuthedFetch.mock.calls[0][1] as { body: string }).body;
    for (const forbidden of ["runId", "claimId", "origin", "uid", "userId", "creator", "role", "workspaceId"]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe("auth", () => {
  it("issues no POST when there is no signed-in user", async () => {
    auth = { user: null, authReady: true };
    await mount(UNFILED);
    expect(await submit()).toEqual({ status: "rejected", code: "unauthorized" });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });

  it("issues no POST before auth is ready", async () => {
    auth = { user: null, authReady: false };
    await mount(UNFILED);
    expect((await submit()).status).toBe("rejected");
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });

  it("retries a 401 exactly once with a forced refresh and the IDENTICAL body", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(401, { ok: false, errorCode: "auth_error" })).mockResolvedValueOnce(response(200, okBody()));
    await mount(UNFILED);
    expect((await submit()).status).toBe("ok");
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect((mockedAuthedFetch.mock.calls[0][1] as { forceTokenRefresh?: boolean }).forceTokenRefresh).toBeUndefined();
    expect((mockedAuthedFetch.mock.calls[1][1] as { forceTokenRefresh?: boolean }).forceTokenRefresh).toBe(true);
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  it.each([
    ["auth_error body", { ok: false, errorCode: "auth_error" }],
    ["unauthorized body", { ok: false, errorCode: "unauthorized" }],
    ["empty body", {}],
  ])("terminates a second 401 (%s) as auth_error with no third request", async (_l, body) => {
    mockedAuthedFetch.mockResolvedValue(response(401, body));
    await mount(UNFILED);
    expect(await submit()).toEqual({ status: "rejected", code: "auth_error" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
  });
});

describe("single flight", () => {
  it("issues exactly ONE request for two same-tick submissions", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise);
    await mount(UNFILED);

    let first!: Promise<TeamClaimCreateOutcome>;
    let second!: TeamClaimCreateOutcome;
    await act(async () => {
      first = hook.submit({ claim: CLAIM, selectedModels: MODELS });
      second = await hook.submit({ claim: CLAIM, selectedModels: MODELS });
    });
    expect(second).toEqual({ status: "already_submitting" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve(response(200, okBody()));
      await first;
    });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight guard so a later submission is allowed", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    await mount(UNFILED);
    expect((await submit()).status).toBe("ok");
    expect((await submit()).status).toBe("ok");
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
  });
});

describe("no unsafe automatic retry", () => {
  it.each([
    ["a transport failure", null],
    ["HTTP 500", 500],
    ["HTTP 503", 503],
  ])("issues exactly one request for %s and reports outcome_unknown", async (_l, status) => {
    if (status === null) mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    else mockedAuthedFetch.mockResolvedValue(response(status as number, { ok: false, errorCode: "internal_error" }));
    await mount(UNFILED);
    // A dropped or faulted request may already have created the Claim.
    expect(await submit()).toEqual({ status: "outcome_unknown" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one request for a 429 rate limit and reports a definite rejection", async () => {
    mockedAuthedFetch.mockResolvedValue(response(429, { ok: false, errorCode: "rate_limit_exceeded" }));
    await mount(UNFILED);
    expect(await submit()).toEqual({ status: "rejected", code: "rate_limit_exceeded" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("success validation and containment", () => {
  it("accepts an exact Unfiled response", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    await mount(UNFILED);
    expect(await submit()).toEqual({ status: "ok", verificationId: "vcl-1", workspaceId: W, projectId: null });
  });

  it("accepts an exact Project response", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    await mount(FILED);
    expect(await submit()).toEqual({ status: "ok", verificationId: "vcl-1", workspaceId: W, projectId: P });
  });

  it.each([
    ["a foreign Workspace", UNFILED, okBody({ workspaceId: "ws-other" })],
    ["a filed response on the Unfiled route", UNFILED, okBody({ projectId: P })],
    ["a different Project", FILED, okBody({ projectId: "proj-other" })],
    ["an Unfiled response on the Project route", FILED, okBody({ projectId: null })],
    ["a missing verificationId", UNFILED, okBody({ verificationId: "" })],
    ["ok !== true", UNFILED, { ...okBody(), ok: false }],
    ["a non-object body", UNFILED, "not json"],
  ])("reports outcome_unknown for %s — an artifact may exist", async (_l, address, body) => {
    mockedAuthedFetch.mockResolvedValue(response(200, body));
    await mount(address as TeamClaimCreateAddress);
    expect(await submit()).toEqual({ status: "outcome_unknown" });
  });

  it("reports outcome_unknown for an unparseable success body", async () => {
    mockedAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await mount(UNFILED);
    expect(await submit()).toEqual({ status: "outcome_unknown" });
  });
});

describe("definite rejections", () => {
  it.each([
    ["invalid_claim", 400],
    ["claim_too_long", 400],
    ["not_enough_models", 400],
    ["PLAN_MODEL_LIMIT_REACHED", 403],
    ["RUN_LIMIT_REACHED", 429],
    ["team_workspace_not_found", 404],
    ["insufficient_capability", 403],
    ["project_not_found", 404],
    ["project_archived", 409],
    ["unexpected_field", 400],
  ])("maps %s", async (code, status) => {
    mockedAuthedFetch.mockResolvedValue(response(status as number, { ok: false, errorCode: code }));
    await mount(UNFILED);
    const outcome = await submit();
    expect(outcome.status).toBe("rejected");
    expect((outcome as { code: string }).code).toBe(code);
  });

  it("carries safe quota data on a run-limit rejection", async () => {
    mockedAuthedFetch.mockResolvedValue(
      response(429, { ok: false, errorCode: "RUN_LIMIT_REACHED", runsUsed: 25, runsLimit: 25, resetsAt: "2026-10-01T00:00:00.000Z", plan: "LITE" })
    );
    await mount(UNFILED);
    const outcome = await submit();
    expect((outcome as { usage: { runsLimit: number } }).usage.runsLimit).toBe(25);
  });

  it("treats an unrecognised sub-500 error as outcome_unknown rather than a definite failure", async () => {
    mockedAuthedFetch.mockResolvedValue(response(418, { ok: false, errorCode: "teapot" }));
    await mount(UNFILED);
    expect(await submit()).toEqual({ status: "outcome_unknown" });
  });
});

describe("R4-I4 origin-linked mode", () => {
  const ORIGIN = { runId: "run-9", claimId: "v1:key_findings:0:abc" };
  const submitOrigin = async (): Promise<TeamClaimCreateOutcome> => {
    let outcome!: TeamClaimCreateOutcome;
    await act(async () => {
      outcome = await hook.submit({ origin: ORIGIN, selectedModels: MODELS });
    });
    return outcome;
  };

  it("POSTs exactly {runId, claimId, models} to the Team endpoint", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    await mount(UNFILED);
    await submitOrigin();
    expect(urls()).toEqual(["/api/workspaces/ws-1/verifications"]);
    expect(Object.keys(bodyOf()).sort()).toEqual(["claimId", "models", "runId"]);
    expect(bodyOf()).toEqual({ runId: ORIGIN.runId, claimId: ORIGIN.claimId, models: MODELS });
  });

  it("sends no claim text and no projectId", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    await mount(FILED);
    await submitOrigin();
    const raw = (mockedAuthedFetch.mock.calls[0][1] as { body: string }).body;
    for (const forbidden of ["claim\"", "projectId", "origin\"", "workspaceId", "uid", "creator", "role"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("never posts to the Personal endpoint", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    await mount(UNFILED);
    await submitOrigin();
    for (const u of urls()) {
      expect(u).not.toContain("/api/verify-claim");
      expect(u).not.toContain("/api/user/");
    }
  });

  it("retries a 401 exactly once with the identical origin body", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(401, { ok: false, errorCode: "auth_error" })).mockResolvedValueOnce(response(200, okBody()));
    await mount(UNFILED);
    expect((await submitOrigin()).status).toBe("ok");
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  it("terminates a second 401 as auth_error with no third request", async () => {
    mockedAuthedFetch.mockResolvedValue(response(401, { ok: false, errorCode: "unauthorized" }));
    await mount(UNFILED);
    expect(await submitOrigin()).toEqual({ status: "rejected", code: "auth_error" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
  });

  it("issues exactly ONE request for two same-tick origin submissions", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise);
    await mount(UNFILED);
    let first!: Promise<TeamClaimCreateOutcome>;
    let second!: TeamClaimCreateOutcome;
    await act(async () => {
      first = hook.submit({ origin: ORIGIN, selectedModels: MODELS });
      second = await hook.submit({ origin: ORIGIN, selectedModels: MODELS });
    });
    expect(second).toEqual({ status: "already_submitting" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      slow.resolve(response(200, okBody()));
      await first;
    });
  });

  it.each([
    ["a transport failure", null],
    ["HTTP 500", 500],
    ["HTTP 503", 503],
  ])("issues exactly one request for %s and reports outcome_unknown", async (_l, status) => {
    if (status === null) mockedAuthedFetch.mockRejectedValue(new Error("network"));
    else mockedAuthedFetch.mockResolvedValue(response(status as number, {}));
    await mount(UNFILED);
    expect(await submitOrigin()).toEqual({ status: "outcome_unknown" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 429", async () => {
    mockedAuthedFetch.mockResolvedValue(response(429, { ok: false, errorCode: "rate_limit_exceeded" }));
    await mount(UNFILED);
    expect(await submitOrigin()).toEqual({ status: "rejected", code: "rate_limit_exceeded" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("maps origin-specific rejections", async () => {
    for (const code of ["origin_not_eligible", "invalid_origin_locator", "ambiguous_request_mode"]) {
      mockedAuthedFetch.mockResolvedValue(response(404, { ok: false, errorCode: code }));
      await mount(UNFILED);
      const outcome = await submitOrigin();
      expect(outcome.status).toBe("rejected");
      expect((outcome as { code: string }).code).toBe(code);
    }
  });

  describe("success: the SERVER decides the Project", () => {
    it("accepts an Unfiled result", async () => {
      mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: null })));
      await mount(UNFILED);
      expect(await submitOrigin()).toEqual({ status: "ok", verificationId: "vcl-1", workspaceId: W, projectId: null });
    });

    it("accepts any valid Project id, even one the composer never knew", async () => {
      // The source run may have been reorganized since the handoff link was made.
      mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: "proj-moved" })));
      await mount(UNFILED);
      expect(await submitOrigin()).toEqual({ status: "ok", verificationId: "vcl-1", workspaceId: W, projectId: "proj-moved" });
    });

    it("accepts a Project id that differs from the composer's own address", async () => {
      mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: "proj-other" })));
      await mount(FILED);
      expect((await submitOrigin()).status).toBe("ok");
    });

    it.each([
      ["a foreign Workspace", okBody({ workspaceId: "ws-other" })],
      ["projectId undefined", { ok: true, verificationId: "vcl-1", workspaceId: W }],
      ["projectId empty string", okBody({ projectId: "" })],
      ["projectId a number", okBody({ projectId: 7 })],
      ["projectId an object", okBody({ projectId: { id: "p" } })],
      ["a missing verificationId", okBody({ verificationId: "" })],
      ["ok !== true", { ...okBody(), ok: false }],
    ])("reports outcome_unknown for %s", async (_l, body) => {
      mockedAuthedFetch.mockResolvedValue(response(200, body));
      await mount(UNFILED);
      expect(await submitOrigin()).toEqual({ status: "outcome_unknown" });
    });
  });
});

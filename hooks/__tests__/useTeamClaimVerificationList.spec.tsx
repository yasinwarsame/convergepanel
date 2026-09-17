/**
 * TEAM-VERIFICATION-PARITY-R4-I2 §AD — `useTeamClaimVerificationList`.
 *
 * The URL builder and the containment parser are REAL and are additionally
 * exercised directly, because they are the whole security value of this hook.
 * `useAuth` and `authedFetch` are controlled boundaries; the hook runs inside a
 * probe component so React's real effect/commit ordering — and therefore the
 * generation guard, address invalidation and unmount behaviour — is under test.
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
  useTeamClaimVerificationList,
  buildTeamClaimListUrl,
  parseTeamClaimListPageResponse,
  type TeamClaimListAddress,
  type UseTeamClaimVerificationListResult,
} from "@/hooks/useTeamClaimVerificationList";

const W = "ws-1";
const P = "proj-1";

const ALL: TeamClaimListAddress = { kind: "workspace", workspaceId: W, scope: "all" };
const UNFILED: TeamClaimListAddress = { kind: "workspace", workspaceId: W, scope: "unfiled" };
const PROJECT: TeamClaimListAddress = { kind: "project", workspaceId: W, projectId: P };

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
const filedItem = (over: Record<string, unknown> = {}) => item({ projectId: P, project: { id: P, name: "Launch", status: "active" }, ...over });

function page(items: unknown[], over: Record<string, unknown> = {}, scope: string | undefined = "all") {
  return { ok: true, items, hasMore: false, ...(scope !== undefined ? { scope } : {}), ...over };
}

const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const results: UseTeamClaimVerificationListResult[] = [];
function Probe(props: { address: TeamClaimListAddress; enabled?: boolean }) {
  results.push(useTeamClaimVerificationList(props));
  return null;
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(props: { address: TeamClaimListAddress; enabled?: boolean }) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(Probe, props));
  });
  await flush();
  return r;
}

async function update(r: TestRenderer.ReactTestRenderer, props: { address: TeamClaimListAddress; enabled?: boolean }) {
  await act(async () => {
    r.update(createElement(Probe, props));
  });
  await flush();
}

const last = () => results[results.length - 1];
const urls = () => mockedAuthedFetch.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  jest.clearAllMocks();
  results.length = 0;
  auth = { user: USER_A, authReady: true };
});

describe("URL shape", () => {
  it("builds the Workspace All URL", () => {
    expect(buildTeamClaimListUrl(ALL)).toBe("/api/workspaces/ws-1/verifications");
  });

  it("builds the Workspace Unfiled URL with the server scope contract", () => {
    expect(buildTeamClaimListUrl(UNFILED)).toBe("/api/workspaces/ws-1/verifications?scope=unfiled");
  });

  it("builds the Project URL", () => {
    expect(buildTeamClaimListUrl(PROJECT)).toBe("/api/workspaces/ws-1/projects/proj-1/verifications");
  });

  it("appends the cursor exactly once, on every address", () => {
    expect(buildTeamClaimListUrl(ALL, "c1")).toBe("/api/workspaces/ws-1/verifications?cursor=c1");
    expect(buildTeamClaimListUrl(UNFILED, "c1")).toBe("/api/workspaces/ws-1/verifications?scope=unfiled&cursor=c1");
    expect(buildTeamClaimListUrl(PROJECT, "c1")).toBe("/api/workspaces/ws-1/projects/proj-1/verifications?cursor=c1");
    for (const a of [ALL, UNFILED, PROJECT]) {
      expect(buildTeamClaimListUrl(a, "c1").match(/cursor=/g)).toHaveLength(1);
    }
  });

  it("encodes Workspace, Project and cursor", () => {
    expect(buildTeamClaimListUrl({ kind: "project", workspaceId: "w s", projectId: "p/1" }, "a b")).toBe(
      "/api/workspaces/w%20s/projects/p%2F1/verifications?cursor=a+b"
    );
  });

  it("never encodes a creator, uid, role or capability filter", () => {
    for (const a of [ALL, UNFILED, PROJECT]) {
      const u = buildTeamClaimListUrl(a, "c1");
      for (const forbidden of ["uid", "userId", "creator", "role", "capab"]) expect(u).not.toContain(forbidden);
      expect(u).not.toContain("/api/user/");
    }
  });
});

describe("auth", () => {
  it("waits for authReady before requesting", async () => {
    auth = { user: null, authReady: false };
    await mount({ address: ALL });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(last().status).toBe("loading");
  });

  it("reports unauthorized with no signed-in user", async () => {
    auth = { user: null, authReady: true };
    await mount({ address: ALL });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(last().status).toBe("error");
    expect(last().initialErrorCode).toBe("unauthorized");
  });

  it("performs exactly one forced token refresh on 401 and then succeeds", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(401, { ok: false, errorCode: "auth_error" })).mockResolvedValueOnce(response(200, page([item()])));
    await mount({ address: ALL });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect((mockedAuthedFetch.mock.calls[0][1] as { forceTokenRefresh?: boolean }).forceTokenRefresh).toBeUndefined();
    expect((mockedAuthedFetch.mock.calls[1][1] as { forceTokenRefresh?: boolean }).forceTokenRefresh).toBe(true);
    expect(last().status).toBe("ready");
  });

  it("terminates on a second 401 without looping", async () => {
    mockedAuthedFetch.mockResolvedValue(response(401, { ok: false, errorCode: "auth_error" }));
    await mount({ address: ALL });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(last().initialErrorCode).toBe("auth_error");
  });

  it("issues GET only, with no body and no Personal route", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item()])));
    await mount({ address: ALL });
    for (const call of mockedAuthedFetch.mock.calls) {
      expect((call[1] as { method: string }).method).toBe("GET");
      expect((call[1] as { body?: unknown }).body).toBeUndefined();
      expect(call[0] as string).not.toContain("/api/user/");
    }
  });

  it("issues no request at all when disabled", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item()])));
    await mount({ address: PROJECT, enabled: false });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(last().status).toBe("disabled");
    expect(last().items).toEqual([]);
  });
});

describe("Workspace All containment", () => {
  it("accepts a valid empty page", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([])));
    await mount({ address: ALL });
    expect(last().status).toBe("ready");
    expect(last().items).toEqual([]);
  });

  it("accepts mixed Unfiled and Project rows", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item(), filedItem({ verificationId: "vcl-2" })])));
    await mount({ address: ALL });
    expect(last().status).toBe("ready");
    expect(last().items.map((i) => i.verificationId)).toEqual(["vcl-1", "vcl-2"]);
  });

  it("rejects a response that served a different scope", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item()], {}, "unfiled")));
    await mount({ address: ALL });
    expect(last().initialErrorCode).toBe("malformed_response");
  });

  it("rejects a missing scope envelope", async () => {
    // Built inline: `page(..., undefined)` would trigger the helper's default.
    mockedAuthedFetch.mockResolvedValue(response(200, { ok: true, items: [item()], hasMore: false }));
    await mount({ address: ALL });
    expect(last().initialErrorCode).toBe("malformed_response");
  });

  it("rejects a foreign-Workspace row", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item({ workspaceId: "ws-other" })])));
    await mount({ address: ALL });
    expect(last().initialErrorCode).toBe("malformed_response");
  });

  it("rejects projectId null with a non-null project", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item({ projectId: null, project: { id: P, name: "X", status: "active" } })])));
    await mount({ address: ALL });
    expect(last().initialErrorCode).toBe("malformed_response");
  });

  it("rejects a filed row whose Project is null — never rendered as Unfiled", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item({ projectId: P, project: null })])));
    await mount({ address: ALL });
    expect(last().initialErrorCode).toBe("malformed_response");
    expect(last().items).toEqual([]);
  });

  it("rejects a mismatched project.id", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item({ projectId: P, project: { id: "other", name: "X", status: "active" } })])));
    await mount({ address: ALL });
    expect(last().initialErrorCode).toBe("malformed_response");
  });
});

describe("Unfiled containment", () => {
  it("accepts a valid Unfiled row and asserts the served scope", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item()], {}, "unfiled")));
    await mount({ address: UNFILED });
    expect(urls()).toEqual(["/api/workspaces/ws-1/verifications?scope=unfiled"]);
    expect(last().status).toBe("ready");
  });

  it("rejects a Project-bound row", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([filedItem()], {}, "unfiled")));
    await mount({ address: UNFILED });
    expect(last().initialErrorCode).toBe("malformed_response");
  });

  it("rejects a response that served scope=all", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item()], {}, "all")));
    await mount({ address: UNFILED });
    expect(last().initialErrorCode).toBe("malformed_response");
  });
});

describe("Project containment", () => {
  const projectPage = (items: unknown[], over: Record<string, unknown> = {}) => ({ ok: true, items, hasMore: false, ...over });

  it("accepts a valid Project row", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, projectPage([filedItem()])));
    await mount({ address: PROJECT });
    expect(urls()).toEqual(["/api/workspaces/ws-1/projects/proj-1/verifications"]);
    expect(last().status).toBe("ready");
  });

  it.each([
    ["another Project", { projectId: "proj-2", project: { id: "proj-2", name: "B", status: "active" } }],
    ["an Unfiled row", { projectId: null, project: null }],
    ["a foreign Workspace", { workspaceId: "ws-other" }],
    ["a mismatched project.id", { projectId: P, project: { id: "proj-9", name: "B", status: "active" } }],
  ])("rejects %s", async (_label, over) => {
    mockedAuthedFetch.mockResolvedValue(response(200, projectPage([item(over as Record<string, unknown>)])));
    await mount({ address: PROJECT });
    expect(last().initialErrorCode).toBe("malformed_response");
  });
});

describe("item field validation", () => {
  it.each([
    ["missing verificationId", { verificationId: "" }],
    ["empty claim", { claim: "" }],
    ["unknown verdict", { verdict: "maybe" }],
    ["non-finite consensusScore", { consensusScore: Number.NaN }],
    ["bad confidenceLabel", { confidenceLabel: "Very high" }],
    ["bad evidenceQuality", { evidenceQuality: "excellent" }],
    ["bad governanceStatus", { governanceStatus: "escalated" }],
    ["unparseable createdAt", { createdAt: "not-a-date" }],
    ["empty createdAt", { createdAt: "" }],
  ])("fails the whole page for %s", async (_label, over) => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item(), item({ verificationId: "vcl-bad", ...(over as Record<string, unknown>) })])));
    await mount({ address: ALL });
    // One bad row must not yield a plausible-looking short list.
    expect(last().initialErrorCode).toBe("malformed_response");
    expect(last().items).toEqual([]);
  });

  it("ignores a raw creator field rather than surfacing it", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item({ userId: "uid-creator", reviewerUid: "uid-rev" })])));
    await mount({ address: ALL });
    expect(last().status).toBe("ready");
    expect(JSON.stringify(last().items)).not.toContain("uid-creator");
    expect(JSON.stringify(last().items)).not.toContain("uid-rev");
  });

  it("accepts an absent governanceStatus and omits the key", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item()])));
    await mount({ address: ALL });
    expect(Object.prototype.hasOwnProperty.call(last().items[0], "governanceStatus")).toBe(false);
  });
});

describe("server error mapping", () => {
  it.each([
    [401, "auth_error", "auth_error"],
    [403, "insufficient_capability", "insufficient_capability"],
    [404, "team_workspace_not_found", "team_workspace_not_found"],
    [404, "project_not_found", "project_not_found"],
    [503, "team_workspace_unavailable", "team_workspace_unavailable"],
    [400, "invalid_scope", "invalid_scope"],
    [400, "invalid_cursor", "invalid_cursor"],
    [500, "internal_error", "internal_error"],
  ])("maps HTTP %s %s", async (status, code, expected) => {
    mockedAuthedFetch.mockResolvedValue(response(status as number, { ok: false, errorCode: code }));
    await mount({ address: ALL });
    expect(last().initialErrorCode).toBe(expected);
  });

  it("maps a transport failure to network_error", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("offline"));
    await mount({ address: ALL });
    expect(last().initialErrorCode).toBe("network_error");
  });

  it("never renders a failure as a successful empty list", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, { ok: false, errorCode: "internal_error" }));
    await mount({ address: ALL });
    expect(last().status).toBe("error");
    expect(last().status).not.toBe("ready");
  });
});

describe("pagination", () => {
  it("exposes hasMore and appends the next page", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(200, page([item({ verificationId: "vcl-2" })])));
    await mount({ address: ALL });
    expect(last().hasMore).toBe(true);
    await act(async () => {
      last().loadMore();
    });
    await flush();
    expect(urls()[1]).toBe("/api/workspaces/ws-1/verifications?cursor=c1");
    expect(last().items.map((i) => i.verificationId)).toEqual(["vcl-1", "vcl-2"]);
  });

  it("dedupes a verificationId repeated across pages", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(200, page([item(), item({ verificationId: "vcl-2" })])));
    await mount({ address: ALL });
    await act(async () => {
      last().loadMore();
    });
    await flush();
    expect(last().items.map((i) => i.verificationId)).toEqual(["vcl-1", "vcl-2"]);
  });

  it("preserves already-rendered rows when load-more fails", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(500, { ok: false, errorCode: "internal_error" }));
    await mount({ address: ALL });
    await act(async () => {
      last().loadMore();
    });
    await flush();
    expect(last().items.map((i) => i.verificationId)).toEqual(["vcl-1"]);
    expect(last().loadMoreErrorCode).toBe("internal_error");
    expect(last().status).toBe("ready");
  });

  it("supports restarting from page 1 after invalid_cursor", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(400, { ok: false, errorCode: "invalid_cursor" }))
      .mockResolvedValueOnce(response(200, page([item()])));
    await mount({ address: ALL });
    await act(async () => {
      last().loadMore();
    });
    await flush();
    expect(last().loadMoreErrorCode).toBe("invalid_cursor");
    await act(async () => {
      last().resetAndReloadFromStart();
    });
    await flush();
    expect(urls()[2]).toBe("/api/workspaces/ws-1/verifications");
    expect(last().items.map((i) => i.verificationId)).toEqual(["vcl-1"]);
  });
});

describe("address changes drop the cursor and clear rows", () => {
  async function firstPageThen(r: TestRenderer.ReactTestRenderer, next: { address: TeamClaimListAddress }) {
    await act(async () => {
      last().loadMore();
    });
    await flush();
    await update(r, next);
  }

  it("All -> Unfiled never reuses the previous cursor", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValue(response(200, page([], {}, "unfiled")));
    const r = await mount({ address: ALL });
    await update(r, { address: UNFILED });
    expect(urls()[urls().length - 1]).toBe("/api/workspaces/ws-1/verifications?scope=unfiled");
    expect(urls().some((u) => u.includes("scope=unfiled") && u.includes("cursor="))).toBe(false);
  });

  it("Unfiled -> All never reuses the previous cursor", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" }, "unfiled")))
      .mockResolvedValue(response(200, page([])));
    const r = await mount({ address: UNFILED });
    await update(r, { address: ALL });
    expect(urls()[urls().length - 1]).toBe("/api/workspaces/ws-1/verifications");
  });

  it("Project A -> Project B never reuses the previous cursor or rows", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, { ok: true, items: [filedItem()], hasMore: true, nextCursor: "c1" }))
      .mockResolvedValue(response(200, { ok: true, items: [], hasMore: false }));
    const r = await mount({ address: PROJECT });
    await update(r, { address: { kind: "project", workspaceId: W, projectId: "proj-2" } });
    expect(urls()[urls().length - 1]).toBe("/api/workspaces/ws-1/projects/proj-2/verifications");
    expect(last().items).toEqual([]);
  });

  it("Workspace A -> Workspace B never reuses the previous cursor or rows", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValue(response(200, page([])));
    const r = await mount({ address: ALL });
    await update(r, { address: { kind: "workspace", workspaceId: "ws-2", scope: "all" } });
    expect(urls()[urls().length - 1]).toBe("/api/workspaces/ws-2/verifications");
    expect(last().items).toEqual([]);
  });
});

describe("race safety", () => {
  it("a stale All response never paints after switching to Unfiled", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise).mockResolvedValue(response(200, page([], {}, "unfiled")));
    const r = await mount({ address: ALL });
    await update(r, { address: UNFILED });

    await act(async () => {
      slow.resolve(response(200, page([item({ verificationId: "stale-all" })])));
      await slow.promise;
    });
    await flush();

    expect(last().items).toEqual([]);
    expect(JSON.stringify(last().items)).not.toContain("stale-all");
  });

  it("a stale Project A response never paints after switching to Project B", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise).mockResolvedValue(response(200, { ok: true, items: [], hasMore: false }));
    const r = await mount({ address: PROJECT });
    await update(r, { address: { kind: "project", workspaceId: W, projectId: "proj-2" } });

    await act(async () => {
      slow.resolve(response(200, { ok: true, items: [filedItem({ verificationId: "stale-a" })], hasMore: false }));
      await slow.promise;
    });
    await flush();

    expect(JSON.stringify(last().items)).not.toContain("stale-a");
  });

  it("a stale response never paints after the signed-in identity changes", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise).mockResolvedValue(response(200, page([])));
    const r = await mount({ address: ALL });
    auth = { user: USER_B, authReady: true };
    await update(r, { address: ALL });

    await act(async () => {
      slow.resolve(response(200, page([item({ verificationId: "stale-uid" })])));
      await slow.promise;
    });
    await flush();

    expect(JSON.stringify(last().items)).not.toContain("stale-uid");
  });

  it("commits nothing after unmount", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise);
    const r = await mount({ address: ALL });
    const before = results.length;
    await act(async () => {
      r.unmount();
    });
    await act(async () => {
      slow.resolve(response(200, page([item()])));
      await slow.promise;
    });
    await flush();
    expect(results.length).toBe(before);
  });
});

describe("parseTeamClaimListPageResponse (pure)", () => {
  it("is the containment decision itself, independent of transport", () => {
    expect(parseTeamClaimListPageResponse({ ok: true, status: 200, body: page([filedItem()]), address: UNFILED }).ok).toBe(false);
    expect(parseTeamClaimListPageResponse({ ok: true, status: 200, body: page([item()], {}, "unfiled"), address: UNFILED }).ok).toBe(true);
    expect(parseTeamClaimListPageResponse({ ok: true, status: 200, body: page([item({ workspaceId: "nope" })]), address: ALL }).ok).toBe(false);
  });
});

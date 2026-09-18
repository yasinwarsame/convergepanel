/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AK — `useTeamVideoVerificationList`.
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
  useTeamVideoVerificationList,
  buildTeamVideoListUrl,
  parseTeamVideoListPageResponse,
  teamVideoListInitialErrorCopy,
  teamVideoListLoadMoreErrorCopy,
  type TeamVideoListAddress,
  type UseTeamVideoVerificationListResult,
} from "@/hooks/useTeamVideoVerificationList";

const W = "ws-1";
const P = "proj-1";

const ALL: TeamVideoListAddress = { kind: "workspace", workspaceId: W, scope: "all" };
const UNFILED: TeamVideoListAddress = { kind: "workspace", workspaceId: W, scope: "unfiled" };
const PROJECT: TeamVideoListAddress = { kind: "project", workspaceId: W, projectId: P };

function item(over: Record<string, unknown> = {}) {
  return {
    verificationId: "vid-1",
    fileName: "clip.mp4",
    verdict: "authentic_captured",
    contentType: "camera_footage",
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
const filedItem = (over: Record<string, unknown> = {}) => item({ projectId: P, project: { id: P, name: "Launch", status: "active" }, ...over });

function page(items: unknown[], over: Record<string, unknown> = {}, scope = "all") {
  return { ok: true, items, hasMore: false, scope, ...over };
}
/**
 * A body with NO `scope` key at all. Built separately because passing
 * `undefined` for a defaulted parameter silently triggers the default, which
 * would make "the server omitted scope" assertions vacuous.
 */
function pageNoScope(items: unknown[], over: Record<string, unknown> = {}) {
  return { ok: true, items, hasMore: false, ...over };
}

const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const results: UseTeamVideoVerificationListResult[] = [];
function Probe(props: { address: TeamVideoListAddress; enabled?: boolean }) {
  results.push(useTeamVideoVerificationList(props));
  return null;
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(props: { address: TeamVideoListAddress; enabled?: boolean }) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(Probe, props));
  });
  await flush();
  return r;
}

async function update(r: TestRenderer.ReactTestRenderer, props: { address: TeamVideoListAddress; enabled?: boolean }) {
  await act(async () => {
    r.update(createElement(Probe, props));
  });
  await flush();
}

const last = () => results[results.length - 1];
const urls = () => mockedAuthedFetch.mock.calls.map((c) => c[0] as string);
const parse = (body: unknown, address: TeamVideoListAddress = ALL) => parseTeamVideoListPageResponse({ ok: true, status: 200, body, address });

beforeEach(() => {
  jest.clearAllMocks();
  results.length = 0;
  auth = { user: USER_A, authReady: true };
});

describe("URL shape", () => {
  it("builds the Workspace All URL", () => {
    expect(buildTeamVideoListUrl(ALL)).toBe("/api/workspaces/ws-1/video-verifications");
  });

  it("builds the Workspace Unfiled URL with the server scope contract", () => {
    expect(buildTeamVideoListUrl(UNFILED)).toBe("/api/workspaces/ws-1/video-verifications?scope=unfiled");
  });

  it("builds the Project URL", () => {
    expect(buildTeamVideoListUrl(PROJECT)).toBe("/api/workspaces/ws-1/projects/proj-1/video-verifications");
  });

  it("appends the cursor exactly once, on every address", () => {
    expect(buildTeamVideoListUrl(ALL, "c1")).toBe("/api/workspaces/ws-1/video-verifications?cursor=c1");
    expect(buildTeamVideoListUrl(UNFILED, "c1")).toBe("/api/workspaces/ws-1/video-verifications?scope=unfiled&cursor=c1");
    expect(buildTeamVideoListUrl(PROJECT, "c1")).toBe("/api/workspaces/ws-1/projects/proj-1/video-verifications?cursor=c1");
    for (const a of [ALL, UNFILED, PROJECT]) {
      expect(buildTeamVideoListUrl(a, "c1").match(/cursor=/g)).toHaveLength(1);
    }
  });

  it("encodes Workspace, Project and cursor", () => {
    expect(buildTeamVideoListUrl({ kind: "project", workspaceId: "w s", projectId: "p/1" }, "a b")).toBe(
      "/api/workspaces/w%20s/projects/p%2F1/video-verifications?cursor=a+b"
    );
  });

  it("never reaches a Personal endpoint", () => {
    for (const a of [ALL, UNFILED, PROJECT]) {
      const u = buildTeamVideoListUrl(a, "c");
      expect(u).not.toContain("/api/user/");
      expect(u).not.toContain("/api/verify-video");
      expect(u).not.toContain("videoVerifications");
    }
  });
});

describe("strict row parsing — one bad row fails the WHOLE page", () => {
  it("accepts a well-formed Unfiled row", () => {
    const r = parse(page([item()]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.page.items[0].fileName).toBe("clip.mp4");
  });

  it.each(["authentic_captured", "authentic_produced", "likely_manipulated", "inconclusive", "insufficient"])("accepts canonical verdict %s", (verdict) => {
    expect(parse(page([item({ verdict })])).ok).toBe(true);
  });

  it('accepts the legacy aggregate verdict "authentic"', () => {
    expect(parse(page([item({ verdict: "authentic" })])).ok).toBe(true);
  });

  it("omits contentType when absent rather than inventing one", () => {
    const raw = item();
    delete (raw as Record<string, unknown>).contentType;
    const r = parse(page([raw]));
    expect(r.ok).toBe(true);
    expect(r.ok && "contentType" in r.page.items[0]).toBe(false);
  });

  it.each([
    ["missing verificationId", { verificationId: "" }],
    ["missing fileName", { fileName: "" }],
    ["unknown verdict", { verdict: "probably_fine" }],
    ["non-string verdict", { verdict: 3 }],
    ["empty contentType", { contentType: "" }],
    ["NaN consensus", { consensusScore: Number.NaN }],
    ["consensus below range", { consensusScore: -1 }],
    ["consensus above range", { consensusScore: 101 }],
    ["non-number consensus", { consensusScore: "88" }],
    ["bad confidence", { confidenceLabel: "high" }],
    ["bad evidence quality", { evidenceQuality: "excellent" }],
    ["negative frameCount", { frameCount: -1 }],
    ["non-integer frameCount", { frameCount: 2.5 }],
    ["non-number frameCount", { frameCount: "8" }],
    ["unparseable createdAt", { createdAt: "not-a-date" }],
    ["empty createdAt", { createdAt: "" }],
    ["unknown governanceStatus", { governanceStatus: "pending" }],
    ["foreign Workspace", { workspaceId: "ws-other" }],
    ["empty-string projectId", { projectId: "" }],
  ])("%s fails the whole page", (_l, over) => {
    const r = parse(page([item(), item({ verificationId: "vid-2", ...(over as Record<string, unknown>) })]));
    expect(r).toEqual({ ok: false, errorCode: "malformed_response" });
  });

  it("a filed row WITHOUT a Project DTO fails the whole page (lists never degrade)", () => {
    expect(parse(page([item({ projectId: P, project: null })]))).toEqual({ ok: false, errorCode: "malformed_response" });
  });

  it("an Unfiled row WITH a Project DTO fails the whole page", () => {
    expect(parse(page([item({ projectId: null, project: { id: P, name: "X", status: "active" } })]))).toEqual({ ok: false, errorCode: "malformed_response" });
  });

  it("a Project DTO whose id disagrees with projectId fails the whole page", () => {
    expect(parse(page([item({ projectId: P, project: { id: "other", name: "X", status: "active" } })]))).toEqual({ ok: false, errorCode: "malformed_response" });
  });

  it("an archived Project label is accepted", () => {
    const r = parse(page([filedItem({ project: { id: P, name: "Launch", status: "archived" } })]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.page.items[0].project?.status).toBe("archived");
  });
});

describe("scope containment", () => {
  it("Unfiled scope rejects a filed row", () => {
    expect(parse(page([filedItem()], {}, "unfiled"), UNFILED)).toEqual({ ok: false, errorCode: "malformed_response" });
  });

  it("Project scope rejects a row filed elsewhere", () => {
    expect(parseTeamVideoListPageResponse({ ok: true, status: 200, body: pageNoScope([filedItem({ projectId: "other", project: { id: "other", name: "O", status: "active" } })]), address: PROJECT })).toEqual({
      ok: false,
      errorCode: "malformed_response",
    });
  });

  it("Project scope rejects an Unfiled row", () => {
    expect(parseTeamVideoListPageResponse({ ok: true, status: 200, body: pageNoScope([item()]), address: PROJECT })).toEqual({
      ok: false,
      errorCode: "malformed_response",
    });
  });

  it("All scope accepts both Unfiled and filed rows", () => {
    const r = parse(page([item(), filedItem({ verificationId: "vid-2" })]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.page.items.map((i) => i.projectId)).toEqual([null, P]);
  });

  it("a Workspace scope echo mismatch is malformed", () => {
    expect(parse(page([item()], {}, "unfiled"), ALL)).toEqual({ ok: false, errorCode: "malformed_response" });
    expect(parse(pageNoScope([item()]), ALL)).toEqual({ ok: false, errorCode: "malformed_response" });
  });
});

describe("page envelope", () => {
  it("hasMore true WITHOUT a cursor is malformed (no page-1 replay loop)", () => {
    expect(parse(page([item()], { hasMore: true }))).toEqual({ ok: false, errorCode: "malformed_response" });
  });

  it("hasMore true WITH a cursor is accepted", () => {
    const r = parse(page([item()], { hasMore: true, nextCursor: "c1" }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.page.nextCursor).toBe("c1");
  });

  it("hasMore false WITH a cursor is malformed (the server derives one from the other)", () => {
    expect(parse(page([item()], { hasMore: false, nextCursor: "c1" }))).toEqual({ ok: false, errorCode: "malformed_response" });
  });

  it.each([
    ["ok false", { ok: false, items: [], hasMore: false, scope: "all" }],
    ["items not an array", { ok: true, items: {}, hasMore: false, scope: "all" }],
    ["hasMore not boolean", { ok: true, items: [], hasMore: "no", scope: "all" }],
    ["empty nextCursor", { ok: true, items: [], hasMore: true, nextCursor: "", scope: "all" }],
    ["not an object", null],
  ])("%s is malformed", (_l, body) => {
    expect(parse(body)).toEqual({ ok: false, errorCode: "malformed_response" });
  });

  it("maps server error codes and status fallbacks", () => {
    const err = (status: number, body: unknown) => parseTeamVideoListPageResponse({ ok: false, status, body, address: ALL });
    expect(err(403, { errorCode: "insufficient_capability" })).toEqual({ ok: false, errorCode: "insufficient_capability" });
    expect(err(404, { errorCode: "team_workspace_not_found" })).toEqual({ ok: false, errorCode: "team_workspace_not_found" });
    expect(err(400, { errorCode: "invalid_cursor" })).toEqual({ ok: false, errorCode: "invalid_cursor" });
    expect(err(400, { errorCode: "invalid_scope" })).toEqual({ ok: false, errorCode: "invalid_scope" });
    expect(err(503, {})).toEqual({ ok: false, errorCode: "team_workspace_unavailable" });
    expect(err(401, {})).toEqual({ ok: false, errorCode: "auth_error" });
    expect(err(418, {})).toEqual({ ok: false, errorCode: "internal_error" });
  });
});

describe("requests follow the addressed scope", () => {
  it("issues the Workspace All request", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item()])));
    await mount({ address: ALL });
    expect(urls()).toEqual(["/api/workspaces/ws-1/video-verifications"]);
    expect(last().items).toHaveLength(1);
  });

  it("issues the server Unfiled request, never a client filter of All", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item()], {}, "unfiled")));
    await mount({ address: UNFILED });
    expect(urls()).toEqual(["/api/workspaces/ws-1/video-verifications?scope=unfiled"]);
  });

  it("issues the Project request", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, { ok: true, items: [filedItem()], hasMore: false }));
    await mount({ address: PROJECT });
    expect(urls()).toEqual(["/api/workspaces/ws-1/projects/proj-1/video-verifications"]);
  });

  it("uses GET with no-store and never a Personal route", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([])));
    await mount({ address: ALL });
    const opts = mockedAuthedFetch.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.method).toBe("GET");
    expect(opts.cache).toBe("no-store");
    expect(JSON.stringify(urls())).not.toContain("/api/user/");
  });

  it("issues nothing when disabled", async () => {
    await mount({ address: ALL, enabled: false });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(last().status).toBe("disabled");
  });

  it("waits for auth readiness", async () => {
    auth = { user: USER_A, authReady: false };
    await mount({ address: ALL });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(last().status).toBe("loading");
  });

  it("no signed-in user -> unauthorized without a request", async () => {
    auth = { user: null, authReady: true };
    await mount({ address: ALL });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(last().initialErrorCode).toBe("unauthorized");
  });
});

describe("401 handling", () => {
  it("retries exactly once with a forced refresh, then succeeds", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(401, {})).mockResolvedValueOnce(response(200, page([item()])));
    await mount({ address: ALL });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect((mockedAuthedFetch.mock.calls[0][1] as Record<string, unknown>).forceTokenRefresh).toBeUndefined();
    expect((mockedAuthedFetch.mock.calls[1][1] as Record<string, unknown>).forceTokenRefresh).toBe(true);
    expect(last().status).toBe("ready");
  });

  it("a second 401 is auth_error, decided BEFORE the body is parsed, with no third request", async () => {
    const secondBody = jest.fn(async () => ({ ok: false, errorCode: "unauthorized" }));
    mockedAuthedFetch
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValueOnce({ ok: false, status: 401, json: secondBody });
    await mount({ address: ALL });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(secondBody).not.toHaveBeenCalled();
    expect(last().initialErrorCode).toBe("auth_error");
  });

  it("both attempts share one AbortSignal", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(401, {})).mockResolvedValueOnce(response(200, page([])));
    await mount({ address: ALL });
    const s0 = (mockedAuthedFetch.mock.calls[0][1] as Record<string, unknown>).signal;
    const s1 = (mockedAuthedFetch.mock.calls[1][1] as Record<string, unknown>).signal;
    expect(s0).toBe(s1);
  });
});

describe("address changes abort and restart from page 1", () => {
  async function abortedOnChange(from: TeamVideoListAddress, to: TeamVideoListAddress) {
    const d = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(d.promise).mockResolvedValue(response(200, page([item()], {}, to.kind === "workspace" ? to.scope : undefined)));
    const r = await mount({ address: from });
    const firstSignal = (mockedAuthedFetch.mock.calls[0][1] as { signal: AbortSignal }).signal;
    expect(firstSignal.aborted).toBe(false);
    await update(r, { address: to });
    return { firstSignal, r };
  }

  it("scope change aborts the in-flight request", async () => {
    const { firstSignal } = await abortedOnChange(ALL, UNFILED);
    expect(firstSignal.aborted).toBe(true);
    expect(urls()[1]).toBe("/api/workspaces/ws-1/video-verifications?scope=unfiled");
  });

  it("Workspace change aborts the in-flight request", async () => {
    const { firstSignal } = await abortedOnChange(ALL, { kind: "workspace", workspaceId: "ws-2", scope: "all" });
    expect(firstSignal.aborted).toBe(true);
  });

  it("Project change aborts the in-flight request", async () => {
    const { firstSignal } = await abortedOnChange(PROJECT, { kind: "project", workspaceId: W, projectId: "proj-2" });
    expect(firstSignal.aborted).toBe(true);
  });

  it("unmount aborts the in-flight request", async () => {
    const d = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(d.promise);
    const r = await mount({ address: ALL });
    const signal = (mockedAuthedFetch.mock.calls[0][1] as { signal: AbortSignal }).signal;
    await act(async () => {
      r.unmount();
    });
    expect(signal.aborted).toBe(true);
  });

  it("a stale response for the previous scope can never paint", async () => {
    const d = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(d.promise).mockResolvedValue(response(200, page([item({ verificationId: "vid-new" })], {}, "unfiled")));
    const r = await mount({ address: ALL });
    await update(r, { address: UNFILED });
    await act(async () => {
      d.resolve(response(200, page([item({ verificationId: "vid-stale" })])));
      await new Promise((res) => setTimeout(res, 0));
    });
    await flush();
    expect(last().items.map((i) => i.verificationId)).toEqual(["vid-new"]);
  });

  it("an identity change restarts from page 1", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, page([item()])));
    const r = await mount({ address: ALL });
    auth = { user: USER_B, authReady: true };
    await update(r, { address: ALL });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(2);
    expect(urls()[1]).not.toContain("cursor");
  });
});

describe("pagination and load-more", () => {
  it("load-more sends the cursor and appends", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(200, page([item({ verificationId: "vid-2" })])));
    await mount({ address: ALL });
    expect(last().hasMore).toBe(true);
    await act(async () => {
      last().loadMore();
    });
    await flush();
    expect(urls()[1]).toBe("/api/workspaces/ws-1/video-verifications?cursor=c1");
    expect(last().items.map((i) => i.verificationId)).toEqual(["vid-1", "vid-2"]);
  });

  it("a load-more failure PRESERVES already-rendered rows", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(503, { errorCode: "team_workspace_unavailable" }));
    await mount({ address: ALL });
    await act(async () => {
      last().loadMore();
    });
    await flush();
    expect(last().items).toHaveLength(1);
    expect(last().status).toBe("ready");
    expect(last().loadMoreErrorCode).toBe("team_workspace_unavailable");
  });

  it("an invalid cursor on load-more offers a reload-from-start path", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(400, { errorCode: "invalid_cursor" }))
      .mockResolvedValueOnce(response(200, page([item()])));
    await mount({ address: ALL });
    await act(async () => {
      last().loadMore();
    });
    await flush();
    expect(teamVideoListLoadMoreErrorCopy(last().loadMoreErrorCode!).action).toBe("reload");
    await act(async () => {
      last().resetAndReloadFromStart();
    });
    await flush();
    expect(urls()[2]).toBe("/api/workspaces/ws-1/video-verifications");
    expect(last().items).toHaveLength(1);
  });

  it("deduplicates repeated ids across pages, AFTER validation", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(200, page([item(), item({ verificationId: "vid-2" })])));
    await mount({ address: ALL });
    await act(async () => {
      last().loadMore();
    });
    await flush();
    expect(last().items.map((i) => i.verificationId)).toEqual(["vid-1", "vid-2"]);
  });

  it("a repeated id does NOT silence an integrity-invalid row", async () => {
    mockedAuthedFetch
      .mockResolvedValueOnce(response(200, page([item()], { hasMore: true, nextCursor: "c1" })))
      .mockResolvedValueOnce(response(200, page([item({ workspaceId: "ws-other" })])));
    await mount({ address: ALL });
    await act(async () => {
      last().loadMore();
    });
    await flush();
    expect(last().loadMoreErrorCode).toBe("malformed_response");
  });
});

describe("error copy is video-specific", () => {
  it.each(["unauthorized", "auth_error", "team_workspace_not_found", "insufficient_capability", "team_workspace_unavailable", "network_error", "invalid_cursor", "malformed_response"] as const)(
    "initial copy for %s mentions videos, never claims",
    (code) => {
      const copy = teamVideoListInitialErrorCopy(code);
      expect(copy.message.toLowerCase()).not.toContain("claim");
      expect(copy.message.length).toBeGreaterThan(0);
    }
  );

  it.each(["invalid_cursor", "auth_error", "insufficient_capability", "internal_error", "network_error"] as const)("load-more copy for %s mentions videos, never claims", (code) => {
    expect(teamVideoListLoadMoreErrorCopy(code).message.toLowerCase()).not.toContain("claim");
  });

  it("a concealed denial reveals nothing about another Workspace or Project", () => {
    for (const code of ["team_workspace_not_found", "project_not_found", "insufficient_capability"] as const) {
      const m = teamVideoListInitialErrorCopy(code).message.toLowerCase();
      expect(m).not.toContain("workspace");
      expect(m).not.toContain("project");
      expect(m).not.toContain("permission");
    }
  });
});

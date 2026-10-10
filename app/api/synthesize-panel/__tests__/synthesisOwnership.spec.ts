/**
 * SYNTHESIS_LEGACY_OWNERSHIP_HARDENING — positive ownership on every
 * /api/synthesize-panel surface (POST generation, GET cache, in-flight gate).
 *
 * Contract: typeof run.userId === "string" && run.userId === uid, then a valid
 * Workspace binding. Every denial (malformed runId, missing run, missing /
 * non-string / foreign owner, invalid binding) is the SAME concealed 403;
 * only a genuine inability to check is 503. A slash-containing runId never
 * reaches Firestore path resolution.
 */
jest.mock("@/lib/env", () => ({ OPENAI_API_KEY: "test-key", ANTHROPIC_API_KEY: "test-key" }));
jest.mock("@/lib/firebase/auth-helpers", () => ({ verifySessionCookie: jest.fn().mockResolvedValue({ uid: "owner-uid" }) }));
jest.mock("@/lib/firebase/auth", () => ({ verifyIdToken: jest.fn() }));
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() }),
}));

const OWNER = "owner-uid";
const runDocs = new Map<string, Record<string, unknown>>();
const docPaths: string[] = []; // every collection("runs").doc(id) path ever resolved
const writes: string[] = [];
const dbState = { available: true, throwOnRead: false };
const db = {
  collection: (name: string) => ({
    doc: (id: string) => {
      if (name === "runs") docPaths.push(id);
      return {
        get: jest.fn().mockImplementation(async () => {
          if (name === "users") return { exists: true, data: () => ({ email: "u@example.test" }) };
          if (dbState.throwOnRead) throw new Error("firestore down");
          const data = runDocs.get(id);
          return { exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
        }),
        update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
          writes.push(`update ${name}/${id}`);
          runDocs.set(id, { ...(runDocs.get(id) ?? {}), ...fields });
        }),
        set: jest.fn().mockImplementation(async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
          writes.push(`set ${name}/${id}`);
          runDocs.set(id, { ...(opts?.merge ? runDocs.get(id) ?? {} : {}), ...fields });
        }),
        collection: () => ({ add: jest.fn().mockImplementation(async () => { writes.push(`add ${name}/${id}/sub`); return { id: "e" }; }) }),
      };
    },
  }),
};
jest.mock("@/lib/firebase/admin", () => ({ get adminDb() { return dbState.available ? db : null; } }));

const integrity = { mode: "real-like" as "real-like" | "invalid" | "throw" };
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: jest.fn(async (d: Record<string, unknown>) => {
    if (integrity.mode === "throw") throw new Error("integrity lookup down");
    if (integrity.mode === "invalid") return { classification: "invalid", reason: "workspace_not_found" };
    return typeof d.workspaceId === "string" ? { classification: "valid", workspaceId: d.workspaceId } : { classification: "legacy" };
  }),
}));

const mockedGovernance = jest.fn().mockResolvedValue({ governanceStatus: "approved" });
jest.mock("@/lib/governance/evaluateAndStore", () => ({ evaluateAndStoreGovernance: (...a: unknown[]) => mockedGovernance(...a) }));
const mockCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: JSON.stringify({ executiveSummary: "S", keyFindings: [{ claim: "Zanzibar holds the answer.", confidence: "Medium", evidenceRefs: [], modelsSupporting: ["chatgpt", "claude"] }], disagreements: [], biasAndBlindSpots: [], openQuestions: [], methodology: "Cross-model comparison." }) } }],
});
jest.mock("openai", () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a: unknown[]) => mockCreate(...a) } } })));
jest.mock("@anthropic-ai/sdk", () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

// Pass-through spies: the real contract runs, but calls are observable — so POST's
// EARLY runId guard (before the in-flight map and any access check) is falsifiable
// on its own, not merely masked by the resolver's own defense-in-depth shape check.
jest.mock("@/lib/synthesis/synthesisRunAccess", () => {
  const actual = jest.requireActual("@/lib/synthesis/synthesisRunAccess");
  return { ...actual, resolveSynthesisRunAccess: jest.fn(actual.resolveSynthesisRunAccess) };
});
jest.mock("@/lib/synthesis/inFlightDisclosureGate", () => {
  const actual = jest.requireActual("@/lib/synthesis/inFlightDisclosureGate");
  return { ...actual, resolveInFlightDisclosureGate: jest.fn(actual.resolveInFlightDisclosureGate) };
});

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/synthesize-panel/route";
import { classifyRunOwner, isPathSafeRunId, resolveSynthesisRunAccess } from "@/lib/synthesis/synthesisRunAccess";
import { resolveInFlightDisclosureGate } from "@/lib/synthesis/inFlightDisclosureGate";

const TEXT_A = "Zanzibar is the island the evidence points to, with a long and well documented trading history.";
const TEXT_B = "Zanzibar again stands out: its archives and port records make it the strongest first candidate.";
/** A complete, synthesis-eligible run; `owner` controls the userId field exactly (OMIT = field absent). */
const OMIT = Symbol("omit");
function seed(runId: string, owner: unknown, extra: Record<string, unknown> = {}) {
  const doc: Record<string, unknown> = {
    question: "Which island?",
    runDocument: { question: "Which island?", perModel: [
      { modelId: "chatgpt", status: "ok", rawTextTruncated: TEXT_A },
      { modelId: "claude", status: "ok", rawTextTruncated: TEXT_B },
    ] },
    ...extra,
  };
  if (owner !== OMIT) doc.userId = owner;
  runDocs.set(runId, doc);
}
const CACHED = { synthesizedStructuredReport: { executiveSummary: "cached" }, schemaVersion: 1, synthesizedBy: "m", synthesisConsensusSummary: { overallConsensusScore: 80 }, synthesisConsensusAudit: { runId: "x" } };

const post = (runId: unknown) =>
  POST(new NextRequest("http://localhost/api/synthesize-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, question: "q", results: [{ modelId: "chatgpt", text: TEXT_A }, { modelId: "claude", text: TEXT_B }] }),
  }));
const get = (runId: string) => GET(new NextRequest(`http://localhost/api/synthesize-panel?runId=${encodeURIComponent(runId)}&mode=cache`));

const CONCEALED = { errorCode: "FORBIDDEN", message: "You don't have access to this run." };
async function expectConcealed(res: Response) {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect({ errorCode: body.errorCode, message: body.message }).toEqual(CONCEALED);
  expect(body.details).toBeUndefined(); // no condition-specific detail leaks
}
const noSideEffects = () => {
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockedGovernance).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
};

beforeEach(() => {
  (resolveSynthesisRunAccess as jest.Mock).mockClear();
  (resolveInFlightDisclosureGate as jest.Mock).mockClear();
  runDocs.clear();
  docPaths.length = 0;
  writes.length = 0;
  dbState.available = true;
  dbState.throwOnRead = false;
  integrity.mode = "real-like";
  mockCreate.mockClear();
  mockedGovernance.mockClear();
});

/** B–I of the owner-shape matrix — every one must be denied, identically. */
const DENIED_OWNERS: Array<[string, unknown]> = [
  ["different string owner", "other-uid"],
  ["missing field", OMIT],
  ["undefined", undefined],
  ["null", null],
  ["empty string", ""],
  ["number", 42],
  ["object", { uid: OWNER }],
  ["array", [OWNER]],
];

describe("shared contract — synthesisRunAccess", () => {
  it("isPathSafeRunId: non-empty string without '/'", () => {
    expect(isPathSafeRunId("run-abc")).toBe(true);
    expect(isPathSafeRunId("u-1712345-ab12cd3")).toBe(true);
    for (const bad of ["", "run-a/humanReviewPanel/current", "/", "a/b", 7, null, undefined, ["a"]]) expect(isPathSafeRunId(bad)).toBe(false);
  });
  it.each(DENIED_OWNERS)("classifyRunOwner: %s → not the owner", (_l, owner) => {
    const data: Record<string, unknown> = {};
    if (owner !== OMIT) data.userId = owner;
    expect(classifyRunOwner(data, OWNER)).not.toBe("owner");
  });
  it("classifyRunOwner: the exact string uid → owner (and an empty caller uid never matches)", () => {
    expect(classifyRunOwner({ userId: OWNER }, OWNER)).toBe("owner");
    expect(classifyRunOwner({ userId: "" }, "")).toBe("owner_mismatch");
  });
  it("slash runId → forbidden with ZERO Firestore path resolution", async () => {
    expect(await resolveSynthesisRunAccess("run-a/humanReviewPanel/current", OWNER)).toEqual({ outcome: "forbidden", reason: "malformed_run_id" });
    expect(docPaths).toEqual([]);
  });
  it("infrastructure states are 'unavailable', never authorization", async () => {
    dbState.available = false;
    expect((await resolveSynthesisRunAccess("r", OWNER)).outcome).toBe("unavailable");
    dbState.available = true;
    dbState.throwOnRead = true;
    expect(await resolveSynthesisRunAccess("r", OWNER)).toEqual({ outcome: "unavailable", reason: "run_lookup_threw" });
    dbState.throwOnRead = false;
    seed("r", OWNER);
    integrity.mode = "throw";
    expect(await resolveSynthesisRunAccess("r", OWNER)).toEqual({ outcome: "unavailable", reason: "workspace_integrity_check_threw" });
  });
  it("owner matches but Workspace binding invalid → forbidden (membership never rescues a missing owner)", async () => {
    seed("r", OWNER, { workspaceId: "ws-1" });
    integrity.mode = "invalid";
    expect((await resolveSynthesisRunAccess("r", OWNER)).outcome).toBe("forbidden");
    integrity.mode = "real-like";
    seed("r2", OMIT, { workspaceId: "ws-1" });
    expect(await resolveSynthesisRunAccess("r2", OWNER)).toEqual({ outcome: "forbidden", reason: "owner_missing" });
  });
});

describe("POST — generation requires positive ownership", () => {
  it("A. exact string owner → synthesizes (200)", async () => {
    seed("run-own", OWNER);
    const res = await post("run-own");
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(docPaths.filter((p) => p === "run-own").length).toBeGreaterThan(0);
  });
  it.each(DENIED_OWNERS)("%s → concealed 403 with zero model calls, governance or writes — even with perfect persisted rows", async (_l, owner) => {
    seed("run-x", owner);
    await expectConcealed(await post("run-x"));
    noSideEffects();
  });
  it("missing run → the same concealed 403", async () => {
    await expectConcealed(await post("run-missing"));
    noSideEffects();
  });
  it("slash runId → concealed 403 with NO Firestore path resolution and no nested write", async () => {
    runDocs.set("run-a/humanReviewPanel/current", { userId: OWNER }); // would be the nested doc
    await expectConcealed(await post("run-a/humanReviewPanel/current"));
    expect(docPaths).toEqual([]);
    noSideEffects();
  });
  it("slash runId is refused by POST's OWN early guard — the access resolver and in-flight gate are never even consulted", async () => {
    await expectConcealed(await post("run-a/humanReviewPanel/current"));
    expect(resolveSynthesisRunAccess).not.toHaveBeenCalled();
    expect(resolveInFlightDisclosureGate).not.toHaveBeenCalled();
  });
  it.each([["absent", undefined], ["number", 7], ["empty", ""], ["whitespace", "   "]])("%s runId → 400 before any lookup or generation", async (_l, runId) => {
    const res = await post(runId);
    expect(res.status).toBe(400);
    expect(docPaths).toEqual([]);
    noSideEffects();
  });
  it("owner matches + invalid Workspace binding → 403; integrity lookup throws → 503", async () => {
    seed("run-ws", OWNER, { workspaceId: "ws-1" });
    integrity.mode = "invalid";
    await expectConcealed(await post("run-ws"));
    integrity.mode = "throw";
    const res = await post("run-ws");
    expect(res.status).toBe(503);
    expect((await res.json()).errorCode).toBe("RUN_LOOKUP_UNAVAILABLE");
    noSideEffects();
  });
  it("read throws / no Firestore → 503, never authorization", async () => {
    seed("run-r", OWNER);
    dbState.throwOnRead = true;
    expect((await post("run-r")).status).toBe(503);
    dbState.throwOnRead = false;
    dbState.available = false;
    expect((await post("run-r")).status).toBe(503);
    noSideEffects();
  });
});

describe("GET — cached synthesis only after positive ownership", () => {
  it("A + cached synthesis → 200 with the unchanged cache schema", async () => {
    seed("g-own", OWNER, CACHED);
    const res = await get("g-own");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({
      ok: true,
      report: { executiveSummary: "cached" },
      schemaVersion: 1,
      synthesizedBy: "m",
      cached: true,
      consensusSummary: { overallConsensusScore: 80 },
      auditBundle: { runId: "x" },
    }));
    expect(docPaths).toEqual(["g-own"]); // ONE read: ownership and cache share it
  });
  it("A + no cached synthesis → 404 (the only meaning of 404: you own it, nothing cached)", async () => {
    seed("g-nocache", OWNER);
    const res = await get("g-nocache");
    expect(res.status).toBe(404);
  });
  it.each(DENIED_OWNERS)("%s + a cached synthesis → concealed 403, nothing disclosed", async (_l, owner) => {
    seed("g-x", owner, CACHED);
    const res = await get("g-x");
    await expectConcealed(res);
  });
  it("missing run → concealed 403, NOT 404 (no existence probe)", async () => {
    await expectConcealed(await get("g-missing"));
  });
  it("slash runId → concealed 403 with no Firestore path resolution", async () => {
    runDocs.set("g-a/humanReviewPanel/current", { userId: OWNER, ...CACHED });
    await expectConcealed(await get("g-a/humanReviewPanel/current"));
    expect(docPaths).toEqual([]);
  });
  it("owner matches + invalid binding → 403; read or integrity failure → 503", async () => {
    seed("g-ws", OWNER, { workspaceId: "ws-1", ...CACHED });
    integrity.mode = "invalid";
    await expectConcealed(await get("g-ws"));
    integrity.mode = "throw";
    expect((await get("g-ws")).status).toBe(503);
    integrity.mode = "real-like";
    dbState.throwOnRead = true;
    expect((await get("g-ws")).status).toBe(503);
    dbState.throwOnRead = false;
    dbState.available = false;
    expect((await get("g-ws")).status).toBe(503);
  });
});

describe("in-flight disclosure gate — direct (defense in depth)", () => {
  it("A → verified (cache_hit when cached, else verified_no_cache)", async () => {
    seed("f-own", OWNER, CACHED);
    expect((await resolveInFlightDisclosureGate("f-own", OWNER)).outcome).toBe("cache_hit");
    seed("f-own2", OWNER);
    expect((await resolveInFlightDisclosureGate("f-own2", OWNER)).outcome).toBe("verified_no_cache");
  });
  it.each(DENIED_OWNERS)("%s → denied, concealed 403", async (_l, owner) => {
    seed("f-x", owner, CACHED);
    const r = await resolveInFlightDisclosureGate("f-x", OWNER);
    expect(r).toEqual(expect.objectContaining({ outcome: "denied", status: 403, ...CONCEALED }));
  });
  it("missing run → the same concealed 403 (no longer a 503 existence signal)", async () => {
    expect(await resolveInFlightDisclosureGate("f-missing", OWNER)).toEqual(expect.objectContaining({ outcome: "denied", status: 403, ...CONCEALED, reason: "run_not_found" }));
  });
  it("slash runId → denied before any Firestore lookup", async () => {
    expect(await resolveInFlightDisclosureGate("f-a/humanReviewPanel/current", OWNER)).toEqual(expect.objectContaining({ outcome: "denied", status: 403, reason: "malformed_run_id" }));
    expect(docPaths).toEqual([]);
  });
  it("read/integrity failure → 503", async () => {
    seed("f-r", OWNER);
    dbState.throwOnRead = true;
    expect(await resolveInFlightDisclosureGate("f-r", OWNER)).toEqual(expect.objectContaining({ outcome: "denied", status: 503, errorCode: "RUN_LOOKUP_UNAVAILABLE" }));
  });
});

describe("POST — a malformed runId never reaches the in-flight branch", () => {
  it("even while a request for the same (slash) key is in flight, the slash id is refused before the in-flight map", async () => {
    seed("ok-run", OWNER);
    const first = post("ok-run"); // occupies the in-flight map with a real key
    const res = await post("ok-run/humanReviewPanel/current");
    await expectConcealed(res);
    await first;
    expect(docPaths.every((p) => !p.includes("/"))).toBe(true);
    expect((resolveInFlightDisclosureGate as jest.Mock).mock.calls.every((c) => !String(c[0]).includes("/"))).toBe(true);
  });
});

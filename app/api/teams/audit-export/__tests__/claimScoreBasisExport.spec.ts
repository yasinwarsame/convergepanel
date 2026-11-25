/**
 * R5 (review record 16, section F, MINOR-1) — the Team audit export states the basis of each CLAIM row's consensus score.
 *
 * Contract choice: the ten established columns keep their order, names and formats (`consensusScore` stays the stored
 * number, so a numeric parser of that column is unaffected); ONE column, `consensusBasis`, is appended LAST in the CSV and
 * added to each JSON row. For a claim row (`verificationId`, no `runId`) it is read from the linked
 * `verifications/{verificationId}` persisted rows by the shared gate:
 *   independent_models              — >= 2 independent executing models, one distinct identified model per slot;
 *   slot_responses                  — computed over panel slot responses, not independent corroboration (R4 qualifier);
 *   insufficient_independent_models — fewer than two independent executing models (not a consensus);
 *   independence_unverified         — the executing models could not be established (or the read failed: fail closed).
 * Research rows: "" (this PR covers claim records; the research score basis is outside its scope).
 */
const teamRunDocs = new Map<string, Record<string, any>>();
const canonicalDocs = new Map<string, Record<string, any>>();
let failBasisRead = false;
const vanishOnMaskedRead = new Set<string>();

const mockAdminDb: any = {
  collection: (name: string) => ({
    where: (field: string, _op: string, value: unknown) => ({
      get: async () => ({ docs: [...teamRunDocs.entries()].filter(([, d]) => d[field] === value).map(([id, data]) => ({ id, data: () => data })) }),
    }),
    doc: (id: string) => ({ __path: `${name}/${id}`, __id: id, path: `${name}/${id}` }),
  }),
  getAll: async (...args: any[]) => {
    const last = args[args.length - 1];
    const hasOpts = last && typeof last === "object" && "fieldMask" in last;
    const refs = hasOpts ? args.slice(0, -1) : args;
    const mask: string[] | undefined = hasOpts ? last.fieldMask : undefined;
    if (failBasisRead && mask) throw new Error("basis read failed");
    return refs.map((ref: any) => {
      const full = mask && vanishOnMaskedRead.has(ref.__path) ? undefined : canonicalDocs.get(ref.__path);
      const data = full && mask ? Object.fromEntries(Object.entries(full).filter(([k]) => mask.includes(k))) : full;
      return { id: ref.__id, ref: { path: ref.__path }, exists: !!full, data: () => data };
    });
  },
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: async () => "caller-uid",
  loadUserAndTeam: async () => ({ user: { email: "caller@test.com" }, team: { id: "team-1", members: [] } }),
  memberRole: () => "admin",
  isTeamAdmin: () => true,
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/teams/audit-export/route";

const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", gemini: "google", grok: "xai", perplexity: "perplexity" };
const row = (modelId: string, verdict: string, rec: { sub?: boolean; provider?: string } = {}) => ({
  modelId,
  status: "ok",
  verdict,
  confidence: "high",
  summary: `${modelId} says ${verdict}`,
  correctParts: [],
  incorrectParts: [],
  unverifiableParts: [],
  ...(rec.sub ? { substituted: true } : {}),
  provider: rec.provider ?? OWN[modelId],
});
const DS = { sub: true, provider: "deepseek" };
const MIX = [row("chatgpt", "accurate", DS), row("claude", "accurate", DS), row("gemini", "accurate", DS), row("grok", "accurate", DS), row("perplexity", "inaccurate")];
const ALL_DS = [row("chatgpt", "accurate", DS), row("claude", "accurate", DS)];
const OWN_TWO = [row("chatgpt", "accurate"), row("claude", "accurate")];

function claim(rowId: string, verificationId: string, modelResults: unknown[] | undefined, at: string) {
  canonicalDocs.set(`verifications/${verificationId}`, {
    userId: "owner-uid",
    claim: "c",
    ...(modelResults ? { modelResults, selectedModels: (modelResults as Array<{ modelId: string }>).map((r) => r.modelId) } : {}),
  });
  teamRunDocs.set(rowId, {
    teamId: "team-1",
    userEmail: "owner@test.com",
    type: "verification",
    query: `claim ${rowId}`,
    verdict: "confirmed",
    consensusScore: 92,
    policyFlags: [],
    humanDecision: null,
    timestamp: { toMillis: () => new Date(at).getTime() },
    runId: null,
    verificationId,
  });
}
function research(rowId: string, at: string) {
  canonicalDocs.set(`runs/run-${rowId}`, { userId: "owner-uid" });
  teamRunDocs.set(rowId, {
    teamId: "team-1",
    userEmail: "owner@test.com",
    type: "research",
    query: `research ${rowId}`,
    verdict: null,
    consensusScore: 70,
    policyFlags: [],
    humanDecision: null,
    timestamp: { toMillis: () => new Date(at).getTime() },
    runId: `run-${rowId}`,
  });
}
const ESTABLISHED = "runId,timestamp,userEmail,type,queryTruncated,verdict,consensusScore,policyFlags,humanDecisionAction,humanDecisionNotes";

beforeEach(() => {
  teamRunDocs.clear();
  canonicalDocs.clear();
  failBasisRead = false;
  vanishOnMaskedRead.clear();
  claim("c-mix", "v-mix", MIX, "2026-08-05T00:00:00.000Z");
  claim("c-ds", "v-ds", ALL_DS, "2026-08-04T00:00:00.000Z");
  claim("c-own", "v-own", OWN_TWO, "2026-08-03T00:00:00.000Z");
  claim("c-none", "v-none", undefined, "2026-08-02T00:00:00.000Z");
  research("r1", "2026-08-01T00:00:00.000Z");
});

describe("GET /api/teams/audit-export — claim score basis (R5)", () => {
  it("JSON: every row carries consensusBasis; the stored score and the established fields are unchanged", async () => {
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    const by = Object.fromEntries(rows.map((r: any) => [r.runId, r]));
    expect(rows.map((r: any) => [r.runId, r.consensusScore, r.consensusBasis])).toEqual([
      ["c-mix", 92, "slot_responses"],
      ["c-ds", 92, "insufficient_independent_models"],
      ["c-own", 92, "independent_models"],
      ["c-none", 92, "independence_unverified"],
      ["r1", 70, ""],
    ]);
    expect(Object.keys(by["c-mix"])).toEqual([
      "runId",
      "timestamp",
      "userEmail",
      "type",
      "queryTruncated",
      "verdict",
      "consensusScore",
      "policyFlags",
      "humanDecision",
      "consensusBasis",
    ]);
  });

  it("CSV: the ten established columns are an unchanged prefix; consensusBasis is the appended last column", async () => {
    const text = await (await GET(new NextRequest("http://localhost/api/teams/audit-export?format=csv"))).text();
    const lines = text.split("\n");
    expect(lines[0]).toBe(`${ESTABLISHED},consensusBasis`);
    const mix = lines.find((l) => l.startsWith('"c-mix"')) as string;
    expect(mix.split(",")).toHaveLength(11);
    expect(mix).toContain(',"confirmed",92,');
    expect(mix.endsWith(',"slot_responses"')).toBe(true);
    expect(lines.find((l) => l.startsWith('"r1"'))?.endsWith(',""')).toBe(true);
    expect(lines.find((l) => l.startsWith('"c-own"'))?.endsWith(',"independent_models"')).toBe(true);
  });

  it("selectedModels is read: a requested model without a row makes otherwise-independent rows unverified (review M19)", async () => {
    (canonicalDocs.get("verifications/v-own") as Record<string, unknown>).selectedModels = ["chatgpt", "claude", "grok"];
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    const by = Object.fromEntries(rows.map((r: any) => [r.runId, r]));
    expect(by["c-own"].consensusBasis).toBe("independence_unverified");
    expect(by["c-mix"].consensusBasis).toBe("slot_responses");
  });

  it("the basis read fails → claim rows are independence_unverified (fail closed), never independent_models", async () => {
    failBasisRead = true;
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    expect(rows.filter((r: any) => r.type === "verification").map((r: any) => r.consensusBasis)).toEqual(Array(4).fill("independence_unverified"));
  });

  // ── R6 owner decision B1: the appended column is kept; its contract is pinned here ──
  const BASES = ["independent_models", "slot_responses", "insufficient_independent_models", "independence_unverified"];

  it("R6 B1: a claim row whose linked verification document is absent at the basis read is independence_unverified (explicit unknown)", async () => {
    // The authority read (no field mask) still sees the document; it is gone by the basis read (field-masked).
    vanishOnMaskedRead.add("verifications/v-own");
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    const by = Object.fromEntries(rows.map((r: any) => [r.runId, r]));
    expect(by["c-own"].consensusBasis).toBe("independence_unverified");
    expect(by["c-own"].consensusScore).toBe(92);
  });

  it("R6 B1: claim rows take only the four documented values; research rows ''; the export shares the history enum", async () => {
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    for (const r of rows) {
      if (r.type === "verification") expect([r.runId, BASES.includes(r.consensusBasis)]).toEqual([r.runId, true]);
      else expect([r.runId, r.consensusBasis]).toEqual([r.runId, ""]);
    }
    const { CLAIM_SCORE_BASES } = require("@/lib/verification/claimStatementBasisSources");
    expect(CLAIM_SCORE_BASES).toEqual(BASES);
  });

  it("R6 B1: CSV — every row has 11 cells; column 7 stays the numeric stored score for every row, withheld or not", async () => {
    const text = await (await GET(new NextRequest("http://localhost/api/teams/audit-export?format=csv"))).text();
    const [header, ...body] = text.split("\n");
    expect(header.split(",")).toEqual([...ESTABLISHED.split(","), "consensusBasis"]);
    expect(body).toHaveLength(5);
    for (const line of body) {
      const cells = line.split(",");
      expect(cells).toHaveLength(11);
      expect(Number.isFinite(Number(cells[6]))).toBe(true);
      expect(cells[6]).toMatch(/^\d+$/);
      expect(['""', ...BASES.map((b) => `"${b}"`)]).toContain(cells[10]);
    }
    // Withheld claim rows still export their stored number (the basis column says why it is not a consensus).
    expect(body.find((l) => l.startsWith('"c-ds"'))?.split(",").slice(6, 7)).toEqual(["92"]);
    expect(body.find((l) => l.startsWith('"c-ds"'))?.endsWith(',"insufficient_independent_models"')).toBe(true);
  });

  it("R6 B1: the JSON row carries no other new field and no per-model data (no unsupported metadata)", async () => {
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    for (const r of rows) {
      expect(Object.keys(r)).toEqual(["runId", "timestamp", "userEmail", "type", "queryTruncated", "verdict", "consensusScore", "policyFlags", "humanDecision", "consensusBasis"]);
      expect(typeof r.consensusScore).toBe("number");
    }
    const raw = JSON.stringify(rows);
    for (const leak of ["modelResults", "selectedModels", "provider", "deepseek", "substituted"]) expect(raw).not.toContain(leak);
  });
});

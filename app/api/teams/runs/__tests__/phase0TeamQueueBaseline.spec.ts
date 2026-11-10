/**
 * Phase 0 compatibility restoration — T-teamq (inventory v3.4 H-13, row L16; owner ruling O15 = yes, 2026-11-08).
 *
 * The Team review queue (`GET /api/teams/runs?version=1`) is governance-queue metadata: its DTO must equal the 35933c8
 * DTO, with `consensusWithheld` the ONLY additional key, and that key (plus the rendered consensus text of
 * LegacyReviewListItem) must equal the b894828 presentation — the stored score is kept in the DTO and never shown as a
 * number while it is withheld.
 *
 * The REAL route handler runs over 14 legacy Team review rows linked to canonical artifacts (independent, all-DeepSeek,
 * partly-DeepSeek, one-model, pre-provenance, substitute-without-provider, no rows, status-less row research runs; a row
 * without a stored score; a second owner; independent / one-answered / DeepSeek-collapsed / unverified claim
 * verifications) plus the enrichment-read-failure case. The fake Firestore and auth doubles are those of
 * legacyConsensusIndependence.spec.ts.
 *
 * Oracles (fixtures/phase0TeamQueue.golden.json) were produced by running THIS file, unchanged, in git-archive exports of
 * 35933c8 (`base`) and b894828 (`presentation`) with PHASE0_GOLDEN_OUT set; neither is computed from the code under test.
 */
const teamRunDocs = new Map<string, Record<string, any>>();
const pathStore = new Map<string, Record<string, any>>();
let getAllShouldThrow = false;
let getAllCallCount = 0;
let getAllSucceedForFirstCalls = 0;
function makeDocRef(path: string): any {
  return { __path: path, path, id: path.split("/").pop(), get: async () => ({ exists: pathStore.has(path), data: () => pathStore.get(path) }), collection: (name: string) => makeCollectionRef(`${path}/${name}`) };
}
function makeCollectionRef(path: string): any {
  return { doc: (id: string) => makeDocRef(`${path}/${id}`) };
}
const mockAdminDb = {
  collection: (name: string) => {
    if (name === "teamRuns") {
      return {
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => ({ docs: [...teamRunDocs.entries()].filter(([, d]) => d[field] === value).map(([id, data]) => ({ id, data: () => data })) }),
        }),
      };
    }
    return makeCollectionRef(name);
  },
  getAll: async (...refs: Array<{ __path: string }>) => {
    getAllCallCount += 1;
    if (getAllShouldThrow && getAllCallCount > getAllSucceedForFirstCalls) throw new Error("batch read boom");
    return refs.map((ref) => ({ id: ref.__path.split("/").pop(), ref: { path: ref.__path }, exists: pathStore.has(ref.__path), data: () => pathStore.get(ref.__path) }));
  },
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: async (uids: string[]) => new Map(uids.map((u) => [u, `Name-${u}`])),
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
}));
jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: async () => "caller-uid",
  loadUserAndTeam: async () => ({ user: { email: "caller@test.com" }, team: { id: "team-1", members: [] } }),
  memberRole: () => "admin",
  isTeamAdmin: () => true,
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }));

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { GET } from "@/app/api/teams/runs/route";

const GOLDEN = join(__dirname, "fixtures", "phase0TeamQueue.golden.json");
const TEAM_ID = "team-1";
const ts = (iso: string) => ({ toMillis: () => new Date(iso).getTime() });
const pm = (modelId: string, status: string | undefined, provider?: string) => ({
  modelId,
  ...(status !== undefined ? { status } : {}),
  rawTextTruncated: `${modelId} text`,
  ...(provider ? { provider } : {}),
});
const vrow = (modelId: string, status: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  status,
  verdict: status === "ok" ? "accurate" : status,
  confidence: "high",
  summary: `${modelId} s`,
  correctParts: [],
  incorrectParts: [],
  unverifiableParts: [],
  ...extra,
});
let seq = 0;
function legacy(id: string, over: Record<string, unknown>) {
  teamRunDocs.set(id, {
    teamId: TEAM_ID,
    userId: "owner-uid",
    userEmail: "o@test.com",
    type: "research",
    query: "q",
    consensusScore: 72,
    policyFlags: [],
    timestamp: ts(`2026-07-${String(10 + ++seq).padStart(2, "0")}T00:00:00.000Z`),
    ...over,
  });
}
function seedRun(runId: string, perModel: unknown[] | undefined, owner = "owner-uid") {
  pathStore.set(`runs/${runId}`, { userId: owner, ...(perModel ? { runDocument: { perModel } } : {}) });
}
function seedVer(id: string, modelResults: unknown[] | undefined, selected?: string[]) {
  pathStore.set(`verifications/${id}`, {
    userId: "owner-uid",
    claim: "c",
    consensusScore: 92,
    ...(modelResults ? { modelResults } : {}),
    ...(selected ? { selectedModels: selected } : {}),
  });
}

function renderConsensusText(item: unknown): string | null {
  const LegacyReviewListItem = require("@/components/teamGovernance/LegacyReviewListItem").default;
  const html = renderToStaticMarkup(createElement(LegacyReviewListItem, { item } as never)).replace(/<!-- -->/g, "");
  return (html.match(/(Consensus \d+\/100|No consensus score[^<]*|Consensus score withheld[^<]*|Score withheld[^<]*)/) ?? [null])[0];
}

async function snapshot() {
  const res = await GET(new NextRequest("http://localhost/api/teams/runs?version=1"));
  const body = await res.json();
  const items: Record<string, { dto: Record<string, unknown>; consensusText: string | null }> = {};
  for (const i of body.items ?? []) if (i.kind === "legacy") items[i.teamRunId] = { dto: i, consensusText: renderConsensusText(i) };
  return { status: res.status as number, items };
}

async function runGrid() {
  teamRunDocs.clear();
  pathStore.clear();
  seq = 0;
  getAllShouldThrow = false;
  getAllCallCount = 0;
  getAllSucceedForFirstCalls = 0;
  seedRun("r-ind", [pm("chatgpt", "ok", "openai"), pm("claude", "ok", "anthropic"), pm("grok", "ok", "xai")]);
  seedRun("r-fc", [pm("chatgpt", "substituted", "deepseek"), pm("claude", "substituted", "deepseek")]);
  seedRun("r-pc", [pm("chatgpt", "substituted", "deepseek"), pm("claude", "substituted", "deepseek"), pm("grok", "ok", "xai")]);
  seedRun("r-one", [pm("chatgpt", "ok", "openai"), pm("claude", "failed")]);
  seedRun("r-pre62a", [pm("chatgpt", "ok"), pm("claude", "substituted"), pm("grok", "ok")]);
  seedRun("r-s3mn", [pm("chatgpt", "ok", "openai"), pm("claude", "ok", "anthropic"), pm("grok", "substituted")]);
  seedRun("r-norows", undefined);
  seedRun("r-statusless", [pm("chatgpt", "ok", "openai"), pm("claude", undefined)]);
  for (const [id, runId] of [
    ["ind", "r-ind"],
    ["fc", "r-fc"],
    ["pc", "r-pc"],
    ["one", "r-one"],
    ["pre62a", "r-pre62a"],
    ["s3mn", "r-s3mn"],
    ["norows", "r-norows"],
    ["statusless", "r-statusless"],
  ]) legacy(id, { runId });
  legacy("noscore", { runId: "r-fc", consensusScore: null });
  seedRun("r-b-ind", [pm("chatgpt", "ok", "openai"), pm("claude", "ok", "anthropic")], "owner-b");
  legacy("ownerb", { runId: "r-b-ind", userId: "owner-b", userEmail: "b@test.com" });
  seedVer("v-ind", [vrow("chatgpt", "ok"), vrow("claude", "ok")], ["chatgpt", "claude"]);
  seedVer("v-one", [vrow("chatgpt", "ok"), vrow("claude", "failed")], ["chatgpt", "claude"]);
  seedVer("v-ds", [vrow("chatgpt", "ok", { substituted: true, provider: "deepseek" }), vrow("claude", "ok", { substituted: true, provider: "deepseek" })], ["chatgpt", "claude"]);
  seedVer("v-none", undefined);
  for (const v of ["v-ind", "v-one", "v-ds", "v-none"]) legacy(`claim-${v}`, { type: "verification", runId: null, verificationId: v, consensusScore: 92 });
  const main = await snapshot();
  teamRunDocs.clear();
  legacy("readfail", { runId: "r-ind" });
  getAllShouldThrow = true;
  getAllSucceedForFirstCalls = 1;
  getAllCallCount = 0;
  const readFail = await snapshot();
  return { main, readFail };
}

const ADDITIVE = new Set(["consensusWithheld"]);
const withoutAdditive = (dto: Record<string, unknown>) => Object.fromEntries(Object.entries(dto).filter(([k]) => !ADDITIVE.has(k)));

describe("T-teamq: GET /api/teams/runs?version=1 — Phase 0 DTO equals 35933c8; consensusWithheld is the only additive key", () => {
  let grid: Awaited<ReturnType<typeof runGrid>>;
  let golden: { base: typeof grid; presentation: typeof grid } | null = null;
  beforeAll(async () => {
    grid = await runGrid();
    if (!process.env.PHASE0_GOLDEN_OUT && existsSync(GOLDEN)) golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  });

  it("covers 14 legacy rows plus the read-failure row", () => {
    if (process.env.PHASE0_GOLDEN_OUT) {
      writeFileSync(process.env.PHASE0_GOLDEN_OUT, JSON.stringify(grid, null, 1));
      return;
    }
    expect(grid.main.status).toBe(200);
    expect(Object.keys(grid.main.items)).toHaveLength(14);
    expect(Object.keys(grid.readFail.items)).toEqual(["readfail"]);
    expect(golden).not.toBeNull();
  });

  it.each(["main", "readFail"] as const)("%s: every row's DTO minus consensusWithheld equals the 35933c8 DTO", (part) => {
    if (process.env.PHASE0_GOLDEN_OUT) return;
    const base = golden!.base[part];
    expect(grid[part].status).toBe(base.status);
    expect(Object.keys(grid[part].items).sort()).toEqual(Object.keys(base.items).sort());
    for (const [id, item] of Object.entries(grid[part].items)) {
      expect([id, withoutAdditive(item.dto)]).toEqual([id, base.items[id].dto]);
      for (const k of Object.keys(item.dto)) if (!(k in base.items[id].dto)) expect([id, k]).toEqual([id, "consensusWithheld"]);
    }
  });

  it.each(["main", "readFail"] as const)("%s: consensusWithheld and the rendered consensus text equal the b894828 presentation", (part) => {
    if (process.env.PHASE0_GOLDEN_OUT) return;
    const pres = golden!.presentation[part];
    for (const [id, item] of Object.entries(grid[part].items)) {
      expect([id, item.dto.consensusWithheld]).toEqual([id, pres.items[id].dto.consensusWithheld]);
      expect([id, item.consensusText]).toEqual([id, pres.items[id].consensusText]);
    }
  });

  it("a withheld row keeps its stored score in the DTO and never renders it as a number", () => {
    if (process.env.PHASE0_GOLDEN_OUT) return;
    const withheld = Object.entries(grid.main.items).filter(([, i]) => i.dto.consensusWithheld);
    // C-b (CB-01, PQ-1 (a)): claim-v-ind's own-provider rows record no provider, so the shared gate withholds its score.
    // C-c (CC-01, PQ-1 (a)): pre62a / s3mn research rows (provider-less ok row / unrecorded substitute) are withheld too.
    expect(withheld.map(([id]) => id).sort()).toEqual(["claim-v-ds", "claim-v-ind", "claim-v-none", "claim-v-one", "fc", "norows", "one", "pre62a", "s3mn", "statusless"]);
    for (const [id, i] of withheld) {
      expect([id, typeof i.dto.consensusScore]).toEqual([id, "number"]);
      expect([id, /Consensus \d+\/100/.test(i.consensusText ?? "")]).toEqual([id, false]);
    }
  });
});

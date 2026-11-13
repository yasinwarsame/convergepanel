/**
 * Phase 0 compatibility restoration — L15 DTO equality (inventory v3.4 H-13, row L15; owner ruling O14 = A, 2026-11-08).
 *
 * The governance-queue DTO (`GET /api/governance/queue`) must equal the 35933c8 DTO on every 35933c8 key — including the
 * known-wrong "(others disagree)" line on unanimous claim rows (O14 = A; corrected later at render time by track C-b) —
 * and may carry ONLY the four additive keys `consensusWithheld`, `modelIndependence`, `qualifiedDisagreements` and
 * `singleModelAssessment`, each equal to the b894828 value (the executing-model presentation is kept).
 *
 * The REAL route handler runs over 19 named research / claim / video fixtures (the O-5q and QUEUE23 grids) and 61 seeded
 * rows (2–5 slots; ok / DeepSeek-substituted / provider-less substitutes / failed / parse_error slots; string, object
 * and legacy keyDisagreements items; unanimous, split and single-answer claims; selectedModels without rows; videos with
 * duplicate or missing ids), read page by page.
 *
 * Oracle (fixtures/phase0QueueDto.golden.json): THIS file run unchanged in git-archive exports of 35933c8 (`base`) and
 * b894828 (`presentation`) with PHASE0_GOLDEN_OUT set — never computed from the code under test.
 */
process.env.TZ = "UTC";
jest.mock("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }));
const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({ resolveGovernanceRequestUser: (...a: any[]) => mockedResolveGovernanceRequestUser(...a) }));
const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: (...a: any[]) => mockedResolveVisibleUserIds(...a),
  runOwnerVisibleInGovernance: () => true,
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
const docsBy: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = { runs: [], verifications: [], videoVerifications: [] };
function chain(name: string): any {
  const snap = () => ({
    docs: (docsBy[name] ?? []).map((r) => ({ id: r.id, data: () => r.data, exists: true })),
    size: (docsBy[name] ?? []).length,
    empty: (docsBy[name] ?? []).length === 0,
  });
  const c: any = {};
  for (const m of ["where", "orderBy", "limit", "select", "offset", "startAfter"]) c[m] = () => c;
  c.get = async () => snap();
  c.count = () => ({ get: async () => ({ data: () => ({ count: (docsBy[name] ?? []).length }) }) });
  c.doc = (id: string) => ({
    get: async () => {
      const d = (docsBy[name] ?? []).find((x) => x.id === id);
      return { exists: !!d, id, data: () => d?.data };
    },
  });
  return c;
}
const mockAdminDb: any = { collection: (name: string) => chain(name), getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })) };
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";

const GOLDEN = join(__dirname, "fixtures", "phase0QueueDto.golden.json");
const ADDITIVE = ["consensusWithheld", "modelIndependence", "qualifiedDisagreements", "singleModelAssessment"] as const;

let stamp = 0;
const at = () => new Date(Date.parse("2026-11-01T12:00:00Z") - ++stamp * 60_000);
const pm = (modelId: string, status: string, extra: Record<string, unknown> = {}) => ({ modelId, status, rawTextTruncated: `${modelId} text`, ...extra });
const sub = (id: string, provider?: string) => pm(id, "substituted", { ...(provider ? { provider } : {}), substitutedFrom: id });
const DIS = (a: string, b: string, topic: string) => ({ topic, whyTheyDiffer: "w", positionsByModel: { [a]: "x", [b]: "y" } });
const research = (id: string, perModel: unknown[] | undefined, disagreements: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  data: {
    userId: "owner-a",
    question: id,
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    createdAt: at(),
    synthesisConsensusSummary: { overallConsensusScore: 90, lowEvidenceClaims: 0, aggregateSupportRatio: 1 },
    policyConsensusSummary: { evidenceQuality: "strong" },
    synthesizedStructuredReport: { executiveSummary: "s", keyFindings: [{ claim: "k1" }], disagreements },
    ...(perModel ? { runDocument: { perModel } } : {}),
    ...extra,
  },
});
const claimRow = (modelId: string, status: string, verdict: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  status,
  verdict,
  confidence: "high",
  summary: `${modelId} says ${verdict}`,
  correctParts: [],
  incorrectParts: [],
  ...extra,
});
const claim = (id: string, modelResults: unknown[], selected?: string[], owner = "owner-a") => ({
  id,
  data: {
    userId: owner,
    claim: id,
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    timestamp: at(),
    consensusScore: 80,
    evidenceQuality: "moderate",
    verdict: "accurate",
    modelResults,
    selectedModels: selected ?? (modelResults as any[]).map((r) => r.modelId),
  },
});
const video = (id: string, modelResults: unknown[] | undefined, owner = "owner-a") => ({
  id,
  data: {
    type: "video_verification",
    userId: owner,
    fileName: id,
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    timestamp: at(),
    consensusScore: 85,
    evidenceQuality: "strong",
    verdict: "authentic",
    ...(modelResults ? { modelResults } : {}),
  },
});

const IDS = ["chatgpt", "claude", "gemini", "grok", "perplexity"];
function seeded(n: number) {
  let s = 26110801;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const runs: any[] = [];
  const vers: any[] = [];
  const vids: any[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 3;
    const k = 2 + Math.floor(rnd() * 4);
    const slots = IDS.slice(0, k);
    if (kind === 0) {
      const perModel = slots.map((m) => {
        const r = rnd();
        return r < 0.35 ? pm(m, "ok", { provider: m }) : r < 0.6 ? sub(m, "deepseek") : r < 0.7 ? sub(m) : r < 0.8 ? pm(m, "ok") : pm(m, "failed", { rawTextTruncated: "" });
      });
      const nd = Math.floor(rnd() * 5);
      const dis = Array.from({ length: nd }, (_, j) => {
        const r = rnd();
        if (r < 0.2) return `Point ${i}.${j}: models differ`;
        const a = pick(slots);
        const b = pick(slots);
        return r < 0.85 ? DIS(a, b, `Topic ${i}.${j}`) : { topic: `Legacy ${i}.${j}`, summary: "s", models: [a, b] };
      });
      const extra: Record<string, unknown> = rnd() < 0.3 ? { structuredSynthesis: { keyFindings: [`Finding ${i}`], disagreements: dis } } : {};
      if (rnd() < 0.15) extra.synthesizedReportV2 = { keyDisagreements: [{ topic: `KD ${i}`, summary: "kd" }] };
      runs.push(research(`G-R${i}`, rnd() < 0.1 ? undefined : perModel, dis, extra));
    } else if (kind === 1) {
      const rowsC = slots.map((m) => {
        const r = rnd();
        const status = r < 0.7 ? "ok" : r < 0.85 ? "failed" : "parse_error";
        const verdict = status === "ok" ? pick(["accurate", "inaccurate", "partially_accurate", "accurate"]) : "";
        const extra: Record<string, unknown> = {};
        if (rnd() < 0.25) Object.assign(extra, { substituted: true, ...(rnd() < 0.7 ? { provider: "deepseek" } : {}) });
        if (rnd() < 0.3) extra.incorrectParts = [`The claim overstates figure ${i} by a wide and documented margin across sources.`];
        if (rnd() < 0.3) extra.correctParts = [`Part ${i} is right`];
        return claimRow(m, status, verdict, extra);
      });
      const selected = rnd() < 0.2 ? [...slots, "perplexity"] : undefined;
      vers.push(claim(`G-C${i}`, rowsC, selected));
    } else {
      const vslots = ["gemini", "gpt4o", "claude"].slice(0, 1 + Math.floor(rnd() * 3));
      const rowsV = vslots.map((m) => {
        const r = rnd();
        return r < 0.7 ? { modelId: m, status: "ok", verdict: pick(["authentic", "likely_manipulated", "manipulated"]) } : { modelId: m, status: "failed" };
      });
      if (rnd() < 0.15) rowsV.push({ ...rowsV[0] });
      vids.push(video(`G-V${i}`, rnd() < 0.08 ? undefined : rowsV));
    }
  }
  return { runs, vers, vids };
}

function grid() {
  stamp = 0;
  const ind5 = IDS.map((m) => pm(m, "ok", { provider: m }));
  const g = seeded(61);
  docsBy.runs = [
    research("R-IND", ind5, [DIS("chatgpt", "claude", "Topic A")]),
    research("R-FC", ["chatgpt", "claude", "gemini"].map((m) => sub(m, "deepseek")), [DIS("chatgpt", "claude", "Topic A")]),
    research("R-PC", [sub("chatgpt", "deepseek"), sub("claude", "deepseek"), pm("gemini", "ok", { provider: "gemini" }), pm("grok", "ok", { provider: "grok" })], [
      DIS("chatgpt", "claude", "Topic same-exec"),
      DIS("gemini", "grok", "Topic genuine"),
    ]),
    research("R-UV", [pm("chatgpt", "ok"), sub("claude"), pm("gemini", "ok")], [DIS("chatgpt", "claude", "Topic A")]),
    research("R-NOROWS", undefined, [DIS("chatgpt", "claude", "Topic A")]),
    { ...research("R-B-IND", ind5, [DIS("chatgpt", "claude", "Topic B")]), data: { ...research("R-B-IND", ind5, [DIS("chatgpt", "claude", "Topic B")]).data, userId: "owner-b" } },
    research("R-CAP", [sub("chatgpt", "deepseek"), sub("claude", "deepseek"), pm("grok", "ok", { provider: "grok" })], [
      ...[1, 2, 3, 4].map((i) => DIS("chatgpt", "claude", `Same ${i}`)),
      DIS("chatgpt", "grok", "Genuine"),
    ]),
    ...g.runs,
  ];
  docsBy.verifications = [
    claim("C-IND-agree2", [claimRow("chatgpt", "ok", "accurate"), claimRow("claude", "ok", "accurate")]),
    claim("C-IND-split", [claimRow("chatgpt", "ok", "accurate"), claimRow("claude", "ok", "accurate"), claimRow("gemini", "ok", "accurate"), claimRow("grok", "ok", "inaccurate")]),
    claim("C-ONE", [claimRow("chatgpt", "ok", "accurate"), claimRow("claude", "failed", "")]),
    claim("C-REAL3", [claimRow("chatgpt", "ok", "accurate"), claimRow("claude", "ok", "accurate"), claimRow("gemini", "ok", "accurate")]),
    claim("C-SUBNONE", [claimRow("chatgpt", "ok", "accurate"), claimRow("claude", "ok", "accurate"), claimRow("gemini", "ok", "accurate", { substituted: true })]),
    claim("C-SUBMIX", [claimRow("chatgpt", "ok", "accurate"), claimRow("claude", "ok", "accurate", { substituted: true, provider: "deepseek" }), claimRow("gemini", "ok", "accurate", { substituted: true })]),
    claim("C-SUBUNK", [claimRow("chatgpt", "ok", "accurate"), claimRow("claude", "ok", "accurate"), claimRow("gemini", "ok", "accurate", { substituted: true, provider: "unknown" })]),
    claim("C-B-IND", [claimRow("chatgpt", "ok", "accurate"), claimRow("claude", "ok", "accurate")], undefined, "owner-b"),
    claim("C-SUBREC", [claimRow("chatgpt", "ok", "accurate"), claimRow("claude", "ok", "accurate"), claimRow("gemini", "ok", "accurate", { substituted: true, provider: "deepseek" })]),
    ...g.vers,
  ];
  docsBy.videoVerifications = [
    video("V-IND", [{ modelId: "gemini", status: "ok", verdict: "authentic" }, { modelId: "gpt4o", status: "ok", verdict: "authentic" }, { modelId: "claude", status: "ok", verdict: "manipulated" }]),
    video("V-ONE", [{ modelId: "gemini", status: "ok", verdict: "authentic" }, { modelId: "gpt4o", status: "failed" }, { modelId: "claude", status: "failed" }]),
    video("V-SUB", [{ modelId: "gemini", status: "ok", verdict: "authentic" }, { modelId: "gpt4o", status: "ok", verdict: "authentic" }, { modelId: "claude", status: "substituted", verdict: "authentic" }]),
    ...g.vids,
  ];
}

async function readAll(): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (let offset = 0; offset < 400; offset += 50) {
    const res = await GET(new NextRequest(`http://localhost/api/governance/queue?status=all&runType=all&limit=50&offset=${offset}`));
    expect(res.status).toBe(200);
    const json: any = await res.json();
    const runs: any[] = json.runs ?? [];
    for (const r of runs) out[`${r.collection}:${r.runId}`] = JSON.parse(JSON.stringify(r));
    if (runs.length < 50) break;
  }
  return out;
}

describe("L15: GET /api/governance/queue — Phase 0 DTO equals 35933c8 on every 35933c8 key; four additive keys only", () => {
  let rows: Record<string, Record<string, unknown>>;
  let golden: { base: typeof rows; presentation: typeof rows } | null = null;
  beforeAll(async () => {
    jest.useFakeTimers({
      now: new Date("2026-11-03T00:00:00.000Z"),
      doNotFake: ["hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" });
    mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
    grid();
    rows = await readAll();
    jest.useRealTimers();
    if (!process.env.PHASE0_GOLDEN_OUT && existsSync(GOLDEN)) golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  });

  it("reads all 80 rows (research, claim, video)", () => {
    if (process.env.PHASE0_GOLDEN_OUT) {
      writeFileSync(process.env.PHASE0_GOLDEN_OUT, JSON.stringify(rows, null, 1));
      return;
    }
    expect(Object.keys(rows)).toHaveLength(80);
    expect(golden).not.toBeNull();
    expect(Object.keys(rows).sort()).toEqual(Object.keys(golden!.base).sort());
  });

  it("DTO minus the additive keys == the 35933c8 DTO (every row, every key)", () => {
    if (process.env.PHASE0_GOLDEN_OUT) return;
    for (const [id, dto] of Object.entries(rows)) {
      const base = Object.fromEntries(Object.entries(dto).filter(([k]) => !(ADDITIVE as readonly string[]).includes(k)));
      expect([id, base]).toEqual([id, golden!.base[id]]);
    }
  });

  it("no key outside the 35933c8 key set except the four additive keys", () => {
    if (process.env.PHASE0_GOLDEN_OUT) return;
    for (const [id, dto] of Object.entries(rows)) {
      for (const k of Object.keys(dto)) if (!(k in golden!.base[id])) expect([id, (ADDITIVE as readonly string[]).includes(k) ? "additive" : k]).toEqual([id, "additive"]);
    }
  });

  it("each additive key equals the b894828 value (executing-model presentation kept)", () => {
    if (process.env.PHASE0_GOLDEN_OUT) return;
    let present = 0;
    for (const [id, dto] of Object.entries(rows)) {
      for (const k of ADDITIVE) {
        if (dto[k] !== undefined) present++;
        expect([id, k, dto[k]]).toEqual([id, k, golden!.presentation[id][k]]);
      }
    }
    expect(present).toBeGreaterThan(60);
  });

  it("O14 = A: the unanimous claim row carries the 35933c8 '(others disagree)' line", () => {
    if (process.env.PHASE0_GOLDEN_OUT) return;
    expect(rows["verifications:C-IND-agree2"].disagreementPoints).toEqual(["ChatGPT, Claude rated as accurate (others disagree)"]);
  });
});

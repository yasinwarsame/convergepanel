/**
 * Review of 262ef64 — PARITY for records with >= 2 independent executing models and no collapsed slots: the outputs of
 * the gate, the queue (research classifier + claim wording + consensus fields, through GET /api/governance/queue), the
 * live disagreement filter, the panel verdict and its share texts, and every claim surface (detail view, audit trail,
 * copied verdict, memo, Team list row, Personal history line) are byte-identical to the established baseline, 8584211.
 *
 * Method: a seeded generator builds 240 research runs and 240 claim verifications (2–5 slots, >= 2 answering
 * independent models, failed slots, a single non-collapsing DeepSeek substitute, disagreement items attributed by slot
 * id / family name / one slot / a failed slot / no names, V2 `positions[]`, legacy `keyDisagreements`). This same file
 * was run in a scratch worktree at 8584211 (feature detection below selects each commit's own composition — the
 * PanelSynthesisView gate input and the history line formula of that commit) and its outputs hashed; the digest is
 * pinned here. Phase 0 (owner Option C, O14 = A; inventory v3.4 H-8 (2)): the governance-queue DTO is the 35933c8 DTO
 * again, including "… rated as X (others disagree)" on unanimous claim rows, so the former B2 normalisation of the
 * baseline is removed and the digest is the RAW 8584211 output (reproduced 2026-11-08 by running this file in a
 * git-archive export of 8584211; the same run with the B2 line reproduces the former pin 96651b5d…).
 * Memo "Generated:" lines are stripped (wall clock); audit timestamps are fixture-invalid ("—") to stay TZ-independent.
 */
const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: (...args: any[]) => mockedResolveGovernanceRequestUser(...args),
}));
const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: (...args: any[]) => mockedResolveVisibleUserIds(...args),
  runOwnerVisibleInGovernance: () => true,
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
let runRows: Array<{ id: string; data: Record<string, unknown> }> = [];
let verRows: Array<{ id: string; data: Record<string, unknown> }> = [];
const mockAdminDb: any = {
  collection: (name: string) => {
    const rowsFor = name === "runs" ? () => runRows : name === "verifications" ? () => verRows : () => [];
    const snap = () => ({ docs: rowsFor().map((r) => ({ id: r.id, data: () => r.data })) });
    const q: any = { where: () => q, orderBy: () => q, limit: () => q, select: () => q, get: async () => snap() };
    if (name === "runs" || name === "verifications" || name === "videoVerifications") return q;
    return { doc: () => ({ get: async () => ({ exists: false }) }) };
  },
  getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));

import { createHash } from "crypto";
import * as fs from "fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";
import { classifyStoredDisagreement, storedRunIndependenceContext } from "@/lib/panel/storedDisagreementIndependence";
import { crossModelDisagreements, buildPanelVerdict, formatVerdictText, buildCopyForXShort } from "@/lib/verificationGate/panelVerdict";
import { computeVerificationGate } from "@/lib/verificationGate/verificationGate";
import { independentSynthesisResponders } from "@/lib/panel/independentVoices";
import ClaimVerificationResultView, { buildClaimVerdictClipboardText, ClaimVerificationAuditTrailDetails } from "@/components/verification/ClaimVerificationResultView";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { toTeamClaimVerificationSummary } from "@/lib/workspaces/teamClaimVerificationSummary";
import { TeamClaimListRow } from "@/components/workspace/claims/TeamClaimListRow";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";

/**
 * Pinned: sha256 of the 8584211 outputs for the generated set (computed in a scratch export at that commit, without
 * normalisation). Was 96651b5d2288eb0fabcfb09cf1a582c1d99e93d34613fb78341c33a4bbf8ee02 (B2-normalised baseline).
 */
const BASELINE_8584211_DIGEST = "ecda400490d0b6f10931dd72465941156b1ab332f752912e0e616a3232c5eb21";

// Feature detection: the claim presentation module exists only after 8584211.
let presentation: any = null;
try {
  presentation = require("@/lib/verification/claimConsensusPresentation");
} catch {
  presentation = null;
}
const IS_BASELINE = presentation === null;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SLOTS = ["chatgpt", "claude", "gemini", "grok", "perplexity"];
const FAMILY: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", grok: "Grok", perplexity: "Perplexity" };
const WORDS = "archive founding source scope figure estimate methodology record treaty census revision timeline dataset".split(" ");

function gen(seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const text = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
  const shuffled = [...SLOTS].sort(() => r() - 0.5);
  const slots = shuffled.slice(0, 2 + Math.floor(r() * 4));
  return { r, pick, text, slots };
}

/** A research run with >= 2 independent answering models and at most one substitute (never collapsed). */
function researchRecord(i: number) {
  const { r, pick, text, slots } = gen(1000 + i);
  const answering = slots.slice(0, Math.max(2, Math.ceil(slots.length * r())));
  const subIdx = r() < 0.3 ? Math.floor(r() * answering.length) : -1;
  const perModel = slots.map((s) => {
    if (!answering.includes(s)) return { modelId: s, status: "failed", rawTextTruncated: "" };
    if (answering.indexOf(s) === subIdx) return { modelId: s, status: "substituted", provider: "deepseek", rawTextTruncated: `${s} via ds ${text(3)}` };
    return { modelId: s, status: "ok", rawTextTruncated: `${s} ${text(4)}` };
  });
  const items: any[] = [];
  const n = 1 + Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const kind = Math.floor(r() * 6);
    const names = [...slots].sort(() => r() - 0.5).slice(0, 1 + Math.floor(r() * 3));
    const key = (s: string) => (r() < 0.4 ? FAMILY[s] : s);
    const positionsByModel = Object.fromEntries(names.map((s) => [key(s), text(2)]));
    const topic = `${text(1 + Math.floor(r() * 5))} ${k}`;
    const whyTheyDiffer = text(2 + Math.floor(r() * 14));
    if (kind === 0) items.push(`${topic}: ${whyTheyDiffer}`);
    else if (kind === 1) items.push({ topic, whyTheyDiffer });
    else items.push({ topic, positionsByModel, whyTheyDiffer });
  }
  const keyFindings = Array.from({ length: 1 + Math.floor(r() * 3) }, (_x, k) => ({
    claim: `${text(4)} finding ${k}`,
    modelsSupporting: answering.slice(0, 1 + Math.floor(r() * answering.length)),
    confidence: pick(["High", "Medium", "Low", "Mixed"]),
    evidenceRefs: r() < 0.5 ? [] : ["ref"],
  }));
  const trustSummary = { strongConsensus: Math.floor(r() * 3), contestedAreas: Math.floor(r() * 3), uncertainPoints: Math.floor(r() * 3) };
  const report = { executiveSummary: text(6), keyFindings, disagreements: items.filter((x) => typeof x === "object").map((x) => ({ positionsByModel: {}, ...x })), biasAndBlindSpots: r() < 0.5 ? [text(3)] : [], openQuestions: [] };
  const legacy = r() < 0.2;
  const v2Positions = r() < 0.3 ? [{ topic: "v2", positions: answering.slice(0, 2).map((s) => ({ model: FAMILY[s], position: "p" })) }] : [];
  const data: Record<string, unknown> = {
    userId: "owner-a",
    question: `run ${i}`,
    governanceStatus: "needs_review",
    governanceReasons: ["r"],
    createdAt: { toMillis: () => Date.now() - 1000 * i }, // inside the queue window; not part of the outputs
    consensusScore: 40 + Math.floor(r() * 60),
    synthesizedStructuredReport: { disagreements: items },
    ...(v2Positions.length ? { synthesizedReportV2: { keyDisagreements: v2Positions } } : {}),
    ...(legacy ? { resultsCompact: { perModel } } : { runDocument: { perModel } }),
  };
  return { id: `run-${i}`, data, perModel, report, trustSummary, items };
}

/** A claim verification with >= 2 answering slots (claim connectors never substitute). */
function claimRecord(i: number) {
  const { r, pick, text, slots } = gen(5000 + i);
  const answering = slots.slice(0, Math.max(2, Math.ceil(slots.length * r())));
  const unanimous = r() < 0.35;
  const v0 = pick(["accurate", "inaccurate", "partially_accurate", "unverifiable"]);
  const modelResults = slots.map((s) => {
    if (!answering.includes(s)) {
      const st = r() < 0.5 ? "failed" : "parse_error";
      return { modelId: s, status: st, verdict: st, confidence: "low", summary: "", correctParts: [], incorrectParts: [], unverifiableParts: [] };
    }
    return {
      modelId: s,
      status: "ok",
      verdict: unanimous ? v0 : pick(["accurate", "inaccurate", "partially_accurate", "unverifiable"]),
      confidence: pick(["high", "medium", "low"]),
      summary: `${s} ${text(5)}`,
      correctParts: r() < 0.7 ? [`${text(4)} correct`] : [],
      incorrectParts: r() < 0.5 ? [Array.from({ length: 5 }, () => `tok${Math.floor(r() * 1e6)}`).join(" ")] : [],
      unverifiableParts: r() < 0.3 ? [text(3)] : [],
    };
  });
  const verdict = pick(["confirmed", "disputed", "partially_true", "unverifiable"]);
  const consensusScore = Math.floor(r() * 101);
  const confidenceLabel = pick(["High", "Medium", "Low"]);
  const evidenceQuality = pick(["strong", "mixed", "weak"]);
  const legacy = r() < 0.2;
  const data: Record<string, unknown> = {
    userId: "owner-a",
    type: "claim_verification",
    claim: `claim ${i} ${text(5)}`,
    verdict,
    consensusScore,
    confidenceLabel,
    evidenceQuality,
    supportRatio: Math.round(r() * 100) / 100,
    governanceStatus: "needs_review",
    governanceReasons: ["r"],
    timestamp: { toMillis: () => Date.now() - 1000 * i, seconds: 1_700_000_000 + i, nanoseconds: 0 }, // queue window; fixed seconds for the Team row date
    modelResults,
    auditBundle: {
      version: "1",
      kind: "claim_verification",
      claimCharCount: 10,
      modelCount: modelResults.length,
      verdict,
      consensusScore,
      confidenceLabel,
      evidenceQuality,
      perModel: modelResults.map((m) => ({ modelId: m.modelId, pipelineStatus: m.status, verdictLabel: m.status === "ok" ? m.verdict : null, confidence: m.confidence, summaryLength: 1, counts: { correct: 0, incorrect: 0, unverifiable: 0 } })),
      generatedAt: "not-a-date",
    },
    ...(legacy ? {} : { selectedModels: slots }),
  };
  return { id: `ver-${i}`, data, unanimous: new Set(modelResults.filter((m) => m.status === "ok").map((m) => String(m.verdict))).size === 1 };
}

const N = 240;
const html = (el: any) => renderToStaticMarkup(el);
const stripGenerated = (s: string) => s.split("\n").filter((l) => !l.startsWith("Generated:")).join("\n");

async function outputs(): Promise<unknown> {
  const research = Array.from({ length: N }, (_x, i) => researchRecord(i));
  const claims = Array.from({ length: N }, (_x, i) => claimRecord(i));
  // The queue caps how many rows one request lists: feed it in small batches.
  const byId: Record<string, any> = {};
  for (let start = 0; start < N; start += 5) {
    runRows = research.slice(start, start + 5).map(({ id, data }) => ({ id, data }));
    verRows = claims.slice(start, start + 5).map(({ id, data }) => ({ id, data }));
    const res = await GET(new NextRequest("http://localhost/api/governance/queue"));
    for (const q of (await res.json()).runs as any[]) byId[q.runId] = q;
  }
  for (const id of [...research.map((x) => x.id), ...claims.map((x) => x.id)]) if (!byId[id]) throw new Error(`queue did not list ${id}`);

  const researchOut = research.map((rec) => {
    const rows = rec.perModel.map((p: any) => ({ modelId: p.modelId, status: p.status, provider: p.provider, rawText: p.rawTextTruncated }));
    const responders = independentSynthesisResponders(rows as any).length;
    const crossModel = responders >= 2;
    const ctx = storedRunIndependenceContext(rec.data);
    const queueBasis = rec.items.map((it: unknown) => classifyStoredDisagreement(it, ctx));
    const genuine = crossModelDisagreements(rec.report.disagreements as any, rows as any, crossModel);
    const gateInput: any = IS_BASELINE
      ? { keyFindings: rec.report.keyFindings, disagreements: genuine, biasAndBlindSpots: rec.report.biasAndBlindSpots, openQuestions: [], trustSummary: rec.trustSummary, sourceBacked: false, questionLength: 30, independentModelCount: responders }
      : { keyFindings: rec.report.keyFindings, disagreements: rec.report.disagreements, independentDisagreements: genuine, biasAndBlindSpots: rec.report.biasAndBlindSpots, openQuestions: [], trustSummary: rec.trustSummary, sourceBacked: false, questionLength: 30, independentModelCount: responders };
    const gate = computeVerificationGate(gateInput);
    const verdict = buildPanelVerdict("q", rec.report as any, gate, rows as any, { crossModel });
    const q = byId[rec.id];
    return {
      id: rec.id,
      queueBasis,
      genuine: genuine.map((d: any) => d.topic),
      gate,
      verdict,
      linkedin: formatVerdictText(verdict, "linkedin"),
      x: buildCopyForXShort(verdict),
      queue: { consensusScore: q.consensusScore, evidenceQuality: q.evidenceQuality, consensusWithheld: q.consensusWithheld, modelIndependence: q.modelIndependence, disagreements: q.disagreements, disagreementPoints: q.disagreementPoints, qualifiedDisagreements: q.qualifiedDisagreements, keyFindings: q.keyFindings },
    };
  });

  const claimOut = claims.map((rec) => {
    const payload = mapStoredVerificationToClientPayload(rec.data as any, rec.id);
    const memo = generateVerificationMemo({
      type: "claim",
      claim: payload.claim,
      verdict: payload.verdict,
      consensusScore: payload.consensusScore,
      confidenceLabel: payload.confidenceLabel,
      evidenceQuality: payload.evidenceQuality ?? "mixed",
      modelEvidence: payload.modelEvidence,
      agreementPoints: payload.whereModelsAgree,
      disagreementPoints: payload.whereModelsDisagree.map((d) => d.point),
      verificationId: rec.id,
      ...(IS_BASELINE ? {} : { claimModelIndependence: presentation.claimModelIndependence((payload as any).modelIndependence) }),
    } as any);
    const summary = toTeamClaimVerificationSummary({ verificationId: rec.id, data: rec.data, workspaceId: "w", projectId: null, project: null })!;
    const history = IS_BASELINE
      ? ` · ${payload.consensusScore} consensus`
      : presentation.claimHistoryConsensusSuffix({ consensusScore: payload.consensusScore, modelIndependence: (payload as any).modelIndependence });
    const q = { ...byId[rec.id] };
    return {
      id: rec.id,
      view: html(createElement(ClaimVerificationResultView, { data: payload })),
      audit: html(createElement(ClaimVerificationAuditTrailDetails, { data: payload })),
      clipboard: buildClaimVerdictClipboardText(payload),
      memo: stripGenerated(memo),
      teamRow: html(createElement("ul", null, createElement(TeamClaimListRow, { workspaceId: "w", item: summary as any, showProject: false }))),
      history,
      queue: {
        consensusScore: q.consensusScore,
        evidenceQuality: q.evidenceQuality,
        consensusWithheld: q.consensusWithheld,
        modelIndependence: q.modelIndependence,
        agreementSummary: q.agreementSummary,
        dissentSummary: q.dissentSummary,
        agreementPoints: q.agreementPoints,
        disagreementPoints: q.disagreementPoints,
        disagreements: q.disagreements,
        qualifiedDisagreements: q.qualifiedDisagreements,
        singleModelAssessment: q.singleModelAssessment,
      },
    };
  });
  return { research: researchOut, claims: claimOut };
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
});
afterEach(() => jest.restoreAllMocks());

describe("records with >= 2 independent executing models (no collapsed slots): identical to 8584211", () => {
  it("every generated record really has >= 2 independent executing models and no collapse", () => {
    for (let i = 0; i < N; i++) {
      const rec = researchRecord(i);
      const ctx = storedRunIndependenceContext(rec.data);
      expect([ctx.independence, ctx.collapsed]).toEqual(["independent", false]);
    }
  });

  it("output digest equals the pinned 8584211 digest", async () => {
    const out = await outputs();
    const json = JSON.stringify(out);
    const digest = createHash("sha256").update(json).digest("hex");
    if (process.env.PARITY_DUMP) fs.writeFileSync(process.env.PARITY_DUMP, json);
    if (IS_BASELINE) {
      // Baseline run (scratch worktree at 8584211): report the digest to pin.
      // eslint-disable-next-line no-console
      process.stdout.write(`PARITY_DIGEST=${digest}\n`);
      return;
    }
    expect(digest).toBe(BASELINE_8584211_DIGEST);
  });
});

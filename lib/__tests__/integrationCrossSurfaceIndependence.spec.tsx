/**
 * Connector integration (Order 34) — ONE cross-surface consistency oracle on the integrated tree.
 *
 * The same fixture records go through every presentation family:
 *  - research UI: synthesis view, panel response, list view, strip, evidence, governance;
 *  - share texts (Markdown, LinkedIn, X, memo), PDF and DOCX (o5pRender);
 *  - stored-run lists, history and the governance / Team queues (storedRunConsensusIndependence, the run summary
 *    and status line, the queue withheld text);
 *  - claim: saved payload, result view, Team list row, history line, memo;
 *  - video: saved payload, result view, Team list summary, memo.
 *
 * Fixture classes: genuine 5/5, genuine 2+3 (two own providers plus DeepSeek in three slots), all slots timed out, one
 * answer with stored count 5, one substitute in two slots, provider-less historical (pre-6.2a) rows, and video.
 *
 * Every family must state the SAME independence for a class: a genuine run keeps agreement and its score; anything
 * else never reads as unqualified agreement between models.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "pro", governanceAssignedReviewerEmail: null }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("server-only", () => ({}));

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderRecord } from "@/lib/adaptiveSchema/__tests__/o5p/o5pRender";
import { htmlText } from "@/lib/adaptiveSchema/__tests__/o5p/htmlText";
import { CONSENSUS_WITHHELD_TEXT, consensusScoreWithheldReason, storedRunConsensusIndependence } from "@/lib/panel/independentVoices";
import { runExecutionIdentity } from "@/lib/panel/executionIdentity";
import { storedVerificationConsensusIndependence, storedVideoConsensusIndependence } from "@/lib/panel/storedVerificationIndependence";
import { toRunSummaryBase } from "@/lib/runs/runSummary";
import { workspaceRunStatusLine } from "@/components/workspace/WorkspaceRunCard";
import { queueConsensusText } from "@/components/governance/GovernanceDashboard";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { mapStoredVideoVerificationToClientPayload } from "@/lib/user/mapStoredVideoVerificationToClientPayload";
import ClaimVerificationResultView from "@/components/verification/ClaimVerificationResultView";
import VideoVerificationResultView from "@/components/verification/VideoVerificationResultView";
import { toTeamClaimVerificationSummary } from "@/lib/workspaces/teamClaimVerificationSummary";
import { TeamClaimListRow } from "@/components/workspace/claims/TeamClaimListRow";
import { toTeamVideoVerificationSummary } from "@/lib/workspaces/teamVideoVerificationSummary";
import { claimHistoryConsensusSuffix } from "@/lib/verification/claimConsensusPresentation";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import type { ModelResult } from "@/lib/types";

const records: Record<string, any> = JSON.parse(readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/records.json"), "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const FIVE = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
const TEXT = "Raising the minimum wage has small employment effects in most studies.";

type Slot = "ok" | "okNoProvider" | "ds" | "timeout";
type Cls = { name: string; slots: Slot[]; expected: "independent" | "insufficient" | "unverified" };
const CLASSES: Cls[] = [
  { name: "genuine 5/5", slots: ["ok", "ok", "ok", "ok", "ok"], expected: "independent" },
  { name: "genuine 2+3", slots: ["ok", "ok", "ds", "ds", "ds"], expected: "independent" },
  { name: "all slots timed out", slots: ["timeout", "timeout", "timeout", "timeout", "timeout"], expected: "unverified" },
  { name: "one answer, stored count 5", slots: ["ok", "timeout", "timeout", "timeout", "timeout"], expected: "insufficient" },
  { name: "one substitute in two slots", slots: ["ds", "ds", "timeout", "timeout", "timeout"], expected: "insufficient" },
  { name: "provider-less historical rows", slots: ["okNoProvider", "okNoProvider", "okNoProvider", "okNoProvider", "okNoProvider"], expected: "unverified" },
];

const resultRow = (m: string, s: Slot): ModelResult =>
  (s === "ok"
    ? { modelId: m, status: "ok", rawText: TEXT, latencyMs: 5, provider: OWN[m] }
    : s === "okNoProvider"
      ? { modelId: m, status: "ok", rawText: TEXT, latencyMs: 5 }
      : s === "ds"
        ? { modelId: m, status: "substituted", rawText: TEXT, latencyMs: 5, provider: "deepseek" }
        : { modelId: m, status: "timeout", rawText: null, latencyMs: 5 }) as unknown as ModelResult;
const perModelRow = (r: ModelResult) => ({ modelId: r.modelId, status: r.status, rawTextTruncated: r.rawText ?? "", ...(r.provider ? { provider: r.provider } : {}) });
const claimRow = (m: string, s: Slot) => ({
  modelId: m,
  status: s === "timeout" ? "failed" : "ok",
  verdict: s === "timeout" ? "failed" : "accurate",
  confidence: "high",
  summary: "s",
  correctParts: [],
  incorrectParts: [],
  unverifiableParts: [],
  ...(s === "ok" ? { provider: OWN[m] } : s === "ds" ? { substituted: true, provider: "deepseek" } : {}),
});

/** Unqualified agreement between models, in any wording the surfaces use. */
const UNQUALIFIED_AGREEMENT = /\ball [2-9] dispatched models support it\b(?! \(counted by panel slot)|\b[2-9]\/[2-9] models (converge|agree|say)\b|\bagreed by [2-9] models\b|\bStrong consensus\b(?! \()|This claim is supported by [2-9]\/[2-9] models|\b[2-9] AI models (researched|evaluated)\b/;
const UNVERIFIED = /model independence (unverified|not recorded)|No successful model responses|Independent-model coverage unverified/i;

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
function textOf(key: string, v: string): string {
  if (key.startsWith("export.pdfTree")) {
    const out: string[] = [];
    JSON.parse(v, (k, val) => {
      if (typeof val === "string" && k !== "t") out.push(val);
      return val;
    });
    return out.join(" ");
  }
  return key.startsWith("ui.") || key.startsWith("export.docxXml") ? htmlText(v) : v;
}
const SURFACES = ["ui.synthesisView", "ui.panelResponse", "ui.listView", "ui.primaryStrip", "ui.panelEvidence", "ui.governance", "text.markdown", "text.linkedin", "text.x", "text.memo", "export.pdfTree", "export.docxXml"];

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe.each(CLASSES)("one independence across every surface — $name", (c) => {
  const rows = FIVE.map((m, i) => resultRow(m, c.slots[i]));
  const runDoc = { question: "q", selectedModels: FIVE, createdAt: { toMillis: () => 1 }, synthesisConsensusSummary: { overallConsensusScore: 88 }, runDocument: { perModel: rows.map(perModelRow) } };
  const claimDoc = {
    userId: "u", claim: "Minimum wage claim.", type: "claim_verification", verdict: "confirmed", consensusScore: 88, confidenceLabel: "High", evidenceQuality: "strong", supportRatio: 1,
    modelResults: FIVE.map((m, i) => claimRow(m, c.slots[i])), selectedModels: FIVE,
    auditBundle: { version: "1", kind: "claim_verification", claimCharCount: 10, modelCount: 5, verdict: "confirmed", consensusScore: 88, confidenceLabel: "High", evidenceQuality: "strong", perModel: [], generatedAt: "not-a-date" },
    timestamp: { seconds: 1_800_000_000, nanoseconds: 0 },
  };

  it("stored-run families (lists, history, governance / Team queue) and the claim families share the class's independence", () => {
    expect(storedRunConsensusIndependence(runDoc)).toBe(c.expected);
    expect(storedVerificationConsensusIndependence(claimDoc as never)).toBe(c.expected);
    const reason = consensusScoreWithheldReason(c.expected);
    // Lists and history (run summary + status line).
    const s = toRunSummaryBase("r", runDoc);
    expect(s.synthesisConsensusWithheld).toBe(reason);
    if (c.expected === "independent") expect(workspaceRunStatusLine(s)).toContain("Synthesis 88/100");
    else expect(workspaceRunStatusLine(s)).not.toMatch(/Synthesis \d+\/100/);
    // Governance / Team queue text over the same reason.
    expect(queueConsensusText({ consensusScore: 88, consensusWithheld: reason }, true)).toBe(reason ? CONSENSUS_WITHHELD_TEXT[reason] : "88/100");
  });

  it("claim: saved payload, result view, Team list row, history line and memo agree", () => {
    const payload = mapStoredVerificationToClientPayload(claimDoc as never, "vcl-x");
    expect(payload.modelIndependence).toBe(c.expected);
    const view = html(createElement(ClaimVerificationResultView, { data: payload }));
    const summary = toTeamClaimVerificationSummary({ verificationId: "vcl-x", data: { ...claimDoc, workspaceId: "w" }, workspaceId: "w", projectId: null, project: null })!;
    const teamRow = html(createElement("ul", null, createElement(TeamClaimListRow, { workspaceId: "w", item: summary as never, showProject: false })));
    const historyLine = claimHistoryConsensusSuffix({ consensusScore: summary.consensusScore, modelIndependence: c.expected });
    const memo = generateVerificationMemo({ type: "claim", claim: "c", verdict: "confirmed", consensusScore: 88, confidenceLabel: "High", evidenceQuality: "strong", verificationId: "v", modelEvidence: payload.modelEvidence, claimModelIndependence: c.expected });
    if (c.expected === "independent") {
      expect(view).toContain(">88</p>");
      expect(teamRow).toContain("88/100 consensus");
      expect(historyLine).toBe(" · 88 consensus");
      expect(memo).toContain("CONSENSUS SCORE: 88/100");
    } else {
      const withheld = CONSENSUS_WITHHELD_TEXT[consensusScoreWithheldReason(c.expected)!];
      for (const out of [view, teamRow, historyLine]) {
        expect(out).toContain(withheld);
        expect(out).not.toMatch(UNQUALIFIED_AGREEMENT);
      }
      expect(memo).not.toContain("CONSENSUS SCORE: 88/100");
      expect(memo).not.toMatch(UNQUALIFIED_AGREEMENT);
    }
  });

  it("research UI, share texts, memo, PDF and DOCX: no unqualified agreement unless genuine; genuine runs keep agreement", async () => {
    const rec = clone(records["generic-consensus"]);
    rec.results = rec.results.map((r: any, i: number) => ({ ...r, ...resultRow(r.modelId, c.slots[i]), rawText: r.rawText ?? TEXT }));
    const raw = await renderRecord(rec, rows);
    const texts = Object.fromEntries(Object.entries(raw).filter(([k, v]) => v != null && SURFACES.includes(k)).map(([k, v]) => [k, textOf(k, v!)]));
    expect(Object.keys(texts).length).toBeGreaterThanOrEqual(10);
    const identity = runExecutionIdentity(rows);
    if (c.expected === "independent" && identity.kind === "IND") {
      for (const [k, t] of Object.entries(texts)) expect([k, UNVERIFIED.test(t)]).toEqual([k, false]);
    } else if (c.expected === "independent") {
      // PC: counts are of independent executing models (K), never of answering slots (M).
      const slotCount = new RegExp(`\\b${identity.answeredSlots} AI models researched|\\ball ${identity.answeredSlots} dispatched models support it\\b(?! \\(counted by panel slot)|\\b${identity.answeredSlots}/${identity.answeredSlots} models`);
      for (const [k, t] of Object.entries(texts)) expect([k, slotCount.test(t)]).toEqual([k, false]);
      expect(texts["text.memo"]).toContain(`${identity.independentModels} AI models researched this question independently`);
    } else {
      // Order 35 A (F-1, owner ruling): the memo of a run with fewer than two answering models states the verified count,
      // never the requested slot count or the stored score — zero: no responses, consensus cannot be assessed; one: no
      // multi-model agreement. Every surface, the memo included, is held to the rule below.
      if (c.name === "all slots timed out") {
        expect(texts["text.memo"]).toContain("CONSENSUS SCORE: none (no successful model responses; consensus cannot be assessed)");
        expect(texts["text.memo"]).toContain("No model responses are available for this question");
      }
      if (c.name === "one answer, stored count 5") {
        expect(texts["text.memo"]).toContain("CONSENSUS SCORE: none (fewer than two independent models responded");
        expect(texts["text.memo"]).toContain("Treat the findings as a single model's output.");
      }
      if (c.name === "all slots timed out" || c.name === "one answer, stored count 5") {
        expect(texts["text.memo"]).not.toMatch(/\b\d+ AI models researched this question independently|CONSENSUS SCORE: \d+\/100|independently researched by \d+ large language models/);
      }
      for (const [k, t] of Object.entries(texts)) { const m = t.match(UNQUALIFIED_AGREEMENT); expect([k, m ? t.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 60) : null]).toEqual([k, null]); }
    }
  });
});

describe("video (PQ-2 strict): every video family is independence-unverified", () => {
  const modelResults = ["chatgpt", "claude", "gemini"].map((m) => ({ modelId: m, modelName: m, status: "ok", verdict: "authentic_captured", confidence: "high", contentType: "camera_footage", summary: "s", visualIndicators: [], metadataIndicators: [], manipulationSignals: [], authenticitySignals: [], productionSignals: [], deceptionIndicators: [], compressionNotes: [], limitations: [] }));
  const doc = { userId: "u", type: "video_verification", fileName: "a.mp4", verdict: "authentic_captured", contentType: "camera_footage", consensusScore: 100, confidenceLabel: "High", evidenceQuality: "strong", supportRatio: 100, metadata: { duration: 10, width: 1, height: 1, codec: "h264", frameRate: 30, fileSize: 1, format: "mp4", hasAudio: true }, metadataAnalysis: { flags: [], summary: "s" }, modelResults, agreementPoints: ["3/3 models identified camera footage"], disagreementPoints: [], frameCount: 8, warnings: [], timestamp: { seconds: 1_800_000_000, nanoseconds: 0 } };
  it("saved payload, result view, Team list summary and memo", () => {
    expect(storedVideoConsensusIndependence(modelResults)).toBe("unverified");
    const p = mapStoredVideoVerificationToClientPayload("vid", doc);
    expect(p.modelIndependence).toBe("unverified");
    const view = html(createElement(VideoVerificationResultView, { data: p }));
    expect(view).toContain(CONSENSUS_WITHHELD_TEXT.independence_unverified);
    expect(view).not.toContain("Where models agree");
    const s = toTeamVideoVerificationSummary({ verificationId: "vid", data: doc, workspaceId: "w", projectId: null, project: null })!;
    expect([s.consensusScore, s.consensusWithheld]).toEqual([null, "independence_unverified"]);
    const memo = generateVerificationMemo({ type: "video", verdict: "authentic_captured", consensusScore: 100, confidenceLabel: "High", evidenceQuality: "strong", verificationId: "vid", modelEvidence: p.modelEvidence, agreementPoints: p.agreementPoints, videoModelIndependence: p.modelIndependence });
    expect(memo).toContain("CONSENSUS SCORE: withheld (model independence not recorded)");
    expect(memo).not.toMatch(/vision-capable AI models independently analyzed/);
  });
});

describe("integration hunk #1: a presented report without a top-claim result still states the top claim's independence", () => {
  it("Markdown (classic and readable) carries the Model independence line; an independent run carries none", () => {
    const { buildAdaptiveSynthesisMarkdown } = require("@/lib/adaptiveSchema/shareBuilders");
    const { provenanceOf } = require("@/lib/adaptiveSchema/__tests__/o5p/o5pRender");
    const rec = clone(records["generic-consensus"]);
    delete rec.synthesisReport.verdictCard.topConsensusAgreement;
    const uv = provenanceOf(FIVE.map((m) => resultRow(m, "okNoProvider")));
    const ind = provenanceOf(FIVE.map((m) => resultRow(m, "ok")));
    const readable = { status: "caution", badge: "Verification gate: Caution", banner: "b", bannerNote: null };
    for (const r of [undefined, readable]) {
      const md = buildAdaptiveSynthesisMarkdown("Q", rec.synthesisReport, undefined, uv, undefined, r);
      expect(md).toMatch(/\*\*Panel verdict:\*\* .*\n\*\*Model independence:\*\* /);
      expect(buildAdaptiveSynthesisMarkdown("Q", rec.synthesisReport, undefined, ind, undefined, r)).not.toContain("**Model independence:**");
    }
  });
});

describe("integration hunk #10b: the readable X post keeps the connector qualifier of a qualified run", () => {
  it("legacy report: the short qualifier sits before the brand, never cut, within 280; an independent run has none", () => {
    const { buildAdaptiveXPost } = require("@/lib/adaptiveSchema/shareBuilders");
    const { modelWrittenShortLabel } = require("@/lib/panel/executionIdentity");
    const rec = clone(records["generic-mixed"]);
    delete rec.synthesisReport.presentation;
    const readable = { status: "caution", badge: "Verification gate: Caution", banner: "Verification gate: Caution", bannerNote: null };
    const uvRows = FIVE.map((m) => resultRow(m, "okNoProvider"));
    const uv = runExecutionIdentity(uvRows);
    expect(uv.qualified).toBe(true);
    const long = "Across the last two decades of peer-reviewed labour-economics research, does a sustained shift to remote or hybrid work measurably change productivity?";
    for (const q of ["Q?", long]) {
      const post: string = buildAdaptiveXPost(q, rec.synthesisReport, undefined, uv, readable);
      expect(post.length).toBeLessThanOrEqual(280);
      expect(post.endsWith(`${modelWrittenShortLabel(uv)}\n\nvia ConvergePanel`)).toBe(true);
    }
    const ind = runExecutionIdentity(FIVE.map((m) => resultRow(m, "ok")));
    expect(buildAdaptiveXPost("Q?", rec.synthesisReport, undefined, ind, readable)).toBe(buildAdaptiveXPost("Q?", rec.synthesisReport, undefined, undefined, readable));
  });
});

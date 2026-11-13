/**
 * Review of 262ef64, MAJOR B2 — the governance queue's claim / video agreement wording, end to end (GET route with a
 * Firestore double that HONOURS `.select()` projections -> GovernanceDashboard expanded row):
 *  - no "(others disagree)" unless another independent model ANSWERED with a different verdict;
 *  - no "1/1 models say …" / "N/N models agree" below two independent executing models;
 *  - four separate classifications: genuine disagreement, repeated outputs from one executing model, one model's
 *    assessment / contested points, unknown model independence.
 * NIT: `selectedModels` reaches the classifier only through the VER_QUEUE_FIELDS projection — a requested model with no
 * row is "unverified" only because the projection carries it.
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
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));

let verRows: Array<{ id: string; data: Record<string, unknown> }> = [];
let vidRows: Array<{ id: string; data: Record<string, unknown> }> = [];
const projections: Record<string, string[][]> = { verifications: [], videoVerifications: [] };

/** A query double whose `.select(...fields)` really projects each document to those fields (Firestore semantics). */
function query(name: string, fields: string[] | null): any {
  const rows = () => (name === "verifications" ? verRows : name === "videoVerifications" ? vidRows : []);
  const project = (data: Record<string, unknown>) =>
    fields ? Object.fromEntries(fields.filter((f) => f in data).map((f) => [f, data[f]])) : data;
  return {
    where: () => query(name, fields),
    orderBy: () => query(name, fields),
    limit: () => query(name, fields),
    select: (...f: string[]) => {
      projections[name]?.push(f);
      return query(name, f);
    },
    get: async () => ({ docs: rows().map((r) => ({ id: r.id, data: () => project(r.data) })) }),
  };
}
const mockAdminDb: any = {
  collection: (name: string) =>
    name === "runs" || name === "verifications" || name === "videoVerifications"
      ? query(name, null)
      : { doc: () => ({ get: async () => ({ exists: false }) }) },
  getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";
import {
  FragmentRow,
  QUALIFIED_DISAGREEMENTS_HEADING,
  QUEUE_VERIFICATION_INDEPENDENCE_NOTE,
  queueVerificationAgreementView,
} from "@/components/governance/GovernanceDashboard";
import { QUALIFIED_DISAGREEMENT_TEXT } from "@/lib/panel/storedDisagreementIndependence";

/**
 * C-b (CB-01): an own-provider `ok` claim row counts toward verified independence only when it records its provider, so
 * the fixtures below record one (`OWN_PROVIDER`; video rows are judged by the queue's own video rule, C-c CC-12, which
 * ignores it). `vrowNoProvider` is the row every stored own-provider claim actually holds (m-B).
 */
const OWN_PROVIDER: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", gemini: "google", perplexity: "perplexity" };
const vrowNoProvider = (modelId: string, status: "ok" | "parse_error" | "failed", verdict: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  status,
  verdict: status === "ok" ? verdict : status,
  confidence: "high",
  summary: `${modelId} summary`,
  correctParts: [],
  incorrectParts: [],
  unverifiableParts: [],
  ...extra,
});
const vrow = (modelId: string, status: "ok" | "parse_error" | "failed", verdict: string, extra: Record<string, unknown> = {}) =>
  vrowNoProvider(modelId, status, verdict, status === "ok" && extra.substituted !== true ? { provider: OWN_PROVIDER[modelId], ...extra } : extra);
const DS = { substituted: true, provider: "deepseek" };
const ver = (id: string, modelResults: unknown[] | undefined, selectedModels?: string[]) => ({
  id,
  data: {
    userId: "owner-a",
    type: "claim_verification",
    claim: id,
    verdict: "confirmed",
    consensusScore: 92,
    evidenceQuality: "strong",
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    timestamp: { toMillis: () => Date.now() },
    ...(modelResults ? { modelResults } : {}),
    ...(selectedModels ? { selectedModels } : {}),
  },
});
const vid = (id: string, modelResults: unknown[]) => ({
  id,
  data: {
    userId: "owner-a",
    type: "video_verification",
    fileName: `${id}.mp4`,
    verdict: "authentic",
    consensusScore: 80,
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    timestamp: { toMillis: () => Date.now() },
    modelResults,
  },
});
const LONG_A = "The structure was completed in March of that year by the original builders";
const LONG_B = "Opening ceremonies happened much later according to municipal archives";

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  projections.verifications = [];
  projections.videoVerifications = [];
  vidRows = [];
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
});
afterEach(() => jest.restoreAllMocks());

async function rows(): Promise<Record<string, any>> {
  const res = await GET(new NextRequest("http://localhost/api/governance/queue"));
  expect(res.status).toBe(200);
  const json = await res.json();
  return Object.fromEntries(json.runs.map((r: any) => [r.runId, r]));
}

function render(row: Record<string, unknown>): string {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement("table", null,
      createElement("tbody", null,
        createElement(FragmentRow as never, {
          row,
          chip: { wrap: "", label: "Review" },
          mh: { text: "", cls: "", title: "" },
          ev: { text: "", cls: "" },
          exp: true,
          firstReason: "",
          more: "",
          consensusColor: () => "",
          expanded: new Set<string>(),
          setExpanded: noop,
          reviewBusyKey: null,
          onApprove: noop,
          onBlock: noop,
          onChanges: noop,
        } as never)
      )
    )
  )
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'");
}

const MULTI_MODEL = /\d+\/\d+ models (say|rate|agree)|others disagree|Where models agree|Where models disagree/;

describe("GET /api/governance/queue + GovernanceDashboard — claim wording by executing-model independence", () => {
  it("one of three requested models responded: one model's assessment; no N/N, no '(others disagree)'", async () => {
    verRows = [ver("one", [vrow("chatgpt", "ok", "accurate"), vrow("claude", "failed", ""), vrow("grok", "parse_error", "")], ["chatgpt", "claude", "grok"])];
    const r = (await rows())["one"];
    expect(r.modelIndependence).toBe("insufficient");
    expect(r.singleModelAssessment).toBe("One independent model's assessment (ChatGPT): accurate — not agreement between models");
    // Phase 0 (L15, O14 = A): the DTO carries the 35933c8 slot-count lines, including the known-wrong "(others
    // disagree)" line; the dashboard renders none of them for a row with `modelIndependence` (below).
    expect([r.agreementSummary, r.disagreementPoints]).toEqual(["1/1 models say accurate", ["ChatGPT rated as accurate (others disagree)"]]);
    for (const k of ["agreementPoints", "dissentSummary", "disagreements"]) expect(k in r).toBe(false);
    const html = render(r);
    expect(html).not.toMatch(MULTI_MODEL);
    expect(html).toContain(QUEUE_VERIFICATION_INDEPENDENCE_NOTE.insufficient);
    expect(html).toContain(r.singleModelAssessment);
  });

  it("two responses from the same DeepSeek fallback: repeated outputs from one executing model, not a disagreement", async () => {
    verRows = [
      ver("ds", [vrow("chatgpt", "ok", "accurate", { ...DS, incorrectParts: [LONG_A] }), vrow("claude", "ok", "inaccurate", { ...DS, incorrectParts: [LONG_B] })], ["chatgpt", "claude"]),
    ];
    const r = (await rows())["ds"];
    expect(r.modelIndependence).toBe("insufficient");
    expect(r.qualifiedDisagreements).toEqual([
      { text: "DeepSeek (substituting ChatGPT, Claude) rated as accurate; inaccurate — repeated outputs from one executing model", basis: "same_executing_model" },
      { text: "Conflicting assessments: (chatgpt) vs (claude)", basis: "same_executing_model" },
    ]);
    expect(r.singleModelAssessment).toBe("One independent model's assessment (DeepSeek (substituting ChatGPT, Claude)): accurate / inaccurate — not agreement between models");
    const html = render(r);
    expect(html).not.toMatch(MULTI_MODEL);
    expect(html).toContain(QUALIFIED_DISAGREEMENTS_HEADING);
    expect(html).toContain(`(${QUALIFIED_DISAGREEMENT_TEXT.same_executing_model})`);
  });

  it("two genuinely independent models that agree: 2/2 agreement, no '(others disagree)'", async () => {
    verRows = [ver("two", [vrow("chatgpt", "ok", "accurate"), vrow("claude", "ok", "accurate"), vrow("grok", "failed", "")], ["chatgpt", "claude", "grok"])];
    const r = (await rows())["two"];
    expect("modelIndependence" in r).toBe(false);
    expect(r.agreementSummary).toBe("2/2 models say accurate");
    // Phase 0 (L15, O14 = A): the 35933c8 DTO line "(others disagree)" on a unanimous row is restored verbatim; it is
    // known-wrong and is corrected at render time by track C-b (CB-21, PQ-3): the DTO keeps it, the dashboard drops it.
    expect(r.disagreementPoints).toEqual(["ChatGPT, Claude rated as accurate (others disagree)"]);
    const html = render(r);
    expect(html).toContain("Where models agree");
    expect(html).toContain("2/2 models say accurate");
    expect(html).not.toContain("others disagree");
    expect(html).not.toContain("Where models disagree");
  });

  it("C-b (CB-01): provider-less own-provider rows (every stored own-provider claim) are unverified — nothing between models", async () => {
    verRows = [ver("pl", [vrowNoProvider("chatgpt", "ok", "accurate"), vrowNoProvider("claude", "ok", "accurate"), vrowNoProvider("grok", "failed", "")], ["chatgpt", "claude", "grok"])];
    const r = (await rows())["pl"];
    expect(r.modelIndependence).toBe("unverified");
    expect(r.qualifiedDisagreements).toEqual([
      { text: "2/2 responses say accurate — model independence unverified, not confirmed as agreement between models", basis: "independence_unverified" },
    ]);
    const html = render(r);
    expect(html).not.toMatch(MULTI_MODEL);
    expect(html).toContain(QUEUE_VERIFICATION_INDEPENDENCE_NOTE.unverified);
  });

  it("one independent model with contested claims: its contested points are its own, not a disagreement between models", async () => {
    verRows = [
      ver("contested", [vrow("chatgpt", "ok", "partially_accurate", { incorrectParts: [LONG_A] }), vrow("grok", "parse_error", "", { incorrectParts: [LONG_B] })], ["chatgpt", "grok"]),
    ];
    const r = (await rows())["contested"];
    expect(r.modelIndependence).toBe("insufficient");
    expect(r.qualifiedDisagreements).toEqual([{ text: "Conflicting assessments: (chatgpt) vs (grok)", basis: "single_independent_model" }]);
    expect(r.singleModelAssessment).toBe("One independent model's assessment (ChatGPT): partially accurate — not agreement between models");
    const html = render(r);
    expect(html).not.toMatch(MULTI_MODEL);
    expect(html).toContain(`(${QUALIFIED_DISAGREEMENT_TEXT.single_independent_model})`);
  });

  it("missing provenance: tally stated as responses, independence unverified; nothing between models", async () => {
    verRows = [
      ver("partial", [vrow("chatgpt", "ok", "accurate"), vrow("claude", "ok", "accurate")], ["chatgpt", "claude", "grok"]),
      ver("none", undefined),
    ];
    const by = await rows();
    expect(by["partial"].modelIndependence).toBe("unverified");
    expect(by["partial"].qualifiedDisagreements).toEqual([
      { text: "2/2 responses say accurate — model independence unverified, not confirmed as agreement between models", basis: "independence_unverified" },
    ]);
    expect(by["none"].modelIndependence).toBe("unverified");
    for (const id of ["partial", "none"]) {
      const html = render(by[id]);
      expect(html).not.toMatch(MULTI_MODEL);
      expect(html).toContain(QUEUE_VERIFICATION_INDEPENDENCE_NOTE.unverified);
    }
  });

  it("genuine disagreement between independent models: dissent, '(others disagree)' and the conflict stay", async () => {
    verRows = [
      ver("split", [vrow("chatgpt", "ok", "accurate"), vrow("claude", "ok", "inaccurate", { incorrectParts: [LONG_A] }), vrow("grok", "ok", "inaccurate", { incorrectParts: [LONG_B] })], ["chatgpt", "claude", "grok"]),
    ];
    const r = (await rows())["split"];
    expect("modelIndependence" in r).toBe(false);
    expect(r.agreementSummary).toBe("2/3 models say inaccurate");
    expect(r.dissentSummary).toBe("Dissent: ChatGPT: Accurate");
    expect(r.disagreementPoints).toEqual(["ChatGPT rated as accurate (others disagree)", "Claude, Grok rated as inaccurate (others disagree)"]);
    expect(r.disagreements).toEqual(["Conflicting assessments: (claude) vs (grok)"]);
    const html = render(r);
    expect(html).toContain("Where models disagree");
    expect(html).toContain("ChatGPT rated as accurate (others disagree)");
  });

  it("legacy record (no substitution fields, no selectedModels): judged by its rows", async () => {
    verRows = [ver("legacy", [vrow("chatgpt", "ok", "accurate"), vrow("gemini", "ok", "accurate"), vrow("grok", "ok", "accurate")])];
    const r = (await rows())["legacy"];
    expect("modelIndependence" in r).toBe(false);
    expect(r.agreementPoints).toEqual(["3/3 models rate this as accurate"]);
  });

  it("NIT — selectedModels reaches the classifier only through the VER_QUEUE_FIELDS projection", async () => {
    verRows = [ver("partial", [vrow("chatgpt", "ok", "accurate"), vrow("claude", "ok", "accurate")], ["chatgpt", "claude", "grok"])];
    const r = (await rows())["partial"];
    expect(projections.verifications.length).toBeGreaterThan(0);
    for (const f of projections.verifications) expect(f).toEqual(expect.arrayContaining(["modelResults", "selectedModels"]));
    // grok was requested but has no row → unverified (only visible because the projection carries selectedModels).
    // Phase 0 (L15): stored score kept in the DTO; withholding is the additive reason.
    expect([r.consensusScore, r.consensusWithheld, r.modelIndependence]).toEqual([92, "independence_unverified", "unverified"]);
  });
});

describe("video rows", () => {
  it("one video model answered: no '1/1 models say', a single-model assessment instead", async () => {
    verRows = [];
    vidRows = [vid("v1", [vrow("gemini", "ok", "authentic"), vrow("chatgpt", "failed", "")])];
    const r = (await rows())["v1"];
    expect(r.modelIndependence).toBe("insufficient");
    // Phase 0 (L15, O14 = A): the 35933c8 DTO tally; the dashboard does not render it for this row (below).
    expect(r.agreementSummary).toBe("1/1 models say authentic");
    expect(r.singleModelAssessment).toBe("One independent model's assessment (Gemini): authentic — not agreement between models");
    expect(render(r)).not.toMatch(MULTI_MODEL);
  });

  it("two video models disagree: '(others disagree)' stays (the other model answered)", async () => {
    verRows = [];
    vidRows = [vid("v2", [vrow("gemini", "ok", "authentic"), vrow("chatgpt", "ok", "likely_manipulated")])];
    const r = (await rows())["v2"];
    expect("modelIndependence" in r).toBe(false);
    expect(r.disagreementPoints).toEqual(["Gemini rated as authentic (others disagree)", "ChatGPT rated as likely manipulated (others disagree)"]);
    expect(r.agreementSummary).toBe("1/2 models say authentic");
  });
});

describe("queueVerificationAgreementView honours modelIndependence whatever lines a row carries", () => {
  it.each(["insufficient", "unverified"] as const)("%s: no agree / disagree lines", (mi) => {
    const v = queueVerificationAgreementView({ modelIndependence: mi, agreementSummary: "1/1 models say accurate", disagreementPoints: ["X (others disagree)"], dissentSummary: "Dissent: Y", disagreements: ["Z"] });
    expect([v.agreeLines, v.disagreeLines, v.note]).toEqual([[], [], QUEUE_VERIFICATION_INDEPENDENCE_NOTE[mi]]);
  });
});

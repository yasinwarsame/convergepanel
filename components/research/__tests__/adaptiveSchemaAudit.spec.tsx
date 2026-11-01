/**
 * D-5 (shared Adaptive Schema architecture, 2026-11-02): per-schema audit of the shared report.
 *
 * For EVERY executing schema in the registry (18: 9 Milestone-2, 9 legacy-active including generic), under the
 * Production condition of Gemini failing on every call, the real chain runs:
 *   finalizeAdaptiveRun (two models answer, Gemini's slot failed)
 *     -> the envelope it persists -> JSON round trip
 *     -> buildRunReadPayload -> Personal interpreter AND Team interpreter
 *     -> PersistedResearchResultView -> ResultsDisplay -> the schema's adaptive view.
 *
 * Asserted for all 18 (Individual and Team): the run reads as ready; the adaptive view for THAT schema renders; the
 * envelope family is right; never the no-analysis fallback, never "No unified answer yet", never "incompatible format"
 * for a provider failure; the panel's content is reachable.
 * Asserted for the 9 legacy-active schemas: every responding model's own response is reachable, and the failed model
 * is disclosed as "did not respond".
 *
 * OPEN AUDIT FINDING (reported to the owner, fix NOT made in this PR, per D-5): the 9 Milestone-2 views render the
 * aggregated result only. A second model's own response is not reachable, and a model that did not respond is not
 * disclosed. Recorded as it.todo below until the owner approves the fix.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
const AUTH = { user: { uid: "owner-1" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn(async () => ({ modelId: "gemini", status: "error", rawText: "Gemini request failed. Please try again.", latencyMs: 200 })) }));
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: {} }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS, SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";
import { buildRunReadPayload } from "@/lib/runs/runReadPayload";
import { interpretPersistedRunReadPayload } from "@/lib/research/persistedRunPresentation";
import { interpretTeamRunDetailResponse } from "@/lib/research/teamRunDetailPresentation";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { seededResults } from "@/lib/adaptiveSchema/__tests__/o5p/o5pScenarios";

const WS = "aTeamWorkspaceAutoId12345";
const PROJECT = "projAutoId0001";
const RUN = "run-audit-1";
const rt = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const text = (n: unknown): string => {
  if (n == null) return "";
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map(text).join(" ");
  return ((n as { children?: unknown[] }).children ?? []).map(text).join(" ");
};

/** Every executing schema: active and not the non-executing limitation. Pinned to 18, so a new schema joins the audit. */
const EXECUTING = (Object.keys(SCHEMA_REGISTRY) as (keyof typeof SCHEMA_REGISTRY)[]).filter((id) => SCHEMA_REGISTRY[id].implementationStatus === "active" && id !== "graceful_limitation").sort();
const LEGACY = new Set<string>(PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS);
const M2 = new Set<string>(Object.keys(SCHEMA_ANSWER_SHAPE));

/** Two answering models with per-model marker text in every string field; Gemini's slot failed, as in Production. */
function panelRows(id: string): any[] {
  if (id === "forecast_speculative") {
    // The scenario-tree view needs real scenarios; the o5p seeded answers provide them. Models are identified by name.
    return seededResults("forecast_speculative", 11).slice(0, 2).map((x: any, j: number) => ({ ...x, modelId: ["chatgpt", "claude"][j], status: "ok" }));
  }
  const s = SCHEMA_REGISTRY[id as keyof typeof SCHEMA_REGISTRY];
  return ["chatgpt", "claude"].map((m) => {
    const body: Record<string, unknown> = {};
    for (const f of s.fields) body[f.key] = f.type === "string" ? `${f.key}-${m}-marker` : [];
    // A ranked list with no items has nothing to show; one real item (the validator's EnumItem shape) carries the marker.
    if (id === "ranked_enumeration") body.items = [{ id: `item-${m}`, label: `label-${m}-marker`, rank: 1, rationale: `rationale-${m}-marker` }];
    return { modelId: m, status: "ok", rawText: JSON.stringify(body), latencyMs: 1 };
  });
}
const reachable = (id: string, t: string, m: "chatgpt" | "claude") => (id === "forecast_speculative" ? t.includes(m === "chatgpt" ? "ChatGPT" : "Claude") : t.includes(`-${m}-marker`));

async function audit(id: string) {
  const s = SCHEMA_REGISTRY[id as keyof typeof SCHEMA_REGISTRY];
  const rows = [...panelRows(id), { modelId: "gemini", status: "error", rawText: "Gemini request failed. Please try again.", latencyMs: 200 }];
  const res: any = await finalizeAdaptiveRun(s, rows as never, "Audit question?", undefined, { queryType: id, answerShape: s.renderHint, confidence: 0.9, domain: "d" } as never);
  const perModel = rows.map((r) => ({ modelId: r.modelId, status: r.status, rawTextTruncated: r.rawText, tokenUsage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 }, latencyMs: 1, wasTruncated: false }));
  const doc = rt({ userId: "owner-1", workspaceId: WS, projectId: PROJECT, question: "Audit question?", status: "complete", runDocument: { perModel }, adaptiveOutput: res.persistedOutput, legacyAdaptiveOutput: res.persistedLegacyOutput });
  const render = async (presentation: any, extra: Record<string, unknown> = {}) => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(createElement(PersistedResearchResultView, { presentation, ...extra }));
    });
    return r;
  };
  const personalPayload = rt(await buildRunReadPayload({ mayReadDecisionContent: true, runId: RUN, data: doc, viewerRole: "owner", resolveReviewRouting: jest.fn().mockResolvedValue("not_configured") }));
  const personal = interpretPersistedRunReadPayload(personalPayload, RUN);
  const teamPayload = rt(await buildRunReadPayload({ mayReadDecisionContent: true, runId: RUN, data: doc, viewerRole: "team_member", resolveReviewRouting: jest.fn().mockResolvedValue("not_configured") }));
  const team = interpretTeamRunDetailResponse({ ...teamPayload, team: { workspaceId: WS, projectId: PROJECT, project: null, assignee: null, createdAt: null, completedAt: null, origin: null, review: null } }, { workspaceId: WS, runId: RUN, projectId: PROJECT });
  if (personal.kind !== "ready" || team.kind !== "ready") throw new Error(`${id}: not ready (${personal.kind}/${team.kind})`);
  const pr = await render(personal.presentation);
  const tr = await render(team.presentation, { adaptiveAncillaryPresentation: { mode: "delegated_read_only" } });
  return { res, personal, team, views: { individual: pr, team: tr } };
}

beforeEach(() => {
  mockedAuthedFetch.mockReset();
  mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it("audits every executing schema: 18, split 9 Milestone-2 / 9 legacy-active (generic included)", () => {
  expect(EXECUTING).toHaveLength(18);
  expect(EXECUTING.filter((id) => M2.has(id))).toHaveLength(9);
  expect(EXECUTING.filter((id) => LEGACY.has(id))).toHaveLength(9);
  expect(LEGACY.has("generic")).toBe(true);
});

describe.each(EXECUTING)("%s", (id) => {
  it("persists its envelope, and both Individual and Team render the same adaptive schema view: never empty, never mislabelled", async () => {
    const { res, personal, team, views } = await audit(id);
    // Persistence: the right family, holding the schema id.
    if (M2.has(id)) expect(res.persistedOutput?.schemaId).toBe(id);
    else expect(res.persistedLegacyOutput?.schemaId).toBe(id);
    for (const [surface, interp] of [["individual", personal], ["team", team]] as const) {
      if (interp.kind !== "ready") throw new Error("unreachable");
      expect([surface, interp.presentation.adaptive?.schemaId]).toEqual([surface, id]);
    }
    for (const [surface, r] of Object.entries(views)) {
      const adaptive = r.root.findAllByType(AdaptivePanelResponse as never);
      expect([surface, adaptive.length]).toEqual([surface, 1]);
      expect([surface, (adaptive[0].props as { schema: { id: string } }).schema.id]).toEqual([surface, id]);
      const t = text(r.toJSON());
      expect([surface, t.includes("models returned a response")]).toEqual([surface, false]); // not the no-analysis fallback
      expect([surface, /No unified answer yet/.test(t)]).toEqual([surface, false]);
      expect([surface, /incompatible format/.test(t)]).toEqual([surface, false]); // Gemini's failure is not a format problem
      expect([surface, reachable(id, t, "chatgpt") || reachable(id, t, "claude")]).toEqual([surface, true]);
    }
    // Opening a saved report makes no model call and no write.
    for (const [url, init] of mockedAuthedFetch.mock.calls as [string, { method?: string } | undefined][]) {
      expect([url, init?.method ?? "GET"]).not.toEqual([url, "POST"]);
    }
  });

  if (LEGACY.has(id)) {
    it("legacy-active: every responding model's own response is reachable, and the failed model is disclosed as not having responded", async () => {
      const { views } = await audit(id);
      for (const [surface, r] of Object.entries(views)) {
        const t = text(r.toJSON());
        expect([surface, reachable(id, t, "chatgpt"), reachable(id, t, "claude")]).toEqual([surface, true, true]);
        expect([surface, t.includes("did not respond")]).toEqual([surface, true]);
      }
    });
  } else {
    it.todo(`OPEN FINDING (owner approval pending): ${id} should make each responding model's own response reachable`);
    it.todo(`OPEN FINDING (owner approval pending): ${id} should disclose a model that did not respond`);
  }
});

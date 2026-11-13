/**
 * Phase 0 compatibility restoration — U-1 (inventory v3.4 H-21 / H-15; app/page.tsx L03 sites 3–4 and the L04 client
 * caller; owner Option C, 2026-11-08).
 *
 * MOUNTS the real app/page.tsx (Home) and drives its real saved-run path: a verification deep link
 * (`?openVerification=`) → "View source research" → loadResearchRunIntoState (`/api/user/runs/{id}`) → the client
 * consensus engine (synthesizeReport, the L04 client caller) → the history auto-synthesis condition (site 4) →
 * generateSynthesisAutomatically's pre-flight (site 3) and its POST /api/synthesize-panel → the real ResultsDisplay /
 * PanelSynthesisView with the returned synthesis → the client verification gate (VerificationGateCard `gate.status`).
 *
 * For every executing pattern (all DeepSeek, provider-less substitutes, partly DeepSeek, independent, one usable slot,
 * one slot with empty text) the DECISION record — synthesis POST count and body (model ids, cluster model ids), the
 * client report's consensus decisions (null-ness, cluster model ids, trust summary), the pre-flight refusal text, and
 * the gate status — must equal 35933c8.
 *
 * Oracle (fixtures/phase0ClientGateCallers.golden.json): THIS file run unchanged in git-archive exports of 35933c8
 * (`base`) and b894828 (`subject`, kept for the record) with PHASE0_GOLDEN_OUT set — never computed from the code under
 * test. Only external boundaries are doubled (auth, plan, Firestore profile read, authedFetch / fetch, router, a few
 * leaf components that are not on this path).
 */
const navigation = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn(), refresh: jest.fn() };
jest.mock("next/navigation", () => ({ useRouter: () => navigation, usePathname: () => "/", useSearchParams: () => new URLSearchParams("") }));
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => require("react").createElement("a", { href }, children as never) }));
jest.mock("next/image", () => ({ __esModule: true, default: () => null }));
// next/dynamic → the real module, synchronously (the loader names it).
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => unknown) => {
    const m = String(loader).match(/require\(["']([^"']+)["']\)/) ?? String(loader).match(/import\(["']([^"']+)["']\)/);
    if (!m) throw new Error(`next/dynamic double: cannot resolve ${String(loader)}`);
    const mod = require(m[1]);
    return mod.default ?? mod;
  },
}));
const mockUser = { uid: "uid-1", email: "u@test.com", emailVerified: true, getIdToken: async () => "tok" };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: mockUser, loading: false, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({
  useUserPlan: () => ({ plan: "full", runsThisMonth: 0, monthlyLimit: 150, videoLimit: 10, videoRunsThisMonth: 0, refresh: async () => {}, loading: false, error: null }),
}));
jest.mock("firebase/firestore", () => ({ doc: () => ({}), getDoc: async () => ({ exists: () => true, data: () => ({ onboardingCompleted: true }) }) }));
jest.mock("@/lib/firebase/client", () => ({ db: {}, auth: {} }));
jest.mock("@/lib/analytics", () => ({ trackEvent: () => {} }));
jest.mock("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
for (const leaf of ["LandingPage", "ClaimVerificationResult", "VideoUploader", "VideoVerificationResult", "FileAttachButton", "EmailVerificationNotice"]) {
  jest.doMock(`@/components/${leaf}`, () => ({ __esModule: true, default: () => null }));
}
/** ModelPicker double: exposes the page's own selection callback (the live path selects the scenario's slots). */
const mockPicker: { onSelectionChange?: (m: string[]) => void } = {};
jest.doMock("@/components/ModelPicker", () => ({
  __esModule: true,
  default: (props: { onSelectionChange: (m: string[]) => void }) => {
    mockPicker.onSelectionChange = props.onSelectionChange;
    return null;
  },
}));
const authedCalls: string[] = [];
let runResponse: Record<string, unknown> = {};
let livePanelResponse: Record<string, unknown> = {};
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: async (url: string) => {
    authedCalls.push(String(url));
    const json = (body: unknown, ok = true) => ({
      ok,
      status: ok ? 200 : 404,
      statusText: ok ? "OK" : "Not Found",
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (String(url) === "/api/run-panel") return json(livePanelResponse);
    if (String(url).startsWith("/api/user/verifications/v-1")) {
      return json({
        ok: true,
        payload: { verificationId: "v-1", claim: "Paris is the capital of France.", verdict: "accurate", modelResults: [], sourceResearch: { runId: "run-x", claimId: "c1" } },
      });
    }
    if (String(url).startsWith("/api/user/runs/run-x")) return json(runResponse);
    return json({ ok: false }, false);
  },
  prepareAuthedHeaders: async (_u: unknown, h: Record<string, string>) => h,
}));

process.env.TZ = "UTC";
const store: Record<string, string> = {};
(globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v), removeItem: (k: string) => void delete store[k] };
(globalThis as any).window = {
  location: { search: "", pathname: "/", href: "http://localhost/" },
  scrollY: 0,
  addEventListener: () => {},
  removeEventListener: () => {},
  scrollTo: () => {},
  requestIdleCallback: (cb: () => void) => setTimeout(cb, 0),
  localStorage: (globalThis as any).localStorage,
};
(globalThis as any).document = { getElementById: () => null, body: { scrollHeight: 0 } };

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { ModelResult } from "@/lib/types";

const GOLDEN = join(__dirname, "fixtures", "phase0ClientGateCallers.golden.json");
const TEXTS = [
  "Paris is the capital of France. The city sits on the Seine river. It has been the seat of government for centuries.",
  "Paris is the capital of France. The city sits on the Seine river. It is the most populous city in the country.",
  "Lyon is the capital of France. The city sits on the Rhone river. It has been the seat of government for centuries.",
];
const ok = (i: number, id: string, provider: string) => ({ modelId: id, status: "ok", rawText: TEXTS[i], provider, latencyMs: 1 });
const sub = (i: number, id: string, provider?: string) => ({ modelId: id, status: "substituted", rawText: TEXTS[i], ...(provider ? { provider } : {}), substitutedFrom: id, latencyMs: 1 });
const ROWS: Record<string, unknown[]> = {
  FC2: [sub(0, "chatgpt", "deepseek"), sub(1, "claude", "deepseek")],
  FC2_NOPROV: [sub(0, "chatgpt"), sub(1, "claude")],
  PC3: [sub(0, "chatgpt", "deepseek"), sub(1, "claude", "deepseek"), ok(2, "grok", "xai")],
  IND2: [ok(0, "chatgpt", "openai"), ok(1, "claude", "anthropic")],
  ONE: [ok(0, "chatgpt", "openai"), { modelId: "claude", status: "failed", rawText: "", latencyMs: 1 }],
  EMPTY_TEXT: [ok(0, "chatgpt", "openai"), { ...ok(1, "claude", "anthropic"), rawText: "   " }],
  // live-run shapes: the live trigger counts status "ok" rows, so substitutes reach the L04 caller only beside 2 ok rows
  MIX4: [ok(0, "chatgpt", "openai"), ok(1, "claude", "anthropic"), sub(2, "grok", "deepseek"), sub(0, "gemini", "deepseek")],
  MIX3_NOPROV: [ok(0, "chatgpt", "openai"), ok(1, "claude", "anthropic"), sub(2, "grok")],
};
/** `history:` = saved-run path (sites 3–4 + L04 via loadResearchRunIntoState); `live:` = a panel run (L04 + site 3 + gate). */
const SCENARIOS = [
  ...["FC2", "FC2_NOPROV", "PC3", "IND2", "ONE", "EMPTY_TEXT"].map((n) => `history:${n}`),
  ...["IND2", "MIX4", "MIX3_NOPROV", "PC3", "FC2"].map((n) => `live:${n}`),
];
const SYNTHESIS = {
  executiveSummary: "Paris is the capital.",
  keyFindings: [{ claim: "Paris is the capital of France.", confidence: "High", evidenceRefs: ["r1"], modelsSupporting: ["chatgpt", "claude"] }],
  disagreements: [{ topic: "Population figure", whyTheyDiffer: "Different census years", positionsByModel: { chatgpt: "2.1m", claude: "2.2m" } }],
  biasAndBlindSpots: [],
  openQuestions: [],
  methodology: "Cross-model comparison.",
};

const posts: Array<{ url: string; body: any }> = [];
(globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  if (init?.method === "POST") {
    posts.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, report: SYNTHESIS, consensusSummary: { modelsHealthy: 2, modelCount: 2, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 0, overallConsensusScore: 88, aggregateSupportRatio: 1 } }),
    };
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) };
};

const nameOf = (n: TestRenderer.ReactTestInstance) => (typeof n.type === "string" ? n.type : (n.type as any)?.displayName ?? (n.type as any)?.name ?? "");
const nodeText = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(nodeText).join(""));
async function settle(r?: TestRenderer.ReactTestRenderer) {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
  }
  return r;
}

async function runScenario(name: string) {
  posts.length = 0;
  authedCalls.length = 0;
  const [mode, rowsKey] = name.split(":");
  const results = ROWS[rowsKey] as ModelResult[];
  (globalThis as any).window.location.search = mode === "history" ? "?openVerification=v-1" : "";
  livePanelResponse = { ok: true, runId: "run-live", results, governanceStatus: "approved" };
  runResponse = { ok: true, runId: "run-x", question: "What is the capital of France?", selectedModels: results.map((r) => r.modelId), results, adaptive: { status: "absent", output: null }, legacyAdaptive: { status: "absent", output: null }, synthesisCache: null };
  const consensus = require("@/lib/consensus");
  const realSynthesize = consensus.synthesizeReport;
  const reports: unknown[] = [];
  const spy = jest.spyOn(consensus, "synthesizeReport").mockImplementation((...a: unknown[]) => {
    const out = realSynthesize(...a);
    reports.push(out);
    return out;
  });
  const Home = require("@/app/page").default;
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(Home));
  });
  await settle(r);
  if (mode === "history") {
    const viewSource = r.root.findAll((n) => n.type === "button" && nodeText(n).includes("View source research"));
    if (viewSource.length !== 1) throw new Error(`${name}: "View source research" not rendered (${viewSource.length})`);
    await act(async () => {
      viewSource[0].props.onClick();
    });
    await settle(r);
  } else {
    const textarea = r.root.find((n) => n.type === "textarea" && n.props.id === "question");
    await act(async () => {
      textarea.props.onChange({ target: { value: "What is the capital of France?" } });
      mockPicker.onSelectionChange!(results.map((x) => x.modelId));
    });
    await settle(r);
    const run = r.root.findAll((n) => n.type === "button" && /Run panel/.test(nodeText(n)));
    if (run.length < 1) throw new Error(`${name}: Run panel button not rendered`);
    await act(async () => {
      run[0].props.onClick();
    });
    await settle(r);
    // The results view's own "Synthesis" mode mounts PanelSynthesisView (the client gate caller).
    const synthesisMode = r.root.findAll((n) => n.type === "button" && nodeText(n).trim() === "Synthesis");
    if (synthesisMode.length > 0) {
      await act(async () => {
        synthesisMode[0].props.onClick();
      });
      await settle(r);
    }
  }
  const gates = r.root.findAll((x) => nameOf(x) === "VerificationGateCard");
  const rd = r.root.findAll((x) => nameOf(x) === "ResultsDisplay");
  const report = reports.length ? (reports[reports.length - 1] as any) : undefined;
  const record = {
    runRead: authedCalls.filter((u) => u.startsWith(mode === "history" ? "/api/user/runs/" : "/api/run-panel")).length,
    resultsDisplayMounted: rd.length > 0,
    clientReport:
      report === undefined
        ? "not-called"
        : report === null
          ? null
          : {
              clusters: (report.consensusAnalysis?.agreementClusters ?? []).map((c: any) => [...(c.modelIds ?? [])].sort()),
              trustSummary: report.consensusAnalysis?.trustSummary ?? null,
            },
    synthesisPosts: posts.map((p) => ({
      url: p.url,
      resultModelIds: (p.body.results ?? []).map((x: any) => x.modelId),
      agreementClusterModelIds: (p.body.agreementClusters ?? []).map((c: any) => [...(c.modelIds ?? [])].sort()),
    })),
    preflightRefusal: /Synthesis requires[^.]*\./.exec(nodeText(r.root))?.[0] ?? null,
    gateStatus: gates[0]?.props?.gate?.status ?? null,
  };
  spy.mockRestore();
  await act(async () => r.unmount());
  return record;
}

describe("U-1: app/page.tsx client gate callers (mounted) — decisions equal 35933c8", () => {
  const out: Record<string, unknown> = {};
  beforeAll(async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    for (const name of SCENARIOS) out[name] = await runScenario(name);
  }, 120000);

  it("every scenario's decision record equals the 35933c8 record", () => {
    if (process.env.PHASE0_GOLDEN_OUT) {
      writeFileSync(process.env.PHASE0_GOLDEN_OUT, JSON.stringify(out, null, 1));
      return;
    }
    expect(existsSync(GOLDEN)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(Object.keys(golden.base).sort()).toEqual([...SCENARIOS].sort());
    for (const name of SCENARIOS) expect([name, out[name]]).toEqual([name, golden.base[name]]);
  });

  it("the path really ran: the saved run was read, the gate was computed where a synthesis was returned", () => {
    if (process.env.PHASE0_GOLDEN_OUT) return;
    for (const name of SCENARIOS) expect([name, (out[name] as any).runRead]).toEqual([name, 1]);
    // Saved runs: two answered slots (whoever executed them) start the auto-synthesis (35933c8 slot rule, site 4) and
    // pass the pre-flight (site 3); one usable slot does not.
    for (const name of ["history:FC2", "history:FC2_NOPROV", "history:PC3", "history:IND2"]) {
      expect([name, (out[name] as any).synthesisPosts.length, (out[name] as any).preflightRefusal]).toEqual([name, 1, null]);
    }
    expect((out["history:ONE"] as any).synthesisPosts).toEqual([]);
    // Live runs with >= 2 "ok" rows reach the real client gate.
    for (const name of ["live:IND2", "live:MIX4", "live:MIX3_NOPROV"]) {
      expect([name, (out[name] as any).resultsDisplayMounted, typeof (out[name] as any).gateStatus]).toEqual([name, true, "string"]);
    }
  });
});

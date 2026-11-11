/**
 * Order 30 / Order K Google hotfix: gemini-2.5-flash auto-routes to
 * gemini-3.5-flash-lite from 2026-12-01 (aistudio.google.com/docs/deprecations),
 * and the panel used to RECORD the shut-down gemini-2.0-flash.
 *
 * Pins:
 *  1. Every Gemini call site sends GEMINI_MODEL_ID (research/claim connector,
 *     every adaptive stage through callGemini, video vision).
 *  2. The panel's recorded requestedModel for the gemini slot is exactly the
 *     model the SDK was asked for.
 *  3. The request body is the documented Gemini 3.x form: no `temperature`,
 *     no `thinkingBudget`; `thinkingConfig.thinkingLevel` is always sent and is
 *     GEMINI_THINKING_LEVEL ("LOW", owner direction, Order 31) unless overridden.
 *  4. No customer-facing Gemini label names 2.0 / 2.5 / "3 Pro".
 *
 * No network: the Google SDK and `fetch` are doubles.
 */
import fs from "fs";
import path from "path";

const mockGetGenerativeModel = jest.fn();
const mockGenerateContent = jest.fn();
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: (args: unknown) => {
      mockGetGenerativeModel(args);
      return { generateContent: (...a: unknown[]) => mockGenerateContent(...a) };
    },
  })),
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/env", () => ({
  ...jest.requireActual("@/lib/env"),
  GEMINI_API_KEY: "test-gemini-key",
}));

import { GEMINI_MODEL_ID, GEMINI_DISPLAY_NAME, GEMINI_THINKING_LEVEL } from "@/lib/models/gemini";
import { callGemini } from "@/lib/connectors/gemini";
import type { GeminiDiagnosticOperation } from "@/lib/connectors/types";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** Source with block and line comments removed, so prose about old models does not count as a call. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const LONG_ANSWER = "A sufficiently long answer from the model so the panel short-response check does not flag it as suspicious. ".repeat(3);

function okSdkResponse(text = LONG_ANSWER) {
  return {
    response: {
      text: () => text,
      candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
    },
  };
}

let savedEnvKey: string | undefined;
beforeEach(() => {
  mockGetGenerativeModel.mockReset();
  mockGenerateContent.mockReset();
  mockGenerateContent.mockResolvedValue(okSdkResponse());
  savedEnvKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});
afterEach(() => {
  if (savedEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedEnvKey;
});

describe("the constant", () => {
  it("is the documented auto-route target and its label names it", () => {
    expect(GEMINI_MODEL_ID).toBe("gemini-3.5-flash-lite");
    expect(GEMINI_DISPLAY_NAME).toBe("Gemini 3.5 Flash-Lite");
  });

  it("the thinking level every call sends is LOW (owner direction), not the model default", () => {
    expect(GEMINI_THINKING_LEVEL).toBe("LOW");
  });
});

describe("callGemini sends GEMINI_MODEL_ID with a Gemini 3.x request body", () => {
  const OPS: (GeminiDiagnosticOperation | undefined)[] = [
    undefined, "panel", "classification", "claim_cluster", "stance_backfill", "bias_detection", "coverage_audit", "synthesis_narrative",
  ];

  it.each(OPS.map((op) => [op ?? "(none: research/claim panel call)", op]))("operation %s -> model is GEMINI_MODEL_ID", async (_label, op) => {
    const r = await callGemini("Q", null, "k", op ? { diagnosticOperation: op as GeminiDiagnosticOperation, maxOutputTokens: 900 } : undefined);
    expect(r.status).toBe("ok");
    expect(mockGetGenerativeModel).toHaveBeenCalledTimes(1);
    expect(mockGetGenerativeModel.mock.calls[0][0]).toMatchObject({ model: "gemini-3.5-flash-lite" });
  });

  it("default body: maxOutputTokens + thinkingConfig LOW — no temperature, no thinkingBudget", async () => {
    await callGemini("Q", null, "k", { maxOutputTokens: 1234 });
    const req = mockGenerateContent.mock.calls[0][0];
    expect(req.generationConfig).toEqual({ maxOutputTokens: 1234, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(JSON.stringify(req)).not.toMatch(/temperature|thinkingBudget|thinking_budget|topP|topK/);
  });

  it("the research/claim panel call (no opts at all) also sends thinkingConfig LOW", async () => {
    await callGemini("Q", null, "k");
    const req = mockGenerateContent.mock.calls[0][0];
    expect(req.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
  });

  it("an explicit per-call thinkingLevel overrides the default, in the documented 3.x placement", async () => {
    await callGemini("Q", null, "k", { maxOutputTokens: 1024, thinkingLevel: "MINIMAL" });
    const req = mockGenerateContent.mock.calls[0][0];
    expect(req.generationConfig).toEqual({ maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "MINIMAL" } });
  });

  it("the model in the failure diagnostic is the model called", async () => {
    const e: any = new Error("[GoogleGenerativeAI Error]: [404 Not Found]");
    e.status = 404;
    mockGenerateContent.mockRejectedValue(e);
    const { logger } = jest.requireMock("@/lib/logger");
    (logger.warn as jest.Mock).mockClear();
    await callGemini("Q", null, "k", { diagnosticOperation: "classification" });
    const logged = (logger.warn as jest.Mock).mock.calls.map((c) => c[1]).filter(Boolean);
    expect(logged.length).toBeGreaterThan(0);
    for (const payload of logged) expect(payload).toMatchObject({ model: "gemini-3.5-flash-lite" });
  });
});

describe("adaptive stages reach Gemini only through callGemini (so they send GEMINI_MODEL_ID)", () => {
  const STAGES: [string, number][] = [
    ["lib/adaptiveSchema/classifier.ts", 1],
    ["lib/adaptiveSchema/biasDetection.ts", 1],
    ["lib/adaptiveSchema/coverageAudit.ts", 1],
    ["lib/adaptiveSchema/alignment.ts", 2],
    ["lib/adaptiveSchema/synthesisReport.ts", 1],
  ];
  it.each(STAGES)("%s calls callGemini %d time(s) and names no Gemini model itself", (file, n) => {
    const src = code(file);
    expect(src).toMatch(/import \{ callGemini \} from "@\/lib\/connectors\/gemini";/);
    expect((src.match(/callGemini\(/g) ?? []).length).toBe(n);
    expect(src).not.toMatch(/["'`/]gemini-\d/);
    expect(src).not.toMatch(/thinkingBudget\s*:/);
  });

  it("only the classifier overrides the thinking level (MINIMAL); every other stage sends the LOW default", () => {
    expect(read("lib/adaptiveSchema/classifier.ts")).toMatch(/thinkingLevel: "MINIMAL"/);
    expect((code("lib/adaptiveSchema/classifier.ts").match(/thinkingLevel\s*:/g) ?? []).length).toBe(1);
    for (const [file] of STAGES.filter(([f]) => !f.endsWith("classifier.ts"))) expect(code(file)).not.toMatch(/thinkingLevel\s*:/);
  });

  it("no non-test source outside lib/models/gemini.ts carries a Gemini model-id literal", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "__tests__" || ent.name === "node_modules") continue;
          walk(rel);
        } else if (/\.(ts|tsx)$/.test(ent.name) && !/\.spec\.|\.test\./.test(ent.name)) {
          if (rel === path.join("lib", "models", "gemini.ts")) continue;
          const src = read(rel);
          if (/["'`/]gemini-\d/.test(src)) offenders.push(rel);
        }
      }
    };
    ["lib", "app", "components", "hooks"].forEach(walk);
    expect(offenders).toEqual([]);
  });
});

describe("video vision sends GEMINI_MODEL_ID", () => {
  it("URL names the constant; body sends thinkingConfig LOW and no deprecated sampling or thinkingBudget field", async () => {
    const calls: { url: string; body: any }[] = [];
    const savedFetch = (global as any).fetch;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: { totalTokenCount: 5 } }) } as any;
    });
    try {
      const { callGeminiVision } = await import("@/lib/video/visionCalls");
      await callGeminiVision("prompt", [{ base64: "AAAA" } as any]);
    } finally {
      (global as any).fetch = savedFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url.split("?")[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(calls[0].body.generationConfig).toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(JSON.stringify(calls[0].body)).not.toMatch(/temperature|thinkingBudget|topP|topK/);
  });
});

describe("the panel records the model it called", () => {
  it("runPanel gemini slot: requestedModel === actualModel === the model the SDK was asked for", async () => {
    const { runPanel } = await import("@/lib/panel");
    const [r] = await runPanel("Q", ["gemini"], { gemini: "k" });
    expect(r.status).toBe("ok");
    const sent = mockGetGenerativeModel.mock.calls[0][0].model;
    expect(sent).toBe(GEMINI_MODEL_ID);
    expect(r.requestedModel).toBe(sent);
    expect(r.actualModel).toBe(sent);
    expect(r.provider).toBe("google");
  });

  it("a failed gemini slot still records the model it attempted, not gemini-2.0-flash", async () => {
    const e: any = new Error("[GoogleGenerativeAI Error]: [401 Unauthorized]");
    e.status = 401;
    mockGenerateContent.mockRejectedValue(e);
    const { runPanel } = await import("@/lib/panel");
    const [r] = await runPanel("Q", ["gemini"], { gemini: "k" });
    expect(r.status).not.toBe("ok");
    expect(r.requestedModel).toBe(GEMINI_MODEL_ID);
  });
});

describe("customer-facing Gemini labels name the model actually called", () => {
  const STALE = /Gemini\s+(2\.0|2\.5|3)(\s+(Pro|Flash))?\b(?!\.\d)|Gemini 3 Pro/;

  it("panel roster label, MODEL_INFO and the plan feature bullet", () => {
    const { getPanelModelConfig } = require("@/lib/panelModels");
    const { MODEL_INFO } = require("@/lib/modelInfo");
    const { PLAN_CONFIGS } = require("@/lib/plans");
    expect(getPanelModelConfig("gemini").label).toBe(GEMINI_DISPLAY_NAME);
    expect(MODEL_INFO.gemini.displayName).toBe(GEMINI_DISPLAY_NAME);
    const features: string[] = Object.values(PLAN_CONFIGS).flatMap((p: any) => p.features ?? []);
    expect(features.some((f) => f.includes(GEMINI_DISPLAY_NAME))).toBe(true);
    for (const f of features) expect(f).not.toMatch(STALE);
  });

  it("no PSEO page names a stale Gemini model", () => {
    const { PAGES } = require("@/lib/pseo/pages");
    const text = JSON.stringify(PAGES);
    expect(text).not.toMatch(STALE);
    expect(text).toContain(GEMINI_DISPLAY_NAME);
  });

  // app/page.tsx is excluded: byte-frozen by readableFrozenFiles/dsProvenanceUiBoundaries specs; its only
  // stale mention is a JSX comment that is never rendered.
  it("About, Help, landing, signup and model-picker sources name no stale Gemini model", () => {
    for (const f of ["app/about/page.tsx", "app/help/page.tsx", "components/LandingPage.tsx", "app/signup/page.tsx", "components/ModelPicker.tsx"]) {
      expect(read(f)).not.toMatch(STALE);
    }
  });

  it("the stale-label pattern itself catches each old label (the assertion can fail)", () => {
    for (const s of ["Gemini 2.0 Flash", "Gemini 2.5 Flash", "Gemini 3 Pro", "Gemini 3"]) expect(s).toMatch(STALE);
    expect(GEMINI_DISPLAY_NAME).not.toMatch(STALE);
  });
});

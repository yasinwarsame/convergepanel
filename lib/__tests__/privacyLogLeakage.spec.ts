/**
 * Privacy remediation (2026-11-17 audit, L1–L4) — runtime logs carry no claim
 * / question text and no model or provider output. Every console method is
 * spied (the shared `logger` writes through console, so this observes both
 * `logger.*` and any raw `console.*`), the REAL code path is run with
 * synthetic sentinels, and the captured log arguments are searched.
 * Controls prove the spy observes the log line in question.
 */
import type { GovernanceInput } from "@/lib/governance/evaluateGovernance";
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";

const QUESTION = "SYNTHETIC_QUESTION_SENTINEL is the moon hollow";
const MODEL_OUTPUT = "SYNTHETIC_MODEL_OUTPUT_SENTINEL the claim that the moon is hollow";
const PROVIDER_ECHO = "SYNTHETIC_PROVIDER_ECHO_SENTINEL";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: jest.fn(async () => ({ planId: "full" })) }));
jest.mock("@/lib/governance/governancePolicyStore", () => ({
  loadGovernancePolicy: jest.fn(async () => require("@/lib/governance/evaluateGovernance").getDefaultGovernancePolicy()),
}));

type Spied = jest.SpyInstance[];
let spies: Spied;
beforeEach(() => {
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => jest.restoreAllMocks());

function logged(): string {
  return JSON.stringify(
    spies.flatMap((s) => s.mock.calls).map((args) => args.map((a: unknown) => (a instanceof Error ? `${a.name}: ${a.message}` : a)))
  );
}

describe("L1 — lib/governance/evaluateAndStore.ts", () => {
  it("logs the governance evaluation with metadata only — no question text", async () => {
    db.docs.clear();
    db.writeLog = [];
    db.seed("verifications/vcl-1", { userEmail: "owner@example.test" });
    const input: GovernanceInput = {
      consensusScore: 80,
      evidenceQuality: "mixed",
      sourceBacked: false,
      missingSourcesCount: 0,
      modelHealth: { ok: 4, substituted: 0, failed: 0 },
      question: QUESTION,
      runType: "verification",
      verificationVerdict: "confirmed",
    } as GovernanceInput;
    let mod: typeof import("@/lib/governance/evaluateAndStore") | undefined;
    jest.isolateModules(() => {
      mod = require("@/lib/governance/evaluateAndStore");
    });
    await mod!.evaluateAndStoreGovernance({ runId: "vcl-1", collection: "verifications", input, ownerUid: "uid-1" });
    const out = logged();
    expect(out).not.toContain("SYNTHETIC_QUESTION_SENTINEL");
    expect(out).not.toContain("moon");
    // control: the operational line is still emitted, with the run id and length
    expect(out).toContain("Evaluating governance");
    expect(out).toContain("vcl-1");
    expect(out).toContain(`"questionLength":${QUESTION.length}`);
  });
});

describe("L2 — lib/verification/buildClaimModelEvidence.ts", () => {
  it("an unparseable model response logs lengths only — no model output", () => {
    const { buildClaimModelEvidence } = require("@/lib/verification/buildClaimModelEvidence");
    const rows = buildClaimModelEvidence([{ modelId: "chatgpt", status: "ok", rawText: `<<${MODEL_OUTPUT}>> not json at all`, latencyMs: 1 }]);
    expect(rows[0].status).toBe("parse_error");
    const out = logged();
    expect(out).not.toContain("SYNTHETIC_MODEL_OUTPUT_SENTINEL");
    expect(out).toContain("JSON parse failed even after repair"); // control
    expect(out).toContain('"rawLength"');
  });
});

describe("L3/L4 — provider error bodies (Grok, Perplexity)", () => {
  const savedFetch = global.fetch;
  afterEach(() => {
    global.fetch = savedFetch;
  });
  function respondWith(body: string, status: number) {
    global.fetch = jest.fn(async () => new Response(body, { status, headers: { "Content-Type": "application/json" } })) as any;
  }

  const echoJson = JSON.stringify({ error: { message: `${PROVIDER_ECHO} ${QUESTION}`, type: "invalid_request_error", code: "bad_request" } });

  it("Grok: a JSON error body is not logged; status/code/type are", async () => {
    respondWith(echoJson, 400);
    const { callGrok } = require("@/lib/connectors/grok");
    const r = await callGrok(QUESTION, null, "xai-synthetic-key");
    expect(r.status).not.toBe("ok");
    expect(String(r.errorMessage)).toContain(PROVIDER_ECHO); // the user-facing result still carries the provider message
    const out = logged();
    expect(out).not.toContain(PROVIDER_ECHO);
    expect(out).not.toContain("SYNTHETIC_QUESTION_SENTINEL");
    expect(out).toContain("invalid_request_error"); // control
    expect(out).toContain('"httpStatus":"400"');
  });

  it("Grok: a non-JSON error body is not logged", async () => {
    respondWith(`${PROVIDER_ECHO} plain text`, 502);
    const { callGrok } = require("@/lib/connectors/grok");
    await callGrok(QUESTION, null, "xai-synthetic-key");
    expect(logged()).not.toContain(PROVIDER_ECHO);
    expect(logged()).toContain("non-JSON");
  });

  it("Grok: an unparseable 200 body (model output) is not logged via the SyntaxError message", async () => {
    // V8's SyntaxError quotes only the first ~10 characters of the body, so the
    // sentinel must fit in that window for this assertion to be able to fail.
    respondWith("LEAK10CHRS {not json", 200);
    const { callGrok } = require("@/lib/connectors/grok");
    await callGrok(QUESTION, null, "xai-synthetic-key");
    expect(logged()).not.toContain("LEAK10CHRS");
    expect(logged()).toContain("Failed to parse JSON response");
  });

  it("Grok: a primitive JSON 200 body is not logged", async () => {
    respondWith(JSON.stringify(MODEL_OUTPUT), 200);
    const { callGrok } = require("@/lib/connectors/grok");
    await callGrok(QUESTION, null, "xai-synthetic-key");
    expect(logged()).not.toContain("SYNTHETIC_MODEL_OUTPUT_SENTINEL");
    expect(logged()).toContain("Invalid response structure");
  });

  it("Perplexity: a JSON error body is not logged; status/code/type are", async () => {
    respondWith(echoJson, 400);
    const { callPerplexity } = require("@/lib/connectors/perplexity");
    const r = await callPerplexity(QUESTION, null, "pplx-synthetic-key");
    expect(r.status).toBe("error");
    expect(String(r.errorMessage)).toContain(PROVIDER_ECHO);
    const out = logged();
    expect(out).not.toContain(PROVIDER_ECHO);
    expect(out).not.toContain("SYNTHETIC_QUESTION_SENTINEL");
    expect(out).toContain("bad_request"); // control
  });
});

/**
 * Round 2 (review M2) — model-output previews in server/client logs.
 */
describe("M2 — lib/agreementMap.ts (runs on server and client)", () => {
  it("buildAgreementMap logs counts / lengths only — no previews, no claim text", () => {
    const { buildAgreementMap } = require("@/lib/agreementMap");
    const body = (id: string) =>
      `## Summary\n${MODEL_OUTPUT} ${id}. The ${MODEL_OUTPUT} keeps going for a while so that sentences are extracted.\n\n## Key Claims\n- ${MODEL_OUTPUT} first key claim sentence here.\n- ${MODEL_OUTPUT} second key claim sentence here.\n`;
    buildAgreementMap([
      { modelId: "chatgpt", status: "ok", rawText: body("a"), latencyMs: 1 },
      { modelId: "claude", status: "ok", rawText: body("b"), latencyMs: 1 },
    ]);
    const out = logged();
    expect(out).not.toContain("SYNTHETIC_MODEL_OUTPUT_SENTINEL");
    expect(out).toContain("Claim extraction summary"); // control
    expect(out).toContain("textLengthsByModel");
  });
});

describe("M2 — lib/adaptiveSchema/validator.ts", () => {
  const { validateAdaptiveResponse } = require("@/lib/adaptiveSchema/validator");
  const { getResultSchema } = require("@/lib/adaptiveSchema/schemaRegistry");
  const schema = getResultSchema("comparison_matrix");

  it("invalid JSON: the SyntaxError excerpt of the model's text is not logged", () => {
    validateAdaptiveResponse("chatgpt", schema, "LEAKVAL123 this is not json");
    expect(logged()).not.toContain("LEAKVAL123");
    expect(logged()).toContain("Response was not valid JSON"); // control
  });

  it("schema-invalid JSON: Zod messages (which quote received values) are not logged — field names are", () => {
    const obj: Record<string, unknown> = {};
    for (const f of schema.fields) obj[f.key] = `${MODEL_OUTPUT} ${f.key}`;
    validateAdaptiveResponse("chatgpt", schema, JSON.stringify(obj));
    const out = logged();
    expect(out).not.toContain("SYNTHETIC_MODEL_OUTPUT_SENTINEL");
    expect(out).toMatch(/issueFields|schema validation/i); // control
  });
});

describe("M2 — source dispositions for provider / panel error logs", () => {
  const read = (p: string) => require("fs").readFileSync(require("path").join(__dirname, "..", "..", p), "utf8");
  it.each([
    ["lib/connectors/deepseek.ts", /msg=\$\{msg\.slice/],
    ["lib/panel.ts", /Promise rejected for model \$\{modelId\}:`, settled\.reason\)/],
    ["lib/panel.ts", /Unexpected throw from \$\{modelId\}:`, err\)/],
    ["lib/panel.ts", /\$\{dsResult\.message\}/],
    ["lib/connectors/chatgpt.ts", /ChatGPT API error:", \{\s*message: error\?\.message/],
    ["lib/connectors/claude.ts", /Claude API error:", \{\s*message: error\?\.message/],
    ["lib/connectors/gemini.ts", /\bmessage: error\?\.message,|errorMessage: (?:fetchError|error)\?\.message,/],
    ["lib/runPanelExecution.ts", /contentPreview\s*:/],
    ["app/api/synthesize-panel/route.ts", /rawPreview\s*:|parseError: parseError\?\.message|validationErrors: validationError\?\.errors/],
    ["components/PanelSynthesisView.tsx", /responsePreview\s*:|Failed to parse server response: \$\{parseError\.message\}/],
    ["components/ResultsDisplay.tsx", /Received results:", results\)/],
    ["app/page.tsx", /responseText\.substring|fullResponse: data|"Invalid response structure:", data\)|Raw results from API:", data\.results\)|Skipping malformed result:", result\)/],
  ])("%s no longer contains %s", (file, pattern) => {
    expect(read(file)).not.toMatch(pattern);
  });
});

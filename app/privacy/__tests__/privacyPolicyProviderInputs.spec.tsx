/**
 * Privacy Policy accuracy pins (R4 Track C).
 *
 * Two halves that must move together:
 *  1. CODE FACTS — which inputs each AI provider receives on the auxiliary
 *     Deep Research paths, read from the code that is live (cabbdbb). If one of
 *     these fails, the code changed and the policy text in app/privacy/page.tsx
 *     must be re-checked before this test is updated.
 *  2. POLICY TEXT — the rendered page states exactly those facts, and no more.
 *
 * Also pins the set of unresolved legal placeholders, so a placeholder cannot
 * be added, removed or silently "filled in" without updating the owner/legal
 * completion checklist (privacy audit evidence 12-…-completion-checklist.md).
 */
import fs from "fs";
import nodePath from "path";
import { renderToStaticMarkup } from "react-dom/server";

const mockCallGemini = jest.fn();
jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: (...args: unknown[]) => mockCallGemini(...args),
}));

import PrivacyPage from "@/app/privacy/page";
import { planAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { authoritativeSynthesisInputs } from "@/lib/synthesis/authoritativeRunInputs";

const ROOT = nodePath.resolve(__dirname, "../../..");
const src = (rel: string) => fs.readFileSync(nodePath.join(ROOT, rel), "utf8");

function renderedText(): string {
  const html = renderToStaticMarkup(PrivacyPage());
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("code facts: inputs sent to providers on auxiliary Deep Research paths", () => {
  // Every callGemini call site outside the connector itself, with its exact
  // first argument. The second argument (context) must be the literal `null`.
  const GEMINI_AUX_CALLERS: Record<string, string[]> = {
    "lib/adaptiveSchema/classifier.ts": ["trimmedQuery"],
    "lib/adaptiveSchema/alignment.ts": ["userMessage", "userMessage"],
    "lib/adaptiveSchema/biasDetection.ts": ['`Question: "${question}"\\n\\n${responsesBlock}`'],
    "lib/adaptiveSchema/coverageAudit.ts": ["userMessage"],
    "lib/adaptiveSchema/synthesisReport.ts": ["userMessage"],
  };

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(nodePath.join(ROOT, dir), { withFileTypes: true })) {
      const rel = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(rel, out);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
        out.push(rel);
      }
    }
    return out;
  }

  it("the only callGemini callers are the five auxiliary modules, and each passes a null context", () => {
    const callers = [...walk("lib"), ...walk("app")].filter(
      (f) => f !== "lib/connectors/gemini.ts" && src(f).includes("callGemini(")
    );
    expect(callers.sort()).toEqual(Object.keys(GEMINI_AUX_CALLERS).sort());
    for (const [file, firstArgs] of Object.entries(GEMINI_AUX_CALLERS)) {
      const text = src(file);
      expect(text.split("callGemini(").length - 1).toBe(firstArgs.length);
      for (const firstArg of firstArgs) {
        expect(text).toContain(`callGemini(${firstArg}, null, GEMINI_API_KEY`);
      }
    }
  });

  it("classification sends the question to Gemini without the separate context", async () => {
    mockCallGemini.mockReset();
    mockCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, latencyMs: 0 });
    const question = "Why did inflation persist after 2021? PRIVPOL_QUESTION_SENTINEL";
    await planAdaptiveRun(question, ["chatgpt", "claude"], "Context:\nPRIVPOL_CONTEXT_SENTINEL");
    expect(mockCallGemini).toHaveBeenCalled();
    for (const call of mockCallGemini.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("PRIVPOL_CONTEXT_SENTINEL");
      expect(call[1]).toBeNull();
    }
    expect(mockCallGemini.mock.calls.some((c) => String(c[0]).includes("PRIVPOL_QUESTION_SENTINEL"))).toBe(true);
  });

  it("synthesis receives the question together with the persisted context", () => {
    const result = authoritativeSynthesisInputs({
      question: "Q",
      questionContext: "Context:\nPRIVPOL_CONTEXT_SENTINEL",
      runDocument: {
        question: "Q",
        perModel: [
          { modelId: "chatgpt", status: "ok", rawTextTruncated: "answer one" },
          { modelId: "claude", status: "ok", rawTextTruncated: "answer two" },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.question).toContain("PRIVPOL_CONTEXT_SENTINEL");
    expect(result.value.rows.map((r) => r.text)).toEqual(["answer one", "answer two"]);
  });

  it("synthesis sends that question to OpenAI, with Anthropic as the fallback, and never to Gemini", () => {
    const route = src("app/api/synthesize-panel/route.ts");
    expect(route).toContain("const question = authoritative.value.question;");
    expect(route).toContain('import OpenAI from "openai";');
    expect(route).toContain('import Anthropic from "@anthropic-ai/sdk";');
    expect(route).toContain("callClaudeFallback(fullPrompt");
    expect((route.match(/\$\{question\.trim\(\)\}/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(route).not.toMatch(/callGemini|connectors\/gemini|GEMINI_API_KEY/);
  });

  it("the DeepSeek fallback receives the question and the context", () => {
    expect(src("lib/panel.ts")).toContain("callDeepSeek(question, modelId, dsKey, context)");
  });
});

describe("policy text states those facts", () => {
  const text = renderedText();

  it("discloses that Deep Research synthesis sends question, context and answers to OpenAI or Anthropic", () => {
    expect(text).toContain(
      "your question, any context you add and the model answers may also be sent to OpenAI (or Anthropic, as a fallback) to produce a combined summary, whether or not you selected those models"
    );
  });

  it("says Gemini auxiliary calls receive the question and answers, not the separate context", () => {
    expect(text).toContain("your question and all the model answers may also be sent to Google (Gemini API)");
    expect(text).toContain("The context you add is not sent separately in these steps, but the model answers can quote or summarize it.");
    expect(text).not.toMatch(/question and context, and all the model answers, are also sent to Google/);
  });

  it("does not present payment receipts as an email we send", () => {
    expect(text).not.toContain("invitations and payment receipts");
    for (const sentence of text.split(/(?<=[.!?])\s+/).filter((s) => /receipt/i.test(s))) {
      expect(sentence).toMatch(/Stripe/);
      expect(sentence).toMatch(/\bmay\b/);
    }
  });

  it("scopes administrative-deletion audit excerpts to claim and video verifications", () => {
    expect(text).toContain("When our staff delete a stored claim or video verification");
    expect(text).not.toContain("When our staff delete a stored item");
  });

  it("states the legacy team copy includes the email address", () => {
    expect(text).toContain("a copy of the content you run, together with your email address, is also kept for that team");
  });

  it("states research cannot be self-deleted either", () => {
    expect(text).toContain("does not currently let you delete your account, your research or individual verifications yourself");
  });
});

describe("unresolved legal placeholders (each maps to an OPEN owner/legal checklist item)", () => {
  it("renders exactly the known placeholders, so the page is visibly unfinished", () => {
    const found = renderedText().match(/\[[A-Z][A-Z /]*— [A-Z/ ]*VERIFY\]/g) || [];
    expect(found).toEqual([
      "[REVISION DATE — OWNER VERIFY]", // PP-02
      "[LEGAL ENTITY NAME — OWNER VERIFY]", // PP-01
      "[REGISTERED ADDRESS — OWNER VERIFY]", // PP-01
      "[TRANSFER SAFEGUARDS — OWNER/LEGAL VERIFY]", // PP-06
      "[MINIMUM AGE — OWNER/LEGAL VERIFY]", // PP-07
      "[SUPERVISORY AUTHORITY / COMPLAINT DETAILS — OWNER/LEGAL VERIFY]", // PP-09
    ]);
  });
});

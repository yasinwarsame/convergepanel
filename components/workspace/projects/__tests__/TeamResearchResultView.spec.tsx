/**
 * Team Project Research Composer, Phase 12A.3 — `TeamResearchResultView`:
 * pure/prop-driven, no hooks/effects, so `renderToStaticMarkup` exercises
 * its real render logic directly.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TeamResearchResultView from "@/components/workspace/projects/TeamResearchResultView";
import type { TeamResearchRunResult } from "@/hooks/useTeamProjectResearch";

function baseResult(overrides: Partial<TeamResearchRunResult["results"][number]> = {}): TeamResearchRunResult["results"][number] {
  return {
    modelId: "chatgpt",
    status: "ok",
    rawTextFull: "The market size is approximately $50B.",
    rawText: "The market size is approximately $50B.",
    latencyMs: 1200,
    tokenUsage: { input: 10, output: 20, total: 30 } as any,
    requestedModel: "gpt-5.2",
    provider: "openai",
    actualModel: "gpt-5.2",
    ...overrides,
  };
}

describe("TeamResearchResultView", () => {
  it("renders each model's label and text", () => {
    const html = renderToStaticMarkup(
      createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult(), baseResult({ modelId: "claude", rawTextFull: "Roughly $48B." })] } })
    );
    expect(html).toContain("GPT 5.2");
    expect(html).toContain("Claude Opus 4.5");
    expect(html).toContain("The market size is approximately $50B.");
    expect(html).toContain("Roughly $48B.");
  });

  it("a failed model result shows its error message, not empty text", () => {
    const html = renderToStaticMarkup(
      createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult({ status: "failed", error: { message: "Provider timeout" } })] } })
    );
    expect(html).toContain("Provider timeout");
    expect(html).toContain("Failed");
  });

  it("renders the GovernanceChip when governanceStatus is present", () => {
    const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult()], governanceStatus: "needs_review" } }));
    expect(html).toContain("Review");
  });

  it("renders no governance chip when governanceStatus is absent", () => {
    const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult()] } }));
    expect(html).not.toMatch(/Approved|Blocked|Review/);
  });

  describe("follow-up to PR #130 — JSON-shaped rawTextFull renders as a readable semantic report, not raw JSON", () => {
    it("un-fenced JSON object (e.g. GPT-5.2/Perplexity style) is parsed and rendered semantically, not as raw JSON in a <pre> block", () => {
      const raw = JSON.stringify({ scenarios: [{ label: "Moderate Crash", probability: 0.4 }] });
      const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult({ rawTextFull: raw })] } }));
      expect(html).not.toContain("<pre");
      expect(html).not.toContain("&quot;scenarios&quot;");
      expect(html).toContain("Scenarios");
      expect(html).toContain("Moderate Crash");
      expect(html).toContain("<li");
    });

    it("```json-fenced JSON (e.g. Claude/Grok/Gemini style) has its fence stripped and is rendered semantically", () => {
      const raw = "```json\n" + JSON.stringify({ baseRates: ["one every 5-7 years"] }) + "\n```";
      const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult({ rawTextFull: raw })] } }));
      expect(html).not.toContain("<pre");
      expect(html).not.toContain("&quot;baseRates&quot;");
      expect(html).toContain("Base rates");
      expect(html).toContain("one every 5-7 years");
      expect(html).not.toContain("```");
    });

    it("```json-fenced top-level JSON array has its fence stripped and is rendered semantically", () => {
      const raw = "```json\n" + JSON.stringify([{ label: "Option A" }, { label: "Option B" }]) + "\n```";
      const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult({ rawTextFull: raw })] } }));
      expect(html).not.toContain("<pre");
      expect(html).not.toContain("&quot;label&quot;");
      expect(html).toContain("Label");
      expect(html).toContain("Option A");
      expect(html).toContain("Option B");
      expect(html).not.toContain("```");
    });

    it("plain prose (the ordinary case) still renders in a <p>, unchanged from before this hotfix", () => {
      const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult({ rawTextFull: "The market size is approximately $50B." })] } }));
      expect(html).not.toContain("<pre");
      expect(html).toContain("The market size is approximately $50B.");
    });

    it("malformed/truncated JSON-looking text falls back to the plain <p> path, not a crash or empty render", () => {
      const raw = '{"scenarios": [{"label": "Moderate Crash", "probability": 0.4';
      const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult({ rawTextFull: raw })] } }));
      expect(html).not.toContain("<pre");
      expect(html).toContain("probability");
    });

    it("a bare JSON-parseable scalar (e.g. a quoted string) is NOT treated as structured output", () => {
      const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult({ rawTextFull: '"just a quoted sentence."' })] } }));
      expect(html).not.toContain("<pre");
      expect(html).toContain("just a quoted sentence.");
    });

    it("a failed model's JSON-shaped error path is never run through JSON formatting", () => {
      const html = renderToStaticMarkup(
        createElement(TeamResearchResultView, {
          run: { runId: "run-1", results: [baseResult({ status: "failed", rawTextFull: '{"ignored": true}', error: { message: "Provider timeout" } })] },
        })
      );
      expect(html).not.toContain("<pre");
      expect(html).toContain("Provider timeout");
    });

    it("a mixed panel — one structured-JSON model, one plain-prose model, one failed model — renders all three correctly and independently", () => {
      const html = renderToStaticMarkup(
        createElement(TeamResearchResultView, {
          run: {
            runId: "run-1",
            results: [
              baseResult({ modelId: "chatgpt", rawTextFull: JSON.stringify({ directAnswer: "Yes, demand is the primary driver.", keyRisks: ["Supply shock", "Policy error"] }) }),
              baseResult({ modelId: "claude", rawTextFull: "In plain prose: demand-side pressure looks dominant here." }),
              baseResult({ modelId: "gemini", status: "failed", rawTextFull: '{"ignored": true}', error: { message: "Provider timeout" } }),
            ],
          },
        })
      );
      // Structured model: humanized labels, no raw JSON syntax.
      expect(html).toContain("Direct answer");
      expect(html).toContain("Yes, demand is the primary driver.");
      expect(html).toContain("Key risks");
      expect(html).toContain("Supply shock");
      expect(html).not.toContain("&quot;directAnswer&quot;");
      // Prose model: unchanged plain-text rendering.
      expect(html).toContain("In plain prose: demand-side pressure looks dominant here.");
      // Failed model: error message, never JSON-formatted.
      expect(html).toContain("Provider timeout");
      expect(html).not.toContain("&quot;ignored&quot;");
    });
  });
});

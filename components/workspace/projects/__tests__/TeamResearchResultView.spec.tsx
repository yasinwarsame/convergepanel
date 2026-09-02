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

  describe("production hotfix — JSON-shaped rawTextFull is pretty-printed, not dumped raw", () => {
    it("un-fenced JSON object (e.g. GPT-5.2/Perplexity style) is parsed and pretty-printed in a <pre> block", () => {
      const raw = JSON.stringify({ scenarios: [{ label: "Moderate Crash", probability: 0.4 }] });
      const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult({ rawTextFull: raw })] } }));
      expect(html).toContain("<pre");
      expect(html).toContain("&quot;scenarios&quot;");
      expect(html).toContain("&quot;label&quot;: &quot;Moderate Crash&quot;");
      // Pretty-printed (2-space indent), not the original single-line JSON.stringify output.
      expect(html).not.toContain(raw.replace(/"/g, "&quot;"));
    });

    it("```json-fenced JSON (e.g. Claude/Grok/Gemini style) has its fence stripped and is pretty-printed", () => {
      const raw = "```json\n" + JSON.stringify({ baseRates: ["one every 5-7 years"] }) + "\n```";
      const html = renderToStaticMarkup(createElement(TeamResearchResultView, { run: { runId: "run-1", results: [baseResult({ rawTextFull: raw })] } }));
      expect(html).toContain("<pre");
      expect(html).toContain("&quot;baseRates&quot;");
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
  });
});

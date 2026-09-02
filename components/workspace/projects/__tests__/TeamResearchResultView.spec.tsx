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
});

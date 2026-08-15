/**
 * Phase 5D — WorkspaceRunCard + its pure `workspaceRunStatusLine()` status
 * composition. Renders via `renderToStaticMarkup` (no jsdom), matching this
 * repo's established convention.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceRunCard, workspaceRunStatusLine } from "@/components/workspace/WorkspaceRunCard";
import type { WorkspaceRunSummary } from "@/hooks/useWorkspaceRuns";

const BASE_ITEM: WorkspaceRunSummary = {
  id: "run-abc",
  at: "2026-08-15T12:34:00.000Z",
  question: "How do economists explain the persistence of inflation after 2021?",
  selectedModels: ["chatgpt", "claude"],
};

function render(item: WorkspaceRunSummary): string {
  return renderToStaticMarkup(createElement("ul", null, createElement(WorkspaceRunCard, { item })));
}

describe("workspaceRunStatusLine (pure)", () => {
  it("modelsOk/modelsTotal present, status complete -> '{ok}/{total} model responses', no status suffix", () => {
    expect(workspaceRunStatusLine({ status: "complete", modelsOk: 2, modelsTotal: 2, synthesisConsensusScore: undefined })).toBe(
      "2/2 model responses"
    );
  });

  it("modelsOk/modelsTotal present, non-complete status -> status suffix appended", () => {
    expect(workspaceRunStatusLine({ status: "partial", modelsOk: 1, modelsTotal: 2, synthesisConsensusScore: undefined })).toBe(
      "1/2 model responses · partial"
    );
  });

  it("no model counts, status error -> 'Run ended with an error'", () => {
    expect(workspaceRunStatusLine({ status: "error", modelsOk: undefined, modelsTotal: undefined, synthesisConsensusScore: undefined })).toBe(
      "Run ended with an error"
    );
  });

  it("no model counts, no error -> 'Research panel' fallback", () => {
    expect(workspaceRunStatusLine({ status: undefined, modelsOk: undefined, modelsTotal: undefined, synthesisConsensusScore: undefined })).toBe(
      "Research panel"
    );
  });

  it("synthesis score present -> '· Synthesis {score}/100' suffix, appended after any status suffix", () => {
    expect(workspaceRunStatusLine({ status: "complete", modelsOk: 2, modelsTotal: 2, synthesisConsensusScore: 84 })).toBe(
      "2/2 model responses · Synthesis 84/100"
    );
  });

  it("synthesis score absent -> no synthesis suffix at all", () => {
    expect(workspaceRunStatusLine({ status: "complete", modelsOk: 2, modelsTotal: 2, synthesisConsensusScore: undefined })).not.toMatch(/Synthesis/);
  });
});

describe("WorkspaceRunCard", () => {
  it("renders the question as the title", () => {
    const html = render(BASE_ITEM);
    expect(html).toContain("How do economists explain the persistence of inflation after 2021?");
  });

  it("renders the date via toLocaleString, matching History's exact date treatment", () => {
    const html = render(BASE_ITEM);
    expect(html).toContain(new Date(BASE_ITEM.at).toLocaleString());
  });

  it("links to the existing production-proven deep link, run id percent-encoded", () => {
    const html = render({ ...BASE_ITEM, id: "run with spaces & stuff" });
    expect(html).toContain(`href="/?openResearchRun=${encodeURIComponent("run with spaces & stuff")}"`);
  });

  it("the whole row is a single link — no nested buttons, no duplicate 'Open' affordance", () => {
    const html = render(BASE_ITEM);
    const anchorCount = (html.match(/<a /g) || []).length;
    const buttonCount = (html.match(/<button/g) || []).length;
    expect(anchorCount).toBe(1);
    expect(buttonCount).toBe(0);
  });

  it("renders the governance chip when governanceStatus is present", () => {
    const html = render({ ...BASE_ITEM, governanceStatus: "approved" });
    expect(html).toContain("Approved");
  });

  it("renders no governance chip when governanceStatus is absent", () => {
    const html = render(BASE_ITEM);
    expect(html).not.toContain("Governance:");
  });

  it("never renders adaptiveSchemaId or the raw internal status value as visible text beyond the composed status line", () => {
    const html = render({ ...BASE_ITEM, adaptiveSchemaId: "factual_lookup" as WorkspaceRunSummary["adaptiveSchemaId"], hasAdaptiveOutput: true });
    expect(html).not.toContain("factual_lookup");
  });

  it("never renders workspaceId/userId/ownerUserId — the DTO never carries them, and the card never invents them", () => {
    const html = render(BASE_ITEM);
    expect(html.toLowerCase()).not.toMatch(/workspaceid|ownerid|userid/);
  });
});

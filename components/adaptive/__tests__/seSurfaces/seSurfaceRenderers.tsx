/**
 * Order 6 / S-E.1 — renders every Decision Support surface the wording corrections reach (test-only).
 *
 * The importing spec must mock `@/components/AuthProvider`, `@/lib/client/authedFetch`, `next/navigation` and
 * `next/link` before this module loads (jest.mock is hoisted), and pass its `authedFetch` mock in. Only top-level
 * components that exist at the S-E.1 base (f207e1a) are rendered, so this module also drives the non-DS baseline
 * capture from unmodified main.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import AdaptiveReviewListItem from "@/components/teamGovernance/AdaptiveReviewListItem";
import AdaptiveReviewDetail from "@/components/teamGovernance/AdaptiveReviewDetail";
import PersonalReviewDetail from "@/components/personalReview/PersonalReviewDetail";
import TeamResearchReviewSummary from "@/components/workspace/projects/TeamResearchReviewSummary";
import { teamResearchAncillaryPresentation } from "@/components/workspace/projects/TeamResearchDetailShell";
import { dsPageElement, receiptFor, renderStatic, surfaceFromTree, type DsFixture, type Surface } from "./seSurfaceHarness";

type FetchMock = jest.Mock;

export function teamReview(fixture: DsFixture) {
  const r = receiptFor(fixture);
  return {
    humanReviewStatus: "pending",
    conditions: [],
    decidedVia: null,
    decisionReceipt: { conclusion: r.conclusion, sourceBacked: r.sourceBacked, humanReviewNeeded: r.humanReviewNeeded },
  };
}

export function listItem(fixture: DsFixture, schemaId: string) {
  return {
    kind: "adaptive",
    teamRunId: "team-1:run-1",
    runId: "run-1",
    schemaId,
    answerShape: schemaId === "decision_support" ? "decision_support_view" : "deep_research_view",
    receiptConclusion: receiptFor(fixture).conclusion,
    sourceBacked: fixture.result.sourceBacked,
    humanReviewNeeded: fixture.result.humanReviewNeeded,
    automatedGovernanceStatus: "passed",
    humanReviewStatus: "unreviewed",
    reviewable: true,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    singleReviewer: null,
    assignment: null,
    panel: null,
  } as never;
}

function respond(routes: Record<string, unknown>) {
  return async (url: string) => {
    const path = String(url).split("?")[0];
    if (path in routes) return { ok: true, status: 200, json: async () => routes[path] };
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };
}

export async function renderWithEffects(id: string, element: ReturnType<typeof createElement>): Promise<Surface> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  for (let i = 0; i < 4; i += 1) await act(async () => {});
  const surface = surfaceFromTree(id, renderer.toJSON() as never);
  act(() => renderer.unmount());
  return surface;
}

export async function personalReviewSurface(id: string, fixture: DsFixture, schemaId: string, fetchMock: FetchMock): Promise<Surface> {
  fetchMock.mockImplementation(
    respond({
      "/api/user/runs/run-1": { ok: true, viewerRole: "personal_reviewer" },
      "/api/user/runs/run-1/governance": {
        ok: true,
        schemaId,
        answerShape: schemaId === "decision_support" ? "decision_support_view" : "deep_research_view",
        humanReviewStatus: "pending",
        governanceUpdatedAt: "2026-10-28T00:00:00.000Z",
        decisionReceipt: receiptFor(fixture),
        automatedGovernance: null,
        governance: null,
      },
    })
  );
  return renderWithEffects(id, createElement(PersonalReviewDetail, { runId: "run-1" }));
}

export async function teamReviewDetailSurface(id: string, fixture: DsFixture, schemaId: string, fetchMock: FetchMock): Promise<Surface> {
  fetchMock.mockImplementation(
    respond({
      "/api/teams/adaptive-runs/run-1": {
        ok: true,
        version: 1,
        review: {
          runId: "run-1",
          schemaId,
          answerShape: schemaId === "decision_support" ? "decision_support_view" : "deep_research_view",
          decisionReceipt: receiptFor(fixture),
          humanReview: { status: "pending" },
          reviewable: true,
          updatedAt: "2026-10-28T00:00:00.000Z",
        },
      },
    })
  );
  return renderWithEffects(id, createElement(AdaptiveReviewDetail, { runId: "run-1" }));
}

export function dsPageSurface(id: string, fixture: DsFixture, mode: "personal" | "team", rawStrength: "model_content" | "unwrapped" = "model_content") {
  const ancillary = mode === "team" ? teamResearchAncillaryPresentation(teamReview(fixture) as never, undefined, "decision_support") : undefined;
  return renderStatic(id, dsPageElement(fixture, ancillary, rawStrength));
}

export function teamSummarySurface(id: string, fixture: DsFixture, schemaId: string | null) {
  return renderStatic(id, createElement(TeamResearchReviewSummary, { review: teamReview(fixture) as never, schemaId } as never));
}

export function listItemSurface(id: string, fixture: DsFixture, schemaId: string) {
  return renderStatic(id, createElement(AdaptiveReviewListItem, { item: listItem(fixture, schemaId) }));
}

/** Every DS surface for every fixture. */
export async function allDsSurfaces(fixtures: DsFixture[], fetchMock: FetchMock): Promise<(Surface & { fixture: string; kind: string })[]> {
  const out: (Surface & { fixture: string; kind: string })[] = [];
  for (const f of fixtures) {
    out.push({ ...dsPageSurface(`page:personal:${f.name}`, f, "personal"), fixture: f.name, kind: "page" });
    out.push({ ...dsPageSurface(`page:team:${f.name}`, f, "team"), fixture: f.name, kind: "page_team" });
    out.push({ ...listItemSurface(`listItem:${f.name}`, f, "decision_support"), fixture: f.name, kind: "list_item" });
    out.push({ ...(await personalReviewSurface(`personalReview:${f.name}`, f, "decision_support", fetchMock)), fixture: f.name, kind: "personal_review" });
    out.push({ ...(await teamReviewDetailSurface(`teamReview:${f.name}`, f, "decision_support", fetchMock)), fixture: f.name, kind: "team_review" });
  }
  return out;
}

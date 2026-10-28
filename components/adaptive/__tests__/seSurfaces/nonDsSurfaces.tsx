/**
 * Order 6 / S-E.1 — every surface the wording change touches, rendered for schemas OTHER than Decision Support (AC-6,
 * AC-8). K-3 limits the change to Decision Support, so each of these must be byte-identical to unmodified main.
 *
 * Version-agnostic (imports only what exists unchanged at f207e1a), so the same module captures the baseline from the
 * base commit and re-renders it on the branch. The importing spec owns the mocks and passes its fetch mock in.
 */

import { createElement } from "react";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import type { QueryType } from "@/lib/adaptiveSchema/types";
import { teamResearchAncillaryPresentation } from "@/components/workspace/projects/TeamResearchDetailShell";
import { classification, renderStatic, surfaceText, type DsFixture } from "./seSurfaceHarness";
import { listItemSurface, personalReviewSurface, teamReview, teamReviewDetailSurface, teamSummarySurface } from "./seSurfaceRenderers";

export type Capture = { text: string; html?: string; fetches?: string[] };

const FLAGS: [boolean, boolean][] = [
  [true, false],
  [false, false],
  [true, true],
  [false, true],
];

/** A receipt-only stand-in: the receipt surfaces read nothing but these two stored flags. */
const flagsFixture = (sourceBacked: boolean, humanReviewNeeded: boolean): DsFixture =>
  ({ name: `sb=${sourceBacked},hr=${humanReviewNeeded}`, perModel: [], result: { sourceBacked, humanReviewNeeded } }) as unknown as DsFixture;

export const NON_DS_SCHEMAS = (Object.keys(SCHEMA_REGISTRY) as QueryType[]).filter((q) => q !== "decision_support").sort();

function meta(queryType: QueryType, sourceBacked: boolean, humanReviewNeeded: boolean) {
  return {
    schemaVersion: 1,
    queryType,
    answerShape: SCHEMA_REGISTRY[queryType].renderHint,
    dataBasis: "training_prior",
    freshness: "timeless",
    riskLevel: "professional",
    evidenceQuality: "not_applicable",
    uncertainties: [],
    blindSpots: [],
    humanReviewNeeded,
    sourceBacked,
    generatedAt: "2026-10-28T00:00:00.000Z",
  } as never;
}

function pageCapture(queryType: QueryType, sourceBacked: boolean, humanReviewNeeded: boolean, mode: "personal" | "team"): Capture {
  const fixture = flagsFixture(sourceBacked, humanReviewNeeded);
  const ancillary = mode === "team" ? teamResearchAncillaryPresentation(teamReview(fixture) as never, undefined, queryType) : undefined;
  try {
    const s = renderStatic(
      "page",
      createElement(AdaptivePanelResponse, {
        schema: SCHEMA_REGISTRY[queryType],
        classification: classification(queryType),
        results: [{ modelId: "chatgpt", schemaId: queryType, ok: false, error: "timeout" }],
        meta: meta(queryType, sourceBacked, humanReviewNeeded),
        question: "A user question",
        runId: null,
        ...(ancillary ? { ancillaryPresentation: ancillary } : {}),
      } as never)
    );
    return { text: surfaceText(s), html: s.html };
  } catch (e) {
    return { text: `RENDER ERROR: ${(e as Error).message}` };
  }
}

const fetchLog = (fetchMock: jest.Mock) => fetchMock.mock.calls.map(([url, init]) => `${(init as { method?: string } | undefined)?.method ?? "GET"} ${String(url)}`);

/** Every non-DS capture, keyed by a stable id. */
export async function captureNonDs(fetchMock: jest.Mock): Promise<Record<string, Capture>> {
  const out: Record<string, Capture> = {};
  for (const q of NON_DS_SCHEMAS) {
    for (const [sb, hr] of FLAGS) {
      for (const mode of ["personal", "team"] as const) out[`page:${mode}:${q}:sb=${sb}:hr=${hr}`] = pageCapture(q, sb, hr, mode);
    }
  }
  // Receipt surfaces: a non-DS schema, the generic schema, and (Team summary only) callers that pass no schema at all.
  for (const [sb, hr] of FLAGS) {
    const f = flagsFixture(sb, hr);
    const tag = `sb=${sb}:hr=${hr}`;
    for (const schemaId of [undefined, null, "deep_research", "generic"]) {
      out[`teamSummary:${String(schemaId)}:${tag}`] = { text: surfaceText(teamSummarySurface("s", f, schemaId as string | null)) };
    }
    for (const schemaId of ["deep_research", "generic"]) {
      out[`listItem:${schemaId}:${tag}`] = { text: surfaceText(listItemSurface("l", f, schemaId)) };
      fetchMock.mockReset();
      const personal = await personalReviewSurface("p", f, schemaId, fetchMock);
      out[`personalReview:${schemaId}:${tag}`] = { text: surfaceText(personal), fetches: fetchLog(fetchMock) };
      fetchMock.mockReset();
      const team = await teamReviewDetailSurface("t", f, schemaId, fetchMock);
      out[`teamReview:${schemaId}:${tag}`] = { text: surfaceText(team), fetches: fetchLog(fetchMock) };
    }
  }
  fetchMock.mockReset();
  return out;
}

/**
 * Order 6 / S-E.1 — every surface the wording change touches, rendered for schemas OTHER than Decision Support (AC-6,
 * AC-8). K-3 limits the change to Decision Support, so each of these must be byte-identical to unmodified main.
 *
 * Version-agnostic (imports only what exists unchanged at f207e1a), so the same module captures the baseline from the
 * base commit and re-renders it on the branch. The importing spec owns the mocks and passes its fetch mock in.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import type { QueryType } from "@/lib/adaptiveSchema/types";
import { teamResearchAncillaryPresentation } from "@/components/workspace/projects/TeamResearchDetailShell";
import { classification, renderStatic, surfaceText, type DsFixture } from "./seSurfaceHarness";
import { listItemSurface, personalReviewSurface, teamReview, teamReviewDetailSurface, teamSummarySurface } from "./seSurfaceRenderers";

export type Capture = { text: string; html?: string; fetches?: string[] };

/**
 * Receipt surfaces format timestamps in the process's local timezone ("Oct 28, 2026, 3:00 AM"), which differs between a
 * laptop and CI. S-E.1 does not touch date formatting, so each local date-time is replaced by a fixed token; every
 * other character is still compared exactly.
 */
export const DATETIME_TOKEN = "⟨datetime⟩";
export const LOCAL_DATETIME = /\b[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M\b/g;
export const tokeniseDates = (text: string) => text.replace(LOCAL_DATETIME, DATETIME_TOKEN);

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

/**
 * Populated results for the shared (non-DS) summary path: the o5p historical records — real model results with gate,
 * synthesis report and trust summary — so consensus and grounding tiers are rendered, not only the empty state.
 */
const O5P_RECORDS = join(__dirname, "..", "..", "..", "..", "lib", "adaptiveSchema", "__tests__", "o5p", "__fixtures__", "baseline-2c17fee", "records.json");

function populatedCapture(record: Record<string, unknown>, mode: "personal" | "team"): Capture {
  const queryType = record.schemaId as QueryType;
  const ancillary = mode === "team" ? teamResearchAncillaryPresentation(teamReview(flagsFixture(true, false)) as never, undefined, queryType) : undefined;
  try {
    const s = renderStatic(
      "populated",
      createElement(AdaptivePanelResponse, {
        schema: SCHEMA_REGISTRY[queryType],
        classification: record.classification,
        results: record.results,
        alignedClaims: record.alignedClaims,
        gate: record.gate,
        synthesisReport: record.synthesisReport,
        trustSummary: record.trustSummary,
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
  const records: Record<string, Record<string, unknown>> = JSON.parse(readFileSync(O5P_RECORDS, "utf8"));
  for (const name of Object.keys(records).sort()) {
    for (const mode of ["personal", "team"] as const) out[`populated:${mode}:${name}`] = populatedCapture(JSON.parse(JSON.stringify(records[name])), mode);
  }
  // Receipt surfaces: a non-DS schema, the generic schema, and (Team summary only) callers that pass no schema at all.
  for (const [sb, hr] of FLAGS) {
    const f = flagsFixture(sb, hr);
    const tag = `sb=${sb}:hr=${hr}`;
    for (const schemaId of [undefined, null, "deep_research", "generic"]) {
      out[`teamSummary:${String(schemaId)}:${tag}`] = { text: surfaceText(teamSummarySurface("s", f, schemaId as string | null)) };
    }
    for (const schemaId of ["deep_research", "generic"]) {
      out[`listItem:${schemaId}:${tag}`] = { text: tokeniseDates(surfaceText(listItemSurface("l", f, schemaId))) };
      fetchMock.mockReset();
      const personal = await personalReviewSurface("p", f, schemaId, fetchMock);
      out[`personalReview:${schemaId}:${tag}`] = { text: tokeniseDates(surfaceText(personal)), fetches: fetchLog(fetchMock) };
      fetchMock.mockReset();
      const team = await teamReviewDetailSurface("t", f, schemaId, fetchMock);
      out[`teamReview:${schemaId}:${tag}`] = { text: tokeniseDates(surfaceText(team)), fetches: fetchLog(fetchMock) };
    }
  }
  fetchMock.mockReset();
  return out;
}

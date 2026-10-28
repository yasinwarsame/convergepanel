/**
 * Order 6 / S-E.2: the historical (unmarked) stored record for a fixture key. The 413e14b evidence records
 * (__fixtures__/historicalRecords.json, built by unchanged main 0249a4e5) are used wherever they exist. A case added
 * after that capture (the R1 NIT-4 synthetic-identities case) uses the record the current builder writes with the
 * marker removed, which dsExportMarker.spec.ts proves equal to unchanged main's record for every captured case, and
 * dsExportRendered.spec.ts proves equal for this one too (unchanged main builds it live in exportSuite.mjs).
 */
import historicalRecords from "./__fixtures__/historicalRecords.json";
import { asStored, exportCases, exportRecord } from "./dsExportFixtures";
import type { AdaptiveExportFormat, AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";

export const EVIDENCE_RECORDS = historicalRecords as unknown as Record<string, AdaptiveResearchExportV1>;

/** Cases added after the 413e14b capture; they have no evidence record. */
export const ADDED_AFTER_CAPTURE = ["ds.uncontested_choose_option.unreviewed_in_queue.synthetic_identities"];

export function historicalOf(key: string): AdaptiveResearchExportV1 {
  const evidence = EVIDENCE_RECORDS[key];
  if (evidence) return evidence;
  const format = key.slice(key.lastIndexOf(".") + 1) as AdaptiveExportFormat;
  const name = key.slice(0, key.lastIndexOf("."));
  if (!ADDED_AFTER_CAPTURE.includes(name)) throw new Error(`no historical record for ${key}`);
  const c = exportCases().find((x) => x.name === name)!;
  const record = JSON.parse(JSON.stringify(asStored({ ...exportRecord(c, format), artifactStatus: "ready" as const })));
  delete record.reportSnapshot.presentation;
  return record;
}

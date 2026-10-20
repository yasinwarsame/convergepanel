/**
 * Order 5 (Contract P): the suites that import these pin the HISTORICAL (unmarked) report presentation — the one every
 * report persisted before Contract P renders with. Today's builder marks new reports with
 * presentation.disagreementPositionVersion = 1; with that one field removed, its output is exactly what the 2c17feee
 * builder produced (o5p/builderPurity.spec.ts proves it), i.e. a historical record. The marked presentation is pinned
 * separately (positionPresentation.spec.ts, o5p/markedPresentation.spec.tsx).
 */
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";

const MARKER = "disagreementPositionVersion";

function stripMarker<T>(report: T): T {
  const p = (report as { presentation?: Record<string, unknown> } | null | undefined)?.presentation;
  if (!p || !(MARKER in p)) return report;
  const { [MARKER]: _marker, ...rest } = p;
  return { ...(report as object), presentation: rest } as T;
}

/** buildAdaptiveSynthesisReport, as a historical (unmarked) record. */
export async function historicalBuild(...args: Parameters<typeof buildAdaptiveSynthesisReport>): ReturnType<typeof buildAdaptiveSynthesisReport> {
  return stripMarker(await buildAdaptiveSynthesisReport(...args));
}

/** finalizeAdaptiveRun, with the live report and its persisted copy as historical (unmarked) records. */
export async function historicalFinalize(...args: Parameters<typeof finalizeAdaptiveRun>): ReturnType<typeof finalizeAdaptiveRun> {
  const out = await finalizeAdaptiveRun(...args);
  return {
    ...out,
    ...(out.synthesisReport ? { synthesisReport: stripMarker(out.synthesisReport) } : {}),
    ...(out.persistedLegacyOutput ? { persistedLegacyOutput: { ...out.persistedLegacyOutput, ...(out.persistedLegacyOutput.synthesisReport ? { synthesisReport: stripMarker(out.persistedLegacyOutput.synthesisReport) } : {}) } } : {}),
  };
}

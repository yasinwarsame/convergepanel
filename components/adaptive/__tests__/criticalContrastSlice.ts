/**
 * Order 6 critical-contrast slice — the ONLY markup change it makes, as exact full class values.
 *
 * The sealed page baselines (dsProvenancePagesBaseline.9eca1e3.json, seSurfaces nonDsBaseline.json) were captured
 * before this slice and stay untouched. The parity tests compare the current render with these substitutions
 * REVERSED: equality then proves the slice changed nothing but these class values. A reversal that touched anything
 * else could only make the comparison fail, never pass.
 *
 * Each entry: [current full class value, class value before the slice]. Matched with its surrounding double quotes,
 * which is how both serializers (React `className=` JSON and static-markup `class=`) emit it.
 */
export const CRITICAL_CONTRAST_CLASS_CHANGES: ReadonlyArray<readonly [string, string]> = [
  // P2 / review no-access and every ReviewErrorState message: red-400 (2.77:1 on white) → red-700 (6.47:1).
  ["text-sm font-medium text-red-700", "text-sm font-medium text-red-400"],
  // E-7 model-count disclosure in DecisionSupportView: slate-400 (2.56:1) → slate-600 (7.58:1).
  ["mt-1 text-xs text-slate-600", "mt-1 text-xs text-slate-400"],
  // Team review summary "Conditions" / "Decision receipt" labels: cp-faint (2.79:1) → cp-muted (5.77:1).
  ["text-xs font-medium uppercase tracking-wide text-cp-muted", "text-xs font-medium uppercase tracking-wide text-cp-faint"],
];

/** Reverse the slice's class changes in serialized markup; returns the text and how many values were reversed. */
export function undoCriticalContrastClasses(markup: string): { markup: string; reversed: number } {
  let reversed = 0;
  let out = markup;
  for (const [now, before] of CRITICAL_CONTRAST_CLASS_CHANGES) {
    const parts = out.split(`"${now}"`);
    reversed += parts.length - 1;
    out = parts.join(`"${before}"`);
  }
  return { markup: out, reversed };
}

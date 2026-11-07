/**
 * #290 Increment 1 — the report layout seam.
 *
 * "classic" is the shipped report, byte for byte (every sealed parity oracle pins it). "readable" is the opt-in
 * answer-first layout. Anything that is not exactly "readable" — absent, misspelled, a non-string — is classic: the
 * resolver fails closed to the shipped layout and never guesses.
 *
 * UI-only and pure. Never imported by lib/adaptiveSchema, lib/pdf, lib/docx, export routes or persistence code
 * (readableImportBoundary.spec.ts).
 */

import { REPORT_READABLE_LAYOUT_ENABLED } from "./layoutRollout";

export type ReportLayout = "classic" | "readable";

export const DEFAULT_REPORT_LAYOUT: ReportLayout = "classic";

/** The layout a caller asked for: "readable" only for exactly that value; everything else is classic. */
export function resolveReportLayout(value: unknown): ReportLayout {
  return value === "readable" ? "readable" : DEFAULT_REPORT_LAYOUT;
}

/** The layout a rollout switch selects: readable only when the switch is exactly `true`. */
export function reportLayoutFromSwitch(enabled: unknown): ReportLayout {
  return enabled === true ? "readable" : DEFAULT_REPORT_LAYOUT;
}

/**
 * The layout a Personal / Team report shell renders: an explicitly requested layout when the shell was handed one
 * (tests), otherwise the rollout switch (default off → classic). Both shells call this, so they always agree.
 */
export function resolveShellReportLayout(requested: unknown): ReportLayout {
  return requested === undefined ? reportLayoutFromSwitch(REPORT_READABLE_LAYOUT_ENABLED) : resolveReportLayout(requested);
}

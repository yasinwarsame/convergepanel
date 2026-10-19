/**
 * Verification gate presentation (Order 4: D2, D6, D7, D8)
 *
 * The one source of the words every surface uses for the stored verification
 * gate. Nothing here computes or changes a gate: the value is read as stored
 * (AdaptiveSynthesisReport.gate / AdaptiveGateResult.status) and only worded.
 *
 * - D6: neutral labels — "Verification gate: Pass | Caution | Fail |
 *   Unrecognized". Pass does not claim the models verified the answer; Fail
 *   does not claim a split.
 * - D2: the caution notice is fixed application text, never model text, and
 *   names no cause — the gate's cause is not stored (D1 deferred).
 * - D7: the new wording applies to reports that carry
 *   presentation.verificationGate (written by buildAdaptiveSynthesisReport
 *   from Order 4 on). Every other report renders exactly as before: its gate
 *   is worded with LEGACY_GATE_BANNER_LABEL / the raw value, as it always was.
 * - D8: a stored value that is not pass / caution / fail is "unrecognized" on
 *   every report, old or new — never coerced to a known status, never a
 *   crash, and never worded as a verification result.
 *
 * Pure and client-safe: no "server-only", no I/O.
 */

import { AdaptiveGateStatus, AdaptiveSynthesisReport } from "./types";

/** The stored gate as presentation sees it: a known status, or "unrecognized" for anything else (D8). */
export type GateDisplayStatus = AdaptiveGateStatus | "unrecognized";

const KNOWN_GATE_STATUSES: readonly AdaptiveGateStatus[] = ["pass", "caution", "fail"];

/** Reads a stored gate value without trusting it: a known status, else "unrecognized" — never a default to pass. */
export function readGateStatus(value: unknown): GateDisplayStatus {
  return typeof value === "string" && (KNOWN_GATE_STATUSES as readonly string[]).includes(value) ? (value as AdaptiveGateStatus) : "unrecognized";
}

export const GATE_LABEL = "Verification gate";

/** D6 wording. Exhaustive by type: a new status without wording fails to compile. */
export const GATE_STATUS_WORD: Readonly<Record<GateDisplayStatus, string>> = {
  pass: "Pass",
  caution: "Caution",
  fail: "Fail",
  unrecognized: "Unrecognized",
};

/** "Verification gate: Caution". */
export function gateLabel(status: GateDisplayStatus): string {
  return `${GATE_LABEL}: ${GATE_STATUS_WORD[status]}`;
}

/** D2: the computed caution notice — the owner's canonical wording. It states the gate's result and names no cause. */
export const CAUTION_NOTICE =
  "Caution: This result requires further review. The panel did not meet the conditions for a clean verification pass. Review the findings and limitations before relying on this answer.";

/** D2, for length-limited text (the X post). */
export const CAUTION_NOTICE_SHORT = "requires further review";

/** D8: shown wherever the stored gate value is not one this version knows. It supports no verification conclusion. */
export const UNRECOGNIZED_GATE_NOTICE =
  "The stored verification gate value is not recognized, so no verification result is shown for this answer.";

/** The computed notice that accompanies a gate in the Unified Answer and before model prose; null when the gate needs none. */
export function gateNotice(status: GateDisplayStatus): string | null {
  if (status === "caution") return CAUTION_NOTICE;
  if (status === "unrecognized") return UNRECOGNIZED_GATE_NOTICE;
  return null;
}

/** D4: placed between the gate and model-written certainty prose on caution / fail / unrecognized. */
export const MODEL_PROSE_DOES_NOT_CHANGE_GATE = "The model-written explanation below does not change the verification gate.";

/** D3: the heading for the load-bearing split claims disclosed in a caution answer. */
export function unresolvedLoadBearingHeading(count: number): string {
  return count === 1 ? "Unresolved load-bearing claim" : "Unresolved load-bearing claims";
}

export const DISPUTED_BY_LABEL = "Disputed by";

/**
 * D7: whether a report carries the Order 4 presentation (written by buildAdaptiveSynthesisReport from Order 4
 * on). This is the only boundary between new and historical semantics — never a timestamp.
 */
export function hasGatePresentation(report: Pick<AdaptiveSynthesisReport, "presentation"> | null | undefined): boolean {
  return !!report?.presentation?.verificationGate;
}

/**
 * The banner wording historical reports were rendered with (report view and governance gate). Frozen: kept only so
 * a report without the Order 4 presentation renders exactly as it did (D7). New reports use gateLabel.
 */
export const LEGACY_GATE_BANNER_LABEL: Readonly<Record<AdaptiveGateStatus, string>> = {
  pass: "Verified — panel converges",
  caution: "Caution — partial convergence",
  fail: "Could not verify — panel split",
};

/**
 * The stored gate a page shows (F4): the report's own copy (AdaptiveSynthesisReport.gate) whenever a report is
 * present — the value the Unified Answer, summary and every export read — so one page never states two gates. The
 * gate object's copy (AdaptiveGateResult.status) is used only where there is no report. Both are written from the same
 * computed value, so they differ only on a corrupted record. Nothing is recomputed.
 */
export function pageGateValue(report: Pick<AdaptiveSynthesisReport, "gate"> | null | undefined, gateStatus: unknown): unknown {
  return report ? report.gate : gateStatus;
}

/** The gate banner (report view, governance section). */
export function gateBannerText(report: Pick<AdaptiveSynthesisReport, "presentation"> | null | undefined, stored: unknown): string {
  const status = readGateStatus(stored);
  if (status === "unrecognized" || hasGatePresentation(report)) return gateLabel(status);
  return LEGACY_GATE_BANNER_LABEL[status];
}

/** The verdict card's gate badge: historical reports showed the raw status. */
export function gateBadgeText(report: Pick<AdaptiveSynthesisReport, "presentation"> | null | undefined, stored: unknown): string {
  const status = readGateStatus(stored);
  if (status === "unrecognized" || hasGatePresentation(report)) return gateLabel(status);
  return status;
}

/** The list view's run-header chip: historical reports showed "gate: {status}". */
export function gateChipText(report: Pick<AdaptiveSynthesisReport, "presentation"> | null | undefined, stored: unknown): string {
  const status = readGateStatus(stored);
  if (status === "unrecognized" || hasGatePresentation(report)) return gateLabel(status);
  return `gate: ${status}`;
}

/**
 * The gate as a lowercase word inside a historical text surface ("(gate: caution)"): the stored value when known —
 * so a historical export is unchanged — and "unrecognized" otherwise, never the raw unknown value.
 */
export function legacyGateWord(stored: unknown): string {
  const status = readGateStatus(stored);
  return status === "unrecognized" ? "unrecognized" : status;
}

/**
 * The memo's confidence word (shared memo generator: "(… confidence)"). An unrecognized gate supports no confidence
 * level, so its header reads "(No gate-based confidence)" — never High, and no level is implied.
 */
export const GATE_CONFIDENCE_LABEL: Readonly<Record<GateDisplayStatus, string>> = {
  pass: "High",
  caution: "Medium",
  fail: "Low",
  unrecognized: "No gate-based",
};

/** The tone a renderer styles a gate with; "neutral" for an unrecognized value. */
export type GateTone = AdaptiveGateStatus | "neutral";

export function gateTone(stored: unknown): GateTone {
  const status = readGateStatus(stored);
  return status === "unrecognized" ? "neutral" : status;
}

/**
 * Render-time model independence of an adaptive report's top verdict claim (owner ruling on historical adaptive
 * reports, review of 1ee4982).
 *
 * A report computed before the independent-voice rule (orchestrate.ts `excludeRepeatedSubstitutes`) counted every slot
 * a substitute model answered as its own supporter: ChatGPT and Claude both answered by DeepSeek read "Top consensus —
 * agreed by 2 models". Stored values are never recomputed or rewritten; this module only decides, from the run's own
 * per-slot rows (RunModelProvenanceFacts: slot id, `substituted`, provider), how the stored top claim may be HEADED and
 * DESCRIBED:
 *  - "independent": every slot considered is its own executing model — the report renders exactly as before;
 *  - "repeated_substitute": two or more of those slots were answered by one substitute model — never an unqualified
 *    "Top consensus" / "agreed by N"; the executing models are named ("DeepSeek (substituting ChatGPT, Claude)");
 *  - "unverified": a slot considered has no recorded execution identity (no row, or a row without a recorded status)
 *    — model independence is stated as unverified; nothing is invented.
 * The slots considered are the top claim's supporting cells when the stored rows join it ("supporters"), otherwise
 * every slot the run records ("run"). Without the run's rows at all (`provenance` null — a surface not handed the
 * record, RunModelProvenanceContext's contract) nothing is inferred and the report renders as before.
 *
 * Pure, client-safe; imports no computation module (it is read by positionPresentation.ts).
 */

import { groupSlotsByExecutingVoice } from "@/lib/panel/executingVoiceLabel";
import type { RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import { NO_CONSENSUS_IDENTIFIED } from "./agreementNarrative";

export type AdaptiveTopIndependence =
  | { kind: "independent" }
  | { kind: "repeated_substitute"; scope: "supporters" | "run"; voices: string[]; repeated: string[] }
  | { kind: "unverified"; scope: "supporters" | "run" };

const INDEPENDENT: AdaptiveTopIndependence = Object.freeze({ kind: "independent" as const });

/** Heading in place of "Top consensus" / "Top majority-supported claim" / "Models agree" (repeated substitute model). */
export const ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING = "Top finding (repeated substitute model; not an independent consensus)";
/** Heading in place of "Top consensus" / "Top majority-supported claim" / "Models agree" (execution identity not recorded). */
export const ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING = "Top finding (model independence unverified; not confirmed as a consensus)";

/** The supporting slot ids (agrees / partial cells) of a stored aligned row, or null when it is not a readable row. */
export function supportingSlotsOfRow(row: unknown): string[] | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const cells = (row as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return null;
  const out: string[] = [];
  for (const c of cells) {
    if (!c || typeof c !== "object") continue;
    const { modelId, stance } = c as { modelId?: unknown; stance?: unknown };
    if (typeof modelId === "string" && modelId.trim() && (stance === "agrees" || stance === "partial")) out.push(modelId.trim());
  }
  return out;
}

export function adaptiveTopIndependence(
  supporters: readonly string[] | null,
  provenance: readonly RunModelProvenanceFacts[] | null | undefined
): AdaptiveTopIndependence {
  if (!Array.isArray(provenance)) return INDEPENDENT;
  const scope = supporters ? "supporters" : "run";
  const source = supporters ?? provenance.map((f) => (f && typeof f.modelId === "string" ? f.modelId : ""));
  const slots = Array.from(new Set(source.map((s) => String(s).trim()).filter((s) => s.length > 0)));
  if (slots.length === 0) return scope === "run" && provenance.length > 0 ? { kind: "unverified", scope } : INDEPENDENT;
  const factsOf = (slot: string) => provenance.find((f) => f && typeof f.modelId === "string" && f.modelId.trim() === slot);
  if (slots.some((s) => typeof factsOf(s)?.substituted !== "boolean")) return { kind: "unverified", scope };
  if (scope === "run" && provenance.some((f) => !f || typeof f.modelId !== "string" || !f.modelId.trim())) return { kind: "unverified", scope };
  const groups = groupSlotsByExecutingVoice(slots, provenance);
  if (groups.length >= slots.length) return INDEPENDENT;
  return { kind: "repeated_substitute", scope, voices: groups.map((g) => g.label), repeated: groups.filter((g) => g.slotIds.length > 1).map((g) => g.label) };
}

export function adaptiveTopHeading(t: AdaptiveTopIndependence): string | null {
  if (t.kind === "repeated_substitute") return ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING;
  if (t.kind === "unverified") return ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING;
  return null;
}

const slotsText = (n: number) => `${n} panel slot${n === 1 ? "" : "s"}`;

/**
 * The sentence shown in place of "agreed by N models" / "supported … by N panel slots". `storedCount` is the stored
 * `verdictCard.consensusModelCount`, stated as recorded (never recomputed); 0 / absent omits it. Null when independent.
 */
export function adaptiveTopIndependenceStatement(t: AdaptiveTopIndependence, storedCount: number | null | undefined): string | null {
  const recorded = typeof storedCount === "number" && storedCount > 0 ? `Recorded as supported by ${slotsText(storedCount)}` : null;
  if (t.kind === "repeated_substitute") {
    if (t.scope === "supporters") {
      const m = t.voices.length;
      return `${recorded ? `${recorded}, answered by` : "Supporting slots answered by"} ${m} independent model${m === 1 ? "" : "s"}: ${t.voices.join("; ")}. A substitute model that answered several slots counts once.`;
    }
    return `${recorded ? `${recorded}. ` : ""}In this run ${t.repeated.join("; ")} answered several slots, so this is not presented as an independent consensus.`;
  }
  if (t.kind === "unverified") {
    return `Model independence unverified: ${recorded ? `${recorded.charAt(0).toLowerCase()}${recorded.slice(1)}, but which` : "which"} models answered ${t.scope === "supporters" ? "the supporting slots" : "this run's slots"} is not recorded.`;
  }
  return null;
}

/**
 * An UNMARKED report's top claim (a marked report carries it as PositionView.verdict.topIndependence): its supporting
 * slots from the one stored consensus / majority row whose claimText equals the card's top claim exactly (two rows with
 * that text → not joined), else every slot the run records. Null when independent, when the card names no consensus,
 * or without the run's rows.
 */
export function unmarkedTopIndependence(
  verdictCard: unknown,
  rows: readonly unknown[] | null | undefined,
  provenance: readonly RunModelProvenanceFacts[] | null | undefined
): Exclude<AdaptiveTopIndependence, { kind: "independent" }> | null {
  if (!verdictCard || typeof verdictCard !== "object") return null;
  const top = (verdictCard as { topConsensus?: unknown }).topConsensus;
  if (typeof top !== "string" || top === NO_CONSENSUS_IDENTIFIED) return null;
  let supporters: string[] | null = null;
  if (Array.isArray(rows)) {
    const same = rows.filter((r) => !!r && typeof r === "object" && (r as { claimText?: unknown }).claimText === top);
    const status = same.length === 1 ? String((same[0] as { status?: unknown }).status) : "";
    if (status === "consensus" || status === "majority") supporters = supportingSlotsOfRow(same[0]);
  }
  const t = adaptiveTopIndependence(supporters, provenance);
  return t.kind === "independent" ? null : t;
}

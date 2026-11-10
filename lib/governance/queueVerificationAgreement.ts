/**
 * Agreement / disagreement wording for a claim verification (and a video verification) in the governance review queue,
 * judged by EXECUTING-model independence (lib/panel/storedVerificationIndependence.ts).
 *
 * Four truthful classifications, never mixed:
 *  1. genuine disagreement between independent executing models — `disagreementPoints` ("… (others disagree)" only when
 *     another independent model ANSWERED with a different verdict), `dissentSummary`, `disagreements`;
 *  2. repeated outputs from one executing model (several slots answered by one substitute provider) —
 *     `qualifiedDisagreements` with basis "same_executing_model";
 *  3. single-model uncertainty / contested assertions (fewer than two independent models answered) —
 *     `singleModelAssessment` (the verdict as ONE model's assessment) and `qualifiedDisagreements` with basis
 *     "single_independent_model";
 *  4. unknown model independence (execution identity not recorded) — `qualifiedDisagreements` with basis
 *     "independence_unverified"; no agreement or disagreement line is presented as between models.
 * "N/N models agree" / "k/n models say …" is produced only with ≥ 2 independent executing models, and counts
 * independent executing models. With ≥ 2 independent models and no collapsed slots the agreement / dissent / digest
 * output is the established one, except that "(others disagree)" is no longer emitted when no other model answered
 * with a different verdict.
 *
 * Pure; never mutates its input.
 */

import {
  executingModelKey,
  resolveExecutingModelKeys,
  type StoredConsensusIndependence,
} from "@/lib/panel/independentVoices";
import {
  storedVerificationConsensusIndependence,
  storedVerificationExecutingRows,
} from "@/lib/panel/storedVerificationIndependence";
import { groupSlotsByExecutingVoice } from "@/lib/panel/executingVoiceLabel";
import { runModelFamilyName } from "@/lib/panel/runModelIdentity";
import type { QualifiedDisagreementBasis } from "@/lib/panel/storedDisagreementIndependence";

export type QueueQualifiedSignal = { text: string; basis: QualifiedDisagreementBasis };

export type QueueVerificationAgreement = {
  modelIndependence: StoredConsensusIndependence;
  agreementSummary?: string;
  dissentSummary?: string;
  agreementPoints: string[];
  disagreementPoints: string[];
  /** Digest "conflicting assessments" between independent executing models (genuine only). */
  disagreements: string[];
  /** Signals that are NOT agreement / disagreement between independent models, each with its reason. */
  qualifiedDisagreements: QueueQualifiedSignal[];
  /** Fewer than two independent models answered: the verdict, stated as one model's assessment. */
  singleModelAssessment?: string;
};

/** "One independent model's assessment (ChatGPT): accurate — not agreement between models". */
export function singleModelAssessmentText(label: string, verdicts: readonly string[]): string {
  return `One independent model's assessment (${label}): ${verdicts.join(" / ")} — not agreement between models`;
}

/** A slot group answered by one executing model with differing verdicts. */
export function repeatedOutputsText(label: string, verdicts: readonly string[]): string {
  return `${label} rated as ${verdicts.join("; ")} — repeated outputs from one executing model`;
}

/** The verdict tally when execution identity is unknown — stated as responses, never as models agreeing. */
export function unverifiedTallyText(max: number, n: number, verdict: string): string {
  return `${max}/${n} responses say ${verdict} — model independence unverified, not confirmed as agreement between models`;
}

/**
 * Cap on `disagreements` (genuine digest conflicts). That field is not part of the queue DTO (the route exports only
 * `qualifiedDisagreements` and `singleModelAssessment` from this builder), so the cap hides nothing presented.
 */
const DIGEST_CAP = 3;

type Opts = {
  /** Human verdict label (route-specific). */
  humanize: (v: string) => string;
  /** Digest conflicting-assessment points, each with the two slot ids it names. */
  digest: ReadonlyArray<{ point: string; models: readonly string[] }>;
  /** "verification" reads `verdict ?? verdictLabel` for points; "video" reads `verdict`. */
  kind: "verification" | "video";
};

type Voice = { key: string; slotIds: string[]; label: string; verdicts: string[]; rawVerdicts: string[]; summaryVerdicts: string[] };

const norm = (v: string) => v.toLowerCase().replace(/\s+/g, "_");

/** Video slots are never substituted: each distinct `modelId` is its own executing model. */
function videoIndependence(mr: readonly unknown[]): StoredConsensusIndependence {
  const ids = new Set<string>();
  for (const row of mr) {
    if (!row || typeof row !== "object") return "unverified";
    const m = row as Record<string, unknown>;
    if (typeof m.modelId !== "string" || m.modelId.trim().length === 0 || typeof m.status !== "string") return "unverified";
    if (m.status === "ok") ids.add(m.modelId.trim().toLowerCase());
  }
  return ids.size >= 2 ? "independent" : "insufficient";
}

export function buildQueueVerificationAgreement(data: Record<string, unknown>, opts: Opts): QueueVerificationAgreement {
  const mr = data.modelResults;
  const out: QueueVerificationAgreement = {
    modelIndependence: "unverified",
    agreementPoints: [],
    disagreementPoints: [],
    disagreements: [],
    qualifiedDisagreements: [],
  };
  if (!Array.isArray(mr)) {
    out.modelIndependence = opts.kind === "video" ? "unverified" : storedVerificationConsensusIndependence(data);
    return out;
  }
  const independence = opts.kind === "video" ? videoIndependence(mr) : storedVerificationConsensusIndependence(data);
  out.modelIndependence = independence;

  // Executing-model key per stored row (claims: recorded substitution; video: the slot itself).
  const exec = opts.kind === "video" ? null : storedVerificationExecutingRows(data);
  // Answered rows resolve their keys together, exactly as `storedVerificationIndependentAnswerCount` does.
  let keys: string[] | null = null;
  if (exec) {
    keys = exec.map((r) => executingModelKey(r));
    const answeredIdx = exec.map((r, i) => (r.answered ? i : -1)).filter((i) => i >= 0);
    const resolved = resolveExecutingModelKeys(answeredIdx.map((i) => keys![i]));
    answeredIdx.forEach((rowIdx, j) => {
      keys![rowIdx] = resolved[j];
    });
  }
  const keyOf = (i: number, modelId: string) => (keys ? keys[i] : `slot:${modelId.trim().toLowerCase()}`);
  const keyBySlot = new Map<string, string>();
  mr.forEach((row, i) => {
    if (row && typeof row === "object" && typeof (row as Record<string, unknown>).modelId === "string") {
      const id = String((row as Record<string, unknown>).modelId);
      if (!keyBySlot.has(id)) keyBySlot.set(id, keyOf(i, id));
    }
  });

  // Answered rows grouped by executing model, in stored order.
  const voices: Voice[] = [];
  mr.forEach((row, i) => {
    if (!row || typeof row !== "object") return;
    const m = row as Record<string, unknown>;
    if (String(m.status ?? "") !== "ok") return;
    const id = String(m.modelId ?? "");
    const key = keyOf(i, id);
    const v = norm(String(opts.kind === "video" ? m.verdict ?? "unknown" : m.verdict ?? m.verdictLabel ?? "unknown"));
    const sv = norm(String(m.verdict ?? ""));
    const raw = String(m.verdict ?? "");
    let voice = voices.find((x) => x.key === key);
    if (!voice) {
      voice = { key, slotIds: [], label: "", verdicts: [], rawVerdicts: [], summaryVerdicts: [] };
      voices.push(voice);
    }
    voice.slotIds.push(id);
    voice.verdicts.push(v);
    voice.rawVerdicts.push(raw);
    voice.summaryVerdicts.push(sv);
  });
  const execRows = exec ? exec.map((r) => ({ modelId: r.modelId, status: r.status, provider: r.provider })) : null;
  for (const voice of voices) {
    voice.label =
      voice.slotIds.length > 1 && execRows
        ? groupSlotsByExecutingVoice(voice.slotIds.map((s) => s.trim().toLowerCase()), execRows)[0]?.label ?? voice.slotIds.map(runModelFamilyName).join(", ")
        : runModelFamilyName(voice.slotIds[0]);
  }

  // C-b CB-22: every recorded qualified signal is listed (no cap). A capped list silently dropped recorded lines (a
  // same-executing-model digest point beyond the fifth entry was neither shown as genuine nor as qualified). The input
  // is bounded: the stored digest (at most 12 points, lib/verification/agreementDigest.ts), one entry per executing
  // model and one tally. Exact duplicates are listed once.
  const pushQualified = (text: string, basis: QualifiedDisagreementBasis) => {
    if (!out.qualifiedDisagreements.some((q) => q.text === text)) {
      out.qualifiedDisagreements.push({ text, basis });
    }
  };
  const distinct = (xs: readonly string[]) => Array.from(new Set(xs));
  const human = (vs: readonly string[]) => distinct(vs).map((v) => opts.humanize(v).toLowerCase());

  // (2) one executing model answering several slots with differing verdicts — never a disagreement between models.
  const consistent: Voice[] = [];
  for (const voice of voices) {
    if (distinct(voice.verdicts).length > 1) pushQualified(repeatedOutputsText(voice.label, human(voice.verdicts)), "same_executing_model");
    else consistent.push(voice);
  }

  if (independence === "independent") {
    // Counts are of independent executing models with one consistent verdict.
    const total = Math.max(1, consistent.length);
    const byVerdict = new Map<string, Voice[]>();
    for (const voice of consistent) {
      const v = voice.verdicts[0];
      byVerdict.set(v, [...(byVerdict.get(v) ?? []), voice]);
    }
    const otherVerdictAnswered = byVerdict.size > 1;
    for (const [verdict, vs] of byVerdict) {
      const humanV = opts.humanize(verdict);
      const agreeMin = opts.kind === "video" ? 2 : 3;
      if (vs.length >= agreeMin) {
        out.agreementPoints.push(`${vs.length}/${total} models rate ${opts.kind === "video" ? "" : "this "}as ${humanV.toLowerCase()}`);
      }
      const dissentShape = opts.kind === "video" ? vs.length === 1 && total > 1 : vs.length === 1 || vs.length === 2;
      // "(others disagree)" only when another independent model ANSWERED with a different verdict.
      if (dissentShape && otherVerdictAnswered) {
        out.disagreementPoints.push(`${vs.map((x) => x.label).join(", ")} rated as ${humanV.toLowerCase()} (others disagree)`);
      }
    }
    // Majority over independent models (stored `verdict` only, as before).
    const counts = new Map<string, number>();
    for (const voice of consistent) counts.set(voice.summaryVerdicts[0], (counts.get(voice.summaryVerdicts[0]) ?? 0) + 1);
    let majority = "";
    let max = 0;
    for (const [v, c] of counts) {
      if (c > max) {
        max = c;
        majority = v;
      }
    }
    // "k/n models say …" needs at least two independent models with one consistent verdict each (never "1/1").
    if (consistent.length >= 2) {
      out.agreementSummary = `${max}/${consistent.length} models say ${opts.humanize(majority).toLowerCase()}`;
      const outliers = consistent.filter((voice) => voice.summaryVerdicts[0] !== majority);
      if (outliers.length > 0) {
        out.dissentSummary = `Dissent: ${outliers.map((o) => `${o.label}: ${opts.humanize(o.rawVerdicts[0])}`).join("; ")}`;
      }
    }
    for (const d of opts.digest) {
      const [a, b] = d.models;
      const sameExec = a !== undefined && b !== undefined && keyBySlot.get(a) !== undefined && keyBySlot.get(a) === keyBySlot.get(b);
      if (sameExec) pushQualified(d.point, "same_executing_model");
      else if (out.disagreements.length < DIGEST_CAP) out.disagreements.push(d.point);
    }
    return out;
  }

  if (independence === "insufficient") {
    // (3) fewer than two independent models answered: one model's assessment, its contested points are its own.
    const answered = voices[0];
    if (answered) out.singleModelAssessment = singleModelAssessmentText(answered.label, human(answered.verdicts));
    for (const d of opts.digest) {
      const [a, b] = d.models;
      const sameExec = a !== undefined && b !== undefined && keyBySlot.get(a) !== undefined && keyBySlot.get(a) === keyBySlot.get(b);
      pushQualified(d.point, sameExec ? "same_executing_model" : "single_independent_model");
    }
    return out;
  }

  // (4) execution identity unknown: the tally is stated as responses, nothing as agreement / disagreement between models.
  const okRows = voices.flatMap((voice) => voice.summaryVerdicts);
  if (okRows.length > 0) {
    const counts = new Map<string, number>();
    for (const v of okRows) counts.set(v, (counts.get(v) ?? 0) + 1);
    let majority = "";
    let max = 0;
    for (const [v, c] of counts) {
      if (c > max) {
        max = c;
        majority = v;
      }
    }
    pushQualified(unverifiedTallyText(max, okRows.length, opts.humanize(majority).toLowerCase()), "independence_unverified");
  }
  for (const d of opts.digest) pushQualified(d.point, "independence_unverified");
  return out;
}

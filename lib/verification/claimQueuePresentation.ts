/**
 * Claim-verification wording in the governance review queue (app/api/governance/queue/route.ts), on the SAME shared
 * statement basis as every other claim surface (lib/verification/claimVerdictCounts.ts `claimStatementBasis`, via
 * lib/verification/claimStatementBasisSources.ts `storedClaimStatementBasis`) — owner ruling 2026-11-18 R4, MAJOR-1.
 *
 * The route's established claim lines ("k/n models say …", "k/total models rate this as …", "<names> rated as …
 * (others disagree)", "Dissent: …", the digest bullets) count panel SLOTS and name slot FAMILIES. They are true only when
 * every answering slot is its own identified executing model (`basis.namedOwnModels`); they are kept byte-identical then.
 * For any other record the queue presents "independent" (K ≥ 2) this module supplies the replacement:
 *  - with the identified providers exactly K and each answering all its slots with one verdict: the same line shapes,
 *    counted over DISTINCT identified executing models and naming them by executing identity
 *    ("DeepSeek (substituting ChatGPT, Claude, Gemini, Grok)"); "k/n models say …" only for a majority of ≥ 2 models;
 *  - otherwise: NO line about models — the slot-response counts are listed as a qualified signal;
 *  - the digest's conflict pairs: one per pair of DISTINCT executing models (named), the rest qualified.
 * Plus, for every claim row: the per-row executing label of each slot (`rowLabels`, only where it differs from the slot
 * family) and the score basis (`consensusBasis`). Presentation only: the governance evaluation, its input, the stored
 * record, the consensus score and evidence quality are untouched. Pure; never mutates its input.
 */

import { runModelFamilyName } from "@/lib/panel/runModelIdentity";
import { storedVerificationConsensusIndependence } from "@/lib/panel/storedVerificationIndependence";
import type { QualifiedDisagreementBasis } from "@/lib/panel/storedDisagreementIndependence";
import {
  claimProviderExecutionLabel,
  claimProviderSides,
  claimRowExecutionLabel,
  claimScoreNeedsSlotQualifier,
  claimSlotResponsesNote,
  claimSlotTally,
  formatClaimVerdictCounts,
  splitClaimDisagreementsByIdentity,
} from "@/lib/verification/claimVerdictCounts";
import { canonicalProvider } from "@/lib/panel/providerRegistry";
import { singleModelAssessmentText } from "@/lib/governance/queueVerificationAgreement";
import { storedClaimStatementBasis, type ClaimConsensusBasis } from "@/lib/verification/claimStatementBasisSources";

export type ClaimQueueLines = {
  agreementPoints: string[];
  agreementSummary?: string;
  disagreementPoints: string[];
  dissentSummary?: string;
  disagreements: string[];
  qualified: Array<{ text: string; basis: QualifiedDisagreementBasis }>;
};

export type ClaimQueuePresentation = {
  /** modelId → executing label, only for slots whose label is not the bare family name. */
  rowLabels: ReadonlyMap<string, string>;
  /** null → the route's established lines are true and are kept as they are. */
  lines: ClaimQueueLines | null;
  /**
   * "insufficient" record (one executing model answered): the one-model assessment named by its EXECUTING identity
   * (the queue builder names a single-slot voice by its slot family, which is wrong for a substitute).
   */
  singleModelAssessment?: string;
  consensusBasis?: ClaimConsensusBasis;
};

/** Cap on between-models digest bullets (as the route's established `disagreements`). */
const DIGEST_CAP = 3;

export function claimQueuePresentation(
  data: Record<string, unknown>,
  humanize: (verdict: string) => string,
  digest: ReadonlyArray<{ point: string; models: string[] }>
): ClaimQueuePresentation {
  const rows: unknown[] = Array.isArray(data.modelResults) ? (data.modelResults as unknown[]) : [];
  const rowLabels = new Map<string, string>();
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const id = (r as { modelId?: unknown }).modelId;
    if (typeof id !== "string" || !id || rowLabels.has(id)) continue;
    const label = claimRowExecutionLabel(r);
    if (label !== runModelFamilyName(id)) rowLabels.set(id, label);
  }
  const independence = storedVerificationConsensusIndependence(data);
  if (independence === "insufficient") {
    const sides = claimProviderSides(rows);
    const providers = Object.values(sides.providerOfSlot);
    const verdicts: string[] = [];
    for (const r of rows) {
      const o = r as { status?: unknown; verdict?: unknown };
      if (o && o.status === "ok" && typeof o.verdict === "string" && !verdicts.includes(o.verdict)) verdicts.push(o.verdict);
    }
    if (sides.reliable && sides.providers === 1 && providers.length > 0) {
      return {
        rowLabels,
        lines: null,
        singleModelAssessment: singleModelAssessmentText(claimProviderExecutionLabel(providers[0], rows), verdicts.map((v) => humanize(v).toLowerCase())),
      };
    }
    return { rowLabels, lines: null };
  }
  if (independence !== "independent") return { rowLabels, lines: null };
  const basis = storedClaimStatementBasis(data);
  const consensusBasis: ClaimConsensusBasis | undefined = claimScoreNeedsSlotQualifier(basis) ? "slot_responses" : undefined;
  if (basis.namedOwnModels) return { rowLabels, lines: null, ...(consensusBasis ? { consensusBasis } : {}) };

  const sides = claimProviderSides(rows);
  const tally = claimSlotTally(rows);
  const lines: ClaimQueueLines = { agreementPoints: [], disagreementPoints: [], disagreements: [], qualified: [] };
  const pushQualified = (text: string, b: QualifiedDisagreementBasis) => {
    if (!lines.qualified.some((q) => q.text === text)) lines.qualified.push({ text, basis: b });
  };
  const label = (provider: string) => claimProviderExecutionLabel(provider, rows);
  const lower = (v: string) => humanize(v).toLowerCase();

  if (basis.modelsIdentified && sides.consistent) {
    // One verdict per distinct identified executing model (consistent), in first-answer order.
    const verdictOf = new Map<string, string>();
    for (const r of rows) {
      const o = r as { status?: unknown; verdict?: unknown; provider?: unknown };
      if (!o || o.status !== "ok" || typeof o.verdict !== "string") continue;
      const p = canonicalProvider(o.provider);
      if (p && !verdictOf.has(p)) verdictOf.set(p, o.verdict);
    }
    const n = verdictOf.size;
    const byVerdict = new Map<string, string[]>();
    for (const [p, v] of verdictOf) byVerdict.set(v, [...(byVerdict.get(v) ?? []), p]);
    let majority = "";
    let max = 0;
    for (const [v, ps] of byVerdict) {
      if (ps.length >= 3) lines.agreementPoints.push(`${ps.length}/${n} models rate this as ${lower(v)}`);
      if (byVerdict.size > 1 && ps.length <= 2) lines.disagreementPoints.push(`${ps.map(label).join(", ")} rated as ${lower(v)} (others disagree)`);
      if (ps.length > max) {
        max = ps.length;
        majority = v;
      }
    }
    // "k/n models say …" only for a majority of at least two distinct identified models.
    if (max >= 2 && 2 * max > n) {
      lines.agreementSummary = `${max}/${n} models say ${lower(majority)}`;
      const outliers = [...verdictOf].filter(([, v]) => v !== majority);
      if (outliers.length > 0) lines.dissentSummary = `Dissent: ${outliers.map(([p, v]) => `${label(p)}: ${humanize(v)}`).join("; ")}`;
    }
  } else if (tally !== null && tally.usable > 0) {
    // Nothing about models: the recorded slot responses, qualified.
    pushQualified(
      `Panel slot responses: ${formatClaimVerdictCounts(tally.verdicts)}. ${claimSlotResponsesNote(tally)}`,
      basis.modelsIdentified ? "same_executing_model" : "independence_unverified"
    );
  }

  const split = splitClaimDisagreementsByIdentity(digest, sides);
  for (const p of split.betweenModels) {
    if (lines.disagreements.length >= DIGEST_CAP) break;
    const pair = split.providersOf(p);
    lines.disagreements.push(pair ? `${p.point} [${pair.map(label).join(", ")}]` : p.point);
  }
  for (const p of split.betweenSlots) {
    const [a, b] = p.models;
    const pa = typeof a === "string" ? sides.providerOfSlot[a.trim()] : undefined;
    const pb = typeof b === "string" ? sides.providerOfSlot[b.trim()] : undefined;
    pushQualified(p.point, pa && pa === pb ? "same_executing_model" : "independence_unverified");
  }
  return { rowLabels, lines, ...(consensusBasis ? { consensusBasis } : {}) };
}

/**
 * Order 6 / S-E.1 — whole-surface R6 wording scanner (test-only).
 *
 * S-E's obligation (now): the favourable labels E-1…E-8 that the owner ruled unsupported (D-10 (b)) appear nowhere on
 * a rendered Decision Support surface, and no surface states agreement, convergence, source assurance, review
 * necessity, option distinctness or certainty beyond what the stored result shows.
 *
 * S-2a's later obligation is different and is NOT asserted here: on a surface that renders the provenance block, every
 * remaining favourable statement must meet its §4.1 condition with the limitation visible on the same surface.
 *
 * Matching runs per text node and per reader-visible attribute, after removing sentinel spans (model-authored text,
 * see seSurfaceHarness.ts) and after removing the pinned, phrase-level exemptions below.
 */

import { SENTINEL_SPAN, type Surface } from "./seSurfaceHarness";

export type Family = { id: string; description: string; pattern: RegExp };

export const FAMILIES: Family[] = [
  { id: "F1-consensus-tier", description: "consensus tier word", pattern: /\b(strong|moderate|weak)\s+consensus\b/i },
  { id: "F2-convergence", description: "convergence / unanimity claim", pattern: /\bconverg\w*|\bunanim\w*|\buncontested\b|\ball models agree\b|\bno material split\b|\bgenuine(ly)? agree\w*/i },
  { id: "F3-source-assurance", description: "source assurance", pattern: /\bsource[- ]backed\b|\bevidence[- ]backed\b|\bverified sources?\b|\bfully supported\b|\bsource support captured\b|\bsource grounding\b/i },
  { id: "F4-review-necessity", description: "review necessity", pattern: /\breview (is )?not required\b|\bno (human )?review (is )?(needed|required)\b/i },
  { id: "F5-option-distinctness", description: "option distinctness", pattern: /\b(kept|remain|remains|stay|stays)\s+(distinct|separate)\b|\boptions are (distinct|separate)\b|\bnever (merged|grouped)\b/i },
  { id: "F6-certainty", description: "certainty claim", pattern: /\bcertain(ty)?\b|\bconfiden(t|ce)\b|\bguarantee\w*/i },
  { id: "F7-old-e-strings", description: "old E-1…E-8 wording", pattern: /reflects only genuine agreement|converged on this|assessment evidence strength|human review not required|no source support captured/i },
];

/**
 * Pinned exemptions: whole phrases that state a limitation, a detected split or the product name, never a favourable claim. Each must be
 * at least three words (validated) and must actually occur on a scanned surface (asserted by the spec), so an exemption
 * cannot silently widen into a bare word.
 */
export const EXEMPTIONS: string[] = [
  // "Panel split" badge tooltip — states a detected split.
  "own recommendations did not converge",
  // PanelEvidenceSection contested branch — states a detected split.
  "models did not fully converge",
  // E-7 suffix (owner-approved) and the shipped coverage sentence: both deny certainty.
  "These counts are not a certainty measure.",
  "not a certainty score",
  // Personal review page back link: the product name, not a convergence claim (F2 matches "converg…").
  "Back to ConvergePanel",
];

export function validateExemptions(exemptions: readonly string[]): string[] {
  const problems: string[] = [];
  for (const e of exemptions) {
    if (e.trim().split(/\s+/).length < 3) problems.push(`too broad (fewer than 3 words): ${JSON.stringify(e)}`);
    if (/[\\^$*+?()[\]{}|]/.test(e)) problems.push(`regex syntax not allowed: ${JSON.stringify(e)}`);
  }
  return problems;
}

/** A text node equal to a bare model-assigned strength ("Strong", "Weak: 2") is a qualifier-free E-8 badge. */
const BARE_STRENGTH = /^(strong|moderate|weak)(:\s*\d+)?$/i;

export type Hit = { surface: string; family: string; text: string };

export function scanSurface(
  surface: Surface,
  opts: { exemptions?: readonly string[]; stripSentinels?: boolean; families?: readonly Family[] } = {}
): Hit[] {
  const exemptions = opts.exemptions ?? EXEMPTIONS;
  const families = opts.families ?? FAMILIES;
  const strip = opts.stripSentinels ?? true;
  const hits: Hit[] = [];
  for (const raw of [...surface.textNodes, ...surface.attributes]) {
    let text = strip ? raw.replace(SENTINEL_SPAN, " ") : raw;
    for (const e of exemptions) text = text.split(e).join(" ");
    for (const f of families) if (f.pattern.test(text)) hits.push({ surface: surface.id, family: f.id, text: raw });
    if (BARE_STRENGTH.test(text.trim())) hits.push({ surface: surface.id, family: "F8-bare-strength", text: raw });
  }
  return hits;
}

/** Exemptions that matched at least once across the given surfaces. */
export function usedExemptions(surfaces: readonly Surface[], exemptions: readonly string[] = EXEMPTIONS): Set<string> {
  const used = new Set<string>();
  for (const s of surfaces) for (const raw of [...s.textNodes, ...s.attributes]) for (const e of exemptions) if (raw.includes(e)) used.add(e);
  return used;
}

/**
 * Not-blind guard: a surface must have produced real text and must contain every anchor of the components it is
 * supposed to include. An empty extraction, or a scan restricted to one component, fails here instead of passing
 * vacuously.
 */
export function assertNotBlind(surface: Surface, anchors: readonly string[], minChars = 200): string[] {
  const all = [...surface.textNodes, ...surface.attributes].join("\n");
  const problems: string[] = [];
  if (all.length < minChars) problems.push(`${surface.id}: only ${all.length} characters extracted`);
  for (const a of anchors) if (!all.includes(a)) problems.push(`${surface.id}: anchor missing: ${JSON.stringify(a)}`);
  return problems;
}

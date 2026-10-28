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
 * Matching runs on every text node and every reader-visible attribute, and again on the surface in reader order (all
 * text nodes joined by a space, and every run of two or three adjacent nodes glued), so a phrase split across inline
 * elements is still one phrase. Before matching, sentinel spans (model-authored text, see seSurfaceHarness.tsx), the
 * pinned phrase-level exemptions, exact-node field labels and stored-data debt (exact stored value, own marked field) are removed.
 */

import { SENTINEL_SPAN, type Surface } from "./seSurfaceHarness";

export type Family = { id: string; description: string; pattern: RegExp };

export const FAMILIES: Family[] = [
  { id: "F1-consensus-tier", description: "consensus claim (any consensus wording, tiered or bare)", pattern: /\bconsensus\b/i },
  {
    id: "F2-convergence",
    description: "convergence / agreement / unanimity / genuineness / no-disagreement claim",
    pattern:
      /\bconverg\w*|\bunanim\w*|\buncontested\b|\bagree(s|d|ing)?\b|\bagreement\b|\bconcur\w*|\bno (material )?(disagreement|split|dissent)\b|\baligned\b|\bsame (action|recommendation|option)\b|\bin accord\b|\bgenuine(ly)?\b|(?<!\bnot\s+)\b(all|every|each)(\s+(of the|the|\d+))?\s+models?\s+(recommended|chose|picked|selected|preferred|favou?red|backed|endorsed)\b/i,
  },
  {
    id: "F3-source-assurance",
    description: "source assurance",
    pattern:
      /\bsource[- ]backed\b|\bevidence[- ]backed\b|\bverified\b|\bfully supported\b|\bsource support captured\b|\bsource grounding\b|\bwell[- ]sourced\b|\bcorroborated\b|(?<!\b(?:no|none of the)\s+)\b(sources?|references?|citations?)\s*:?\s+((were|are|have been|was|is|has been)\s+)?(\w+ly\s+)?(checked|confirmed|validated)\b|\bsupported by (the )?sources\b/i,
  },
  {
    id: "F4-review-necessity",
    description: "review necessity",
    pattern:
      /\breview (is )?not (required|needed|necessary)\b|\bno (human )?review (is )?(needed|required|necessary)\b|\b(does not|doesn't) (need|require) (human )?review\b|\breview\s*(:|is)?\s*(optional|unnecessary)\b|\boptional\s+(human\s+)?review\b|\bnot flagged as needed\b/i,
  },
  { id: "F5-option-distinctness", description: "option distinctness", pattern: /\b(kept|remain|remains|stay|stays)\s+(distinct|separate)\b|\boptions are (distinct|separate)\b|\bnever (merged|grouped)\b/i },
  { id: "F6-certainty", description: "certainty claim", pattern: /\bcertain(ty|ly)?\b|\bconfiden(t|ce)\b|(?<!\b(?:not|never|cannot|can't|couldn't|unable to)\s+)\bconfidently\b|\bguarantee\w*|\bdefinitive(ly)?\b|\bproven\b/i },
  { id: "F7-old-e-strings", description: "old E-1…E-8 wording", pattern: /reflects only genuine agreement|converged on this|assessment evidence strength|human review not required|no source support captured/i },
];

/**
 * Pinned exemptions: whole phrases that state a limitation, a detected split or the product name, never a favourable
 * claim. Each must be at least three words (validated) and must actually occur on a scanned surface (asserted by the
 * spec), so an exemption cannot silently widen into a bare word.
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
  // E-2 / E-3 (owner-approved): denies verification.
  "not independently verified",
  // D-9 (owner-approved sealed text): denies agreement.
  "agreement on an option is not established",
  // E-1 / E-4 (owner-approved): the qualified form; a bare "No disagreement" is still caught.
  "No disagreement identified by current grouping",
  // E-7 (owner-approved D-2 template).
  "largest group recommending the same action",
];

/**
 * Stored-data debt (owner rulings 2026-10-28, R2 and R3): the producer's stored split rationale
 * (decisionSupportAlignment.ts:498) is kept byte-identical and still shown. A text node is exempt only when all of:
 *   1. it is inside an element marked `data-ds-field` — the DS rationale (the whole node) or a DS receipt conclusion
 *      (the tail after the builder's first " — ");
 *   2. that text is exactly equal to a stored rationale value the caller passes (`storedRationales`, the fixture's own
 *      stored field), so nothing appended or changed is exempt, whatever it ends with;
 *   3. that stored value parses under the producer's exact grammar (`isStoredSplitRationale`): the fixed sentence, then
 *      "(n of m pick X; n of m pick Y…)." with at least two picks, one shared m, and counts summing to m.
 * The same sentence anywhere else, any other stored value, and the :488 sentence (replaced on screen by
 * dsPresentedRationale / dsPresentedReceiptConclusion) are scanned like any other text.
 */
const SPLIT_RATIONALE_HEAD = "Models agree an option should be chosen but disagree on which one (";
export const STORED_FIELDS = { rationale: "recommendation.rationale", receiptConclusion: "receipt.conclusion" } as const;

export function isStoredSplitRationale(value: string): boolean {
  if (!value.startsWith(SPLIT_RATIONALE_HEAD) || !value.endsWith(").")) return false;
  const picks = value.slice(SPLIT_RATIONALE_HEAD.length, -2).split("; ");
  if (picks.length < 2) return false;
  let total: number | null = null;
  let sum = 0;
  for (const pick of picks) {
    const m = /^(\d+) of (\d+) pick (.+)$/.exec(pick);
    if (!m) return false;
    const [n, of] = [Number(m[1]), Number(m[2])];
    if (n < 1 || (total !== null && of !== total)) return false;
    total = of;
    sum += n;
  }
  return sum === total;
}

function withoutStoredDebt(text: string, field: string | null | undefined, stored: readonly string[]): string {
  const exempt = (value: string) => stored.includes(value) && isStoredSplitRationale(value);
  if (field === STORED_FIELDS.rationale) return exempt(text) ? " " : text;
  if (field === STORED_FIELDS.receiptConclusion) {
    const cut = text.indexOf(" — ");
    if (cut >= 0 && exempt(text.slice(cut + 3))) return text.slice(0, cut);
  }
  return text;
}

/**
 * Pinned field labels: a text node exactly equal to one of these is a heading the owner approved (K-6), not a claim.
 * Only an exact whole node is removed — "Model agreement: unanimous" is still scanned.
 */
export const FIELD_LABELS: string[] = ["Model agreement"];

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
  opts: { exemptions?: readonly string[]; stripSentinels?: boolean; families?: readonly Family[]; joined?: boolean; storedRationales?: readonly string[] } = {}
): Hit[] {
  const exemptions = opts.exemptions ?? EXEMPTIONS;
  const families = opts.families ?? FAMILIES;
  const strip = opts.stripSentinels ?? true;
  const clean = (raw: string) => {
    let text = strip ? raw.replace(SENTINEL_SPAN, " ") : raw;
    for (const e of exemptions) text = text.split(e).join(" ");
    return text;
  };
  const hits: Hit[] = [];
  // Stored-data debt: the exact stored value, in its own marked field only (see isStoredSplitRationale).
  const stored = opts.storedRationales ?? [];
  const textNodes = surface.textNodes.map((t, i) => withoutStoredDebt(t, surface.fields?.[i], stored));
  const nodes = [...textNodes, ...surface.attributes].filter((raw) => !FIELD_LABELS.includes(raw.trim()));
  for (const raw of nodes) {
    const text = clean(raw);
    for (const f of families) if (f.pattern.test(text)) hits.push({ surface: surface.id, family: f.id, text: raw });
    if (BARE_STRENGTH.test(text.trim())) hits.push({ surface: surface.id, family: "F8-bare-strength", text: raw });
  }
  // A phrase split across inline elements ("Human review <b>not required</b>") or JSX string children is one sentence
  // to a reader: scan the reader-order text of the whole surface too, nodes joined by a space. Exemptions apply to the
  // joined text as well, so an exempt phrase stays exempt however it is split. Only families the per-node pass did not
  // already report are added, so one violation is not counted twice.
  // Two reader-order views: the whole surface joined with a space (words split across elements), and every run of two
  // or three adjacent nodes glued with nothing (one word split across elements, "Source<em>-backed</em>"). A run starts
  // and ends on node edges, so gluing never fuses the last word of one sentence onto the first word of the next.
  if (opts.joined ?? true) {
    const seen = new Set(hits.map((h) => h.family));
    const nodes = textNodes.filter((t) => !FIELD_LABELS.includes(t.trim()));
    const views = [nodes.join(" ")];
    for (const size of [2, 3]) for (let i = 0; i + size <= nodes.length; i += 1) views.push(nodes.slice(i, i + size).join(""));
    for (const view of views) {
      const joined = clean(view);
      for (const f of families) {
        const m = joined.match(f.pattern);
        if (m && !seen.has(f.id)) {
          seen.add(f.id);
          hits.push({ surface: surface.id, family: f.id, text: `[joined] …${joined.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + m[0].length + 40)}…` });
        }
      }
    }
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

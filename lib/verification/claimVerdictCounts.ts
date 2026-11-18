/**
 * Claim verification — the per-model verdict DISTRIBUTION behind a stored aggregate label (doc 14 W1, PR-1).
 *
 * The stored aggregate vocabulary (`confirmed | disputed | partially_true | unverifiable`, claimVerdict.ts) has no value
 * for "the models rated it inaccurate", so `computeClaimVerdict` stores `disputed` for a panel in which no model
 * supported the claim (its fall-through). Every surface used to describe that label as disagreement ("Models
 * disagree…", "Models diverged…"). This module lets a surface state what the models actually answered, from the stored
 * rows, without changing the stored label, score, confidence, audit bundle or governance input:
 *  - counts come from usable rows only (`status: "ok"` with a recognised verdict) — the audit bundle's
 *    `perModel[].pipelineStatus/verdictLabel` on the server, or the payload rows on the client. NEVER from
 *    `aggregateSummary`, which folds parse_error / failed rows into "unverifiable";
 *  - a row set that cannot be counted truthfully (an unknown status, an "ok" row with an unknown verdict, a malformed
 *    bundle) yields `null`, and callers then show exactly what they showed before. Never a guessed count.
 *
 * These are counts of ANSWERS (panel slots with a usable verdict), not of independent executing models: a surface that
 * states a number of models still goes through the shared independence gate (lib/panel/executionIdentity.ts).
 * Pure and client-safe. Read-time only — nothing here is persisted, so it applies to historical records unchanged.
 */

import { canonicalProvider } from "@/lib/panel/providerRegistry";

export type ClaimModelVerdictCounts = {
  accurate: number;
  partially_accurate: number;
  inaccurate: number;
  unverifiable: number;
  /** Rows with a usable verdict (the sum of the four). */
  usable: number;
};

const PER_MODEL_VERDICTS = ["accurate", "partially_accurate", "inaccurate", "unverifiable"] as const;
type PerModelVerdict = (typeof PER_MODEL_VERDICTS)[number];
const PIPELINE_STATUSES: ReadonlySet<string> = new Set(["ok", "parse_error", "failed"]);

function isPerModelVerdict(v: unknown): v is PerModelVerdict {
  return typeof v === "string" && (PER_MODEL_VERDICTS as readonly string[]).includes(v);
}

/**
 * Counts usable verdicts over rows `{ status, verdict }`. Rows whose status is not "ok" (parse_error / failed, or a
 * client row without a status) are not answers and are not counted. Returns null when an "ok" row carries a verdict
 * outside the per-model vocabulary, or a row is not an object (the distribution cannot be stated truthfully).
 */
export function countClaimModelVerdicts(rows: ReadonlyArray<unknown>): ClaimModelVerdictCounts | null {
  const c: ClaimModelVerdictCounts = { accurate: 0, partially_accurate: 0, inaccurate: 0, unverifiable: 0, usable: 0 };
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as { status?: unknown; verdict?: unknown };
    if (r.status !== "ok") continue;
    if (!isPerModelVerdict(r.verdict)) return null;
    c[r.verdict] += 1;
    c.usable += 1;
  }
  return c;
}

const COUNT_KEYS = ["accurate", "partially_accurate", "inaccurate", "unverifiable", "usable"] as const;

/**
 * Parse of a counts object received over the wire: the five keys must each be a non-negative integer and `usable` the
 * sum of the four verdict counts; null otherwise (the caller then DROPS the counts for that row — it never fails the
 * page). Additional keys are ignored, so a later server may add counts without breaking this client.
 */
export function parseClaimModelVerdictCounts(v: unknown): ClaimModelVerdictCounts | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of COUNT_KEYS) {
    const n = o[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
  }
  const c = o as unknown as ClaimModelVerdictCounts;
  if (c.accurate + c.partially_accurate + c.inaccurate + c.unverifiable !== c.usable) return null;
  return { accurate: c.accurate, partially_accurate: c.partially_accurate, inaccurate: c.inaccurate, unverifiable: c.unverifiable, usable: c.usable };
}

/**
 * Counts usable verdicts from a stored audit bundle's `perModel` rows (`pipelineStatus` + `verdictLabel`) — the
 * server-side source of truth for the distribution. Null for an absent / malformed bundle or row.
 */
export function countClaimModelVerdictsFromAuditBundle(bundle: unknown): ClaimModelVerdictCounts | null {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return null;
  const perModel = (bundle as { perModel?: unknown }).perModel;
  if (!Array.isArray(perModel)) return null;
  const rows: Array<{ status: unknown; verdict: unknown }> = [];
  for (const raw of perModel) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const p = raw as { pipelineStatus?: unknown; verdictLabel?: unknown };
    if (typeof p.pipelineStatus !== "string" || !PIPELINE_STATUSES.has(p.pipelineStatus)) return null;
    rows.push({ status: p.pipelineStatus, verdict: p.verdictLabel });
  }
  return countClaimModelVerdicts(rows);
}

/**
 * What the stored rows record about the panel's SLOTS — actual responses, never an inferred number of independent
 * models (owner ruling 2026-11-18):
 *  - `slots`: rows recorded (one per selected model slot);
 *  - `usable`: slots with a parsed, recognised verdict (`verdicts` breaks them down per verdict);
 *  - `failed`: slots whose request failed; `malformed`: slots whose response had no recognised verdict (`parse_error`);
 *  - `substitutedUsable`: usable slots answered by a substitute model (the row records `substituted: true`);
 *  - `providers`: distinct RELIABLY IDENTIFIED executing providers (registered canonical tokens only) among the usable
 *    slots, or null when any usable slot records none or an unregistered token ("unknown", "acme", historical rows) —
 *    an unknown identity never inflates the count.
 * Null when a row cannot be classified (not an object, an unknown status, an "ok" row with an unknown verdict).
 */
export type ClaimSlotTally = {
  slots: number;
  usable: number;
  failed: number;
  malformed: number;
  substitutedUsable: number;
  providers: number | null;
  verdicts: ClaimModelVerdictCounts;
};

export function claimSlotTally(rows: ReadonlyArray<unknown>): ClaimSlotTally | null {
  const verdicts = countClaimModelVerdicts(rows);
  if (verdicts === null) return null;
  let failed = 0;
  let malformed = 0;
  let substitutedUsable = 0;
  const providers = new Set<string>();
  let providerUnknown = false;
  for (const raw of rows) {
    const r = raw as { status?: unknown; substituted?: unknown; provider?: unknown };
    if (r.status === "failed") failed += 1;
    else if (r.status === "parse_error") malformed += 1;
    else if (r.status === "ok") {
      if (r.substituted === true) substitutedUsable += 1;
      const p = canonicalProvider(r.provider);
      if (p !== null) providers.add(p);
      else providerUnknown = true;
    } else return null;
  }
  return { slots: rows.length, usable: verdicts.usable, failed, malformed, substitutedUsable, providers: providerUnknown ? null : providers.size, verdicts };
}

/**
 * The tally a claim payload states: its rows, cross-checked against the recorded audit bundle when that is countable —
 * if the two disagree on the per-verdict counts nothing is stated (null).
 */
export function claimPayloadSlotTally(data: { auditBundle?: unknown; modelEvidence?: ReadonlyArray<unknown> }): ClaimSlotTally | null {
  if (!Array.isArray(data.modelEvidence)) return null;
  const t = claimSlotTally(data.modelEvidence);
  if (t === null) return null;
  const fromBundle = countClaimModelVerdictsFromAuditBundle(data.auditBundle);
  if (fromBundle !== null && PER_MODEL_VERDICTS.some((v) => fromBundle[v] !== t.verdicts[v])) return null;
  return t;
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/**
 * One line disclosing what the slot counts are, or null when there is nothing beyond "every slot answered with its own
 * recorded provider": e.g. "3 of 5 slots answered; 1 failed; 1 malformed (no recognized verdict); 2 answered by a
 * substitute model; 2 distinct executing providers".
 */
export function claimSlotTallyNote(t: ClaimSlotTally): string | null {
  const parts: string[] = [];
  if (t.usable < t.slots) parts.push(`${t.usable} of ${n(t.slots, "slot", "slots")} answered`);
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  if (t.malformed > 0) parts.push(`${t.malformed} malformed (no recognized verdict)`);
  if (t.substitutedUsable > 0) parts.push(`${t.substitutedUsable} answered by a substitute model`);
  if (t.providers !== null && t.providers < t.usable) parts.push(n(t.providers, "distinct executing provider", "distinct executing providers"));
  return parts.length === 0 ? null : parts.join("; ");
}

/**
 * Who stands on which side, by RELIABLY IDENTIFIED executing provider (owner ruling 2026-11-18, R3). Over the usable
 * rows (status "ok", recognised verdict):
 *  - `reliable`: every usable row records a registered canonical provider (otherwise nothing below may support a
 *    statement about models);
 *  - `providers`: distinct identified providers; `accurateProviders` / `supportProviders`: providers with an accurate /
 *    an accurate-or-partially-accurate answer;
 *  - `crossModelDisagreement`: a supporting answer and an inaccurate answer come from two DIFFERENT identified providers
 *    (one substitute that answered both sides is differing slot responses, not a disagreement between models);
 *  - `supportAgreement`: at least two different identified providers gave a supporting answer;
 *  - `consistent`: every identified provider answered all its slots with the same verdict;
 *  - `providerOfSlot`: the identified provider of each usable slot (by modelId).
 * No score: identities and observations only.
 */
export type ClaimProviderSides = {
  reliable: boolean;
  providers: number;
  accurateProviders: number;
  supportProviders: number;
  crossModelDisagreement: boolean;
  supportAgreement: boolean;
  consistent: boolean;
  providerOfSlot: Readonly<Record<string, string>>;
};

export function claimProviderSides(rows: ReadonlyArray<unknown>): ClaimProviderSides {
  const usable: Array<{ modelId: string; verdict: PerModelVerdict; provider: string | null }> = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as { modelId?: unknown; status?: unknown; verdict?: unknown; provider?: unknown };
    if (r.status !== "ok" || !isPerModelVerdict(r.verdict)) continue;
    usable.push({ modelId: String(r.modelId ?? "").trim(), verdict: r.verdict, provider: canonicalProvider(r.provider) });
  }
  const reliable = usable.length > 0 && usable.every((u) => u.provider !== null);
  const providerOfSlot: Record<string, string> = {};
  const verdictsBy = new Map<string, Set<PerModelVerdict>>();
  for (const u of usable) {
    if (u.provider === null) continue;
    providerOfSlot[u.modelId] = u.provider;
    verdictsBy.set(u.provider, new Set([...(verdictsBy.get(u.provider) ?? []), u.verdict]));
  }
  const withVerdict = (pred: (v: PerModelVerdict) => boolean) => new Set(usable.filter((u) => u.provider !== null && pred(u.verdict)).map((u) => u.provider as string));
  const support = withVerdict((v) => v === "accurate" || v === "partially_accurate");
  const inaccurate = withVerdict((v) => v === "inaccurate");
  return {
    reliable,
    providers: verdictsBy.size,
    accurateProviders: withVerdict((v) => v === "accurate").size,
    supportProviders: support.size,
    crossModelDisagreement: reliable && [...support].some((s) => [...inaccurate].some((i) => i !== s)),
    supportAgreement: reliable && support.size >= 2,
    consistent: reliable && [...verdictsBy.values()].every((v) => v.size === 1),
    providerOfSlot,
  };
}

/**
 * Split digest conflict points: a pair is between two models only when both slots are usable with two DIFFERENT
 * identified providers; every other pair is a difference between panel slot responses.
 */
export function splitClaimDisagreementsByIdentity<T extends { models: string[] }>(points: readonly T[], sides: ClaimProviderSides): { betweenModels: T[]; betweenSlots: T[] } {
  const betweenModels: T[] = [];
  const betweenSlots: T[] = [];
  for (const p of points) {
    const [a, b] = p.models ?? [];
    const pa = sides.reliable && typeof a === "string" ? sides.providerOfSlot[a.trim()] : undefined;
    const pb = sides.reliable && typeof b === "string" ? sides.providerOfSlot[b.trim()] : undefined;
    (pa && pb && pa !== pb ? betweenModels : betweenSlots).push(p);
  }
  return { betweenModels, betweenSlots };
}

/** One sentence qualifying slot-response counts, with the slot note when there is one. */
export function claimSlotResponsesNote(t: ClaimSlotTally): string {
  const note = claimSlotTallyNote(t);
  return `These counts are of panel slot responses, not of agreeing models${note ? ` (${note})` : ""}.`;
}

/** Banner wording for a stored `disputed` whose opposing responses do not come from two identified models. */
export const CLAIM_SLOT_RESPONSES_DIFFER_TITLE = "Panel slot responses differ on this claim";
export const CLAIM_SLOT_RESPONSES_DIFFER_SUBTITLE =
  "Recorded verdict: Disputed. The opposing responses did not come from two reliably identified executing models, so this is not a disagreement between models.";

/**
 * Shape of the distribution (internal, never persisted or exported — not an API enum):
 *  - "unanimous": every usable answer has the same verdict;
 *  - "no_support": no answer rated it accurate or partially accurate, at least one rated it inaccurate, not unanimous;
 *  - "split": at least one answer supports it (accurate / partially accurate) AND at least one rated it inaccurate;
 *  - "other": anything else (including no usable answer).
 */
export type ClaimVerdictShape = "unanimous" | "no_support" | "split" | "other";

export function claimVerdictShape(c: ClaimModelVerdictCounts): ClaimVerdictShape {
  if (c.usable === 0) return "other";
  if (PER_MODEL_VERDICTS.some((v) => c[v] === c.usable)) return "unanimous";
  const support = c.accurate + c.partially_accurate;
  if (support === 0 && c.inaccurate > 0) return "no_support";
  if (support > 0 && c.inaccurate > 0) return "split";
  return "other";
}

/**
 * True when a stored `disputed` label sits over answers none of which supported the claim (and at least one rated it
 * inaccurate): the label then must NOT be described as disagreement between models. False for a genuine split (an
 * answer on each side), for any other label, and when the counts are unknown (callers keep their wording).
 */
export function isDisputedWithoutSupport(verdict: unknown, c: ClaimModelVerdictCounts | null): c is ClaimModelVerdictCounts {
  return verdict === "disputed" && c !== null && c.usable > 0 && c.accurate + c.partially_accurate === 0 && c.inaccurate > 0;
}

/** True when answers sit on both sides (supporting vs inaccurate): a confidence label is then shown with the split. */
export function hasSplitVerdicts(c: ClaimModelVerdictCounts | null): c is ClaimModelVerdictCounts {
  return c !== null && c.accurate + c.partially_accurate > 0 && c.inaccurate > 0;
}

const VERDICT_WORDS: Record<PerModelVerdict, string> = {
  accurate: "accurate",
  partially_accurate: "partially accurate",
  inaccurate: "inaccurate",
  unverifiable: "unverifiable",
};

/** "4 accurate, 1 inaccurate" — the non-zero verdicts in a fixed order. Empty string when nothing is usable. */
export function formatClaimVerdictCounts(c: ClaimModelVerdictCounts): string {
  return PER_MODEL_VERDICTS.filter((v) => c[v] > 0)
    .map((v) => `${c[v]} ${VERDICT_WORDS[v]}`)
    .join(", ");
}

/**
 * The no-support statement over `total` answering units (models or answers — the caller supplies the unit it may
 * state): "3 of 3 models rated this claim inaccurate" / "3 of 4 models rated this claim inaccurate; 1 could not verify it".
 */
export function claimNoSupportStatement(args: { inaccurate: number; unverifiable: number; total: number; unit: (n: number) => string }): string {
  const { inaccurate, unverifiable, total, unit } = args;
  const head = `${inaccurate} of ${total} ${unit(total)} rated this claim inaccurate`;
  return unverifiable > 0 ? `${head}; ${unverifiable} could not verify it` : head;
}

/**
 * Memo / clipboard sentence for a stored `disputed` label over answers none of which supported the claim (counts of
 * answers with a usable verdict, never of models).
 */
export function claimNoSupportAnswerSentence(c: ClaimModelVerdictCounts): string {
  const tail = c.unverifiable > 0 ? ` and ${c.unverifiable} could not verify it` : "";
  return `No answer supported the claim: ${c.inaccurate} of ${c.usable} rated it inaccurate${tail}.`;
}

/** Banner subtitle for that case: the stored label is named, and not described as disagreement. */
export const CLAIM_NO_SUPPORT_BANNER_SUBTITLE =
  "No model supported the claim. The recorded verdict is Disputed; it does not mean the models disagreed.";

/** "verdicts split: 4 accurate, 1 inaccurate" — the qualifier shown with a confidence label over split answers. */
export function claimSplitVerdictsQualifier(c: ClaimModelVerdictCounts): string {
  return `verdicts split: ${formatClaimVerdictCounts(c)}`;
}

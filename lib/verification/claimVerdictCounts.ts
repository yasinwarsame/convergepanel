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
 * Strict parse of a counts object received over the wire: exactly the five keys, each a non-negative integer, and
 * `usable` the sum of the four verdict counts. Null otherwise.
 */
export function parseClaimModelVerdictCounts(v: unknown): ClaimModelVerdictCounts | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== COUNT_KEYS.length || !COUNT_KEYS.every((k) => keys.includes(k))) return null;
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
 * The counts a claim client payload states: from its audit bundle when that is countable, else from its rows (both are
 * written from the same rows by the verify routes; the bundle is the recorded audit form).
 */
export function claimPayloadVerdictCounts(data: { auditBundle?: unknown; modelEvidence?: ReadonlyArray<unknown> }): ClaimModelVerdictCounts | null {
  return countClaimModelVerdictsFromAuditBundle(data.auditBundle) ?? (Array.isArray(data.modelEvidence) ? countClaimModelVerdicts(data.modelEvidence) : null);
}

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

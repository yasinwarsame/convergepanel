/**
 * Order 5 Contract C1 (claim-tie attribution) — test-only oracles. Nothing here imports trustSummary.ts: the tests
 * compare the candidate against these independent copies, never against the candidate's own legacy branch.
 *
 * - legacyTrust: a frozen copy of the shipped 625773767 trust algorithm (trustSummary.ts at that SHA), with the
 *   weight and cap tables frozen as literals, so a change to config.ts cannot move the oracle with the candidate.
 * - oracleIsEligibleClaimTie: the oracle-side eligibility + tie predicate (O-P strictness condition 1).
 * - claimTieReference: an independently written reference of the approved rule (owner ruling, O-M claim ties):
 *   on an eligible claim-origin tie nobody is credited, and only an explicit `disputes` on a split row is a
 *   contradiction; every other row is scored exactly as legacyTrust scores it.
 * - groundingTier: reportSummary.ts deriveSourceGrounding's no-meta branch (tierFromRatio(overallTrust, 0.6, 0.35)).
 */

export const FROZEN_WEIGHTS: Record<string, { citation: number; consistency: number; contradiction: number }> = {
  factual_lookup: { citation: 0.5, consistency: 0.3, contradiction: 0.2 },
  medical_health: { citation: 0.45, consistency: 0.3, contradiction: 0.25 },
  legal_regulatory: { citation: 0.45, consistency: 0.3, contradiction: 0.25 },
  financial_valuation: { citation: 0.2, consistency: 0.55, contradiction: 0.25 },
  forecast_speculative: { citation: 0.2, consistency: 0.5, contradiction: 0.3 },
  procedural: { citation: 0.15, consistency: 0.55, contradiction: 0.3 },
  contested_empirical: { citation: 0.3, consistency: 0.3, contradiction: 0.4 },
  creative_generative: { citation: 0.1, consistency: 0.4, contradiction: 0.5 },
  generic: { citation: 0.3, consistency: 0.35, contradiction: 0.35 },
};
export const FROZEN_CAPS: Record<string, number | null> = { ok: null, degraded: 0.75, failed: 0 };

type Cell = { modelId: string; stance: string; origin?: { kind?: string }; backfilled?: boolean; raw?: unknown } | null;
type Row = { cells: Cell[]; status: string };
type Schema = { id: string; fields: { key: string; type: string }[] };
type Result = { modelId: string; ok: boolean; data?: Record<string, any> | null; truncatedFields?: string[] };

function parseHealth(r: Result): "ok" | "degraded" | "failed" {
  if (!r.ok) return "failed";
  if (r.truncatedFields && r.truncatedFields.length > 0) return "degraded";
  return "ok";
}

function claimsContributed(schema: Schema, r: Result): number {
  if (!r.ok || !r.data) return 0;
  let n = 0;
  for (const f of schema.fields) {
    if (f.type === "claim[]" || f.type === "metric[]" || f.type === "step[]" || f.type === "scenario[]") {
      const v = r.data[f.key];
      if (Array.isArray(v)) n += v.length;
    }
  }
  return n;
}

function realSource(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s.length > 0 && s !== "unknown" && s !== "none" && s !== "n/a";
}

function citation(schema: Schema, r: Result): number {
  if (!r.ok || !r.data) return 0;
  const vals: (string | null | undefined)[] = [];
  for (const f of schema.fields.filter((x) => x.type === "metric[]")) for (const m of (r.data[f.key] as any[] | undefined) || []) vals.push(m.source);
  if (schema.id === "factual_lookup") vals.push(r.data["source"]);
  if (vals.length === 0) return 1;
  return vals.filter(realSource).length / vals.length;
}

/** Shipped majorityStance: mode, first-seen tie-break. */
function legacyMajority(row: Row): string | null {
  const counts = new Map<string, number>();
  for (const c of row.cells) {
    if (!c) continue;
    counts.set(c.stance, (counts.get(c.stance) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [s, n] of counts) {
    if (n > bestCount) {
      best = s;
      bestCount = n;
    }
  }
  return best;
}

export interface OracleSlot {
  modelId: string;
  claimsContributed: number;
  majorityAlignment: number;
  citationScore: number;
  contradictionCount: number;
  parseHealth: "ok" | "degraded" | "failed";
  trustScore: number;
  capped: boolean;
}
export interface OracleSummary {
  perModel: OracleSlot[];
  overallTrust: number;
}

/** Row attribution for one slot: [participated, aligned, contradicted]. */
type Attribution = (row: Row, cell: NonNullable<Cell>, rowIsTie: boolean) => [number, number];

function compose(schema: Schema, results: Result[], rows: Row[], attribute: Attribution, tieFlags: boolean[]): OracleSummary {
  const w = FROZEN_WEIGHTS[schema.id] ?? FROZEN_WEIGHTS.generic;
  const perModel = results.map((r) => {
    const ph = parseHealth(r);
    let p = 0;
    let a = 0;
    let x = 0;
    rows.forEach((row, i) => {
      const c = row.cells.find((cc) => cc?.modelId === r.modelId);
      if (!c) return;
      p += 1;
      const [al, con] = attribute(row, c, tieFlags[i]);
      a += al;
      x += con;
    });
    const ma = p > 0 ? a / p : 1;
    const cs = citation(schema, r);
    const raw = w.citation * cs + w.consistency * ma + w.contradiction * (1 - (p > 0 ? x / p : 0));
    const cap = FROZEN_CAPS[ph];
    return {
      modelId: r.modelId,
      claimsContributed: claimsContributed(schema, r),
      majorityAlignment: ma,
      citationScore: cs,
      contradictionCount: x,
      parseHealth: ph,
      trustScore: cap === null ? raw : Math.min(raw, cap),
      capped: cap !== null && raw > cap,
    };
  });
  const scored = perModel.filter((m) => m.parseHealth !== "failed");
  return { perModel, overallTrust: scored.length > 0 ? scored.reduce((s, m) => s + m.trustScore, 0) / scored.length : 0 };
}

const legacyAttribution: Attribution = (row, c) => {
  const dom = legacyMajority(row);
  if (dom && c.stance === dom) return [1, 0];
  if (row.status === "split" && c.stance === "disputes") return [0, 1];
  return [0, 0];
};

/** The frozen 625773767 algorithm. */
export function legacyTrust(schema: Schema, results: Result[], rows: Row[]): OracleSummary {
  return compose(schema, results, rows, legacyAttribution, rows.map(() => false));
}

const STANCES = ["agrees", "disputes", "partial", "unclear"];

/**
 * Oracle-side eligibility + tie predicate, written apart from the candidate's. Eligible: at least two non-null
 * cells; every one a claim cell (origin claim, not backfilled, no raw value) or an inferred cell (origin inferred,
 * backfilled, no raw value); a known stance; a distinct slot id that names exactly one result. Tied: the top stance
 * count is shared by at least two stances.
 */
export function oracleIsEligibleClaimTie(row: Row, results: Result[]): boolean {
  const present = row.cells.filter((c): c is NonNullable<Cell> => c !== null && c !== undefined);
  if (present.length < 2) return false;
  const ids: string[] = [];
  for (const c of present) {
    const kind = c.origin?.kind;
    const claimCell = kind === "claim" && c.backfilled !== true && c.raw === undefined;
    const inferredCell = kind === "inferred" && c.backfilled === true && c.raw === undefined;
    if (!claimCell && !inferredCell) return false;
    if (!STANCES.includes(c.stance)) return false;
    if (typeof c.modelId !== "string" || ids.includes(c.modelId)) return false;
    if (results.filter((r) => r.modelId === c.modelId).length !== 1) return false;
    ids.push(c.modelId);
  }
  const tally = STANCES.map((s) => present.filter((c) => c.stance === s).length);
  const top = Math.max(...tally);
  return tally.filter((n) => n === top).length >= 2;
}

/** Independent reference of the approved claim-tie rule. */
export function claimTieReference(schema: Schema, results: Result[], rows: Row[]): OracleSummary & { ties: number } {
  const flags = rows.map((r) => oracleIsEligibleClaimTie(r, results));
  const attribution: Attribution = (row, c, tie) => {
    if (!tie) return legacyAttribution(row, c, false);
    return [0, row.status === "split" && c.stance === "disputes" ? 1 : 0];
  };
  return { ...compose(schema, results, rows, attribution, flags), ties: flags.filter(Boolean).length };
}

export type Grounding = "strong" | "moderate" | "weak";
export function groundingTier(overallTrust: number): Grounding {
  return overallTrust >= 0.6 ? "strong" : overallTrust >= 0.35 ? "moderate" : "weak";
}
export const GROUNDING_RANK: Record<Grounding, number> = { weak: 0, moderate: 1, strong: 2 };

/**
 * Order 5 Contract C1 — claim-origin tie attribution (owner ruling ORDER5_C1_CLAIM_TIE_LOCAL_IMPLEMENTATION_AUTHORIZED).
 *
 * On an eligible claim-origin tie the row stays participated, no slot is credited, and only a slot recorded as
 * "disputes" on a split row counts a contradiction. Every other row (scalar, metric, scenario, step, mixed or unknown
 * origin, untied) keeps the shipped rule. The candidate is compared with:
 * - the values the shipped 625773767 code produced for the same fixtures (__fixtures__/baseline-62577376);
 * - a frozen copy of the shipped algorithm (claimTieOracle.legacyTrust) — never the candidate's own legacy branch;
 * - an independent reference of the approved rule (claimTieOracle.claimTieReference), for exact values.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { buildAdaptiveTrustSummary } from "@/lib/adaptiveSchema/trustSummary";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { computeRunCertainty } from "@/lib/adaptiveSchema/scoring";
import { deriveSourceGrounding } from "@/lib/adaptiveSchema/reportSummary";
import { CLAIM_TIE_ATTRIBUTION_RULE } from "@/lib/adaptiveSchema/types";
import type { AdaptiveModelResult, AdaptiveTrustSummary, AlignedClaim, AlignedClaimCell, AlignedClaimStatus, ClaimCellStance } from "@/lib/adaptiveSchema/types";
import type { ModelId } from "@/lib/types";
import {
  FIXTURES,
  SLOTS,
  claimCell,
  degradedResult,
  derivedCell,
  failedResult,
  inferredCell,
  okResult,
  row,
  scalarRow,
  trustRank,
  unknownCell,
} from "./claimTieFixtures";
import { GROUNDING_RANK, claimTieReference, groundingTier, legacyTrust, oracleIsEligibleClaimTie } from "./claimTieOracle";

const baseline: Record<string, any> = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-62577376", "claimTieBaseline.json"), "utf8"));
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const EPS = 1e-12;

function build(schemaId: string, results: AdaptiveModelResult[], rows: AlignedClaim[]): AdaptiveTrustSummary {
  return buildAdaptiveTrustSummary(getResultSchema(schemaId as any), results, rows);
}
function withoutRule(t: AdaptiveTrustSummary) {
  const { attributionRule: _r, ...rest } = plain(t);
  return rest;
}
function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x as object)) deepFreeze(v);
  }
  return x;
}
const bySlot = (t: { perModel: any[] }) => Object.fromEntries(t.perModel.map((m) => [m.modelId, m]));
/** Sorted-key JSON; hot loops compare these strings and throw with context (jest deep-equal is too slow at this size). */
const canon = (x: any): string =>
  Array.isArray(x)
    ? `[${x.map(canon).join(",")}]`
    : x && typeof x === "object"
      ? `{${Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(",")}}`
      : JSON.stringify(x);
function same(a: unknown, b: unknown, ctx: string) {
  const x = canon(a);
  const y = canon(b);
  if (x !== y) throw new Error(`${ctx}\n  got      ${x}\n  expected ${y}`);
}

/** Asserts candidate ≤ frozen legacy for every slot, overall and grounding, and capped never false → true. */
function expectNotUpward(cand: AdaptiveTrustSummary, legacy: ReturnType<typeof legacyTrust>, ctx: string) {
  const L = bySlot(legacy);
  for (const m of cand.perModel) {
    const l = L[m.modelId];
    if (m.trustScore > l.trustScore + EPS) throw new Error(`${ctx}: ${m.modelId} trust rose ${l.trustScore} -> ${m.trustScore}`);
    if (m.majorityAlignment > l.majorityAlignment + EPS) throw new Error(`${ctx}: ${m.modelId} alignment rose`);
    if (m.contradictionCount < l.contradictionCount) throw new Error(`${ctx}: ${m.modelId} contradictions fell`);
    if (m.capped && !l.capped) throw new Error(`${ctx}: ${m.modelId} capped false -> true`);
  }
  if (cand.overallTrust > legacy.overallTrust + EPS) throw new Error(`${ctx}: overall rose ${legacy.overallTrust} -> ${cand.overallTrust}`);
  if (GROUNDING_RANK[groundingTier(cand.overallTrust)] > GROUNDING_RANK[groundingTier(legacy.overallTrust)]) throw new Error(`${ctx}: grounding improved`);
}

/**
 * Semantic validity of every changed contradiction: a slot's added contradictions are exactly its explicit
 * "disputes" on eligible split ties where the frozen legacy rule had credited it instead; nothing else.
 */
function expectContradictionsJustified(results: AdaptiveModelResult[], rows: AlignedClaim[], cand: AdaptiveTrustSummary, legacy: ReturnType<typeof legacyTrust>, ctx: string) {
  const L = bySlot(legacy);
  for (const m of cand.perModel) {
    let justified = 0;
    for (const r of rows) {
      const c = r.cells.find((x) => x?.modelId === m.modelId);
      if (!c || !oracleIsEligibleClaimTie(r as any, results as any)) continue;
      if (r.status === "split" && c.stance === "disputes") {
        const legacyOnly = legacyTrust({ id: "generic", fields: [] }, [okResult(m.modelId)] as any, [r] as any).perModel[0];
        if (legacyOnly.contradictionCount === 0) justified += 1;
      }
    }
    if (m.contradictionCount - L[m.modelId].contradictionCount !== justified) throw new Error(`${ctx}: ${m.modelId} contradiction delta not justified`);
  }
}

describe("fixtures vs the shipped 62577376 baseline", () => {
  it("every fixture has a captured baseline, and the frozen oracle still reproduces it", () => {
    expect(Object.keys(baseline).sort()).toEqual(FIXTURES.map((f) => f.name).sort());
    for (const f of FIXTURES) {
      expect(plain(legacyTrust(getResultSchema(f.schemaId as any) as any, f.results() as any, f.rows() as any))).toEqual(baseline[f.name].trustSummary);
    }
  });

  it.each(FIXTURES.map((f) => f.name))("%s", (name) => {
    const f = FIXTURES.find((x) => x.name === name)!;
    const rows = deepFreeze(f.rows());
    const results = deepFreeze(f.results());
    const b = baseline[name];
    const t = build(f.schemaId, results, rows);
    // The oracle-side predicate agrees with the fixture's declared class.
    expect(rows.some((r) => oracleIsEligibleClaimTie(r as any, results as any))).toBe(f.tie);
    if (!f.tie) {
      // Unaffected: byte-identical to what the shipped code produced, no attribution marker.
      expect(plain(t)).toEqual(b.trustSummary);
      expect("attributionRule" in t).toBe(false);
    } else {
      expect(t.attributionRule).toBe("claim_tie_no_majority_credit_v1");
      const ref = claimTieReference(getResultSchema(f.schemaId as any) as any, results as any, rows as any);
      const { ties: _t, ...refSummary } = ref;
      expect(withoutRule(t)).toEqual(plain(refSummary));
      expectNotUpward(t, b.trustSummary, name);
      expectContradictionsJustified(results, rows, t, b.trustSummary, name);
    }
    // Core identity on the same rows: certainty and gate are unchanged (trust is never an input to either).
    const certainty = computeRunCertainty(rows, f.schemaId as any);
    expect(certainty).toBe(b.certainty);
    expect(plain(computeAdaptiveGate(rows, certainty, f.schemaId as any))).toEqual(b.gate);
    // Grounding is the shipped derivation over the candidate's overall trust, never better than baseline.
    const g = deriveSourceGrounding({ trustSummary: t });
    expect(GROUNDING_RANK[g as "strong"]).toBeLessThanOrEqual(GROUNDING_RANK[b.grounding as "strong"]);
    if (!f.tie) {
      expect(g).toBe(b.grounding);
      expect(trustRank(t)).toEqual(b.trustRank);
    }
  });
});

describe("hand-computed values (generic weights 0.3 / 0.35 / 0.35, procedural 0.15 / 0.55 / 0.3)", () => {
  const v = (name: string) => {
    const f = FIXTURES.find((x) => x.name === name)!;
    const t = build(f.schemaId, f.results(), f.rows());
    return Object.fromEntries(t.perModel.map((m) => [m.modelId, [Number(m.trustScore.toFixed(4)), m.majorityAlignment, m.contradictionCount, m.capped]]));
  };
  it("1–1 agrees/disputes split: nobody credited, the disputing slot contradicted, in both orders", () => {
    expect(v("claim-1-1-agrees-disputes-split")).toEqual({ chatgpt: [0.65, 0, 0, false], claude: [0.3, 0, 1, false] });
    expect(v("claim-1-1-disputes-agrees-split")).toEqual({ chatgpt: [0.3, 0, 1, false], claude: [0.65, 0, 0, false] });
  });
  it("three-way split: only the explicit dispute is a contradiction", () => {
    expect(v("claim-three-way-split")).toEqual({ chatgpt: [0.65, 0, 0, false], claude: [0.3, 0, 1, false], grok: [0.65, 0, 0, false] });
  });
  it("2–2 agrees/disputes split", () => {
    expect(v("claim-2-2-agrees-disputes-split")).toEqual({ chatgpt: [0.65, 0, 0, false], claude: [0.3, 0, 1, false], grok: [0.65, 0, 0, false], perplexity: [0.3, 0, 1, false] });
  });
  it("partial/disputes split (procedural)", () => {
    expect(v("claim-1-1-partial-disputes-split")).toEqual({ chatgpt: [0.45, 0, 0, false], claude: [0.15, 0, 1, false] });
  });
  it("agrees/unclear and agrees/partial ties: nobody credited, nobody contradicted", () => {
    expect(v("claim-1-1-agrees-unclear-majority")).toEqual({ chatgpt: [0.65, 0, 0, false], claude: [0.65, 0, 0, false] });
    expect(v("claim-2-2-agrees-partial-majority")).toEqual({ chatgpt: [0.65, 0, 0, false], claude: [0.65, 0, 0, false], grok: [0.65, 0, 0, false], perplexity: [0.65, 0, 0, false] });
  });
  it("a tied row that is not split assigns no contradiction, even to a disputing slot", () => {
    const r = v("claim-nonsplit-tie-with-dispute");
    expect(Object.values(r)).toEqual(Array(5).fill([0.65, 0, 0, false]));
  });
  it("degraded slot: the cap stops binding only because raw trust fell below it", () => {
    expect(baseline["degraded-cap-transition"].trustSummary.perModel[0]).toMatchObject({ trustScore: 0.75, capped: true, parseHealth: "degraded" });
    expect(v("degraded-cap-transition")).toEqual({ chatgpt: [0.65, 0, 0, false], claude: [0.3, 0, 1, false] });
    // raw 0.3 + 0.35·3/4 + 0.35 = 0.9125 > 0.75: still capped.
    expect(v("degraded-cap-still-binding").chatgpt).toEqual([0.75, 0.75, 0, true]);
  });
  it("run 964: claude keeps its published contradiction; chatgpt loses the slot-order credit; overall 0.575 → 0.4833", () => {
    expect(v("run-964")).toEqual({ chatgpt: [0.8167, 2 / 3, 0, false], claude: [0.15, 0, 1, false] });
    expect(v("run-964-reversed")).toEqual({ claude: [0.15, 0, 1, false], chatgpt: [0.8167, 2 / 3, 0, false] });
    const f = FIXTURES.find((x) => x.name === "run-964")!;
    const t = build(f.schemaId, f.results(), f.rows());
    expect(Number(t.overallTrust.toFixed(4))).toBe(0.4833);
    expect(deriveSourceGrounding({ trustSummary: t })).toBe("moderate");
    expect(baseline["run-964"].grounding).toBe("moderate");
    expect(baseline["run-964-reversed"].grounding).toBe("strong");
  });
});

// ─── Exhaustive claim-stance domain: exact reference, order independence, monotonicity ──────────────────────────

const STANCES: (ClaimCellStance | null)[] = ["agrees", "disputes", "partial", "unclear", null];
const STATUSES: AlignedClaimStatus[] = ["split", "majority", "limited_coverage", "consensus"];

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}
function* assignments(n: number): Generator<(ClaimCellStance | null)[]> {
  const idx = Array(n).fill(0);
  for (;;) {
    yield idx.map((i) => STANCES[i]);
    let k = 0;
    while (k < n && ++idx[k] === STANCES.length) idx[k++] = 0;
    if (k === n) return;
  }
}

describe("exhaustive single-row claim domain (n = 2..5 slots, every stance incl. silent, 4 statuses, 3 health variants; every order for n ≤ 4, three for n = 5)", () => {
  it("exact reference, monotone vs the frozen legacy oracle, identical in every slot order", () => {
    const counts = { evaluations: 0, ties: 0, changed: 0 };
    for (const n of [2, 3, 4, 5]) {
      const slots = SLOTS.slice(0, n);
      const orders = n <= 4 ? permutations(slots.map((_, i) => i)) : [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3]];
      for (const stances of assignments(n)) {
        for (const status of STATUSES) {
          for (const health of ["ok", "degraded0", "failedLast"] as const) {
            const mk = (i: number) => (health === "degraded0" && i === 0 ? degradedResult(slots[i]) : health === "failedLast" && i === n - 1 ? failedResult(slots[i]) : okResult(slots[i]));
            let reference: Record<string, string> | null = null;
            for (const order of orders) {
              const results = order.map(mk);
              const rows = [row("r", status, order.map((i) => (stances[i] ? (i % 2 ? inferredCell(slots[i], stances[i]!) : claimCell(slots[i], stances[i]!)) : null)))];
              const t = build("generic", results, rows);
              const legacy = legacyTrust({ id: "generic", fields: [] }, results as any, rows as any);
              const ref = claimTieReference({ id: "generic", fields: [] }, results as any, rows as any);
              counts.evaluations += 1;
              const { ties, ...refSummary } = ref;
              const ctx = `n=${n} ${stances} ${status} ${health} ${order}`;
              same(withoutRule(t), refSummary, ctx);
              if (t.attributionRule !== (ties > 0 ? CLAIM_TIE_ATTRIBUTION_RULE : undefined)) throw new Error(`${ctx}: attributionRule ${t.attributionRule}`);
              if (ties === 0) same(t, legacy, ctx);
              else counts.ties += 1;
              expectNotUpward(t, legacy, `n=${n} ${stances} ${status} ${health} ${order}`);
              expectContradictionsJustified(results, rows, t, legacy, `n=${n} ${stances} ${status} ${health}`);
              if (canon(withoutRule(t)) !== canon(legacy)) counts.changed += 1;
              // Order independence: the per-slot attribution is the same multiset-determined value in every order.
              const key = Object.fromEntries(t.perModel.map((m) => [m.modelId, `${m.trustScore.toFixed(12)}|${m.majorityAlignment}|${m.contradictionCount}|${m.capped}`]));
              if (ties > 0) {
                if (reference === null) reference = key;
                else same(key, reference, `order dependence: ${ctx}`);
              }
            }
          }
        }
      }
    }
    expect(counts.ties).toBeGreaterThan(10_000);
    expect(counts.changed).toBeGreaterThan(1_000);
    // eslint-disable-next-line no-console
    console.info(`[o5c] exhaustive claim domain: ${JSON.stringify(counts)}`);
  });
});

describe("scalar rows are never touched (the rule is claim-origin only)", () => {
  const VALUES = ["Paris", "Lyon", "paris", "Rome", "Paris.", "?", null];
  it("every scalar value assignment n = 2..4 in both schemas, every order: exactly the frozen legacy values, no marker", () => {
    let evaluations = 0;
    for (const schemaId of ["factual_lookup", "legal_regulatory"]) {
      for (const n of [2, 3, 4]) {
        const slots = SLOTS.slice(0, n);
        const idx = Array(n).fill(0);
        for (;;) {
          const values = idx.map((i) => VALUES[i]);
          for (const order of permutations(slots.map((_, i) => i))) {
            const ordered = order.map((i) => slots[i]);
            const results = ordered.map((m) => okResult(m, schemaId));
            const rows = [scalarRow("answer", order.map((i) => values[i]), ordered)];
            const t = build(schemaId, results, rows);
            same(t, legacyTrust(getResultSchema(schemaId as any) as any, results as any, rows as any), `scalar ${schemaId} ${values} ${order}`);
            if ("attributionRule" in t) throw new Error(`scalar ${values}: attributionRule set`);
            evaluations += 1;
          }
          let k = 0;
          while (k < n && ++idx[k] === VALUES.length) idx[k++] = 0;
          if (k === n) break;
        }
      }
    }
    expect(evaluations).toBeGreaterThan(50_000);
  });

  it("metric, scenario and step ties and mixed / unknown origins stay on the legacy path in every order", () => {
    const kinds: ((m: ModelId, s: ClaimCellStance) => AlignedClaimCell)[] = [
      (m, s) => derivedCell(m, s, "metric"),
      (m, s) => derivedCell(m, s, "scenario"),
      (m, s) => derivedCell(m, s, "step"),
      unknownCell,
    ];
    for (const make of kinds) {
      for (const stances of assignments(4)) {
        for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 0, 3, 2]]) {
          const results = order.map((i) => okResult(SLOTS[i]));
          const rows = [row("r", "split", order.map((i) => (stances[i] ? make(SLOTS[i], stances[i]!) : null)))];
          const t = build("generic", results, rows);
          same(t, legacyTrust({ id: "generic", fields: [] }, results as any, rows as any), `derived/unknown ${stances} ${order}`);
        }
      }
    }
    // Mixed: one claim cell among derived cells is never eligible.
    const rows = [row("r", "split", [claimCell("chatgpt", "agrees"), derivedCell("claude", "disputes", "step"), claimCell("grok", "disputes"), claimCell("perplexity", "agrees")])];
    const results = SLOTS.slice(0, 4).map((m) => okResult(m));
    expect(plain(build("generic", results, rows))).toEqual(plain(legacyTrust({ id: "generic", fields: [] }, results as any, rows as any)));
  });
});

// ─── Seeded multi-row corpus ──────────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("seeded multi-row corpus (3,000 runs, mixed row kinds, 3 slot orders each)", () => {
  it("exact reference; untouched runs byte-identical to the frozen oracle; never upward; contradictions justified", () => {
    const rnd = mulberry32(5_062_577);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const SCHEMAS = ["generic", "procedural", "factual_lookup", "financial_valuation", "contested_empirical", "medical_health"];
    const stats = { runs: 0, evaluations: 0, withTie: 0, upward: 0, rankUpsWithOwnRise: 0, cappedCleared: 0, groundingDown: 0 };
    for (let run = 0; run < 3000; run++) {
      const schemaId = pick(SCHEMAS);
      const n = 2 + Math.floor(rnd() * 4);
      const slots = SLOTS.slice(0, n);
      const health = slots.map(() => pick(["ok", "ok", "ok", "degraded", "failed"]));
      const specs = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
        const kind = pick(["claim", "claim", "claim", "inferredMix", "scalar", "metric", "step", "unknown"]);
        const status = pick<AlignedClaimStatus>(["split", "split", "majority", "consensus", "limited_coverage", "single_source"]);
        const stances = slots.map(() => pick(STANCES));
        const values = slots.map(() => pick(["A", "B", "a", "C", null]));
        return { kind, status, stances, values };
      });
      const orders = [slots.map((_, i) => i), slots.map((_, i) => n - 1 - i), [...slots.map((_, i) => i)].sort(() => rnd() - 0.5)];
      stats.runs += 1;
      for (const order of orders) {
        const results = order.map((i) => (health[i] === "failed" ? failedResult(slots[i], schemaId) : health[i] === "degraded" ? degradedResult(slots[i], schemaId) : okResult(slots[i], schemaId)));
        const rows = specs.map((s, k) => {
          if (s.kind === "scalar") return scalarRow(`s${k}`, order.map((i) => s.values[i]), order.map((i) => slots[i]), s.status);
          return row(`r${k}`, s.status, order.map((i) => {
            const st = s.stances[i];
            if (!st) return null;
            if (s.kind === "claim") return claimCell(slots[i], st);
            if (s.kind === "inferredMix") return i % 2 ? inferredCell(slots[i], st) : claimCell(slots[i], st);
            if (s.kind === "unknown") return unknownCell(slots[i], st);
            return derivedCell(slots[i], st, s.kind as "metric" | "step");
          }));
        });
        deepFreeze(rows);
        deepFreeze(results);
        const schema = getResultSchema(schemaId as any) as any;
        const t = build(schemaId, results, rows);
        const legacy = legacyTrust(schema, results as any, rows as any);
        const { ties, ...refSummary } = claimTieReference(schema, results as any, rows as any);
        stats.evaluations += 1;
        same(withoutRule(t), refSummary, `run ${run} ${order}`);
        if (ties === 0) {
          same(t, legacy, `run ${run} ${order}`);
          continue;
        }
        stats.withTie += 1;
        expect(t.attributionRule).toBe(CLAIM_TIE_ATTRIBUTION_RULE);
        expectNotUpward(t, legacy, `run ${run}`);
        expectContradictionsJustified(results, rows, t, legacy, `run ${run}`);
        const L = bySlot(legacy);
        const before = trustRank(legacy);
        const after = trustRank(t);
        for (const m of t.perModel) {
          if (after.indexOf(m.modelId) < before.indexOf(m.modelId) && m.trustScore > L[m.modelId].trustScore + EPS) stats.rankUpsWithOwnRise += 1;
          if (L[m.modelId].capped && !m.capped) stats.cappedCleared += 1;
        }
        if (GROUNDING_RANK[groundingTier(t.overallTrust)] < GROUNDING_RANK[groundingTier(legacy.overallTrust)]) stats.groundingDown += 1;
      }
    }
    expect(stats.withTie).toBeGreaterThan(1000);
    expect(stats.rankUpsWithOwnRise).toBe(0);
    // eslint-disable-next-line no-console
    console.info(`[o5c] corpus: ${JSON.stringify(stats)}`);
  });
});

describe("purity and boundaries", () => {
  it("deep-frozen inputs are neither mutated nor required to be mutable; repeated builds are identical", () => {
    for (const f of FIXTURES) {
      const rows = deepFreeze(f.rows());
      const results = deepFreeze(f.results());
      const snapshot = JSON.stringify([rows, results]);
      const a = build(f.schemaId, results, rows);
      const b = build(f.schemaId, results, rows);
      expect(JSON.stringify([rows, results])).toBe(snapshot);
      expect(plain(a)).toEqual(plain(b));
    }
  });

  it("the rule never reads the Contract P presentation marker or row text: identical output when they change", () => {
    const f = FIXTURES.find((x) => x.name === "claim-2-2-agrees-disputes-split")!;
    const rows = f.rows().map((r) => ({ ...r, claimText: "different words", id: "other", presentation: { disagreementPositionVersion: 1 } }) as any);
    const cells = rows.map((r: any) => ({ ...r, cells: r.cells.map((c: any) => c && { ...c, excerpt: "reworded", rawStance: "denies" }) }));
    expect(plain(build(f.schemaId, f.results(), cells))).toEqual(plain(build(f.schemaId, f.results(), f.rows())));
  });

  it("empty input and rows with no positions keep the shipped values and no marker", () => {
    const results = [okResult("chatgpt"), okResult("claude")];
    for (const rows of [[], [row("r", "split", [null, null])]]) {
      const t = build("generic", results, rows);
      expect(plain(t)).toEqual(plain(legacyTrust({ id: "generic", fields: [] }, results as any, rows as any)));
      expect("attributionRule" in t).toBe(false);
    }
  });
});

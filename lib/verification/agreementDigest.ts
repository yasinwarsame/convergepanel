/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

function jaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export type ModelEvidenceLine = {
  modelId: string;
  correctParts: string[];
  incorrectParts: string[];
  /**
   * The row's per-model verdict (`accurate | partially_accurate | inaccurate | unverifiable`, or `parse_error` /
   * `failed` for a row with no usable verdict). Absent → the row has no known side and never forms a verdict-based
   * conflict (doc 14 D-5: the digest previously received no verdicts at all).
   */
  verdict?: string;
};

type Side = "supports" | "inaccurate";

/** Which side of the claim a row's verdict is on; null for unverifiable / parse_error / failed / unknown. */
function verdictSide(verdict: string | undefined): Side | null {
  if (verdict === "accurate" || verdict === "partially_accurate") return "supports";
  if (verdict === "inaccurate") return "inaccurate";
  return null;
}

const AGREEMENT_OVERLAP = 0.35;

export function buildAgreementDisagreementDigest(models: ModelEvidenceLine[]): {
  whereModelsAgree: string[];
  whereModelsDisagree: Array<{ point: string; models: string[] }>;
} {
  const agree: string[] = [];
  const disagree: Array<{ point: string; models: string[] }> = [];

  const correctByModel = models.map((m) => ({
    id: m.modelId,
    parts: m.correctParts.filter(Boolean),
  }));

  for (const m of correctByModel) {
    for (const line of m.parts) {
      const others = correctByModel.filter((o) => o.id !== m.id);
      const overlap = others.filter((o) => o.parts.some((p) => jaccard(line, p) > AGREEMENT_OVERLAP));
      if (overlap.length >= Math.max(1, correctByModel.length - 2)) {
        const label = line.slice(0, 220);
        if (!agree.some((a) => jaccard(a, label) > 0.5)) agree.push(label);
      }
    }
  }

  const addConflict = (a: string, b: string) => {
    // One entry per unordered pair of models, named in input order.
    if (disagree.some((d) => d.models.includes(a) && d.models.includes(b))) return;
    disagree.push({ point: `Conflicting assessments: (${a}) vs (${b})`, models: [a, b] });
  };
  const order = new Map(models.map((m, i) => [m.modelId, i] as const));
  const ordered = (a: string, b: string): [string, string] => ((order.get(a) ?? 0) <= (order.get(b) ?? 0) ? [a, b] : [b, a]);

  // (i) A part one model lists as correct and another lists as incorrect (the agreement overlap threshold) is a
  // conflict between those two models, whatever their aggregate verdicts.
  for (const a of models) {
    for (const b of models) {
      if (a.modelId === b.modelId) continue;
      const clash = a.correctParts.filter(Boolean).some((c) => b.incorrectParts.filter(Boolean).some((i) => jaccard(c, i) > AGREEMENT_OVERLAP));
      if (clash) addConflict(...ordered(a.modelId, b.modelId));
    }
  }

  // (ii) The earlier heuristic — two models' incorrect parts with low token overlap — is kept ONLY for a pair whose
  // verdicts are on opposite sides of the claim (supports vs inaccurate). Two models on the same side (e.g. both
  // "inaccurate", wording their reasons differently) are never reported as conflicting, and neither is a row with no
  // usable verdict.
  const incorrectFlat: Array<{ modelId: string; side: Side | null; text: string }> = [];
  for (const m of models) {
    const side = verdictSide(m.verdict);
    for (const t of m.incorrectParts) incorrectFlat.push({ modelId: m.modelId, side, text: t });
  }

  for (let i = 0; i < incorrectFlat.length; i++) {
    for (let j = i + 1; j < incorrectFlat.length; j++) {
      const a = incorrectFlat[i];
      const b = incorrectFlat[j];
      if (a.modelId === b.modelId) continue;
      if (a.side === null || b.side === null || a.side === b.side) continue;
      if (jaccard(a.text, b.text) < 0.25 && a.text.length > 15 && b.text.length > 15) {
        addConflict(a.modelId, b.modelId);
      }
    }
  }

  return { whereModelsAgree: agree.slice(0, 12), whereModelsDisagree: disagree.slice(0, 12) };
}

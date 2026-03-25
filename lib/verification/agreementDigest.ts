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
};

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
      const overlap = others.filter((o) => o.parts.some((p) => jaccard(line, p) > 0.35));
      if (overlap.length >= Math.max(1, correctByModel.length - 2)) {
        const label = line.slice(0, 220);
        if (!agree.some((a) => jaccard(a, label) > 0.5)) agree.push(label);
      }
    }
  }

  const incorrectFlat: Array<{ modelId: string; text: string }> = [];
  for (const m of models) {
    for (const t of m.incorrectParts) incorrectFlat.push({ modelId: m.modelId, text: t });
  }

  for (let i = 0; i < incorrectFlat.length; i++) {
    for (let j = i + 1; j < incorrectFlat.length; j++) {
      const a = incorrectFlat[i];
      const b = incorrectFlat[j];
      if (a.modelId === b.modelId) continue;
      if (jaccard(a.text, b.text) < 0.25 && a.text.length > 15 && b.text.length > 15) {
        const point = `Conflicting assessments: (${a.modelId}) vs (${b.modelId})`;
        if (!disagree.some((d) => d.point === point)) {
          disagree.push({ point, models: [a.modelId, b.modelId] });
        }
      }
    }
  }

  return { whereModelsAgree: agree.slice(0, 12), whereModelsDisagree: disagree.slice(0, 12) };
}

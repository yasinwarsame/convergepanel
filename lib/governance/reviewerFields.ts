/**
 * Firestore user fields for peer-to-peer governance reviewers.
 */

export function parseGovernanceReviewerFor(
  data: Record<string, unknown> | undefined | null
): string[] {
  const raw = data?.governanceReviewerFor;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x === "string" && x.trim()) out.push(x.trim());
  }
  return [...new Set(out)];
}

/**
 * Phase 6D.3A — deterministic fingerprint over a set of normalization
 * candidate run IDs. Pure, zero-I/O. The future production mutation
 * authorization is bound to BOTH `candidateCount` AND
 * `candidateIdSha256` — a count-only guard could still be fooled by a
 * population that changed size-neutrally (one candidate resolved, a
 * different one appeared); the hash catches that.
 *
 * Encoding (must never change without also changing every stored/quoted
 * hash): sort run IDs lexicographically (plain string sort — Firestore
 * document IDs are compared byte-wise, never locale-aware), join with
 * `\n` (a newline can never appear inside a Firestore document ID, so
 * this delimiter is unambiguous — no run ID could accidentally merge
 * with its neighbor), SHA-256 over the UTF-8 bytes of that joined
 * string, rendered as lowercase hex.
 *
 * Contains no question/answer/report/model-output content — the input
 * is exclusively an array of run ID strings.
 */

import { createHash } from "crypto";

export interface CandidateFingerprint {
  candidateCount: number;
  candidateIdSha256: string;
}

const DELIMITER = "\n";

export function computeCandidateFingerprint(runIds: readonly string[]): CandidateFingerprint {
  const sorted = [...runIds].sort();
  const joined = sorted.join(DELIMITER);
  const candidateIdSha256 = createHash("sha256").update(joined, "utf8").digest("hex");
  return { candidateCount: sorted.length, candidateIdSha256 };
}

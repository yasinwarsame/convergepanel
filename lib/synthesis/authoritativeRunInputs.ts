/**
 * Governance input authority (F2) — the inputs a governance-affecting research
 * synthesis is built from, taken ONLY from the persisted, server-written run.
 *
 * `/api/synthesize-panel` used to build the synthesis prompt, its cache hash,
 * the consensus scoring and therefore System A research governance from the
 * request body (`question`, `results`, `agreementClusters`, `clusters`). A
 * caller could edit model output in the request and steer a governance
 * decision about their own run. The client payload is now transport only;
 * this module is the source of truth.
 *
 * Persisted shapes (characterized against the writers):
 * - question: `runDocument.question` (written by `completeRun`, the same
 *   trimmed question the models answered), else the top-level `question`
 *   (`createRun` / `createTeamWorkspaceRun`), followed by the top-level
 *   `questionContext` when the run persisted one (R1: the server-split
 *   "Context:" material the models also received). Runs created before R1
 *   have no `questionContext` and synthesize from the question alone — what
 *   a reloaded saved run always sent.
 * - model output: `runDocument.perModel[]` rows — `{ modelId, status,
 *   rawTextTruncated, provider?, requestedModel?, substitutedFrom? }`, one per
 *   selected model, written by `completeRun` since the initial commit. No other
 *   server writer of per-model text exists (`resultsCompact` / top-level
 *   `results` were never written), so there is no legacy fallback: a run
 *   without usable persisted rows cannot be synthesized.
 *
 * Pure: no I/O. Never reads anything the caller supplied.
 */
import { isUsableResult } from "@/lib/panel/publicize";
import { composeSynthesisQuestion, readPersistedQuestionContext } from "@/lib/questionContext";

export type AuthoritativeModelRow = {
  modelId: string;
  status: "ok" | "substituted";
  /** The server-persisted model text, exactly as stored (sanitized + storage-capped by `completeRun`). */
  text: string;
  /** Only provenance facts the run persisted; `actualModel` is deliberately never read (see S2). */
  provenance: { provider?: string; requestedModel?: string; substitutedFrom?: string };
};

export type AuthoritativeSynthesisInputs = {
  question: string;
  /** Distinct (first occurrence wins), usable, non-empty rows in persisted order. */
  rows: AuthoritativeModelRow[];
};

export type AuthoritativeSynthesisInputsResult =
  | { ok: true; value: AuthoritativeSynthesisInputs }
  | { ok: false; reason: "question_unavailable" | "results_unavailable" | "insufficient_results" };

/** Minimum distinct usable model rows for a synthesis — the panel's own minimum. */
export const MIN_AUTHORITATIVE_SYNTHESIS_ROWS = 2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function authoritativeSynthesisInputs(run: Record<string, unknown>): AuthoritativeSynthesisInputsResult {
  const runDocument = isPlainObject(run.runDocument) ? run.runDocument : undefined;

  const question = nonEmptyString(runDocument?.question)
    ? runDocument!.question.trim()
    : nonEmptyString(run.question)
      ? run.question.trim()
      : null;
  if (question === null) return { ok: false, reason: "question_unavailable" };
  // Only a server-written context within the request contract's own bound is honoured.
  const questionContext = readPersistedQuestionContext(run.questionContext);

  if (!runDocument || !Array.isArray(runDocument.perModel)) return { ok: false, reason: "results_unavailable" };

  const rows: AuthoritativeModelRow[] = [];
  const seen = new Set<string>();
  for (const raw of runDocument.perModel) {
    if (!isPlainObject(raw) || !nonEmptyString(raw.modelId)) continue;
    const modelId = raw.modelId.trim();
    if (seen.has(modelId)) continue; // a repeated id is one model, never a second perspective
    const status = typeof raw.status === "string" ? raw.status : "";
    if (!isUsableResult({ status })) continue;
    if (!nonEmptyString(raw.rawTextTruncated)) continue;
    seen.add(modelId);
    rows.push({
      modelId,
      status: status === "substituted" ? "substituted" : "ok",
      text: raw.rawTextTruncated,
      provenance: {
        ...(nonEmptyString(raw.provider) ? { provider: raw.provider } : {}),
        ...(nonEmptyString(raw.requestedModel) ? { requestedModel: raw.requestedModel } : {}),
        ...(nonEmptyString(raw.substitutedFrom) ? { substitutedFrom: raw.substitutedFrom } : {}),
      },
    });
  }
  if (rows.length < MIN_AUTHORITATIVE_SYNTHESIS_ROWS) return { ok: false, reason: "insufficient_results" };
  return { ok: true, value: { question: composeSynthesisQuestion(question, questionContext), rows } };
}

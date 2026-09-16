import "server-only";
import type { RunDocument } from "@/lib/panel/schemas";
import type { ModelId } from "@/lib/types";
import { runDocumentToPublicResults } from "@/lib/user/runDocumentToPublicResults";
import { publicizePanelResults } from "@/lib/panel/publicize";
import {
  parsePersistedAdaptiveOutput,
  parsePersistedLegacyAdaptiveOutput,
  type PersistedAdaptiveOutputV1,
  type PersistedLegacyAdaptiveOutputV1,
} from "@/lib/adaptiveSchema/persistedOutput";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { attachDeepResearchClaimIds } from "@/lib/verification/attachDeepResearchClaimIds";

/**
 * Team Research Parity, Phase R1 — the ONE canonical interpretation of a
 * persisted research run for a READ response.
 *
 * Extracted verbatim from `GET /api/user/runs/[runId]` (Phase 8C-B3.1 /
 * PERSONAL-RESEARCH-URL-P0 / 11A.4 lineage) so that the Personal route and
 * the Team research detail route emit byte-identical research payloads from
 * the same run document. Nothing here decides WHO may read: every caller must
 * have completed authorization and derived `viewerRole` before calling in.
 *
 * Contract:
 *   - PRESENTATION only — no authorization, no Firestore access of its own,
 *     no writes, no model execution, no synthesis regeneration, no mutation
 *     of the input document.
 *   - `runDocument.perModel` is preferred; the legacy top-level `results`
 *     array is the fallback only when the rehydrated rows are empty.
 *   - The adaptive and legacy-adaptive envelopes are validated through the
 *     real runtime parsers; absent / malformed / unsupported_version are
 *     legitimate outcomes the client renders distinctly, never errors.
 *   - Deep Research claim ids are attached at response time only.
 *   - `personal_reviewer` and `team_reviewer` lose per-model `tokenUsage`
 *     and `latencyMs` (review-integrity redaction); every other role gets
 *     the full row shape.
 *   - `reviewRouting` needs I/O the builder must not own; it is resolved by
 *     the injected `resolveReviewRouting` ONLY when the human-review status
 *     is still `unreviewed` or `pending`, exactly as the route always did.
 */

export type RunReadViewerRole = "owner" | "personal_reviewer" | "team_member" | "team_reviewer";

export type RunReadReviewRouting = "in_queue" | "not_configured" | "unknown";

export type RunReadReviewRoutingResolver = (args: { runId: string; ownerUid: string; requestId?: string }) => Promise<RunReadReviewRouting>;

export type RunReadPayload = {
  ok: true;
  runId: string;
  viewerRole: RunReadViewerRole;
  question: string;
  selectedModels: ModelId[];
  status: string | undefined;
  results: ReturnType<typeof runDocumentToPublicResults>;
  synthesisCache:
    | { report: unknown; schemaVersion: 1; synthesizedBy: string; consensusSummary: unknown | null }
    | null;
  governance:
    | { governanceReviewRequired: boolean; blockedByPolicy: boolean; policyBlockMessage?: string; policyFlags?: string[] }
    | null;
  governanceStatus: "approved" | "needs_review" | "blocked" | null;
  adaptive:
    | {
        status: "valid";
        output: PersistedAdaptiveOutputV1;
        humanReview: { status: string; conditions?: string[]; decidedVia?: string } | null;
        reviewRouting: RunReadReviewRouting;
      }
    | { status: "absent" | "unsupported_version" | "malformed"; output: null; humanReview: null; reviewRouting: "unknown" };
  legacyAdaptive:
    | { status: "valid"; output: PersistedLegacyAdaptiveOutputV1 }
    | { status: "absent" | "unsupported_version" | "malformed"; output: null };
};

export async function buildRunReadPayload(args: {
  runId: string;
  data: Record<string, unknown>;
  viewerRole: RunReadViewerRole;
  requestId?: string;
  resolveReviewRouting: RunReadReviewRoutingResolver;
}): Promise<RunReadPayload> {
  const { runId, data, viewerRole } = args;
  const owner = String(data.userId ?? "");

  const runDocument = data.runDocument as RunDocument | undefined;
  let results = runDocumentToPublicResults(runDocument);
  if (results.length === 0 && Array.isArray(data.results)) {
    results = publicizePanelResults(data.results as unknown[]) as unknown as typeof results;
  }

  const question = String(data.question ?? "");
  const selectedModels = (Array.isArray(data.selectedModels) ? data.selectedModels : []) as ModelId[];
  const status = typeof data.status === "string" ? data.status : undefined;

  const synthesisCache =
    data.synthesizedStructuredReport && data.schemaVersion === 1
      ? {
          report: data.synthesizedStructuredReport,
          schemaVersion: 1 as const,
          synthesizedBy: (data.synthesizedBy as string) || "cached",
          consensusSummary: data.synthesisConsensusSummary ?? null,
        }
      : null;

  const rawGovStatus = data.governanceStatus;
  const orgGovernanceStatus =
    rawGovStatus === "approved" || rawGovStatus === "needs_review" || rawGovStatus === "blocked"
      ? rawGovStatus
      : null;

  const g = data.teamGovernance as
    | {
        policyFlags?: string[];
        blocked?: boolean;
        blockMessage?: string;
        governanceReviewRequired?: boolean;
      }
    | undefined;

  const governance =
    g &&
    (g.policyFlags?.length ||
      g.blocked ||
      g.governanceReviewRequired ||
      (g.blockMessage && String(g.blockMessage).length > 0))
      ? {
          governanceReviewRequired: !!g.governanceReviewRequired,
          blockedByPolicy: !!g.blocked,
          policyBlockMessage: g.blockMessage ? String(g.blockMessage) : undefined,
          policyFlags: Array.isArray(g.policyFlags) ? g.policyFlags : undefined,
        }
      : null;

  // Query-Routing Redesign, Phase 1 — validate the persisted adaptive
  // envelope (if any) through the real runtime parser, never an unchecked
  // cast of Firestore data. Never reruns models or reclassifies to recover
  // from absent/malformed/unsupported-version data.
  const parsedAdaptive = parsePersistedAdaptiveOutput(data.adaptiveOutput);

  // Adaptive Synthesis Report, Phase 1 — compact human-review fields only,
  // and only when a real adaptiveOutput was persisted (governance is never
  // initialized otherwise). Never reviewer name or comment text.
  const parsedGovernance = parsedAdaptive.ok ? parseGovernanceRecord(data.governanceRecord) : { ok: false as const };
  const humanReview = parsedGovernance.ok
    ? {
        status: parsedGovernance.record.humanReview.status,
        conditions: parsedGovernance.record.humanReview.conditions,
        decidedVia: parsedGovernance.record.humanReview.decidedVia,
      }
    : null;

  // Resolved only when it changes the displayed status (still
  // unreviewed/pending); a decided run's status is unambiguous without it.
  // The resolver is read-only I/O owned by the caller's module boundary.
  let reviewRouting: RunReadReviewRouting = "unknown";
  if (humanReview && (humanReview.status === "unreviewed" || humanReview.status === "pending")) {
    reviewRouting = await args.resolveReviewRouting({ runId, ownerUid: owner, requestId: args.requestId });
  }

  // Phase 11A.4 — response-time only augmentation; never persisted.
  const adaptive: RunReadPayload["adaptive"] = parsedAdaptive.ok
    ? {
        status: "valid" as const,
        output:
          parsedAdaptive.output.schemaId === "deep_research"
            ? { ...parsedAdaptive.output, result: attachDeepResearchClaimIds(runId, parsedAdaptive.output.result) }
            : parsedAdaptive.output,
        humanReview,
        reviewRouting,
      }
    : { status: parsedAdaptive.reason, output: null, humanReview: null, reviewRouting: "unknown" as const };

  // Batch 3 persistence foundation (2C-1) — the SEPARATE legacyAdaptiveOutput
  // family, validated through its own real runtime parser and never
  // conflated with `adaptive.status`.
  const parsedLegacyAdaptive = parsePersistedLegacyAdaptiveOutput(data.legacyAdaptiveOutput);
  const legacyAdaptive: RunReadPayload["legacyAdaptive"] = parsedLegacyAdaptive.ok
    ? { status: "valid" as const, output: parsedLegacyAdaptive.output }
    : { status: parsedLegacyAdaptive.reason, output: null };

  // Governance Follow-Up Hardening / Phase 8C-B3.1 — reviewer roles lose
  // per-model token/latency counts (operational metadata, not review
  // content). Field-by-field removal: same shape and length either way.
  const resultsForResponse =
    viewerRole === "personal_reviewer" || viewerRole === "team_reviewer"
      ? results.map(({ tokenUsage: _tokenUsage, latencyMs: _latencyMs, ...rest }) => rest)
      : results;

  return {
    ok: true,
    runId,
    viewerRole,
    question,
    selectedModels,
    status,
    results: resultsForResponse as RunReadPayload["results"],
    synthesisCache,
    governance,
    governanceStatus: orgGovernanceStatus,
    adaptive,
    legacyAdaptive,
  };
}

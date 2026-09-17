"use client";

/**
 * TEAM-VERIFICATION-PARITY-R4-I3 — the ONE ordinary Team Claim composer,
 * serving both creation addresses:
 *
 *   /workspace/team/{W}/claims/new                      → Unfiled
 *   /workspace/team/{W}/projects/{P}/claims/new         → filed in P
 *
 * THE ROUTE IS THE SCOPE. There is deliberately no Workspace or Project
 * picker: the Project comes from the server-resolved record its page gate
 * already authorized, and is shown as fixed text. A form that could change its
 * own destination would be a second, weaker copy of the server's containment.
 *
 * It renders no result. On a validated success it REPLACES the history entry
 * with the canonical R4-I1 detail address, so Back returns to the Claims or
 * Project parent rather than a stale already-submitted form, and the detail
 * page remains the single owner of result rendering.
 *
 * Mutation safety is the hook's (`useTeamClaimVerificationCreate`): synchronous
 * single-flight, no automatic retry except the one provably pre-side-effect 401
 * refresh, and an explicit `outcome_unknown` state that tells the user to CHECK
 * before resubmitting rather than implying nothing was created.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Breadcrumb } from "@/components/shared/Breadcrumb";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import ModelPicker from "@/components/ModelPicker";
import { useUserPlan } from "@/hooks/useUserPlan";
import { getPlanConfigById, type PlanId } from "@/lib/plans";
import { getDefaultModelSelection } from "@/lib/utils/normalizeSelectedModels";
import { teamClaimDetailHref } from "@/lib/workspaces/teamClaimDetailHref";
import type { TeamClaimOriginTarget } from "@/lib/workspaces/teamClaimOriginHandoff";
import {
  useTeamClaimVerificationCreate,
  type TeamClaimCreateAddress,
  type TeamClaimCreateOutcome,
} from "@/hooks/useTeamClaimVerificationCreate";
import type { ModelId } from "@/lib/types";

/** Mirrors the server's own `MAX_CLAIM_LEN`; never raised client-side. */
const MAX_CLAIM_CHARS = 2000;
const MIN_MODELS = 2;

/**
 * The same trivial legacy plan-id mapping `TeamResearchComposerShell` keeps
 * locally (legacy "solo"/"pro" values). Duplicated deliberately rather than
 * extracted from Personal code, exactly as the research composer documents —
 * without it a legacy plan value would select the wrong model cap.
 */
function normalizePlanId(raw: string): PlanId {
  if (raw === "solo") return "lite";
  if (raw === "pro") return "full";
  if (raw === "free" || raw === "lite" || raw === "full") return raw;
  return "free";
}

export type TeamClaimComposerShellProps = {
  workspaceId: string;
  /** Server-resolved, authorized Workspace display name. */
  workspaceName: string;
  /** Presentation hint from the server-resolved capability set (`audit.read`) — not authorization. */
  showAudit: boolean;
  /** Server-resolved, active, Workspace-contained Project; `null` for the Unfiled address. */
  project: { id: string; name: string } | null;
  /**
   * R4-I4 — when present, this composer verifies an EXISTING research finding:
   * only the two locators are known client-side, the claim text is neither
   * shown nor editable, and the authoritative Project is unknown until the
   * server answers. Absent/null keeps the exact I3 ordinary behaviour.
   */
  originTarget?: TeamClaimOriginTarget | null;
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "validation"; message: string }
  /** A definite non-creation: correcting and resubmitting is safe. */
  | { kind: "rejected"; message: string }
  /** Cannot prove whether a Claim exists. The user must CHECK, not blindly resubmit. */
  | { kind: "outcome_unknown" };

/** Safe, non-disclosing copy for every definite rejection. */
export function teamClaimCreateRejectionCopy(outcome: Extract<TeamClaimCreateOutcome, { status: "rejected" }>): string {
  switch (outcome.code) {
    case "invalid_claim":
      return "Enter a claim before verifying.";
    case "claim_too_long":
      return `Claims are limited to ${MAX_CLAIM_CHARS} characters.`;
    case "not_enough_models":
      return `Select at least ${MIN_MODELS} models.`;
    case "PLAN_MODEL_LIMIT_REACHED":
      return outcome.usage?.maxModelsPerRun
        ? `Your plan allows up to ${outcome.usage.maxModelsPerRun} models per run.`
        : "Your plan allows fewer models than you selected.";
    case "RUN_LIMIT_REACHED": {
      const used = outcome.usage?.runsUsed;
      const limit = outcome.usage?.runsLimit;
      const base = used !== undefined && limit !== undefined ? `You've used all ${limit} runs this month.` : "You've reached your monthly run limit.";
      return outcome.usage?.resetsAt ? `${base} It resets on ${outcome.usage.resetsAt.slice(0, 10)}.` : base;
    }
    case "origin_not_eligible":
      return "This research finding is no longer available for verification. Return to the research and choose a current finding.";
    case "invalid_origin_locator":
    case "ambiguous_request_mode":
      return "This verification link is no longer valid. Return to the research and choose the finding again.";
    case "rate_limit_exceeded":
      return "You're verifying claims too quickly. Please wait a moment and try again.";
    case "unauthorized":
    case "auth_error":
      return "Please sign in again to verify a claim.";
    // Membership, capability and Project drift are collapsed: the user learns
    // they can no longer create here, never whether something exists.
    case "team_workspace_not_found":
    case "insufficient_capability":
    case "project_not_found":
    case "project_archived":
      return "This Workspace or Project is no longer available for claim creation.";
    default:
      return "We couldn't verify this claim. Please check your input and try again.";
  }
}

export default function TeamClaimComposerShell({ workspaceId, workspaceName, showAudit, project, originTarget = null }: TeamClaimComposerShellProps) {
  const router = useRouter();
  const { plan, loading: planLoading } = useUserPlan();
  const normalizedPlan = normalizePlanId((plan as string) || "free");
  const planConfig = getPlanConfigById(normalizedPlan);

  const [claim, setClaim] = useState("");
  const [selectedModels, setSelectedModels] = useState<ModelId[]>([]);
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [focusError, setFocusError] = useState(false);

  const address: TeamClaimCreateAddress = project === null ? { kind: "workspace", workspaceId } : { kind: "project", workspaceId, projectId: project.id };
  const { isSubmitting, submit } = useTeamClaimVerificationCreate({ address });

  useEffect(() => {
    if (!planLoading && selectedModels.length === 0) {
      setSelectedModels(getDefaultModelSelection(planConfig.maxModelsPerRun));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planLoading, planConfig.maxModelsPerRun]);

  // Navigation ownership: a late success must not move a viewer who has left
  // this form, or who is now composing against a different route context.
  const mountedRef = useRef(false);
  const contextKey = `${workspaceId}::${project?.id ?? ""}::${originTarget ? `${originTarget.runId}::${originTarget.claimId}` : ""}`;
  const contextKeyRef = useRef(contextKey);
  useEffect(() => {
    contextKeyRef.current = contextKey;
  }, [contextKey]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!focusError) return;
    errorRef.current?.focus();
    setFocusError(false);
  }, [focusError, submitState]);

  const fail = useCallback((next: SubmitState) => {
    setSubmitState(next);
    setFocusError(true);
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (isSubmitting) return;

      // Origin-linked mode holds NO claim text — the server resolves it from
      // the locators — so the length rules simply do not apply client-side.
      let trimmed = "";
      if (originTarget === null) {
        trimmed = claim.trim();
        if (trimmed.length === 0) {
          fail({ kind: "validation", message: "Enter a claim before verifying." });
          return;
        }
        if (trimmed.length > MAX_CLAIM_CHARS) {
          fail({ kind: "validation", message: `Claims are limited to ${MAX_CLAIM_CHARS} characters.` });
          return;
        }
      }
      if (selectedModels.length < MIN_MODELS) {
        fail({ kind: "validation", message: `Select at least ${MIN_MODELS} models.` });
        return;
      }

      setSubmitState({ kind: "idle" });
      const startedContext = contextKeyRef.current;
      const outcome = await submit(originTarget !== null ? { origin: originTarget, selectedModels } : { claim: trimmed, selectedModels });

      // A request that outlived this form, or this route context, must not navigate.
      if (!mountedRef.current || contextKeyRef.current !== startedContext) return;

      switch (outcome.status) {
        case "ok":
          router.replace(
            teamClaimDetailHref({ workspaceId: outcome.workspaceId, projectId: outcome.projectId, verificationId: outcome.verificationId })
          );
          return;
        case "already_submitting":
          return;
        case "rejected":
          fail({ kind: "rejected", message: teamClaimCreateRejectionCopy(outcome) });
          return;
        case "outcome_unknown":
          fail({ kind: "outcome_unknown" });
          return;
      }
    },
    [isSubmitting, claim, selectedModels, submit, router, fail, originTarget]
  );

  const workspaceHref = `/workspace/team/${encodeURIComponent(workspaceId)}`;
  const claimsHref = `${workspaceHref}/claims`;
  const projectHref = project ? `${workspaceHref}/projects/${encodeURIComponent(project.id)}` : null;
  const backHref = project && projectHref ? projectHref : claimsHref;
  // Origin-linked mode has no client Project authority, so an unconfirmed
  // outcome must point at the Workspace Claims list, which shows BOTH Unfiled
  // and Project-bound Claims — never a guessed Project.
  const unknownCheckHref = originTarget !== null ? claimsHref : backHref;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <Breadcrumb
        className="mb-3"
        segments={
          originTarget !== null
            ? [{ label: workspaceName, href: workspaceHref }, { label: "Claims", href: claimsHref }, { label: "Verify research claim" }]
            : project && projectHref
            ? [
                { label: workspaceName, href: workspaceHref },
                { label: "Projects", href: `${workspaceHref}/projects` },
                { label: project.name, href: projectHref },
                { label: "New claim" },
              ]
            : [{ label: workspaceName, href: workspaceHref }, { label: "Claims", href: claimsHref }, { label: "New claim" }]
        }
        mobileParent={originTarget === null && project && projectHref ? { label: project.name, href: projectHref } : { label: "Claims", href: claimsHref }}
      />

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-cp-text">{originTarget !== null ? "Verify a research claim" : "Verify a claim"}</h1>
        <p className="mt-1 text-sm text-cp-muted" data-testid="team-claim-create-scope">
          {originTarget !== null ? (
            "The claim text will be verified exactly as it appears in the saved research. It can't be edited here. Choose your models, then run the check."
          ) : project ? (
            <>
              This claim will be filed in <span className="font-medium text-cp-text">{project.name}</span>.
            </>
          ) : (
            "This claim will be saved as Unfiled."
          )}
        </p>
      </div>

      {/* A Project Claim is composed beneath its Project; an Unfiled one belongs to the Claims list. */}
      <WorkspaceNav workspaceId={workspaceId} active={originTarget === null && project ? "projects" : "claims"} showAudit={showAudit} />

      <form onSubmit={handleSubmit} className="mt-6 rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
        {originTarget === null && (
          <>
            <label htmlFor="team-claim-text" className="block text-sm font-medium text-cp-text">
              What claim would you like to verify?
            </label>
            <textarea
              id="team-claim-text"
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              onKeyDown={(e) => {
                // Same submit path as the button: validation, single-flight and
                // the disabled state all still apply.
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
                }
              }}
              disabled={isSubmitting}
              rows={5}
              maxLength={MAX_CLAIM_CHARS}
              placeholder="Paste or type a single factual claim…"
              className="mt-2 w-full rounded-lg border border-cp-border bg-cp-bg px-3 py-2 text-sm text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
              data-testid="team-claim-text"
            />
            <p className="mt-1 text-right text-xs text-cp-faint" data-testid="team-claim-char-count">
              {claim.length}/{MAX_CLAIM_CHARS}
            </p>
          </>
        )}

        <div className="mt-5">
          <ModelPicker selectedModels={selectedModels} onSelectionChange={setSelectedModels} plan={normalizedPlan} />
        </div>

        {(submitState.kind === "validation" || submitState.kind === "rejected") && (
          <p ref={errorRef} tabIndex={-1} role="alert" className="mt-4 text-sm font-medium text-red-700 focus:outline-none" data-testid="team-claim-create-error">
            {submitState.message}
          </p>
        )}

        {submitState.kind === "outcome_unknown" && (
          <div ref={errorRef as never} tabIndex={-1} role="alert" className="mt-4 rounded-lg border border-cp-border bg-cp-raised p-4 focus:outline-none" data-testid="team-claim-create-unknown">
            <p className="text-sm text-cp-text">We couldn&apos;t confirm whether the claim was created. Check Claims before trying again.</p>
            <Link href={unknownCheckHref} className="mt-3 inline-block rounded-lg border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text hover:bg-cp-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
              {project ? "Check this Project" : "Check Claims"}
            </Link>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
            className="rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
            data-testid="team-claim-submit"
          >
            {isSubmitting ? "Verifying…" : "Verify claim"}
          </button>
          <Link
            href={backHref}
            className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            {originTarget === null && project ? "Back to Project" : "Back to Claims"}
          </Link>
        </div>

        {isSubmitting && (
          <p role="status" className="mt-3 text-sm text-cp-muted" data-testid="team-claim-submitting">
            Verifying this claim across your selected models…
          </p>
        )}
      </form>
    </main>
  );
}

"use client";

/**
 * TEAM-VERIFICATION-PARITY-R4-I1 — LAYER 2: the Team Claim DETAIL client shell.
 *
 * Rendered by both canonical Team Claim addresses after their Server Component
 * has already enforced identity, Team Workspace access and `research.read`:
 *   - `/workspace/team/{W}/projects/{P}/claims/{verificationId}` (`project` given)
 *   - `/workspace/team/{W}/claims/{verificationId}`               (`project` null → Unfiled)
 *
 * It loads the Claim ONLY through the canonical R3 endpoint
 * `GET /api/workspaces/{W}/verifications/{verificationId}` (with `?projectId=`
 * on a Project address) via `useTeamClaimVerification`, and renders the body
 * with the shared, presentation-pure R2 `ClaimVerificationResultView`.
 *
 * PERSONAL BOUNDARY. It never mounts the Personal `ClaimVerificationResult`
 * wrapper, never calls `/api/user/...` or `/api/governance/...`, never fetches
 * live governance or reviewer identity, and exposes no memo export, audit-JSON
 * export, clipboard action bar or "Verify another" control
 * (`actionsSurface` is deliberately absent — Team export is a later roadmap
 * item, and a local download is not authorization to ship one).
 *
 * NAVIGATION. `WorkspaceNav` has no "claims" item yet — R4-I2 adds it together
 * with the Claim lists. I1 therefore does NOT edit `WorkspaceNav` merely to
 * satisfy an `active` value: a Project address highlights "Projects" and the
 * Unfiled address highlights "Overview", exactly as `TeamResearchDetailShell`
 * does. For the same reason the "Claims" breadcrumb segment is rendered
 * WITHOUT an href until `/workspace/team/{W}/claims` exists in I2 — a crumb
 * pointing at a route this slice does not ship would be broken navigation, and
 * pointing it at the Workspace overview would assert a parent edge that is not
 * the real hierarchy.
 *
 * SOURCE RESEARCH. `payload.sourceResearch` deliberately carries no Project
 * id, so the source run's canonical Team address cannot be derived from the
 * Claim. The affordance therefore resolves lazily, on CLICK only, through the
 * existing authorized Team run read — never on mount, never from a Personal
 * research URL, and never by reusing this Claim's own `projectId`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { User } from "firebase/auth";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import { createGenerationGuard } from "@/lib/client/authGeneration";
import { Breadcrumb } from "@/components/shared/Breadcrumb";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import ClaimVerificationResultView from "@/components/verification/ClaimVerificationResultView";
import { useTeamClaimVerification, type TeamClaimDetailTeam } from "@/hooks/useTeamClaimVerification";
import { formatAbsoluteDate, UNFILED_PROJECT_LABEL } from "@/lib/workspaces/reviewQueuePresentation";
import { teamResearchDetailHref } from "@/lib/workspaces/teamResearchDetailHref";

export type TeamClaimDetailShellProps = {
  workspaceId: string;
  /** Server-resolved, authorized Workspace display name. */
  workspaceName: string;
  verificationId: string;
  /** Server-resolved, Workspace-contained Project for a Project address; `null` for the Unfiled address. */
  project: { id: string; name: string } | null;
  /** Presentation hint from the server-resolved capability set (`audit.read`) — not authorization. */
  showAudit: boolean;
};

/** Lazy, click-time resolution of the source run's canonical Team address. */
type SourceState =
  | { kind: "idle" }
  | { kind: "resolving" }
  /** Every denial/absence reason collapses here — deleted, moved, revoked, malformed or foreign are indistinguishable. */
  | { kind: "unavailable" }
  /** Transport/5xx: honest and retryable. */
  | { kind: "transient" };

const STATE_BOX = "mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-6";
const BUTTON = "mt-4 rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent";

/**
 * The mandatory three-way Project label. A filed Claim whose Project could not
 * be resolved is NEVER shown as "Unfiled": the R3 detail route degrades an
 * unresolvable Project to `team.project === null` while keeping
 * `team.projectId`, so only `projectId === null` means genuinely unfiled.
 */
export function teamClaimProjectLabel(team: TeamClaimDetailTeam): string {
  if (team.projectId === null) return UNFILED_PROJECT_LABEL;
  if (team.project === null) return "Project unavailable";
  return team.project.name;
}

export default function TeamClaimDetailShell({ workspaceId, workspaceName, verificationId, project, showAudit }: TeamClaimDetailShellProps) {
  const { user, authReady } = useAuth();
  const router = useRouter();
  const projectId = project?.id ?? null;
  const { state, retry } = useTeamClaimVerification({ workspaceId, verificationId, expectedProjectId: projectId });

  const [source, setSource] = useState<SourceState>({ kind: "idle" });
  const sourceGuard = useRef(createGenerationGuard()).current;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sourceGuard.next();
    };
  }, [sourceGuard]);

  // A Claim-context change invalidates any in-flight source lookup, so a late
  // response for Claim A can never navigate a viewer now reading Claim B.
  useEffect(() => {
    sourceGuard.next();
    setSource({ kind: "idle" });
  }, [workspaceId, projectId, verificationId, sourceGuard]);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state.kind === "ready") {
      headingRef.current?.focus();
    }
  }, [state.kind]);

  const sourceResearch = state.kind === "ready" ? state.payload.sourceResearch ?? null : null;

  const openSourceResearch = useCallback(async () => {
    if (!sourceResearch || !authReady || !user) return;
    const generation = sourceGuard.next();
    const owns = () => mountedRef.current && sourceGuard.isCurrent(generation);
    setSource({ kind: "resolving" });

    try {
      // Deliberately WITHOUT `?projectId=`: the source run's CURRENT Project
      // association is what we need, and this Claim's own `projectId` is not
      // authority for it. The endpoint re-authorizes the caller itself.
      const res = await authedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(sourceResearch.runId)}`, {
        user: user as User,
        authReady,
        method: "GET",
        cache: "no-store",
      });
      if (!owns()) return;

      if (res.status >= 500) {
        setSource({ kind: "transient" });
        return;
      }
      if (!res.ok) {
        setSource({ kind: "unavailable" });
        return;
      }

      const body = (await res.json().catch(() => null)) as { team?: { workspaceId?: unknown; projectId?: unknown } } | null;
      if (!owns()) return;

      const team = body?.team;
      if (!team || typeof team.workspaceId !== "string" || team.workspaceId !== workspaceId) {
        setSource({ kind: "unavailable" });
        return;
      }
      const sourceProjectId = team.projectId === null ? null : typeof team.projectId === "string" && team.projectId.length > 0 ? team.projectId : undefined;
      if (sourceProjectId === undefined) {
        setSource({ kind: "unavailable" });
        return;
      }

      setSource({ kind: "idle" });
      router.push(teamResearchDetailHref({ workspaceId, projectId: sourceProjectId, runId: sourceResearch.runId }));
    } catch {
      if (!owns()) return;
      setSource({ kind: "transient" });
    }
  }, [sourceResearch, authReady, user, workspaceId, router, sourceGuard]);

  const workspaceHref = `/workspace/team/${encodeURIComponent(workspaceId)}`;
  const projectHref = project ? `${workspaceHref}/projects/${encodeURIComponent(project.id)}` : null;

  const claim = state.kind === "ready" ? state.payload.claim : null;
  const team = state.kind === "ready" ? state.team : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      {/*
        Phase 11B.3 composition, preserved: Breadcrumb -> heading -> WorkspaceNav
        -> content. The final segment and the heading are the Claim itself, which
        exists only once this address's authorized read has returned — so both
        render only then, never on a denied, absent, malformed or transient path.
      */}
      {claim !== null && (
        <Breadcrumb
          className="mb-3"
          segments={
            project && projectHref
              ? [
                  { label: workspaceName, href: workspaceHref },
                  { label: "Projects", href: `${workspaceHref}/projects` },
                  { label: project.name, href: projectHref },
                  { label: claim },
                ]
              : [{ label: workspaceName, href: workspaceHref }, { label: "Claims" }, { label: claim }]
          }
          mobileParent={project && projectHref ? { label: project.name, href: projectHref } : { label: workspaceName, href: workspaceHref }}
        />
      )}

      {claim !== null && team !== null && (
        <div className="mb-6">
          <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-cp-text break-words focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
            {claim}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-cp-muted" data-testid="team-claim-meta">
            <span data-testid="team-claim-project-label">{teamClaimProjectLabel(team)}</span>
            {team.project !== null && team.project.status !== "active" && (
              <span className="rounded-full border border-cp-border bg-cp-raised px-2 py-0.5 text-xs text-cp-faint">Archived</span>
            )}
            {formatAbsoluteDate(team.createdAt) !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid="team-claim-created-at">{formatAbsoluteDate(team.createdAt)}</span>
              </>
            )}
          </p>
        </div>
      )}

      {/* Claim detail sits beneath Projects for a Project address; the Unfiled address belongs to the Workspace overview. R4-I2 introduces the "Claims" item. */}
      <WorkspaceNav workspaceId={workspaceId} active={project ? "projects" : "overview"} showAudit={showAudit} />

      {state.kind === "loading" && (
        <div role="status" className="mt-6 rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">
          Loading this claim…
        </div>
      )}

      {state.kind === "not_found" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">Claim not found.</h2>
          <p className="mt-2 text-sm text-cp-muted">We couldn&apos;t open this claim. It may have been removed, moved, or you may not have access to it.</p>
          <Link href={workspaceHref} className="mt-4 inline-block rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
            Back to {workspaceName}
          </Link>
        </section>
      )}

      {state.kind === "forbidden" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">You don&apos;t have permission to view this claim</h2>
          <p className="mt-2 text-sm text-cp-muted">Your access to research in this Workspace has changed. Ask a Workspace admin if you think this is a mistake.</p>
          <Link href={workspaceHref} className="mt-4 inline-block rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
            Back to {workspaceName}
          </Link>
        </section>
      )}

      {state.kind === "auth_error" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">We couldn&apos;t verify your session</h2>
          <p className="mt-2 text-sm text-cp-muted">
            Your sign-in could not be confirmed, so we didn&apos;t load this claim. This says nothing about the claim itself — please sign in again and reopen this page.
          </p>
          <Link href="/login" className={`${BUTTON} inline-block`}>
            Sign in again
          </Link>
        </section>
      )}

      {state.kind === "unavailable" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">We couldn&apos;t load this claim</h2>
          <p className="mt-2 text-sm text-cp-muted">Something went wrong on our side. The claim hasn&apos;t gone anywhere — please try again.</p>
          <button type="button" onClick={retry} className={BUTTON}>
            Try again
          </button>
        </section>
      )}

      {state.kind === "internal" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">We couldn&apos;t load this claim</h2>
          <p className="mt-2 text-sm text-cp-muted">Something went wrong while reading this claim. Nothing was changed.</p>
          <button type="button" onClick={retry} className={BUTTON}>
            Try again
          </button>
        </section>
      )}

      {state.kind === "malformed" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">This claim couldn&apos;t be displayed</h2>
          <p className="mt-2 text-sm text-cp-muted">The saved result for this claim couldn&apos;t be read. Nothing was changed.</p>
        </section>
      )}

      {state.kind === "ready" && (
        <>
          {sourceResearch !== null && (
            <section className="mt-6 rounded-xl border border-cp-border bg-cp-surface p-4">
              <button
                type="button"
                onClick={() => void openSourceResearch()}
                disabled={source.kind === "resolving"}
                className="rounded-lg border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text hover:bg-cp-raised disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
                data-testid="team-claim-source-research"
              >
                {source.kind === "resolving" ? "Opening source research…" : "View source research"}
              </button>
              {source.kind === "unavailable" && (
                <p role="alert" className="mt-2 text-sm text-cp-muted">
                  Source research is no longer available.
                </p>
              )}
              {source.kind === "transient" && (
                <p role="alert" className="mt-2 text-sm text-cp-muted">
                  We couldn&apos;t open the source research. Please try again.
                </p>
              )}
            </section>
          )}

          {/*
            The R2 boundary, mounted directly. `governanceSurface` carries ONLY
            the already-stored, presentation-safe status from the authorized
            payload — never a live governance or reviewer lookup.
            `noticeSurface` and `actionsSurface` are deliberately absent, so the
            shared view renders nothing in those positions.
          */}
          <div className="mt-6">
            <ClaimVerificationResultView data={state.payload} governanceSurface={state.payload.governanceStatus ? <GovernanceChip status={state.payload.governanceStatus} /> : undefined} />
          </div>
        </>
      )}
    </main>
  );
}

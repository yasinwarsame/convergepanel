"use client";

/**
 * Team Workspace Activation Flow, Phase 12A.1 — the "Set up your
 * Workspace" progress panel on the Workspace home page. Purely
 * presentational: every completion state is a prop derived elsewhere
 * from real Workspace data (`lib/workspaces/activationState.ts`) — this
 * component holds no fetch logic, no persisted/local "skipped" or
 * "step" state of its own, so it renders correctly on first load, after
 * a refresh, or from a different session (Section M/P).
 *
 * Phase 12A.2 — "Create your first project" now links to the real,
 * permanent Team Projects surface (whose own empty state presents the
 * actual create action — no duplicate creation logic lives here).
 *
 * Phase 12A.3 — "Start research" now links to the real Team Projects
 * surface too, once a Project already exists: the actual composer lives
 * at a specific `/projects/{projectId}/research/new` route, but this
 * Overview-level panel deliberately never guesses "the first Project" —
 * it has no cheap way to know which Project the user wants, and each
 * Project's own detail page already exposes a permanent "Start Research"
 * action (Section AC — no expensive read added here solely to pick one).
 * Still `hasProject: false` -> inert note (nowhere useful to send them
 * yet); still no persisted onboarding state — `activation.researchStarted`
 * remains entirely derived from real `hasResearch` data.
 *
 * Once `activation.isFullyActive` (real Team research exists), the panel
 * renders nothing at all — a mature Workspace's home page should not
 * keep nudging a completed setup flow (Section N).
 */

import Link from "next/link";
import type { WorkspaceActivationState } from "@/lib/workspaces/activationState";

function StepRow({
  label,
  complete,
  action,
}: {
  label: string;
  complete: boolean;
  /** Omit for an always-inert step (nothing to do yet, or the caller lacks the capability). */
  action?: { label: string; href: string } | { label: string; note: true };
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <span className="flex items-center gap-2 text-sm">
        <span aria-hidden="true" className={complete ? "text-cp-accent" : "text-cp-faint"}>
          {complete ? "✓" : "○"}
        </span>
        <span className={complete ? "font-medium text-cp-text" : "text-cp-text"}>{label}</span>
        <span className="sr-only">{complete ? "(complete)" : "(not yet complete)"}</span>
      </span>
      {!complete && action && "href" in action && (
        <Link
          href={action.href}
          className="rounded-lg bg-cp-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
        >
          {action.label}
        </Link>
      )}
      {!complete && action && "note" in action && (
        <span className="rounded-lg border border-cp-border-soft px-3 py-1.5 text-xs font-medium text-cp-faint">{action.label}</span>
      )}
    </li>
  );
}

export default function WorkspaceActivationPanel({
  workspaceId,
  activation,
  canInvite,
  canCreateProject,
  canStartResearch,
}: {
  workspaceId: string;
  activation: WorkspaceActivationState;
  /** `members.invite` capability — gates whether "Invite your team" is an active link or inert status text (Section Q). */
  canInvite: boolean;
  /** `projects.create` capability — gates whether "Create your first project" is an active link or inert status text, mirroring the Invite step's own capability-gated pattern (PHASE 12A.2 Section AB). */
  canCreateProject: boolean;
  /** `research.create` AND `research.organize` capability — the exact pair a Project-bound run actually requires server-side (PHASE 12A.3). */
  canStartResearch: boolean;
}) {
  if (activation.isFullyActive) {
    return null;
  }

  const membersHref = `/workspace/team/${encodeURIComponent(workspaceId)}/members`;
  const projectsHref = `/workspace/team/${encodeURIComponent(workspaceId)}/projects`;

  return (
    <section aria-labelledby="workspace-setup-heading" className="mb-8 rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <h2 id="workspace-setup-heading" className="text-sm font-semibold uppercase tracking-wide text-cp-muted">
        Set up your Workspace
      </h2>
      <ul className="mt-3 divide-y divide-cp-border-soft">
        <StepRow label="Workspace created" complete />
        <StepRow
          label="Invite your team"
          complete={activation.teamInvited}
          action={canInvite ? { label: "Invite your team", href: membersHref } : { label: "Owner/Admin only", note: true }}
        />
        <StepRow
          label="Create your first project"
          complete={activation.projectCreated}
          action={canCreateProject ? { label: "Create your first project", href: projectsHref } : { label: "Owner/Admin/Member only", note: true }}
        />
        <StepRow
          label="Start research"
          complete={activation.researchStarted}
          action={
            !canStartResearch
              ? { label: "Owner/Admin/Member only", note: true }
              : activation.projectCreated
                ? { label: "Choose a Project", href: projectsHref }
                : { label: "Create a project first", note: true }
          }
        />
      </ul>
    </section>
  );
}

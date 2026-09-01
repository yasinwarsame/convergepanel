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
 * "Create your first project" and "Start research" render as inert,
 * clearly-labeled upcoming steps (not a link to anywhere) until Phase
 * 12A.2/12A.3 ship real destinations — this deliberately never fakes a
 * navigable action that doesn't exist yet (Section I).
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
}: {
  workspaceId: string;
  activation: WorkspaceActivationState;
  /** `members.invite` capability — gates whether "Invite your team" is an active link or inert status text (Section Q). */
  canInvite: boolean;
}) {
  if (activation.isFullyActive) {
    return null;
  }

  const membersHref = `/workspace/team/${encodeURIComponent(workspaceId)}/members`;

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
        <StepRow label="Create your first project" complete={activation.projectCreated} action={{ label: "Coming soon", note: true }} />
        <StepRow label="Start research" complete={activation.researchStarted} action={{ label: "Coming soon", note: true }} />
      </ul>
    </section>
  );
}

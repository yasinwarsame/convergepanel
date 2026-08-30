"use client";

/**
 * Team Workspace Self-Service Onboarding — the `/workspace/team/{workspaceId}/members`
 * client shell. Shows active members (with canonical Owner badge), pending
 * invitations, and (per `canInvite`/`canManageInvitations`) an Invite
 * Member form plus resend/revoke controls. Reuses the existing
 * invitation create/list/resend/revoke APIs verbatim — no new invitation
 * service. Active member role change/removal is explicitly OUT of scope
 * (deferred, per the frozen phase contract) — this shell is view + invite
 * + pending-invitation management only.
 *
 * Every displayed field comes from the server's own allow-list DTOs
 * (`WorkspaceMemberItem`/`WorkspaceInvitationItem`) — no raw
 * document/UID beyond what those DTOs already expose.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  fetchWorkspaceMembers,
  fetchPendingInvitations,
  createInvitation,
  resendInvitation,
  revokeInvitation,
  type WorkspaceMemberItem,
  type WorkspaceInvitationItem,
  type WorkspaceInvitationRole,
  type WorkspaceMemberRole,
} from "@/lib/client/workspaceTeamClient";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";

const ROLE_LABEL: Record<WorkspaceMemberRole, string> = { owner: "Owner", admin: "Admin", member: "Member", reviewer: "Reviewer", viewer: "Viewer" };

const ROLE_DESCRIPTION: Record<WorkspaceInvitationRole, string> = {
  admin: "Helps manage Workspace operations and reviews.",
  member: "Creates and manages research and projects.",
  reviewer: "Reads research and submits reviews.",
  viewer: "Read-only access.",
};

/** Owner never invitable, mirroring `canManageInvitationTargetRole()`'s server rule verbatim — UI hint only, the server independently re-enforces this. */
const OWNER_INVITABLE_ROLES: readonly WorkspaceInvitationRole[] = ["admin", "member", "reviewer", "viewer"];
const ADMIN_INVITABLE_ROLES: readonly WorkspaceInvitationRole[] = ["member", "reviewer", "viewer"];

function permittedInviteRoles(callerRole: WorkspaceMemberRole): readonly WorkspaceInvitationRole[] {
  if (callerRole === "owner") return OWNER_INVITABLE_ROLES;
  if (callerRole === "admin") return ADMIN_INVITABLE_ROLES;
  return [];
}

export default function WorkspaceMembersShell({
  workspaceId,
  workspaceName,
  callerRole,
  canInvite,
  canManageInvitations,
}: {
  workspaceId: string;
  workspaceName: string;
  callerRole: WorkspaceMemberRole;
  canInvite: boolean;
  canManageInvitations: boolean;
}) {
  const { user, authReady } = useAuth();

  const [members, setMembers] = useState<WorkspaceMemberItem[]>([]);
  const [membersStatus, setMembersStatus] = useState<"loading" | "ready" | "error">("loading");

  const [invitations, setInvitations] = useState<WorkspaceInvitationItem[]>([]);
  const [invitationsStatus, setInvitationsStatus] = useState<"loading" | "ready" | "error">("loading");

  const invitableRoles = permittedInviteRoles(callerRole);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceInvitationRole>(invitableRoles[0] ?? "member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteConfirmation, setInviteConfirmation] = useState<string | null>(null);

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const membersRequestId = useRef(0);
  const invitationsRequestId = useRef(0);
  const emailInputRef = useRef<HTMLInputElement>(null);

  const loadMembers = useCallback(() => {
    if (!authReady) return;
    const requestId = ++membersRequestId.current;
    setMembersStatus("loading");
    (async () => {
      const result = await fetchWorkspaceMembers({ user, authReady, workspaceId });
      if (membersRequestId.current !== requestId) return;
      if (result.status === "ok") {
        setMembers(result.members);
        setMembersStatus("ready");
      } else {
        setMembers([]);
        setMembersStatus("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user?.uid, workspaceId]);

  const loadInvitations = useCallback(() => {
    if (!authReady || !canManageInvitations) {
      setInvitations([]);
      setInvitationsStatus("ready");
      return;
    }
    const requestId = ++invitationsRequestId.current;
    setInvitationsStatus("loading");
    (async () => {
      const result = await fetchPendingInvitations({ user, authReady, workspaceId });
      if (invitationsRequestId.current !== requestId) return;
      if (result.status === "ok") {
        setInvitations(result.invitations);
        setInvitationsStatus("ready");
      } else {
        setInvitations([]);
        setInvitationsStatus("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user?.uid, workspaceId, canManageInvitations]);

  useEffect(() => {
    loadMembers();
    loadInvitations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user?.uid, workspaceId]);

  const openInviteForm = useCallback(() => {
    setInviteError(null);
    setInviteConfirmation(null);
    setShowInviteForm(true);
    setTimeout(() => emailInputRef.current?.focus(), 0);
  }, []);

  const closeInviteForm = useCallback(() => {
    setShowInviteForm(false);
    setInviteEmail("");
    setInviteError(null);
  }, []);

  const handleInvite = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = inviteEmail.trim();
      if (trimmed.length === 0) {
        setInviteError("Enter an email address.");
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        setInviteError("Enter a valid email address.");
        return;
      }
      setInviting(true);
      setInviteError(null);
      setInviteConfirmation(null);
      const result = await createInvitation({ user, authReady, workspaceId, email: trimmed, role: inviteRole });
      setInviting(false);
      if (result.status === "ok") {
        setInviteEmail("");
        setInviteConfirmation(`Invitation sent to ${result.invitation.normalizedEmail}.`);
        loadInvitations();
      } else if (result.status === "denied") {
        setInviteError(result.message);
      } else {
        setInviteError("We couldn't send this invitation. Please try again.");
      }
    },
    [inviteEmail, inviteRole, user, authReady, workspaceId, loadInvitations]
  );

  const handleResend = useCallback(
    async (invitation: WorkspaceInvitationItem) => {
      setPendingActionId(invitation.id);
      setActionError(null);
      const result = await resendInvitation({ user, authReady, workspaceId, invitationId: invitation.id, expectedDeliveryVersion: invitation.deliveryVersion });
      setPendingActionId(null);
      if (result.status === "ok") {
        loadInvitations();
      } else if (result.status === "denied") {
        setActionError(result.message);
      } else {
        setActionError("We couldn't resend this invitation. Please try again.");
      }
    },
    [user, authReady, workspaceId, loadInvitations]
  );

  const handleRevoke = useCallback(
    async (invitation: WorkspaceInvitationItem) => {
      setPendingActionId(invitation.id);
      setActionError(null);
      const result = await revokeInvitation({ user, authReady, workspaceId, invitationId: invitation.id, expectedDeliveryVersion: invitation.deliveryVersion });
      setPendingActionId(null);
      setConfirmRevokeId(null);
      if (result.status === "ok") {
        loadInvitations();
      } else if (result.status === "denied") {
        setActionError(result.message);
      } else {
        setActionError("We couldn't revoke this invitation. Please try again.");
      }
    },
    [user, authReady, workspaceId, loadInvitations]
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-cp-text">Members</h1>
        <p className="mt-1 text-sm text-cp-muted">{workspaceName}</p>
      </div>

      {/* Active members */}
      <section aria-labelledby="active-members-heading" className="mb-8">
        <h2 id="active-members-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-cp-muted">
          Members
        </h2>
        {membersStatus === "loading" && (
          <div role="status" className="rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">
            Loading members…
          </div>
        )}
        {membersStatus === "error" && <ReviewErrorState message="We couldn't load this Workspace's members. Try again." onRetry={loadMembers} />}
        {membersStatus === "ready" && members.length === 0 && (
          <div className="rounded-xl border border-cp-border bg-cp-raised px-6 py-8 text-center text-sm text-cp-muted shadow-sm">No members found.</div>
        )}
        {membersStatus === "ready" && members.length > 0 && (
          <ul className="divide-y divide-cp-border-soft rounded-xl border border-cp-border bg-cp-surface shadow-sm">
            {members.map((m) => (
              <li key={m.uid} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="truncate text-sm font-medium text-cp-text">{m.displayName}</span>
                <span className="inline-flex items-center gap-2 text-xs">
                  {m.isCanonicalOwner && <span className="rounded-full bg-cp-primary-soft px-2 py-0.5 font-medium text-cp-accent">Owner</span>}
                  <span className="rounded-full bg-cp-raised px-2 py-0.5 font-medium text-cp-muted">{ROLE_LABEL[m.role]}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Pending invitations + invite */}
      {canManageInvitations && (
        <section aria-labelledby="pending-invitations-heading" className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="pending-invitations-heading" className="text-sm font-semibold uppercase tracking-wide text-cp-muted">
              Pending Invitations
            </h2>
            {canInvite && !showInviteForm && (
              <button
                type="button"
                onClick={openInviteForm}
                className="inline-flex items-center justify-center rounded-lg bg-cp-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
              >
                Invite Member
              </button>
            )}
          </div>

          {showInviteForm && (
            <form onSubmit={handleInvite} className="mb-4 rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm" aria-label="Invite Member">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="invite-email" className="block text-sm font-medium text-cp-text">
                    Email
                  </label>
                  <input
                    id="invite-email"
                    ref={emailInputRef}
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    disabled={inviting}
                    placeholder="teammate@example.com"
                    className="mt-2 w-full rounded-lg border border-cp-border bg-cp-bg px-3 py-2 text-sm text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                  />
                </div>
                <div>
                  <label htmlFor="invite-role" className="block text-sm font-medium text-cp-text">
                    Role
                  </label>
                  <select
                    id="invite-role"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as WorkspaceInvitationRole)}
                    disabled={inviting}
                    className="mt-2 w-full rounded-lg border border-cp-border bg-cp-bg px-3 py-2 text-sm text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                  >
                    {invitableRoles.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-cp-faint">{ROLE_DESCRIPTION[inviteRole]}</p>
                </div>
              </div>
              {inviteError && (
                <p role="alert" className="mt-3 text-sm font-medium text-red-400">
                  {inviteError}
                </p>
              )}
              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  disabled={inviting}
                  className="rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  {inviting ? "Sending…" : "Send Invite"}
                </button>
                <button
                  type="button"
                  onClick={closeInviteForm}
                  disabled={inviting}
                  className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {inviteConfirmation && (
            <p role="status" className="mb-4 text-sm font-medium text-cp-accent">
              {inviteConfirmation}
            </p>
          )}
          {actionError && (
            <p role="alert" className="mb-4 text-sm font-medium text-red-400">
              {actionError}
            </p>
          )}

          {invitationsStatus === "loading" && (
            <div role="status" className="rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">
              Loading pending invitations…
            </div>
          )}
          {invitationsStatus === "error" && <ReviewErrorState message="We couldn't load pending invitations. Try again." onRetry={loadInvitations} />}
          {invitationsStatus === "ready" && invitations.length === 0 && (
            <div className="rounded-xl border border-cp-border bg-cp-raised px-6 py-8 text-center text-sm text-cp-muted shadow-sm">No pending invitations.</div>
          )}
          {invitationsStatus === "ready" && invitations.length > 0 && (
            <ul className="divide-y divide-cp-border-soft rounded-xl border border-cp-border bg-cp-surface shadow-sm">
              {invitations.map((inv) => {
                const isBusy = pendingActionId === inv.id;
                return (
                  <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-cp-text">{inv.normalizedEmail}</p>
                      <p className="text-xs text-cp-faint">
                        {ROLE_LABEL[inv.role]}
                        {inv.isExpired ? " · Expired" : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleResend(inv)}
                        disabled={isBusy}
                        className="rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                      >
                        {isBusy ? "…" : "Resend"}
                      </button>
                      {confirmRevokeId === inv.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => handleRevoke(inv)}
                            disabled={isBusy}
                            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-50"
                          >
                            {isBusy ? "…" : "Confirm revoke"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRevokeId(null)}
                            disabled={isBusy}
                            className="rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRevokeId(inv.id)}
                          disabled={isBusy}
                          className="rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

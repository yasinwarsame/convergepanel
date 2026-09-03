"use client";

/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — the
 * `/workspace/team/{workspaceId}/audit` client shell. v1: list only, no
 * detail/"Open trail" route (per PHASE TEAM-GOV-R1's audit — the legacy
 * Governance "Open trail" pattern is run-centric and deliberately not
 * replicated here; a sufficiently detailed list row already answers who
 * removed whom, from which role, and when).
 *
 * Every displayed field comes from the server's own allow-list
 * `WorkspaceAuditEventItem` DTO — no raw UID, membership ID, or Workspace
 * ID beyond what that DTO already exposes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { fetchWorkspaceAuditEvents, type WorkspaceAuditEventItem, type WorkspaceAuditPreviousRole } from "@/lib/client/workspaceTeamClient";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";

const ROLE_LABEL: Record<WorkspaceAuditPreviousRole, string> = { admin: "Admin", member: "Member", reviewer: "Reviewer", viewer: "Viewer" };

function formatOccurredAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Unknown time";
  return parsed.toLocaleString();
}

export default function WorkspaceAuditLogShell({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const { user, authReady } = useAuth();

  const [events, setEvents] = useState<WorkspaceAuditEventItem[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  const requestId = useRef(0);

  const loadFirstPage = useCallback(() => {
    if (!authReady) return;
    const thisRequest = ++requestId.current;
    setStatus("loading");
    fetchWorkspaceAuditEvents({ user, authReady, workspaceId }).then((result) => {
      if (requestId.current !== thisRequest) return;
      if (result.status !== "ok") {
        setStatus("error");
        return;
      }
      setEvents(result.events);
      setHasMore(result.hasMore);
      setNextCursor(result.nextCursor);
      setStatus("ready");
    });
  }, [user, authReady, workspaceId]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(() => {
    if (!authReady || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    fetchWorkspaceAuditEvents({ user, authReady, workspaceId, cursor: nextCursor }).then((result) => {
      setLoadingMore(false);
      if (result.status !== "ok") return;
      setEvents((prev) => [...prev, ...result.events]);
      setHasMore(result.hasMore);
      setNextCursor(result.nextCursor);
    });
  }, [user, authReady, workspaceId, nextCursor, loadingMore]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-cp-text">Audit Log</h1>
        <p className="mt-1 text-sm text-cp-muted">{workspaceName}</p>
      </div>

      <WorkspaceNav workspaceId={workspaceId} active="audit" showAudit />

      {status === "loading" && (
        <div role="status" className="rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">
          Loading audit log…
        </div>
      )}

      {status === "error" && <ReviewErrorState message="We couldn't load this Workspace's audit log. Try again." onRetry={loadFirstPage} />}

      {status === "ready" && events.length === 0 && (
        <div role="status" className="rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">
          No Workspace activity yet.
        </div>
      )}

      {status === "ready" && events.length > 0 && (
        <ul className="space-y-3">
          {events.map((event, i) => (
            <li key={i} className="rounded-xl border border-cp-border bg-cp-surface px-5 py-4 shadow-sm">
              {event.eventType === "workspace_member_removed" ? (
                <>
                  <p className="text-sm font-medium text-cp-text">Member removed</p>
                  <p className="mt-1 text-sm text-cp-muted">
                    <span className="font-medium text-cp-text">{event.target.displayName}</span> was removed from this Workspace.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-cp-faint">
                    <span>
                      Previous role: <span className="font-medium text-cp-muted">{ROLE_LABEL[event.previousRole]}</span>
                    </span>
                    <span>
                      By: <span className="font-medium text-cp-muted">{event.actor.displayName}</span>
                    </span>
                    <span>{formatOccurredAt(event.occurredAt)}</span>
                  </div>
                </>
              ) : event.eventType === "workspace_ownership_transferred" ? (
                <>
                  <p className="text-sm font-medium text-cp-text">Ownership transferred</p>
                  <p className="mt-1 text-sm text-cp-muted">
                    <span className="font-medium text-cp-text">{event.actor.displayName}</span> transferred ownership to{" "}
                    <span className="font-medium text-cp-text">{event.target.displayName}</span>.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-cp-faint">
                    <span>
                      {event.target.displayName}&apos;s previous role: <span className="font-medium text-cp-muted">{ROLE_LABEL[event.previousRole]}</span>
                    </span>
                    <span>
                      By: <span className="font-medium text-cp-muted">{event.actor.displayName}</span>
                    </span>
                    <span>{formatOccurredAt(event.occurredAt)}</span>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-cp-text">Role changed</p>
                  <p className="mt-1 text-sm text-cp-muted">
                    <span className="font-medium text-cp-text">{event.target.displayName}</span>&apos;s role changed from{" "}
                    <span className="font-medium text-cp-text">{ROLE_LABEL[event.previousRole]}</span> to <span className="font-medium text-cp-text">{ROLE_LABEL[event.newRole]}</span>.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-cp-faint">
                    <span>
                      By: <span className="font-medium text-cp-muted">{event.actor.displayName}</span>
                    </span>
                    <span>{formatOccurredAt(event.occurredAt)}</span>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {status === "ready" && hasMore && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-lg border border-cp-border bg-cp-surface px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </main>
  );
}

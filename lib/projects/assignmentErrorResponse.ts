/**
 * Project/Research Assignment — the response helpers the shared error
 * modules have no member for. Everything else (auth, body, rollout /
 * authorization concealment, Project/run concealed not-found, archived
 * Project, stale token, internal error) is reused verbatim from
 * `lib/workspaces/teamWorkspaceErrorResponse.ts`,
 * `lib/projects/teamProjectErrorResponse.ts` and
 * `lib/projects/projectErrorResponse.ts` — never duplicated here.
 */

export type AssignmentErrorBody = { ok: false; errorCode: string; message: string };

/**
 * Any per-uid ineligibility reason (not a member, removed, other Workspace,
 * lacks `research.create` for a run assignee) — ONE shape, the specific
 * reason never surfaced. Authorization has already been established by the
 * time this is reached, so a 400 is safe; the target's membership state is
 * still not disclosed.
 */
export function assigneeNotEligibleResponse(): { status: number; body: AssignmentErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "assignee_not_eligible", message: "One or more of the chosen members can't be assigned here." } };
}

export function tooManyAssigneesResponse(): { status: number; body: AssignmentErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "too_many_assignees", message: "A Project can have at most 20 assignees." } };
}

/** Run-assignee expected-state mismatch — never echoes the current assignee. */
export function assigneeConflictResponse(): { status: number; body: AssignmentErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "assignee_conflict", message: "This research's assignment changed since you last viewed it. Please refresh and try again." } };
}

/** `?assignee=` present but not exactly `me` (or duplicated) — a malformed request, never silently coerced to "no filter". */
export function invalidAssigneeFilterResponse(): { status: number; body: { ok: false; errorCode: "invalid_assignee_filter"; message: string } } {
  return { status: 400, body: { ok: false, errorCode: "invalid_assignee_filter", message: "Unsupported assignee filter." } };
}

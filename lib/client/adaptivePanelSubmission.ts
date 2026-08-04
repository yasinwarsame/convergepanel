/**
 * Multi-Reviewer Owner Override, Part F (§F13/§F16/§F17/§F18) — shared,
 * pure client-side outcome mapping for the panel's three mutating actions
 * (vote submission, finalization, owner override). One shared mapper
 * because their server-side error vocabularies overlap heavily
 * (`governance_stale`/`panel_stale`/`not_pending`/`panel_cancelled`/etc.) —
 * reused rather than three near-identical copies drifting independently.
 *
 * Never auto-retries. A `stale`/`terminal` outcome always requires an
 * explicit reload (the caller re-fetches canonical panel state) — this
 * module never re-issues the mutating request itself.
 */

export type AdaptivePanelActionOutcome<T> =
  | { kind: "success"; data: T }
  | { kind: "validation_error"; message: string }
  /** A concurrency conflict — the caller's view of the panel/governance record predates a change. Requires reload, never auto-retried. */
  | { kind: "stale"; message: string }
  /** The panel or review reached a terminal state (cancelled, already finalized, no longer pending). Requires reload; the mutating control should be hidden after this. */
  | { kind: "terminal"; message: string }
  /** Any other safe, named 409 (e.g. quorum_not_met, panel_deadlocked, vote_already_submitted) that isn't itself staleness or terminality. */
  | { kind: "conflict"; code: string; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "network_error"; message: string };

const SAFE_FALLBACK_MESSAGE = "Something went wrong. Please try again.";

/**
 * Pure. Maps a server error `code` (from `{ ok: false, error: { code, message } }`)
 * to a safe, fixed-copy outcome. Never passes the server's own `message`
 * through verbatim — every user-facing string here is a fixed literal, so a
 * future server-side message change can never leak internal detail into
 * the UI.
 */
export type AdaptivePanelErrorOutcome = Exclude<AdaptivePanelActionOutcome<never>, { kind: "success" }>;

export function mapAdaptivePanelErrorCode(code: string): AdaptivePanelErrorOutcome {
  switch (code) {
    case "validation_error":
      return { kind: "validation_error", message: "This request is invalid. Please check your input and try again." };
    case "governance_stale":
    case "panel_stale":
      return { kind: "stale", message: "This changed since you last viewed it. Reloading…" };
    case "not_pending":
      return { kind: "terminal", message: "This review is no longer pending." };
    case "panel_cancelled":
      return { kind: "terminal", message: "This review panel has been cancelled." };
    case "panel_already_finalized":
    case "inconsistent_finalization_state":
      return { kind: "terminal", message: "This panel has already reached a final decision." };
    case "panel_absent":
      return { kind: "terminal", message: "No review panel exists for this run." };
    case "quorum_not_met":
      return { kind: "conflict", code, message: "Not enough reviewers have voted yet." };
    case "panel_deadlocked":
      return { kind: "conflict", code, message: "The panel is deadlocked. More votes, panel reconfiguration, or an owner override is required." };
    case "vote_already_submitted":
      return { kind: "conflict", code, message: "You have already submitted a vote for this panel revision." };
    case "reviewer_not_assigned":
      return { kind: "forbidden", message: "You are not currently a reviewer on this panel." };
    case "insufficient_role":
      return { kind: "forbidden", message: "You don't have permission to do this." };
    case "multi_reviewer_disabled":
      return { kind: "forbidden", message: "Multi-reviewer panel review is not enabled for this team." };
    case "unauthorized":
      return { kind: "unauthenticated", message: "Please sign in." };
    case "forbidden":
      return { kind: "forbidden", message: "You don't have access to this review." };
    case "not_found":
    case "projection_missing":
    case "projection_invalid":
    case "governance_record_absent":
      return { kind: "not_found", message: "This review could not be found." };
    case "firestore_unavailable":
      return { kind: "unavailable", message: "This is temporarily unavailable. Please try again." };
    default:
      return { kind: "unavailable", message: SAFE_FALLBACK_MESSAGE };
  }
}

export type PostJson = (url: string, body: unknown) => Promise<Response>;

/**
 * Shared POST-and-map helper. `postJson` is injected (mirrors
 * `submitAdaptiveReviewDecision`'s own established pattern) so components
 * remain testable without a real network layer.
 */
export async function postAdaptivePanelAction<T>(url: string, body: unknown, postJson: PostJson): Promise<AdaptivePanelActionOutcome<T>> {
  let res: Response;
  try {
    res = await postJson(url, body);
  } catch {
    return { kind: "network_error", message: "Could not reach the server. Please check your connection and try again." };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    return { kind: "network_error", message: "Received an unreadable response. Please reload and try again." };
  }

  if (!res.ok || json?.ok !== true) {
    const code = typeof json?.error?.code === "string" ? json.error.code : "unknown";
    return mapAdaptivePanelErrorCode(code);
  }

  return { kind: "success", data: json as T };
}

"use client";

/**
 * TEAM-VERIFICATION-PARITY-R4-I2 — the ONE client abstraction for the three
 * already-live R3 Team Claim LIST endpoints:
 *
 *   workspace / all     GET /api/workspaces/{W}/verifications
 *   workspace / unfiled GET /api/workspaces/{W}/verifications?scope=unfiled
 *   project             GET /api/workspaces/{W}/projects/{P}/verifications
 *
 * The address is a DISCRIMINATED UNION supplied by the caller, never inferred
 * from the browser pathname, so a surface can only ever request the scope it
 * actually renders. "Unfiled" is the server's own `?scope=unfiled` contract —
 * this hook never simulates it by filtering an "all" response.
 *
 * NOT AN AUTHORIZATION BOUNDARY. Every one of these endpoints re-derives
 * identity, Workspace membership and `research.read` per request. The checks
 * here are CLIENT CONTAINMENT: a page that does not belong to the addressed
 * scope is never handed to the UI.
 *
 * WHOLE-PAGE INTEGRITY. R3 already fails a whole window rather than emit a
 * partial page, and validates every Project reference in the window before
 * emitting a list. This hook mirrors that posture exactly: one malformed or
 * out-of-scope item fails the ENTIRE fetched page. Silently dropping a bad row
 * would turn a server integrity violation into a plausible-looking short list.
 *
 * TRANSPORT (the hardened I1 posture): waits for auth readiness, GET only,
 * `cache: "no-store"`, a monotonic generation guard claimed before the first
 * await, exactly one forced token-refresh retry on HTTP 401 (a second 401 is a
 * finished session, never an empty list), and no commit from a stale or
 * unmounted request. Changing the Workspace, scope, Project or identity
 * invalidates BOTH the initial and the load-more request and drops the cursor.
 *
 * Read-only: no write, no POST, no provider execution, no quota, no governance
 * call, and never a Personal (`/api/user/...`) route.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";

/** The R3 summary DTO, as it is safe to present. Deliberately carries no creator, reviewer, membership, origin, model evidence or raw timestamp. */
export interface TeamClaimListItem {
  verificationId: string;
  claim: string;
  verdict: TeamClaimVerdict;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  governanceStatus?: "approved" | "needs_review" | "blocked";
  createdAt: string;
  workspaceId: string;
  projectId: string | null;
  project: { id: string; name: string; status: string } | null;
}

export type TeamClaimVerdict = "confirmed" | "disputed" | "partially_true" | "unverifiable";

const VERDICTS: ReadonlySet<string> = new Set(["confirmed", "disputed", "partially_true", "unverifiable"]);
const CONFIDENCE: ReadonlySet<string> = new Set(["High", "Medium", "Low"]);
const EVIDENCE: ReadonlySet<string> = new Set(["strong", "mixed", "weak"]);
const GOVERNANCE: ReadonlySet<string> = new Set(["approved", "needs_review", "blocked"]);

export type TeamClaimListAddress =
  | { kind: "workspace"; workspaceId: string; scope: "all" | "unfiled" }
  | { kind: "project"; workspaceId: string; projectId: string };

export type TeamClaimListErrorCode =
  | "unauthorized"
  | "auth_error"
  | "team_workspace_not_found"
  | "team_workspace_unavailable"
  | "insufficient_capability"
  | "project_not_found"
  | "invalid_scope"
  | "invalid_cursor"
  | "internal_error"
  | "network_error"
  | "malformed_response";

const SERVER_ERROR_CODES: ReadonlySet<string> = new Set([
  "unauthorized",
  "auth_error",
  "team_workspace_not_found",
  "team_workspace_unavailable",
  "insufficient_capability",
  "project_not_found",
  "invalid_scope",
  "invalid_cursor",
  "internal_error",
]);

/**
 * The ONE request-URL builder. Path segments are encoded; the cursor is
 * appended exactly once through `URLSearchParams`. No uid, role, capability,
 * creator, collection name or caller-supplied endpoint is ever encoded.
 */
export function buildTeamClaimListUrl(address: TeamClaimListAddress, cursor?: string): string {
  const w = encodeURIComponent(address.workspaceId);
  const params = new URLSearchParams();

  let base: string;
  if (address.kind === "project") {
    base = `/api/workspaces/${w}/projects/${encodeURIComponent(address.projectId)}/verifications`;
  } else {
    base = `/api/workspaces/${w}/verifications`;
    if (address.scope === "unfiled") params.set("scope", "unfiled");
  }

  if (cursor !== undefined) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** One summary row, validated against the addressed scope. Returns null when the row is unusable OR out of scope. */
function parseItem(raw: unknown, address: TeamClaimListAddress): TeamClaimListItem | null {
  if (!isObject(raw)) return null;

  if (!nonEmptyString(raw.verificationId)) return null;
  if (!nonEmptyString(raw.claim)) return null;
  if (typeof raw.verdict !== "string" || !VERDICTS.has(raw.verdict)) return null;
  if (typeof raw.consensusScore !== "number" || !Number.isFinite(raw.consensusScore)) return null;
  if (typeof raw.confidenceLabel !== "string" || !CONFIDENCE.has(raw.confidenceLabel)) return null;
  if (typeof raw.evidenceQuality !== "string" || !EVIDENCE.has(raw.evidenceQuality)) return null;
  if (raw.governanceStatus !== undefined && (typeof raw.governanceStatus !== "string" || !GOVERNANCE.has(raw.governanceStatus))) return null;
  if (!nonEmptyString(raw.createdAt) || Number.isNaN(Date.parse(raw.createdAt))) return null;

  // Workspace containment: the row's own binding must name the addressed Workspace.
  if (raw.workspaceId !== address.workspaceId) return null;

  const projectId = raw.projectId;
  if (!(projectId === null || nonEmptyString(projectId))) return null;

  let project: TeamClaimListItem["project"] = null;
  if (raw.project !== null) {
    if (!isObject(raw.project)) return null;
    if (!nonEmptyString(raw.project.id) || !nonEmptyString(raw.project.name) || typeof raw.project.status !== "string") return null;
    project = { id: raw.project.id, name: raw.project.name, status: raw.project.status };
  }

  // R3 batch-validates every Project reference in the window BEFORE emitting a
  // list, so on a LIST the pair must always agree. (The detail route may
  // legitimately degrade `project` to null while keeping `projectId`; that
  // fallback has no counterpart here.)
  if (projectId === null && project !== null) return null;
  if (projectId !== null && project === null) return null;
  if (projectId !== null && project !== null && project.id !== projectId) return null;

  // Scope containment.
  if (address.kind === "project") {
    if (projectId !== address.projectId) return null;
  } else if (address.scope === "unfiled") {
    if (projectId !== null) return null;
  }

  return {
    verificationId: raw.verificationId,
    claim: raw.claim,
    verdict: raw.verdict as TeamClaimVerdict,
    consensusScore: raw.consensusScore,
    confidenceLabel: raw.confidenceLabel as TeamClaimListItem["confidenceLabel"],
    evidenceQuality: raw.evidenceQuality as TeamClaimListItem["evidenceQuality"],
    ...(raw.governanceStatus !== undefined ? { governanceStatus: raw.governanceStatus as TeamClaimListItem["governanceStatus"] } : {}),
    createdAt: raw.createdAt,
    workspaceId: raw.workspaceId,
    projectId: projectId as string | null,
    project,
  };
}

export type TeamClaimListPage = { items: TeamClaimListItem[]; hasMore: boolean; nextCursor?: string };

export function parseTeamClaimListPageResponse(args: {
  ok: boolean;
  status: number;
  body: unknown;
  address: TeamClaimListAddress;
}): { ok: true; page: TeamClaimListPage } | { ok: false; errorCode: TeamClaimListErrorCode } {
  if (!args.ok) {
    const code = isObject(args.body) && typeof args.body.errorCode === "string" ? args.body.errorCode : null;
    if (code !== null && SERVER_ERROR_CODES.has(code)) {
      return { ok: false, errorCode: code as TeamClaimListErrorCode };
    }
    if (args.status === 401) return { ok: false, errorCode: "auth_error" };
    if (args.status === 403) return { ok: false, errorCode: "insufficient_capability" };
    if (args.status === 404) return { ok: false, errorCode: "team_workspace_not_found" };
    if (args.status === 503) return { ok: false, errorCode: "team_workspace_unavailable" };
    return { ok: false, errorCode: "internal_error" };
  }

  if (!isObject(args.body) || args.body.ok !== true) return { ok: false, errorCode: "malformed_response" };
  if (!Array.isArray(args.body.items)) return { ok: false, errorCode: "malformed_response" };
  if (typeof args.body.hasMore !== "boolean") return { ok: false, errorCode: "malformed_response" };
  if (args.body.nextCursor !== undefined && !nonEmptyString(args.body.nextCursor)) return { ok: false, errorCode: "malformed_response" };

  // The Workspace list echoes the scope it actually served; a mismatch means
  // the response answers a different question than the one this surface asked.
  if (args.address.kind === "workspace" && args.body.scope !== args.address.scope) {
    return { ok: false, errorCode: "malformed_response" };
  }

  const items: TeamClaimListItem[] = [];
  for (const raw of args.body.items) {
    const item = parseItem(raw, args.address);
    // Whole-page failure: never a silently shortened list.
    if (item === null) return { ok: false, errorCode: "malformed_response" };
    items.push(item);
  }

  return {
    ok: true,
    page: { items, hasMore: args.body.hasMore, ...(args.body.nextCursor !== undefined ? { nextCursor: args.body.nextCursor } : {}) },
  };
}

export type TeamClaimListStatus = "disabled" | "loading" | "ready" | "error";

export interface UseTeamClaimVerificationListResult {
  items: TeamClaimListItem[];
  hasMore: boolean;
  status: TeamClaimListStatus;
  initialErrorCode: TeamClaimListErrorCode | null;
  loadingMore: boolean;
  loadMoreErrorCode: TeamClaimListErrorCode | null;
  loadMore: () => void;
  retryInitial: () => void;
  resetAndReloadFromStart: () => void;
}

export function useTeamClaimVerificationList(args: { address: TeamClaimListAddress; enabled?: boolean }): UseTeamClaimVerificationListResult {
  const { address } = args;
  const enabled = args.enabled ?? true;
  const { user, authReady } = useAuth();

  const [items, setItems] = useState<TeamClaimListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<TeamClaimListStatus>(enabled ? "loading" : "disabled");
  const [initialErrorCode, setInitialErrorCode] = useState<TeamClaimListErrorCode | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreErrorCode, setLoadMoreErrorCode] = useState<TeamClaimListErrorCode | null>(null);

  const cursorRef = useRef<string | undefined>(undefined);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seqRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  // The address identity that every request belongs to. Any change to it
  // invalidates in-flight work and drops the cursor.
  const workspaceId = address.workspaceId;
  const scope = address.kind === "workspace" ? address.scope : null;
  const projectId = address.kind === "project" ? address.projectId : null;
  const uid = user?.uid ?? null;

  const fetchPage = useCallback(
    async (opts: { cursor: string | undefined; isLoadMore: boolean; currentUser: User }) => {
      const seq = ++seqRef.current;
      const owns = () => mountedRef.current && seq === seqRef.current;

      if (opts.isLoadMore) {
        setLoadingMore(true);
        setLoadMoreErrorCode(null);
      } else {
        setStatus("loading");
        setInitialErrorCode(null);
      }

      const url = buildTeamClaimListUrl(address, opts.cursor);

      try {
        const read = (forceTokenRefresh = false) =>
          authedFetch(url, {
            user: opts.currentUser,
            authReady: true,
            method: "GET",
            cache: "no-store",
            ...(forceTokenRefresh ? { forceTokenRefresh: true } : {}),
          });

        let res = await read();
        if (!owns()) return;

        if (res.status === 401) {
          // Exactly one forced refresh. A second 401 is a finished session.
          res = await read(true);
          if (!owns()) return;
        }

        const body = await res.json().catch(() => null);
        if (!owns()) return;

        const result = parseTeamClaimListPageResponse({ ok: res.ok, status: res.status, body, address });
        if (!result.ok) {
          if (opts.isLoadMore) {
            setLoadingMore(false);
            setLoadMoreErrorCode(result.errorCode);
          } else {
            setStatus("error");
            setInitialErrorCode(result.errorCode);
          }
          return;
        }

        const deduped: TeamClaimListItem[] = [];
        for (const item of result.page.items) {
          if (seenIdsRef.current.has(item.verificationId)) continue;
          seenIdsRef.current.add(item.verificationId);
          deduped.push(item);
        }
        cursorRef.current = result.page.nextCursor;
        setHasMore(result.page.hasMore);
        if (opts.isLoadMore) {
          setItems((prev) => [...prev, ...deduped]);
          setLoadingMore(false);
          setLoadMoreErrorCode(null);
        } else {
          setItems(deduped);
          setStatus("ready");
          setInitialErrorCode(null);
        }
      } catch {
        if (!owns()) return;
        if (opts.isLoadMore) {
          setLoadingMore(false);
          setLoadMoreErrorCode("network_error");
        } else {
          setStatus("error");
          setInitialErrorCode("network_error");
        }
      }
    },
    // `address` is reconstructed each render; the primitive identity below is
    // what actually determines the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, scope, projectId]
  );

  useEffect(() => {
    // Every address/identity change starts from a clean page-1 state: no stale
    // rows, no stale cursor, no stale dedupe set, and in-flight work orphaned.
    seqRef.current += 1;
    seenIdsRef.current = new Set();
    cursorRef.current = undefined;
    setItems([]);
    setHasMore(false);
    setLoadingMore(false);
    setLoadMoreErrorCode(null);

    if (!enabled) {
      setStatus("disabled");
      setInitialErrorCode(null);
      return;
    }
    if (!authReady) {
      setStatus("loading");
      setInitialErrorCode(null);
      return;
    }
    if (!user) {
      setStatus("error");
      setInitialErrorCode("unauthorized");
      return;
    }

    void fetchPage({ cursor: undefined, isLoadMore: false, currentUser: user });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, authReady, uid, workspaceId, scope, projectId]);

  const loadMore = useCallback(() => {
    if (!enabled || loadingMore || !hasMore || status !== "ready" || !user) return;
    void fetchPage({ cursor: cursorRef.current, isLoadMore: true, currentUser: user });
  }, [enabled, loadingMore, hasMore, status, user, fetchPage]);

  const retryInitial = useCallback(() => {
    if (!enabled || !user) return;
    seenIdsRef.current = new Set();
    cursorRef.current = undefined;
    void fetchPage({ cursor: undefined, isLoadMore: false, currentUser: user });
  }, [enabled, user, fetchPage]);

  const resetAndReloadFromStart = useCallback(() => {
    if (!enabled || !user) return;
    seenIdsRef.current = new Set();
    cursorRef.current = undefined;
    setItems([]);
    setHasMore(false);
    setLoadingMore(false);
    setLoadMoreErrorCode(null);
    void fetchPage({ cursor: undefined, isLoadMore: false, currentUser: user });
  }, [enabled, user, fetchPage]);

  return { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart };
}

/** Initial-state copy. Never reveals whether a foreign Workspace/Project exists. */
export function teamClaimListInitialErrorCopy(code: TeamClaimListErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view claims.", retry: false };
    case "team_workspace_not_found":
    case "project_not_found":
    case "insufficient_capability":
      return { message: "Claims are no longer available here.", retry: false };
    case "team_workspace_unavailable":
    case "network_error":
      return { message: "Couldn't load claims right now. Please try again.", retry: true };
    case "invalid_cursor":
      return { message: "This page link is no longer valid.", retry: true };
    default:
      return { message: "We couldn't display these claims safely.", retry: true };
  }
}

/** Load-more copy. Already-rendered rows are never replaced by these states. */
export function teamClaimListLoadMoreErrorCopy(code: TeamClaimListErrorCode): { message: string; action: "retry" | "reload" } {
  switch (code) {
    case "invalid_cursor":
      return { message: "This page link is no longer valid.", action: "reload" };
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view claims.", action: "reload" };
    case "team_workspace_not_found":
    case "project_not_found":
    case "insufficient_capability":
      return { message: "Claims are no longer available here.", action: "reload" };
    case "internal_error":
    case "malformed_response":
      return { message: "We couldn't display these claims safely.", action: "reload" };
    default:
      return { message: "Couldn't load more claims right now. Please try again.", action: "retry" };
  }
}

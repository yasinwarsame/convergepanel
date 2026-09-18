"use client";

/**
 * TEAM-VERIFICATION-PARITY-R5-I2 — the ONE client abstraction for the three
 * already-live R5-I1 Team Video LIST endpoints:
 *
 *   workspace / all     GET /api/workspaces/{W}/video-verifications
 *   workspace / unfiled GET /api/workspaces/{W}/video-verifications?scope=unfiled
 *   project             GET /api/workspaces/{W}/projects/{P}/video-verifications
 *
 * The address is a DISCRIMINATED UNION supplied by the caller, never inferred
 * from the browser pathname, so a surface can only ever request the scope it
 * actually renders. "Unfiled" is the server's own `?scope=unfiled` contract —
 * this hook never simulates it by filtering an "all" response, which would
 * silently misreport the Workspace whenever the unfiled set spans more than one
 * page.
 *
 * NOT AN AUTHORIZATION BOUNDARY. Every one of these endpoints re-derives
 * identity, Workspace membership and `research.read` per request. The checks
 * here are CLIENT CONTAINMENT: a page that does not belong to the addressed
 * scope is never handed to the UI.
 *
 * WHOLE-PAGE INTEGRITY. R5-I1 already fails a whole window rather than emit a
 * partial page, and batch-validates every Project reference in the window
 * before emitting a list. This hook mirrors that posture exactly: one malformed
 * or out-of-scope item fails the ENTIRE fetched page. Silently dropping a bad
 * row would turn a server integrity violation into a plausible-looking short
 * list.
 *
 * STRICTNESS. The list parser deliberately does NOT reuse the tolerant stored
 * detail mapper (`mapStoredVideoVerificationToClientPayload`), which
 * substitutes "Uploaded video", "inconclusive", 0, "Low" and "weak" for missing
 * values. A row that cannot produce every required summary field is an
 * integrity failure, not a row rendered with fabricated values.
 *
 * TRANSPORT (the hardened Claim posture): waits for auth readiness, GET only,
 * `cache: "no-store"`, a monotonic generation guard claimed before the first
 * await, and an AbortController that actually CANCELS the obsolete request.
 * Changing the Workspace, scope, Project, identity or `enabled`, and
 * unmounting, both invalidate the generation and abort the in-flight read; the
 * cursor is dropped with it.
 *
 * AUTH: exactly one forced token-refresh retry on HTTP 401, sharing the SAME
 * signal as the original attempt. A second 401 terminates immediately as
 * `auth_error` WITHOUT parsing the body — "this is the second 401" is a fact
 * about request history that the pure response parser cannot know.
 *
 * Read-only: no write, no POST, no provider execution, no quota, no governance
 * call, and never a Personal (`/api/user/...` or `/api/verify-video`) route.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";

/**
 * The R5-I1 summary DTO, as it is safe to present. Deliberately carries no
 * uploader, creator email, membership, model evidence, raw frames, metadata
 * blob, token usage or billing/quota state.
 */
export interface TeamVideoListItem {
  verificationId: string;
  fileName: string;
  verdict: TeamVideoVerdict;
  contentType?: string;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  frameCount: number;
  createdAt: string;
  workspaceId: string;
  projectId: string | null;
  project: { id: string; name: string; status: string } | null;
  governanceStatus?: "approved" | "needs_review" | "blocked";
}

/**
 * The canonical aggregate Video verdicts, plus the historical `"authentic"`
 * label the shared `VideoVerificationResultView` still renders. A stored row
 * using it is displayable and must not be treated as corrupt.
 */
export type TeamVideoVerdict =
  | "authentic_captured"
  | "authentic_produced"
  | "likely_manipulated"
  | "inconclusive"
  | "insufficient"
  | "authentic";

const VERDICTS: ReadonlySet<string> = new Set(["authentic_captured", "authentic_produced", "likely_manipulated", "inconclusive", "insufficient", "authentic"]);
const CONFIDENCE: ReadonlySet<string> = new Set(["High", "Medium", "Low"]);
const EVIDENCE: ReadonlySet<string> = new Set(["strong", "mixed", "weak"]);
const GOVERNANCE: ReadonlySet<string> = new Set(["approved", "needs_review", "blocked"]);

export type TeamVideoListAddress =
  | { kind: "workspace"; workspaceId: string; scope: "all" | "unfiled" }
  | { kind: "project"; workspaceId: string; projectId: string };

export type TeamVideoListErrorCode =
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
 * uploader, collection name or caller-supplied endpoint is ever encoded.
 */
export function buildTeamVideoListUrl(address: TeamVideoListAddress, cursor?: string): string {
  const w = encodeURIComponent(address.workspaceId);
  const params = new URLSearchParams();

  let base: string;
  if (address.kind === "project") {
    base = `/api/workspaces/${w}/projects/${encodeURIComponent(address.projectId)}/video-verifications`;
  } else {
    base = `/api/workspaces/${w}/video-verifications`;
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
function parseItem(raw: unknown, address: TeamVideoListAddress): TeamVideoListItem | null {
  if (!isObject(raw)) return null;

  if (!nonEmptyString(raw.verificationId)) return null;
  if (!nonEmptyString(raw.fileName)) return null;
  if (typeof raw.verdict !== "string" || !VERDICTS.has(raw.verdict)) return null;
  if (raw.contentType !== undefined && !nonEmptyString(raw.contentType)) return null;
  if (typeof raw.consensusScore !== "number" || !Number.isFinite(raw.consensusScore)) return null;
  if (raw.consensusScore < 0 || raw.consensusScore > 100) return null;
  if (typeof raw.confidenceLabel !== "string" || !CONFIDENCE.has(raw.confidenceLabel)) return null;
  if (typeof raw.evidenceQuality !== "string" || !EVIDENCE.has(raw.evidenceQuality)) return null;
  if (typeof raw.frameCount !== "number" || !Number.isFinite(raw.frameCount) || !Number.isInteger(raw.frameCount) || raw.frameCount < 0) return null;
  if (raw.governanceStatus !== undefined && (typeof raw.governanceStatus !== "string" || !GOVERNANCE.has(raw.governanceStatus))) return null;
  if (!nonEmptyString(raw.createdAt) || Number.isNaN(Date.parse(raw.createdAt))) return null;

  // Workspace containment: the row's own binding must name the addressed Workspace.
  if (raw.workspaceId !== address.workspaceId) return null;

  const projectId = raw.projectId;
  if (!(projectId === null || nonEmptyString(projectId))) return null;

  let project: TeamVideoListItem["project"] = null;
  if (raw.project !== null) {
    if (!isObject(raw.project)) return null;
    if (!nonEmptyString(raw.project.id) || !nonEmptyString(raw.project.name) || typeof raw.project.status !== "string") return null;
    project = { id: raw.project.id, name: raw.project.name, status: raw.project.status };
  }

  // R5-I1 batch-validates every Project reference in the window BEFORE emitting
  // a list, so on a LIST the pair must always agree. (The detail route may
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
    fileName: raw.fileName,
    verdict: raw.verdict as TeamVideoVerdict,
    ...(raw.contentType !== undefined ? { contentType: raw.contentType } : {}),
    consensusScore: raw.consensusScore,
    confidenceLabel: raw.confidenceLabel as TeamVideoListItem["confidenceLabel"],
    evidenceQuality: raw.evidenceQuality as TeamVideoListItem["evidenceQuality"],
    frameCount: raw.frameCount,
    createdAt: raw.createdAt,
    workspaceId: raw.workspaceId,
    projectId: projectId as string | null,
    project,
    ...(raw.governanceStatus !== undefined ? { governanceStatus: raw.governanceStatus as TeamVideoListItem["governanceStatus"] } : {}),
  };
}

export type TeamVideoListPage = { items: TeamVideoListItem[]; hasMore: boolean; nextCursor?: string };

export function parseTeamVideoListPageResponse(args: {
  ok: boolean;
  status: number;
  body: unknown;
  address: TeamVideoListAddress;
}): { ok: true; page: TeamVideoListPage } | { ok: false; errorCode: TeamVideoListErrorCode } {
  if (!args.ok) {
    const code = isObject(args.body) && typeof args.body.errorCode === "string" ? args.body.errorCode : null;
    if (code !== null && SERVER_ERROR_CODES.has(code)) {
      return { ok: false, errorCode: code as TeamVideoListErrorCode };
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

  // The R5-I1 server derives `hasMore` FROM the cursor, so the two can never
  // disagree there. Both inconsistent combinations are therefore impossible in
  // an authentic response, and accepting either would let a client "load more"
  // by silently re-fetching page 1.
  if (args.body.hasMore === true && !nonEmptyString(args.body.nextCursor)) return { ok: false, errorCode: "malformed_response" };
  if (args.body.hasMore === false && args.body.nextCursor !== undefined) return { ok: false, errorCode: "malformed_response" };

  // The Workspace list echoes the scope it actually served; a mismatch means
  // the response answers a different question than the one this surface asked.
  if (args.address.kind === "workspace" && args.body.scope !== args.address.scope) {
    return { ok: false, errorCode: "malformed_response" };
  }

  const items: TeamVideoListItem[] = [];
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

export type TeamVideoListStatus = "disabled" | "loading" | "ready" | "error";

export interface UseTeamVideoVerificationListResult {
  items: TeamVideoListItem[];
  hasMore: boolean;
  status: TeamVideoListStatus;
  initialErrorCode: TeamVideoListErrorCode | null;
  loadingMore: boolean;
  loadMoreErrorCode: TeamVideoListErrorCode | null;
  loadMore: () => void;
  retryInitial: () => void;
  resetAndReloadFromStart: () => void;
}

export function useTeamVideoVerificationList(args: { address: TeamVideoListAddress; enabled?: boolean }): UseTeamVideoVerificationListResult {
  const { address } = args;
  const enabled = args.enabled ?? true;
  const { user, authReady } = useAuth();

  const [items, setItems] = useState<TeamVideoListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<TeamVideoListStatus>(enabled ? "loading" : "disabled");
  const [initialErrorCode, setInitialErrorCode] = useState<TeamVideoListErrorCode | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreErrorCode, setLoadMoreErrorCode] = useState<TeamVideoListErrorCode | null>(null);

  const cursorRef = useRef<string | undefined>(undefined);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seqRef = useRef(0);
  const mountedRef = useRef(false);
  /** The in-flight read, so an obsolete one can be cancelled rather than merely ignored. */
  const activeControllerRef = useRef<AbortController | null>(null);

  const abortActiveRequest = useCallback(() => {
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
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

      // This request's own controller. Any earlier one is cancelled, and the
      // ref is only cleared later if it still points at THIS controller — an
      // older request's finalization must never cancel a newer one.
      activeControllerRef.current?.abort();
      const controller = new AbortController();
      activeControllerRef.current = controller;

      if (opts.isLoadMore) {
        setLoadingMore(true);
        setLoadMoreErrorCode(null);
      } else {
        setStatus("loading");
        setInitialErrorCode(null);
      }

      const url = buildTeamVideoListUrl(address, opts.cursor);

      try {
        // Both the first attempt and the forced refresh share this signal, so a
        // context change during the refresh cancels the refresh too.
        const read = (forceTokenRefresh = false) =>
          authedFetch(url, {
            user: opts.currentUser,
            authReady: true,
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            ...(forceTokenRefresh ? { forceTokenRefresh: true } : {}),
          });

        let res = await read();
        if (!owns()) return;

        if (res.status === 401) {
          // Exactly one forced refresh, then stop. A second 401 is a finished
          // session: terminate here WITHOUT reading the body, so no server
          // error vocabulary can rename it. There is never a third request.
          res = await read(true);
          if (!owns()) return;
          if (res.status === 401) {
            if (opts.isLoadMore) {
              setLoadingMore(false);
              setLoadMoreErrorCode("auth_error");
            } else {
              setStatus("error");
              setInitialErrorCode("auth_error");
            }
            return;
          }
        }

        const body = await res.json().catch(() => null);
        if (!owns()) return;

        const result = parseTeamVideoListPageResponse({ ok: res.ok, status: res.status, body, address });
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

        // Dedupe AFTER the whole page has validated, so an integrity-invalid
        // row can never be silenced by having been seen before.
        const deduped: TeamVideoListItem[] = [];
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
        // An aborted obsolete request fails the ownership check and must not
        // surface an error of its own.
        if (!owns()) return;
        if (opts.isLoadMore) {
          setLoadingMore(false);
          setLoadMoreErrorCode("network_error");
        } else {
          setStatus("error");
          setInitialErrorCode("network_error");
        }
      } finally {
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
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
    abortActiveRequest();
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
  }, [enabled, authReady, uid, workspaceId, scope, projectId, abortActiveRequest]);

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
export function teamVideoListInitialErrorCopy(code: TeamVideoListErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view videos.", retry: false };
    case "team_workspace_not_found":
    case "project_not_found":
    case "insufficient_capability":
      return { message: "Videos are no longer available here.", retry: false };
    case "team_workspace_unavailable":
    case "network_error":
      return { message: "Couldn't load videos right now. Please try again.", retry: true };
    case "invalid_cursor":
      return { message: "This page link is no longer valid.", retry: true };
    default:
      return { message: "We couldn't display these videos safely.", retry: true };
  }
}

/** Load-more copy. Already-rendered rows are never replaced by these states. */
export function teamVideoListLoadMoreErrorCopy(code: TeamVideoListErrorCode): { message: string; action: "retry" | "reload" } {
  switch (code) {
    case "invalid_cursor":
      return { message: "This page link is no longer valid.", action: "reload" };
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view videos.", action: "reload" };
    case "team_workspace_not_found":
    case "project_not_found":
    case "insufficient_capability":
      return { message: "Videos are no longer available here.", action: "reload" };
    case "internal_error":
    case "malformed_response":
      return { message: "We couldn't display these videos safely.", action: "reload" };
    default:
      return { message: "Couldn't load more videos right now. Please try again.", action: "retry" };
  }
}

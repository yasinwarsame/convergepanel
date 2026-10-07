"use client";

/**
 * TEAM_EXPORT_E3 — the Team research export UI.
 *
 * Three Team routes, never a Personal one:
 *   - create   POST /api/workspaces/{W}/runs/{R}/export                (E1)
 *   - history  GET  /api/workspaces/{W}/runs/{R}/exports               (E2-A)
 *   - download GET  /api/workspaces/{W}/runs/{R}/exports/{exportId}    (E2-B)
 *
 * Every control here is a presentation hint; each route re-derives and
 * re-checks its own authority server-side on every request.
 *   - The export button renders only when the page's server-derived
 *     `canCreateExport` (the caller's `exports.create`) is true, the export
 *     flag is on, and the caller's plan includes advanced export — the same
 *     three conditions E1 enforces.
 *   - The history is shown to every viewer of a Team research report: the page
 *     itself already requires `research.read`, which is exactly what E2-A
 *     requires.
 *   - A download control renders only on `ready` and `superseded` rows, the
 *     statuses E2-B serves. Plan and frozen-governance refusals come back from
 *     E2-B as a 403 and are shown as its message.
 *   - The generator is the export's FROZEN `generatedBy` (display name, then
 *     masked email); with none, a neutral "Not available". No uid is ever
 *     rendered, because the history response carries none (F1).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";
import { getPlanConfig } from "@/lib/plans";
import { authedFetch } from "@/lib/client/authedFetch";
import type { AdaptiveExportFormat } from "@/lib/adaptiveSchema/researchExport";
import { formatCreatedAt, formatLabel, governanceLabel, saveResponseAsDownload, type ExportGovernanceStatusDto } from "@/components/adaptive/exportHistoryFormat";
import { Card, SectionLabel } from "@/components/adaptive/shared";

const EXPORT_FLAG_ENABLED = process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED === "true";
const DOCX_FLAG_ENABLED = process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED === "true";
const JSON_FLAG_ENABLED = process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED === "true";

const FORMAT_OPTIONS: Array<{ value: AdaptiveExportFormat; label: string }> = [
  { value: "pdf", label: "PDF" },
  ...(DOCX_FLAG_ENABLED ? [{ value: "docx" as const, label: "Word (.docx)" }] : []),
  ...(JSON_FLAG_ENABLED ? [{ value: "json" as const, label: "JSON" }] : []),
];
const SHOW_FORMAT_SELECTOR = FORMAT_OPTIONS.length > 1;

export const TEAM_EXPORT_GENERATOR_UNAVAILABLE = "Not available";

export interface TeamExportListItem {
  exportId: string;
  reportVersion: number;
  format: string;
  artifactStatus: string;
  createdAt: string;
  generatedBy?: { displayName: string | null; maskedEmail: string | null };
  governanceStatusAtExport: ExportGovernanceStatusDto;
}

/** The frozen generator identity, never a uid; a neutral label when the export carries none. */
export function teamExportGeneratorLabel(item: Pick<TeamExportListItem, "generatedBy">): string {
  const g = item.generatedBy;
  const name = typeof g?.displayName === "string" ? g.displayName.trim() : "";
  if (name) return name;
  const email = typeof g?.maskedEmail === "string" ? g.maskedEmail.trim() : "";
  if (email) return email;
  return TEAM_EXPORT_GENERATOR_UNAVAILABLE;
}

/** E2-B serves only these two statuses; every other row gets no download control. */
export function isTeamExportDownloadable(artifactStatus: string): boolean {
  return artifactStatus === "ready" || artifactStatus === "superseded";
}

function exportsBase(workspaceId: string, runId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`;
}

/** A created export bumps this so an already-open history reloads. */
const TeamExportRefreshContext = createContext<{ generation: number; bump: () => void }>({ generation: 0, bump: () => undefined });

export function TeamExportRefreshProvider({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  const bump = useCallback(() => setGeneration((g) => g + 1), []);
  const value = useMemo(() => ({ generation, bump }), [generation, bump]);
  return <TeamExportRefreshContext.Provider value={value}>{children}</TeamExportRefreshContext.Provider>;
}

export function TeamResearchExportButton({ workspaceId, runId, canCreateExport }: { workspaceId: string; runId: string; canCreateExport: boolean }) {
  const { user, authReady } = useAuth();
  const { plan, loading: planLoading } = useUserPlan();
  const { bump } = useContext(TeamExportRefreshContext);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [format, setFormat] = useState<AdaptiveExportFormat>("pdf");

  if (!EXPORT_FLAG_ENABLED) return null;
  if (!canCreateExport) return null;
  if (planLoading || !plan) return null;
  if (!getPlanConfig(plan).advancedExportEnabled) return null;

  async function handleExport() {
    setState("loading");
    setErrorMessage(null);
    try {
      const res = await authedFetch(`${exportsBase(workspaceId, runId)}/export`, {
        method: "POST",
        user,
        authReady,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setErrorMessage(body?.message || "Export failed. Please try again.");
        setState("error");
        return;
      }
      await saveResponseAsDownload(res, `convergepanel-export-${runId}.${format}`);
      setState("idle");
      bump();
    } catch {
      setErrorMessage("Export failed. Please check your connection and try again.");
      setState("error");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1" data-testid="team-export-control">
      <div className="flex items-center gap-1.5">
        {SHOW_FORMAT_SELECTOR && (
          <select
            aria-label="Export format"
            value={format}
            disabled={state === "loading"}
            onChange={(e) => setFormat(e.target.value as AdaptiveExportFormat)}
            className="rounded-lg border border-slate-200 bg-white px-1.5 py-1.5 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={handleExport}
          disabled={state === "loading"}
          aria-busy={state === "loading"}
          data-testid="team-export-create"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state === "loading" ? "Generating…" : SHOW_FORMAT_SELECTOR ? "Export" : "Export PDF"}
        </button>
      </div>
      {state === "error" && errorMessage && (
        <p role="alert" className="max-w-[220px] text-right text-[11px] text-red-600">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

function TeamExportHistoryRow({ workspaceId, runId, item }: { workspaceId: string; runId: string; item: TeamExportListItem }) {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const downloadable = isTeamExportDownloadable(item.artifactStatus);
  const isCurrent = item.artifactStatus === "ready";

  async function handleDownload() {
    setState("loading");
    setErrorMessage(null);
    try {
      const res = await authedFetch(`${exportsBase(workspaceId, runId)}/exports/${encodeURIComponent(item.exportId)}`, {
        method: "GET",
        user,
        authReady,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setErrorMessage(body?.message || `Couldn't download this ${formatLabel(item.format)}. Please try again.`);
        setState("error");
        return;
      }
      await saveResponseAsDownload(res, `convergepanel-export-${runId}-v${item.reportVersion}.${item.format}`);
      setState("idle");
    } catch {
      setErrorMessage(`Couldn't download this ${formatLabel(item.format)}. Please check your connection and try again.`);
      setState("error");
    }
  }

  return (
    <li className="flex flex-col gap-2 border-b border-slate-100 py-2.5 last:border-0 sm:flex-row sm:items-center sm:justify-between" data-testid="team-export-row">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-slate-800">v{item.reportVersion}</span>
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              isCurrent ? "bg-green-50 text-green-700" : downloadable ? "bg-slate-100 text-slate-600" : "bg-red-50 text-red-700"
            }`}
          >
            {isCurrent ? "Current" : downloadable ? "Superseded" : item.artifactStatus}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {formatCreatedAt(item.createdAt)} · {formatLabel(item.format)} · {governanceLabel(item.governanceStatusAtExport)}
        </p>
        <p className="mt-0.5 text-xs text-slate-500" data-testid="team-export-generator">
          Exported by {teamExportGeneratorLabel(item)}
        </p>
      </div>

      {downloadable && (
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={handleDownload}
            disabled={state === "loading"}
            aria-busy={state === "loading"}
            aria-label={`Download the ${formatLabel(item.format)} for export version ${item.reportVersion}`}
            data-testid="team-export-download"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {state === "loading" ? "Downloading…" : `Download ${formatLabel(item.format)}`}
          </button>
          {state === "error" && errorMessage && (
            <p role="alert" className="max-w-[200px] text-right text-[11px] text-red-600">
              {errorMessage}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function TeamResearchExportHistory({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const { user, authReady } = useAuth();
  const { generation } = useContext(TeamExportRefreshContext);
  const [open, setOpen] = useState(false);
  const [listState, setListState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [items, setItems] = useState<TeamExportListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  async function fetchPage(cursor: number | null) {
    const query = cursor !== null ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const res = await authedFetch(`${exportsBase(workspaceId, runId)}/exports${query}`, { method: "GET", user, authReady });
    if (!res.ok) throw new Error("list_failed");
    return res.json();
  }

  async function loadFirstPage() {
    setListState("loading");
    setListError(null);
    try {
      const body = await fetchPage(null);
      setItems(Array.isArray(body.exports) ? body.exports : []);
      setHasMore(Boolean(body.hasMore));
      setNextCursor(typeof body.nextCursor === "number" ? body.nextCursor : null);
      setListState("loaded");
    } catch {
      setListError("Couldn't load export history. Please check your connection.");
      setListState("error");
    }
  }

  // Load when first opened, and reload when a new export was created while open.
  // Keyed ONLY on those two events: the latest loader is read through a ref, so
  // an identity change in auth state can never re-trigger a request loop.
  const loadRef = useRef(loadFirstPage);
  loadRef.current = loadFirstPage;
  useEffect(() => {
    if (open) void loadRef.current();
  }, [open, generation]);

  if (!EXPORT_FLAG_ENABLED) return null;

  async function loadMore() {
    if (loadingMore || nextCursor === null) return;
    setLoadingMore(true);
    try {
      const body = await fetchPage(nextCursor);
      setItems((prev) => [...prev, ...(Array.isArray(body.exports) ? body.exports : [])]);
      setHasMore(Boolean(body.hasMore));
      setNextCursor(typeof body.nextCursor === "number" ? body.nextCursor : null);
    } catch {
      setListError("Couldn't load more exports. Please try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Card>
      <details data-testid="team-export-history" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer">
          <SectionLabel>Previous exports</SectionLabel>
        </summary>
        <div className="mt-2">
          {listState === "loading" && <p className="text-sm text-slate-500">Loading export history…</p>}
          {listState === "error" && (
            <p role="alert" className="text-sm text-red-600">
              {listError}
            </p>
          )}
          {listState === "loaded" && items.length === 0 && <p className="text-sm text-slate-500">No previous exports for this report yet.</p>}
          {listState === "loaded" && items.length > 0 && (
            <>
              <ul>
                {items.map((item) => (
                  <TeamExportHistoryRow key={item.exportId} workspaceId={workspaceId} runId={runId} item={item} />
                ))}
              </ul>
              {hasMore && (
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  aria-busy={loadingMore}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}
        </div>
      </details>
    </Card>
  );
}

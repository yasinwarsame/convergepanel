/**
 * Order 6 / S-2a — page-level case matrix for the Decision Support provenance UI.
 *
 * Every page body in this matrix comes from the REAL route handler (P1 `GET /api/user/runs/[runId]`, W1
 * `GET /api/workspaces/[workspaceId]/runs/[runId]`, P2 `GET /api/user/runs/[runId]/governance`) run in-process by
 * dsProvenancePages.spec.tsx with only I/O mocked, so the page receives exactly what the server would send that viewer.
 *
 * Synthetic data only:
 *   - Decision Support outputs come from the real producer (dsExportFixtures.dsOutput / dsStates);
 *   - governance records are the sealed S-1a-min golden records, with their `decisionReceipt` rebuilt by the real
 *     receipt builder from the same output, so the page's receipt matches its result;
 *   - viewers mirror the S-1b.1 / S-1b.2 route suites (dsProvenanceRouteCases.ts, dsProvenanceP2Cases.ts).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { dsOutput, dsStates } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
import { buildAdaptiveDecisionReceipt } from "@/lib/adaptiveSchema/decisionReceiptBuilder";

const GOLDENS = JSON.parse(readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/fixtures/dsProvenanceViewMin.goldens.json"), "utf-8")) as {
  fixtures: { governance: Record<string, { record?: Record<string, unknown> }> };
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export const RUN_ID = "run-parity-1";
export const OWNER = "uid-owner";
export const REVIEWER = "uid-rev-r";
export const STRANGER = "uid-stranger";
export const TEAM_UID = "uid-team-member";
export const WS_ID = "aTeamWorkspaceAutoId12345";
export const PROJECT_ID = "projAutoId0001";

/** The page surface a viewer opens, and the route view that surface may use. */
export type PageKind = "P1" | "W1" | "INBOX";

export interface PageViewer {
  key: string;
  page: PageKind;
  runKind: "personal" | "team";
  uid: string | null;
  /** Expected to be denied by its route (no 200 body). */
  denied?: true;
  history?: "qualifying" | "absent";
  capabilities?: string[];
  assignedTeamReviewer?: true;
  teamAccess?: { granted: false; reason: string };
  runOverrides?: Record<string, unknown>;
}

const MEMBER_CAPS = ["workspace.read", "research.read"];
const REVIEWER_CAPS = ["workspace.read", "research.read", "reviews.submit"];

export const VIEWERS: PageViewer[] = [
  { key: "p1.owner", page: "P1", runKind: "personal", uid: OWNER },
  // A personal reviewer with decision-content access (a qualifying history row) and without it (reduced view, OD-7).
  { key: "p1.rev.content", page: "P1", runKind: "personal", uid: REVIEWER, history: "qualifying" },
  { key: "p1.rev.reduced", page: "P1", runKind: "personal", uid: REVIEWER, history: "absent" },
  { key: "w1.member", page: "W1", runKind: "team", uid: TEAM_UID, capabilities: MEMBER_CAPS },
  { key: "w1.reviewer", page: "W1", runKind: "team", uid: TEAM_UID, capabilities: REVIEWER_CAPS, assignedTeamReviewer: true },
  // The reviewer inbox fetches P1 and P2; it must use only P2 (OD-4).
  { key: "inbox.rev.identity", page: "INBOX", runKind: "personal", uid: REVIEWER, history: "qualifying" },
  { key: "inbox.rev.reduced", page: "INBOX", runKind: "personal", uid: REVIEWER, history: "absent" },
];

export const DENIED_VIEWERS: PageViewer[] = [
  { key: "p1.stranger", page: "P1", runKind: "personal", uid: STRANGER, denied: true },
  { key: "inbox.stranger", page: "INBOX", runKind: "personal", uid: STRANGER, denied: true },
  { key: "w1.membership_not_found", page: "W1", runKind: "team", uid: TEAM_UID, denied: true, teamAccess: { granted: false, reason: "membership_not_found" } },
  // Cross-team: a member of WS_ID opening a run that belongs to another Team workspace.
  { key: "w1.foreign_workspace_run", page: "W1", runKind: "team", uid: TEAM_UID, denied: true, capabilities: MEMBER_CAPS, runOverrides: { workspaceId: "anotherTeamWorkspace00001" } },
];

/**
 * Governance records by run kind: a pending review, a decided review with conditions, a single-reviewer decision, and
 * a decision recorded by a reviewer other than the inbox viewer (so the P2 identity gate depends on the history row).
 */
const RECORD_KEYS = {
  personal: { pending: "R12P:unreviewed_writer", awc: "L5P:PERSONAL_SELF_AWC", single: "R12P2:decidedVia_single_reviewer", other: "R12T:approved" },
  team: { pending: "R12P:unreviewed_writer", awc: "L5T:TEAM_PANEL_AWC", single: "R12T:approved", other: "R12T:approved" },
} as const;
export type RecordKind = keyof (typeof RECORD_KEYS)["personal"];

/**
 * Decision Support states (real producer). D-9-eligible states have options; `all_models_failed` has none. Also: the
 * real opposing-options case, a legacy output without `sources`, an empty and a blank source list, a result that asks
 * for human review, the :488 unresolved option and the :498 split.
 */
export const STATES = [
  "uncontested_choose_option",
  "merged_opposite_options",
  "all_models_failed",
  "legacy_no_sources_field",
  "no_sources",
  "blank_source_list",
  "high_stakes_review_needed",
  "unresolved_option_488",
  "split_option_498",
] as const;
export type StateName = (typeof STATES)[number];

export interface PageCase {
  id: string;
  viewer: PageViewer;
  state: StateName;
  record: RecordKind;
  /** O6-OBS-5: a stored `runDocument.perModel` with a `null` row (P1/W1 throw after authorization). */
  nullPerModelRow?: true;
}

/** Every state with the decided-with-conditions record, three states with the pending and single-reviewer records, one with the other-reviewer record; every viewer. */
export const CASES: PageCase[] = [
  ...VIEWERS.flatMap((viewer) => [
    ...STATES.map((state): PageCase => ({ id: `${viewer.key}|${state}|awc`, viewer, state, record: "awc" })),
    ...(["uncontested_choose_option", "merged_opposite_options", "legacy_no_sources_field"] as const).flatMap((state) =>
      (["pending", "single"] as const).map((record): PageCase => ({ id: `${viewer.key}|${state}|${record}`, viewer, state, record })),
    ),
    { id: `${viewer.key}|uncontested_choose_option|other`, viewer, state: "uncontested_choose_option", record: "other" } as PageCase,
  ]),
  ...DENIED_VIEWERS.map((viewer): PageCase => ({ id: `${viewer.key}|uncontested_choose_option|awc`, viewer, state: "uncontested_choose_option", record: "awc" })),
  { id: "p1.owner|uncontested_choose_option|awc|null_permodel_row", viewer: VIEWERS[0], state: "uncontested_choose_option", record: "awc", nullPerModelRow: true },
];

export function stateOutput(state: StateName) {
  const s = dsStates().find((x) => x.name === state);
  if (!s) throw new Error(`unknown DS state ${state}`);
  return dsOutput(s);
}

export function governanceRecord(kind: "personal" | "team", record: RecordKind, output: ReturnType<typeof stateOutput>): Record<string, unknown> {
  const r = clone(GOLDENS.fixtures.governance[RECORD_KEYS[kind][record]].record) as Record<string, unknown>;
  const result = output.result as unknown as Record<string, unknown>;
  // The stored receipt is built at creation from the same output (a legacy result had no `sources`; the builder needs a list).
  r.decisionReceipt = buildAdaptiveDecisionReceipt({ ...output, result: Array.isArray(result.sources) ? result : { ...result, sources: [] } } as never);
  return r;
}

/** The stored human review of a record, for history rows (P1 content access and the P2 identity gate key on it). */
export function storedHumanReview(kind: "personal" | "team", record: RecordKind): Record<string, unknown> {
  return (GOLDENS.fixtures.governance[RECORD_KEYS[kind][record]].record as { humanReview: Record<string, unknown> }).humanReview;
}

export const PER_MODEL_ROWS = [
  { modelId: "chatgpt", status: "ok", rawTextTruncated: "A", tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, latencyMs: 120, wasTruncated: false, provider: "openai", requestedModel: "gpt-5" },
  { modelId: "claude", status: "substituted", rawTextTruncated: "B", tokenUsage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 }, latencyMs: 340, wasTruncated: false, provider: "deepseek", requestedModel: "claude-x", substitutedFrom: "claude" },
  { modelId: "gemini", status: "error", rawTextTruncated: "", latencyMs: 10, wasTruncated: false },
];

export const D9 =
  "Options were grouped by text similarity. Different options with similar wording (for example 3.5% vs 35%, or Approve vs Disapprove) can be merged; agreement on an option is not established.";

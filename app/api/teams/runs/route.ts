/**
 * HTTP API route (teams/runs): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import {
  getRequestUid,
  loadUserAndTeam,
  memberRole,
  isTeamAdmin,
} from "@/lib/teams/teamApiAuth";
import { logger } from "@/lib/logger";
import {
  classifyTeamRunRow,
  parseTeamRunListFilters,
  applyTeamRunListFilters,
  sortTeamRunListItems,
  paginateTeamRunListItems,
  TeamRunListItemV1,
  TeamRunListResponseV1,
} from "@/lib/governance/teamRunListContract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tsMillis(t: unknown): number {
  if (t && typeof t === "object" && "toMillis" in t && typeof (t as { toMillis: () => number }).toMillis === "function") {
    return (t as { toMillis: () => number }).toMillis();
  }
  return 0;
}

/** Firestore teamRuns row + client sort key (spread doc fields). */
type TeamRunListRow = {
  id: string;
  timestamp: number;
  userId?: string;
  type?: string;
  policyFlags?: string[];
  humanDecision?: unknown;
  [key: string]: unknown;
};

export async function GET(req: NextRequest) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable." } },
      { status: 500 }
    );
  }

  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Team access required" } },
      { status: 403 }
    );
  }

  const { searchParams } = req.nextUrl;

  // ============================================
  // QUERY-ROUTING REDESIGN, PHASE 2A, STEP 7, PART E1 — versioned,
  // explicitly-discriminated list contract, opt-in via `?version=1`
  // (docs/governance-decision-receipts-design.md §25). The legacy,
  // untagged response below remains the default and is UNCHANGED — no
  // internal or external consumer of the default response has been
  // confirmed, so the default is not switched in this step (§25.10).
  // ============================================
  if (searchParams.get("version") === "1") {
    const filterResult = parseTeamRunListFilters(searchParams);
    if (!filterResult.ok) {
      return NextResponse.json(
        { ok: false, error: { code: "validation_error", message: `Invalid query parameter: ${filterResult.reason}` } },
        { status: 400 }
      );
    }
    const { filters } = filterResult;

    const role = memberRole(uid, ctx.team);
    const admin = isTeamAdmin(role);

    const snap = await adminDb.collection("teamRuns").where("teamId", "==", ctx.team.id).get();

    // Member-only scoping happens on RAW document data, before
    // classification/mapping — the mapped adaptive item never exposes
    // `userId` at all (§25.9), so scoping must not depend on the mapped
    // shape.
    const scopedDocs = admin ? snap.docs : snap.docs.filter((d) => d.data().userId === uid);

    const items: TeamRunListItemV1[] = [];
    for (const doc of scopedDocs) {
      const result = classifyTeamRunRow(doc.id, doc.data());
      if (result.status === "valid") {
        items.push(result.item);
      } else {
        // Metadata-only — never the query, receipt conclusion, or any
        // other row content.
        logger.warn("[teams/runs] Skipped a malformed teamRuns row from the versioned list", {
          teamRunId: result.teamRunId,
          detectedKind: result.detectedKind,
        });
      }
    }

    const filteredItems = applyTeamRunListFilters(items, filters);
    const sortedItems = sortTeamRunListItems(filteredItems);
    const { pageItems, pagination } = paginateTeamRunListItems(sortedItems, filters.page, filters.limit);

    const response: TeamRunListResponseV1 = {
      ok: true,
      version: 1,
      items: pageItems,
      pagination,
    };
    return NextResponse.json(response);
  }

  // ---- Legacy, unversioned response (unchanged) ----
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10) || 20));
  const typeFilter = searchParams.get("type") as "research" | "verification" | null;
  const flaggedOnly = searchParams.get("flagged") === "true";
  const userFilter = searchParams.get("userId");

  const role = memberRole(uid, ctx.team);
  const admin = isTeamAdmin(role);

  const snap = await adminDb.collection("teamRuns").where("teamId", "==", ctx.team.id).get();

  let rows: TeamRunListRow[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      timestamp: tsMillis(data.timestamp),
    } as TeamRunListRow;
  });

  if (!admin) {
    rows = rows.filter((r) => r.userId === uid);
  }

  if (typeFilter === "research" || typeFilter === "verification") {
    rows = rows.filter((r) => r.type === typeFilter);
  }

  if (userFilter && admin) {
    rows = rows.filter((r) => r.userId === userFilter);
  }

  if (flaggedOnly) {
    rows = rows.filter((r) => {
      const flags = r.policyFlags;
      return Array.isArray(flags) && flags.length > 0 && !r.humanDecision;
    });
  }

  rows.sort((a, b) => (b.timestamp as number) - (a.timestamp as number));

  const total = rows.length;
  const start = (page - 1) * limit;
  const pageRows = rows.slice(start, start + limit);

  return NextResponse.json({
    ok: true,
    runs: pageRows,
    total,
    page,
    limit,
  });
}

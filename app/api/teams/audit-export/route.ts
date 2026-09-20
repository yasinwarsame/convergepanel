/**
 * HTTP API route (teams/audit-export): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { resolveLegacyReadDomain, teamRunRowIsInLegacyReadDomain } from "@/lib/governance/legacyReviewReadDomain";
import {
  getRequestUid,
  loadUserAndTeam,
  memberRole,
  isTeamAdmin,
} from "@/lib/teams/teamApiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tsMillis(t: unknown): number {
  if (t && typeof t === "object" && "toMillis" in t && typeof (t as { toMillis: () => number }).toMillis === "function") {
    return (t as { toMillis: () => number }).toMillis();
  }
  return 0;
}

function escapeCsv(s: string) {
  const x = s.replace(/"/g, '""');
  return `"${x}"`;
}

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

  const role = memberRole(uid, ctx.team);
  if (!isTeamAdmin(role)) {
    return NextResponse.json(
      { ok: false, error: { code: "insufficient_role", message: "Admin access required" } },
      { status: 403 }
    );
  }

  const { searchParams } = req.nextUrl;
  const fromIso = searchParams.get("from") || "";
  const toIso = searchParams.get("to") || "";
  const format = searchParams.get("format") === "csv" ? "csv" : "json";

  const fromMs = fromIso ? new Date(fromIso).getTime() : 0;
  const toMs = toIso ? new Date(toIso).getTime() : Date.now();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return NextResponse.json(
      { ok: false, error: { code: "validation_error", message: "Invalid from/to dates (ISO)." } },
      { status: 400 }
    );
  }

  const snap = await adminDb.collection("teamRuns").where("teamId", "==", ctx.team.id).get();

  // Query-Routing Redesign, Phase 2A, Step 7, Part E1 — adaptive
  // projections coexist in this SAME collection (§24.1/§25) and are
  // EXPLICITLY excluded here, by the real `adaptive` discriminator field —
  // never by relying on adaptive rows simply lacking legacy fields like
  // `query`/`consensusScore`. A real adaptive export contract (what
  // columns, what's safe to include) is a genuine design decision deferred
  // to a future step, per §21.14/§25 — not built here.
  const legacyDocs = snap.docs.filter((d) => d.data().adaptive !== true);

  // Phase 1 Cross-Authority READ Guard — a Workspace-bound artifact is outside
  // this surface's authority domain, so its row is excluded from the
  // legacy-domain export as well. An export is the highest-leverage read on
  // this collection (bulk, durable, it leaves the product), so it gets the
  // same exclusion as the queue rather than a weaker one. Adaptive rows are
  // already excluded above; this closes the CLASSIC rows — both the
  // run-backed ones and the Workspace Claim VERIFICATION rows, whose
  // `query`/`verdict`/`consensusScore`/`humanDecision` are equally outside a
  // legacy caller's domain.
  //
  // Deliberately applied AFTER the pure `from`/`to` window filter below it in
  // time but before any row is rendered: the window is a local, purely
  // subtractive filter that cannot weaken authorization, so classifying only
  // the rows that could actually be exported keeps a one-day export from
  // reading the team's entire history.
  const windowedDocs = legacyDocs.filter((d) => {
    const t = tsMillis(d.data().timestamp);
    return t >= fromMs && t <= toMs;
  });
  const readDomain = await resolveLegacyReadDomain(windowedDocs.map((d) => d.data()));
  const eligibleDocs = windowedDocs.filter((d) => teamRunRowIsInLegacyReadDomain(d.data(), readDomain));

  // An audit export is a DURABLE compliance artifact: a reader who downloads it
  // treats its contents as the authoritative record for the window. So when the
  // authority of even one in-window candidate could not be determined, the
  // export fails visibly instead of returning a file that is indistinguishable
  // from "there was no activity". Fail-closed stays fail-closed — nothing
  // unproven is ever included — but silence is not an acceptable way to say it.
  //
  // Atomic on purpose: a partially-complete export is not offered, because this
  // route has no completeness marker a reader could notice. And deliberately
  // generic: the response never says which row, which collection or which
  // authority domain was involved, so it cannot become an existence oracle for
  // the very artifacts the read guard hides.
  if (readDomain.classificationUnavailable) {
    return NextResponse.json(
      { ok: false, error: { code: "firestore_unavailable", message: "Could not generate the audit export. Please try again." } },
      { status: 503 }
    );
  }

  const rows = eligibleDocs
    .map((d) => {
      const x = d.data();
      const t = tsMillis(x.timestamp);
      return {
        runId: d.id,
        timestamp: new Date(t).toISOString(),
        userEmail: String(x.userEmail ?? ""),
        type: String(x.type ?? ""),
        queryTruncated: String(x.query ?? "").slice(0, 200),
        verdict: x.verdict != null ? String(x.verdict) : "",
        consensusScore: Number(x.consensusScore ?? 0),
        policyFlags: Array.isArray(x.policyFlags) ? x.policyFlags : [],
        humanDecision: x.humanDecision ?? null,
      };
    })
    .filter((r) => {
      const t = new Date(r.timestamp).getTime();
      return t >= fromMs && t <= toMs;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const fromSlug = fromIso ? fromIso.slice(0, 10) : "start";
  const toSlug = toIso ? toIso.slice(0, 10) : "end";
  const fname = `convergepanel-audit-${fromSlug}-${toSlug}.${format}`;

  if (format === "json") {
    return new NextResponse(JSON.stringify(rows, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${fname}"`,
      },
    });
  }

  const headers = [
    "runId",
    "timestamp",
    "userEmail",
    "type",
    "queryTruncated",
    "verdict",
    "consensusScore",
    "policyFlags",
    "humanDecisionAction",
    "humanDecisionNotes",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    const hd = r.humanDecision as { action?: string; notes?: string } | null;
    lines.push(
      [
        escapeCsv(r.runId),
        escapeCsv(r.timestamp),
        escapeCsv(r.userEmail),
        escapeCsv(r.type),
        escapeCsv(r.queryTruncated),
        escapeCsv(r.verdict),
        String(r.consensusScore),
        escapeCsv((r.policyFlags as string[]).join(";")),
        escapeCsv(hd?.action ?? ""),
        escapeCsv(hd?.notes ?? ""),
      ].join(",")
    );
  }

  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fname}"`,
    },
  });
}

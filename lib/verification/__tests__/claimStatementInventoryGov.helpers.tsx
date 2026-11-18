/**
 * Doc 14 PR-1, R4 (owner ruling 2026-11-18, MAJOR-1): the GOVERNANCE QUEUE as a surface of the closed-world claim
 * sentence inventory. Not a spec: claimStatementInventoryGov*.spec.tsx install the module mocks below (they must be
 * hoisted in the spec file itself) and call `installGovProducer`.
 *
 * Producer: every case's stored document goes through the REAL `GET /api/governance/queue` handler (a Firestore double
 * that honours `.select()` projections, 50 documents per request — the route's page size) and the returned row is
 * rendered by the REAL dashboard row (`FragmentRow`, expanded). The text nodes of that markup are the units.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";
import { FragmentRow } from "@/components/governance/GovernanceDashboard";
import { PRODUCERS, textNodes, type Case } from "./claimStatementInventory.harness";
import { govState } from "./claimStatementInventoryGov.db";

function render(row: Record<string, unknown>): string {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(
      "table",
      null,
      createElement(
        "tbody",
        null,
        createElement(FragmentRow as never, {
          row,
          chip: { wrap: "", label: "Review" },
          mh: { text: "", cls: "", title: "" },
          ev: { text: "", cls: "" },
          exp: true,
          firstReason: "",
          more: "",
          consensusColor: () => "",
          expanded: new Set<string>(),
          setExpanded: noop,
          reviewBusyKey: null,
          onApprove: noop,
          onBlock: noop,
          onChanges: noop,
        } as never)
      )
    )
  );
}

/** Runs every case through the route (batches of 50) and registers the "gov" producer over the returned rows. */
export async function installGovProducer(cases: readonly Case[]): Promise<void> {
  const byCase = new Map<Case, Record<string, unknown>>();
  for (let start = 0; start < cases.length; start += 50) {
    const batch = cases.slice(start, start + 50);
    const now = Date.now();
    govState.rows = batch.map((c, j) => ({
      id: `case-${start + j}`,
      data: {
        ...(c.doc as unknown as Record<string, unknown>),
        userId: "owner-a",
        governanceStatus: "needs_review",
        governanceReasons: ["r1"],
        timestamp: { toMillis: () => now - j },
      },
    }));
    const res = await GET(new NextRequest("http://localhost/api/governance/queue?limit=50"));
    const json = (await res.json()) as { runs?: Array<Record<string, unknown>> };
    const got = new Map((json.runs ?? []).map((r) => [String(r.runId), r]));
    batch.forEach((c, j) => {
      const row = got.get(`case-${start + j}`);
      if (row) byCase.set(c, row);
    });
  }
  PRODUCERS.gov = (c) => {
    const row = byCase.get(c);
    return row ? textNodes(render(row)) : ["<no governance queue row>"];
  };
}

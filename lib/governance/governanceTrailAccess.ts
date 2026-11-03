/**
 * Governance Audit tab — who may open a run's audit TRAIL
 * (`GET /api/governance/audit?runId=&collection=`).
 *
 * The trail shows only the viewer's own actions on that run (the route filters every trail to `byUid === viewer`). It
 * opens when the run's AUTHORITATIVE owner (the parent document's `userId`, read server-side, never a client value or
 * the audit row's recorded `runOwnerUid`) is either:
 *   - the viewer: their own research or claim; or
 *   - inside the viewer's CURRENT governance reviewer scope (`runOwnerVisibleInGovernance`): global for a support admin,
 *     otherwise the owners who currently assign the viewer as their reviewer.
 *
 * The own-run arm does NOT add the viewer to `visibleUserIds`. That set also drives the governance queue, review and
 * decision authority, and is deliberately left as it is (assigners only, never the viewer). A former reviewer, whose
 * assigner has since removed them, stays refused: having acted on a run once is not continuing access to its trail.
 *
 * One rule for both sides: the drilldown enforces it, and the global list uses it to mark which rows can be opened
 * (`trailAvailable`), so the list never offers a trail the drilldown would refuse.
 */
import { runOwnerVisibleInGovernance } from "@/lib/governance/governanceVisibleUserIds";

export function governanceTrailAccessible(args: { viewerUid: string; visibleUserIds: string[] | null; ownerUid: string }): boolean {
  const { viewerUid, visibleUserIds, ownerUid } = args;
  if (viewerUid !== "" && ownerUid !== "" && ownerUid === viewerUid) return true;
  return runOwnerVisibleInGovernance(visibleUserIds, ownerUid);
}

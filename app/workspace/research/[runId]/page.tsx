/**
 * PERSONAL-RESEARCH-URL-1 — `GET /workspace/research/{runId}`, the canonical
 * durable address for a persisted Personal research run.
 *
 * DELIBERATELY THIN. It establishes that someone is signed in and hands the
 * opaque `runId` to the client shell. It does NOT read Firestore, re-implement
 * `GET /api/user/runs/[runId]`'s authorization, derive ownership from the URL,
 * infer a `projectId`, authorize Team membership, or execute models. That API
 * remains the single canonical run-read authority — owner and Personal-reviewer
 * access, Personal/Team binding classification, Workspace integrity, the P0
 * availability contract, and every persisted-result path live there.
 *
 * NOT GATED ON WORKSPACE OR PROJECTS ROLLOUT. The `/workspace/` prefix exists so
 * the shipped 11B.5 `resolveWorkspaceNavContext()` classifies this route as
 * Personal with zero navigation change — it is path placement, not product
 * eligibility. Gating a saved report on `workspaceUiEnabled` or
 * `projectsUiEnabled` would take someone's own research away from them because a
 * separate UI flag had not reached their account, so those flags are not consulted.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import PersonalResearchDetailShell from "@/components/workspace/PersonalResearchDetailShell";

export const dynamic = "force-dynamic";

export default async function PersonalResearchDetailPage({
  params,
}: {
  params: { runId: string };
}) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    // Same concealed treatment every other Personal Workspace-scoped page uses
    // for an unauthenticated request — never a flash-then-hide.
    notFound();
  }

  // A blank/whitespace address is not a run. Ownership is NOT decided here: the
  // id stays opaque and the API authorizes it.
  const runId = params.runId?.trim() ?? "";
  if (runId.length === 0) {
    notFound();
  }

  return <PersonalResearchDetailShell runId={runId} />;
}

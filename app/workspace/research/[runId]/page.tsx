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
 *
 * ZCA L-6: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie, rollout
 * admission or workspace data; it names the page kind and passes only URL params. The gate above runs,
 * unchanged in order and outcome, in the bearer-authorized endpoint named in
 * `components/workspace/PersonalWorkspacePage.tsx` — every closed gate or denial the same 404.
 */

import { notFound } from "next/navigation";
import PersonalWorkspacePage from "@/components/workspace/PersonalWorkspacePage";

export const dynamic = "force-dynamic";

export default function PersonalResearchDetailPage({ params }: { params: { runId: string } }) {
  // Identity-free URL check (D-4 §1: stays in the server render).
  const runId = params.runId?.trim() ?? "";
  if (runId.length === 0) {
    notFound();
  }
  return <PersonalWorkspacePage kind="research" runId={runId} />;
}

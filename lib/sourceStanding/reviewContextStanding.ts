/**
 * Order 4 Slice 2a — attach the Workspace's current Source Standing to the
 * Decision Receipt links Review Context ALREADY displays.
 *
 * Called only when SOURCE_AUTHORITY_METADATA_ENABLED is on (the caller owns the
 * flag check, so flag-off does zero work here). The link list is never
 * changed: same URLs, hostnames, order, dedup and count. Each displayed link
 * gets the identity of its own displayed URL (`sourceIdentityV1`); links with
 * no identity (userinfo, reserved hosts …) are never looked up and get no key.
 * Absence of a record also adds no key — absence is never a status.
 *
 * Reads: exact documents only, batched per successor-chain level (≤ 10
 * displayed ids, then ≤ MAX_SUCCESSOR_CHAIN_DEPTH levels). If the read itself
 * fails, every identity-bearing link is presented UNRESOLVED (we could not
 * resolve its standing) rather than silently looking "unattested".
 */
import "server-only";
import { logger } from "@/lib/logger";
import { sourceIdentityV1 } from "./sourceIdentity";
import { loadStandingPresentations } from "./standingFirestore";
import type { SourceStandingPresentationV1 } from "./standingTypes";

export async function withSourceStanding<L extends { url: string }>(workspaceId: string, links: readonly L[]): Promise<Array<L & { standing?: SourceStandingPresentationV1 }>> {
  const identities = links.map((link) => sourceIdentityV1(link.url));
  if (identities.every((x) => x === null)) return links.slice();
  let presentations: Array<SourceStandingPresentationV1 | null>;
  try {
    presentations = await loadStandingPresentations(workspaceId, identities);
  } catch (err: unknown) {
    logger.warn("[sourceStanding] standing read failed — identity-bearing links presented UNRESOLVED", { workspaceId, error: err instanceof Error ? err.message : String(err) });
    presentations = identities.map((identity) => (identity ? { status: "UNRESOLVED" } : null));
  }
  return links.map((link, i) => {
    const standing = presentations[i];
    return standing ? { ...link, standing } : link;
  });
}

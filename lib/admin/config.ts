/**
 * Phase FIRST-ADMIN-C1 — PRIVILEGED EMAIL CANONICALIZATION.
 *
 * The previous matcher applied NFKC and stripped zero-width characters on BOTH
 * sides. Because NFKC performs compatibility folding, a non-ASCII identity could
 * canonicalize onto an ASCII allowlist entry — a fullwidth character or an
 * embedded zero-width in either the local part or the domain collapses away.
 * The live-record requirement from P0.2 does not help: the holder verified
 * THEIR mailbox, which is a different mailbox from the one on the allowlist.
 *
 * The boundary is therefore stated positively and narrowly:
 *
 *   EMAIL-DERIVED PRIVILEGED AUTHORITY IS AVAILABLE ONLY TO ASCII IDENTITIES.
 *
 * A non-ASCII address is ineligible, full stop. It is not folded, not repaired,
 * not compared — it is rejected before any normalization can erase the evidence
 * that it was non-ASCII. Canonicalization here is deliberately minimal: outer
 * ASCII whitespace and ASCII case only.
 */
export function canonicalizePrivilegedEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Reject BEFORE trimming/lowercasing so nothing can launder a non-ASCII
  // identity into an ASCII one.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Control characters are not part of any legitimate address.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Parses one privileged allowlist. Entries that are not ASCII, or are otherwise
 * malformed, are DROPPED rather than folded — a misconfigured privileged entry
 * must never be silently converted into a working administrator identity.
 */
function parsePrivilegedList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const c = canonicalizePrivilegedEmail(part);
    if (c) out.push(c);
  }
  return out;
}

/** Number of entries dropped as invalid — for diagnostics, never their values. */
export function invalidPrivilegedEntryCount(raw: string | undefined): number {
  if (!raw?.trim()) return 0;
  return raw.split(",").filter((p) => p.trim() !== "" && !canonicalizePrivilegedEmail(p)).length;
}

/**
 * SCOPE-SPECIFIC MEMBERSHIP. These are the only allowlist predicates, and each
 * reads exactly one list.
 *
 * The previous `isAdminEmail()` ORed both lists into a single predicate, so an
 * address in EITHER list received application-admin APIs AND governance-global
 * scope AND policy write. Least privilege was unachievable by configuration and
 * the variable names actively misled the operator. There is deliberately no
 * blended predicate any more — not even a private one — so the shortcut cannot
 * be reintroduced by reuse.
 *
 * Membership is NOT authorization, and these are the ONLY predicates this module
 * exports. The verified forms deliberately live in the server-only
 * `lib/admin/verifiedAdminIdentity.ts` and are private there, so the sole public
 * way to obtain an authority answer is a uid-only resolver that reads the live
 * Firebase Auth record itself. A caller cannot hand in an email and a
 * verification flag of its own choosing.
 */
export function isApplicationAdminEmail(email: string | null | undefined): boolean {
  const c = canonicalizePrivilegedEmail(email);
  if (!c) return false;
  return parsePrivilegedList(process.env.ADMIN_EMAILS).includes(c);
}

export function isGovernanceAdminEmail(email: string | null | undefined): boolean {
  const c = canonicalizePrivilegedEmail(email);
  if (!c) return false;
  return parsePrivilegedList(process.env.GOVERNANCE_ADMIN_EMAILS).includes(c);
}

/** Effective GOVERNANCE allowlist for diagnostics only. Never authority. */
export function governanceAdminEmailsForLog(): string {
  return parsePrivilegedList(process.env.GOVERNANCE_ADMIN_EMAILS).join(",");
}

if (
  typeof window === "undefined" &&
  !process.env.ADMIN_EMAILS?.trim() &&
  !process.env.GOVERNANCE_ADMIN_EMAILS?.trim()
) {
  console.warn(
    "[config] No admin emails configured. Set ADMIN_EMAILS (application admin) and/or GOVERNANCE_ADMIN_EMAILS (governance admin)."
  );
}

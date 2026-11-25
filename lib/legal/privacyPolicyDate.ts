/**
 * PC-1 (owner PP-02, 2026-11-25): the Privacy Policy's displayed "Last updated" date.
 *
 * It is the real publication date of the approved correction. It is never backdated and never the date a draft was
 * created. It stays at the pending sentinel until the release commit replaces it, and that commit is made on the day
 * the reviewed text is published.
 *
 * `lib/legal/__tests__/privacyPolicyPublicationDate.spec.ts` fails while the sentinel is present. The required
 * Quality Gate therefore keeps the page from shipping without a real date.
 */
export const PRIVACY_POLICY_LAST_UPDATED_PENDING = "PENDING-PUBLICATION-DATE";

/** Format at release: "Month D, YYYY" (for example "November 25, 2026"), the same format the page used before. */
export const PRIVACY_POLICY_LAST_UPDATED: string = PRIVACY_POLICY_LAST_UPDATED_PENDING;

/**
 * Order 4 — Source Publisher Class v1 rules. Static, code-reviewed, versioned
 * with SOURCE_PUBLISHER_CLASSIFIER_VERSION. No remote list, no database, no
 * admin override, no LLM, and nothing here is ever fetched at runtime — the
 * policy/evidence URLs are review documentation only.
 *
 * TWO DISTINCT CONCEPTS:
 *
 * 1. RESTRICTED NAMESPACES — a DNS namespace whose OFFICIAL registration
 *    policy limits who may register under it. A match describes who controls
 *    the domain, nothing more. Each rule cites the official eligibility policy
 *    it rests on (verified at implementation time, 2026-10-11). A namespace is
 *    NOT a TLD reputation rule: `.org`, `.com`, ccTLDs etc. are deliberately
 *    absent because they are unrestricted.
 *      Omitted from v1: `.edu` — its official eligibility page
 *      (educause.edu) could not be retrieved for verification, so per the
 *      v1 contract it is left out rather than added from general knowledge.
 *
 * 2. REGISTRY ENTRIES — individual registrable domains whose publisher
 *    identity is documented. Never added for being "credible", "reputable"
 *    or "trusted"; never a multi-tenant/shared hosting suffix.
 *
 * Matching is label-boundary safe only: `host === d`, or (when allowed)
 * `host.endsWith("." + d)`. Never a bare `endsWith(d)`.
 */
import type { SourcePublisherClass } from "./types";

export type RestrictedNamespaceRule = {
  /** The namespace, e.g. "gov" or "gov.uk" — lowercase ASCII, no leading/trailing dot. Matches the namespace itself and every name under it. */
  namespace: string;
  publisherClass: Exclude<SourcePublisherClass, "UNCLASSIFIED" | "OPEN_CONTRIBUTION_PLATFORM">;
  /** Official eligibility policy — documentation for review, never fetched. */
  policyUrls: readonly string[];
  rationale: string;
};

export type RegistryEntry = {
  domain: string;
  publisherClass: Exclude<SourcePublisherClass, "UNCLASSIFIED">;
  includeSubdomains: boolean;
  /** Documentary evidence — review documentation only, never fetched. */
  evidenceUrl: string;
  rationale: string;
};

export const RESTRICTED_NAMESPACE_RULES: readonly RestrictedNamespaceRule[] = [
  {
    namespace: "gov",
    publisherClass: "GOVERNMENT",
    policyUrls: ["https://get.gov/domains/eligibility/"],
    rationale: "CISA administers .gov: \"Only verified U.S. government organizations can register and operate a .gov domain.\"",
  },
  {
    namespace: "mil",
    publisherClass: "GOVERNMENT",
    policyUrls: ["https://www.rfc-editor.org/rfc/rfc1956.html", "https://www.iana.org/domains/root/db/mil.html"],
    rationale: ".mil is delegated to the US Department of Defense (sponsor: DoD Network Information Center); only US military services, commands and DoD operating agencies may register second-level names.",
  },
  {
    namespace: "int",
    publisherClass: "INTERGOVERNMENTAL_ORGANIZATION",
    policyUrls: ["https://www.iana.org/domains/int/policy"],
    rationale: "IANA restricts .int to intergovernmental organizations established by an international treaty between national governments, with independent international legal personality.",
  },
  {
    namespace: "gov.uk",
    publisherClass: "GOVERNMENT",
    policyUrls: ["https://www.gov.uk/guidance/check-if-your-organisation-can-get-a-govuk-domain-name"],
    rationale: "Assigned by the Cabinet Office (CDDO); only listed UK public-sector organisations (central government, councils, fire services, police and crime commissioners, etc.) can apply.",
  },
];

export const REGISTRY_ENTRIES: readonly RegistryEntry[] = [
  {
    domain: "canada.ca",
    publisherClass: "GOVERNMENT",
    includeSubdomains: true,
    evidenceUrl: "https://design.canada.ca/specifications/mandatory-elements/domains-urls.html",
    rationale: "\"All public-facing Government of Canada websites must use the Canada.ca domain\"; domains and sub-domains are approved by Service Canada.",
  },
  {
    domain: "un.org",
    publisherClass: "INTERGOVERNMENTAL_ORGANIZATION",
    includeSubdomains: true,
    evidenceUrl: "https://www.un.org/en/about-us",
    rationale: "Official website of the United Nations, an international organization of 193 Member States founded under its Charter.",
  },
  {
    domain: "wikipedia.org",
    publisherClass: "OPEN_CONTRIBUTION_PLATFORM",
    includeSubdomains: true,
    evidenceUrl: "https://en.wikipedia.org/wiki/Wikipedia:About",
    rationale: "Articles \"can be edited by anyone with Internet access\" — the platform does not vouch for any individual author.",
  },
  {
    domain: "substack.com",
    publisherClass: "OPEN_CONTRIBUTION_PLATFORM",
    includeSubdomains: true,
    evidenceUrl: "https://substack.com/about",
    rationale: "Writers publish their own publications (commonly at <name>.substack.com); the platform does not author or vouch for them.",
  },
  {
    domain: "youtube.com",
    publisherClass: "OPEN_CONTRIBUTION_PLATFORM",
    includeSubdomains: true,
    evidenceUrl: "https://support.google.com/youtube/answer/57407",
    rationale: "Users upload and publish their own videos; the platform does not author or vouch for them.",
  },
];

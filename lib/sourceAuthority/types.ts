/**
 * Order 4 — Source Publisher Class v1.
 *
 * Answers ONE question: what kind of publisher / domain namespace does a
 * cited web address belong to? It is DESCRIPTIVE, categorical and unordered.
 *
 * It does NOT say — and must never be used to imply — that the page exists,
 * was fetched, supports the claim, is current, is peer reviewed, is the
 * primary source, or is accurate, reliable or trustworthy. There is no score,
 * no ranking and no ordering between classes: GOVERNMENT is not "above"
 * OPEN_CONTRIBUTION_PLATFORM. Publisher class has no effect on verdicts,
 * evidence type/strength, sourceBacked, consensus scoring or governance.
 */

/** Unordered. Do not add a numeric mapping, a sort weight or a high/medium/low tier. */
export type SourcePublisherClass = "GOVERNMENT" | "INTERGOVERNMENTAL_ORGANIZATION" | "ACADEMIC_INSTITUTION" | "OPEN_CONTRIBUTION_PLATFORM" | "UNCLASSIFIED";

export type SourcePublisherReasonCode =
  | "matched_restricted_namespace"
  | "matched_registry_entry"
  | "not_a_url"
  | "unsupported_protocol"
  | "credential_bearing_url"
  | "over_length"
  | "non_public_host"
  | "no_rule_matched";

export type SourcePublisherMatchedRule = { kind: "namespace" | "registry"; value: string };

/** Bump on ANY change to the rules, registry or host hygiene that could change a result. */
export const SOURCE_PUBLISHER_CLASSIFIER_VERSION = 1 as const;

export type SourcePublisherClassification = {
  publisherClass: SourcePublisherClass;
  reasonCode: SourcePublisherReasonCode;
  matchedRule: SourcePublisherMatchedRule | null;
  /** The canonical ASCII host that was matched against, or null when the input never yielded an acceptable host. */
  host: string | null;
  classifierVersion: typeof SOURCE_PUBLISHER_CLASSIFIER_VERSION;
};

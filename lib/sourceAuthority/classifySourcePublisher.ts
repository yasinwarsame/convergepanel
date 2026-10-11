/**
 * Order 4 — classify ONE raw, model-authored source string into a descriptive
 * publisher class. Deterministic and pure: no fetch, no DNS, no model call, no
 * keyword or fuzzy matching. Fails closed — anything not matched by an
 * explicit rule is UNCLASSIFIED.
 *
 * Order: strict URL + host hygiene → restricted namespaces → registry →
 * UNCLASSIFIED. Only the web address is read: nothing about the claim, the
 * model's evidence type, sourceBacked or the label wording influences it.
 */
import { labelBoundaryMatch, normalizeAuthorityHost } from "./normalizeAuthorityHost";
import { REGISTRY_ENTRIES, RESTRICTED_NAMESPACE_RULES, type RegistryEntry } from "./registry";
import { SOURCE_PUBLISHER_CLASSIFIER_VERSION, type SourcePublisherClassification } from "./types";

/** Exact domain always; a subdomain only when the entry opts in — label-boundary safe, never a bare `endsWith(domain)`. */
export function registryEntryMatches(host: string, entry: Pick<RegistryEntry, "domain" | "includeSubdomains">): boolean {
  return host === entry.domain || (entry.includeSubdomains && host.endsWith(`.${entry.domain}`));
}

export function classifySourcePublisher(raw: unknown): SourcePublisherClassification {
  const base = { classifierVersion: SOURCE_PUBLISHER_CLASSIFIER_VERSION };
  const normalized = normalizeAuthorityHost(raw);
  if (!normalized.ok) return { ...base, publisherClass: "UNCLASSIFIED", reasonCode: normalized.reasonCode, matchedRule: null, host: null };
  const { host } = normalized;

  const namespace = RESTRICTED_NAMESPACE_RULES.find((rule) => labelBoundaryMatch(host, rule.namespace));
  if (namespace) {
    return { ...base, publisherClass: namespace.publisherClass, reasonCode: "matched_restricted_namespace", matchedRule: { kind: "namespace", value: namespace.namespace }, host };
  }

  const entry = REGISTRY_ENTRIES.find((e) => registryEntryMatches(host, e));
  if (entry) {
    return { ...base, publisherClass: entry.publisherClass, reasonCode: "matched_registry_entry", matchedRule: { kind: "registry", value: entry.domain }, host };
  }

  return { ...base, publisherClass: "UNCLASSIFIED", reasonCode: "no_rule_matched", matchedRule: null, host };
}

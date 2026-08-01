/**
 * Query-Routing Redesign — the routing guarantee (Milestone 1, refined in
 * Milestone 1.5).
 *
 * The single point every classification must pass through before EITHER
 * (a) the server decides whether to run the model panel at all
 * (orchestrate.ts's planAdaptiveRun, before runPanel()), or (b) the client
 * decides what to render (AdaptivePanelResponse.tsx). Same function, same
 * registry, called from both sides — this is deliberate: duplicating the
 * routing decision in the API route would let the server execute a schema
 * the client considers disabled, or the client show a handoff after the
 * server already ran a full panel. There is exactly one place this logic
 * lives.
 *
 * Milestone 1.5 adds the RoutedQuery discriminated union (replacing
 * Milestone 1's flatter {status, schema, effectiveQueryType, limitation?}
 * shape) so the SERVER can use `kind` as a hard pre-execution gate — only
 * `kind: "active"` may ever reach runPanel(). Priority order when multiple
 * conditions could apply: a schema's own implementationStatus (handoff/
 * disabled) always wins over the classifier's requiresClarification flag —
 * asking a clarifying question is only useful when the schema could
 * genuinely execute once the missing detail arrives, which today is never
 * true for a disabled/handoff schema (the capability gap remains regardless
 * of what detail the user adds). Clarification vs. a flat "unanswerable"
 * outcome is therefore only ever decided for graceful_limitation itself,
 * the one schema whose implementationStatus is "active" but which must
 * still never trigger a real 5-model panel run (see the "unanswerable"
 * kind below).
 *
 * Client-safe (no "server-only") — AdaptivePanelResponse.tsx (a client
 * component) calls this directly to decide what to render.
 */

import { QueryClassification, ResultSchema, GracefulLimitationResponse, HandoffTarget, QueryType } from "./types";
import { SCHEMA_REGISTRY } from "./schemaRegistry";
import { buildCommonMeta } from "./commonMeta";

/**
 * Discriminated union of every possible routing outcome. Only `kind:
 * "active"` may invoke model fan-out — every other variant carries its own
 * fully-formed `response` (or, for "active", a `schema` to build prompts
 * from) and nothing else needs computing before returning to the caller.
 */
export type RoutedQuery =
  | { kind: "active"; queryType: QueryType; schema: ResultSchema }
  | { kind: "handoff"; queryType: QueryType; handoffTarget: HandoffTarget; response: GracefulLimitationResponse }
  | { kind: "disabled"; queryType: QueryType; capabilityReason: string; response: GracefulLimitationResponse }
  | { kind: "clarification"; queryType: QueryType; question: string; response: GracefulLimitationResponse }
  /** graceful_limitation classified directly (not via a clarification) — e.g. unbounded scope, impossible certainty, a restricted inference. No single follow-up question would fix these, so there's nothing to ask; still zero-model, deterministic, never a panel run. */
  | { kind: "unanswerable"; queryType: QueryType; response: GracefulLimitationResponse }
  | { kind: "invalid"; response: GracefulLimitationResponse };

interface HandoffCopy {
  limitation: string;
  whyItMatters: string;
  nearestValidAlternative: string;
}

const HANDOFF_COPY: Record<HandoffTarget, HandoffCopy> = {
  claim_verification: {
    limitation:
      "This request is best handled in Claim Verification, where the claim can be pressure-tested across five models with evidence, model stances, Verification Gate, and Panel Verdict.",
    whyItMatters:
      "Claim Verification runs a dedicated five-model pipeline built specifically for pressure-testing a single claim — Deep Research's panel isn't built for that.",
    nearestValidAlternative: "Switch to the Claim Verification tab and paste the claim there.",
  },
  video_verification: {
    limitation:
      "This request requires the dedicated Video Verification workflow. Upload the video or image in Video Verification to review it across three vision models.",
    whyItMatters:
      "Media authenticity review needs uploaded media and specialized vision models — Deep Research's text panel can't evaluate a file it never receives.",
    nearestValidAlternative: "Switch to the Video Verification tab and upload the file there.",
  },
};

function buildLimitation(
  kind: GracefulLimitationResponse["kind"],
  classification: QueryClassification,
  copy: { limitation: string; whyItMatters?: string; nearestValidAlternative?: string; clarifyingQuestion?: string },
  handoffTarget?: HandoffTarget
): GracefulLimitationResponse {
  return {
    kind,
    limitation: copy.limitation,
    whyItMatters: copy.whyItMatters,
    nearestValidAlternative: copy.nearestValidAlternative,
    clarifyingQuestion: copy.clarifyingQuestion,
    handoffTarget,
    meta: buildCommonMeta({
      classification,
      queryType: "graceful_limitation",
      answerShape: "limitation_notice",
      dataBasis: "calculated",
      evidenceQuality: "not_applicable",
      humanReviewNeeded: false,
    }),
  };
}

function isKnownStatus(status: unknown): status is ResultSchema["implementationStatus"] {
  return status === "active" || status === "disabled" || status === "handoff";
}

/**
 * Routes a classification to the outcome that should actually drive
 * execution. See the module doc for the priority order. Never throws —
 * an unrecognized queryType or a malformed registry entry fails safe to
 * `kind: "invalid"`, not an exception.
 */
export function routeClassifiedQuery(classification: QueryClassification): RoutedQuery {
  const entry = SCHEMA_REGISTRY[classification.queryType];

  if (!entry || !isKnownStatus(entry.implementationStatus)) {
    return {
      kind: "invalid",
      response: buildLimitation("unrecognized_or_invalid", classification, {
        limitation: "This request couldn't be classified into a supported answer shape.",
        whyItMatters: "Something about this query didn't match any known request type.",
        clarifyingQuestion: "Could you rephrase your question, or break it into a more specific request?",
      }),
    };
  }

  // A schema's own readiness always wins over "one more detail would help"
  // — clarifying doesn't change whether the capability exists.
  if (entry.implementationStatus === "handoff") {
    const target = entry.handoffTarget;
    if (!target) {
      return {
        kind: "invalid",
        response: buildLimitation("unrecognized_or_invalid", classification, {
          limitation: "This request needs to be handled by a different ConvergePanel workflow, but the handoff target isn't configured.",
        }),
      };
    }
    const copy = HANDOFF_COPY[target];
    return {
      kind: "handoff",
      queryType: entry.id,
      handoffTarget: target,
      response: buildLimitation("handoff", classification, copy, target),
    };
  }

  if (entry.implementationStatus === "disabled") {
    const reason = entry.capabilityReason || `This request type ("${entry.id}") isn't available yet.`;
    return {
      kind: "disabled",
      queryType: entry.id,
      capabilityReason: reason,
      response: buildLimitation("capability_gap", classification, {
        limitation: reason,
        whyItMatters: "The underlying capability this request needs hasn't been built yet — showing a guess would be worse than saying so plainly.",
      }),
    };
  }

  // implementationStatus === "active" from here down.

  if (classification.requiresClarification) {
    const question = classification.clarificationQuestion || "Could you clarify what you're asking?";
    return {
      kind: "clarification",
      queryType: entry.id,
      question,
      response: buildLimitation("genuine_limitation", classification, {
        limitation: question,
        whyItMatters: "One necessary detail is missing before this can be answered.",
        clarifyingQuestion: question,
      }),
    };
  }

  // graceful_limitation is registered "active" (it's a real, working
  // schema — its fields exist for a future model-authored elaboration),
  // but a DIRECT classification into it (not via requiresClarification)
  // means the request is fundamentally unanswerable, not merely missing
  // one detail. Never worth a 5-model panel run to have each model
  // independently restate the same limitation — deterministic response
  // built straight from the classifier's own rationale instead.
  if (entry.id === "graceful_limitation") {
    return {
      kind: "unanswerable",
      queryType: "graceful_limitation",
      response: buildLimitation("genuine_limitation", classification, {
        limitation: classification.rationale || "This request can't be answered as asked.",
      }),
    };
  }

  return { kind: "active", queryType: entry.id, schema: entry };
}

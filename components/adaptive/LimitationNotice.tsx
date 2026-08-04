"use client";

/**
 * Query-Routing Redesign, Milestone 1.
 *
 * The single renderer every non-"active" classification resolves to (see
 * routeClassifiedQuery.ts) — disabled schemas, handoffs to Claim/Video
 * Verification, and genuine "can't answer this" cases all render here, with
 * copy that names the ACTUAL reason (never a generic "something went
 * wrong"). Four distinct tones by `kind`, since a capability gap, a handoff
 * to a dedicated feature, and an unrecognized request all read differently.
 */

import { GracefulLimitationResponse } from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel } from "./shared";

const KIND_STYLES: Record<GracefulLimitationResponse["kind"], { label: string; card: string; body: string; sub: string }> = {
  handoff: {
    label: "A different ConvergePanel workflow handles this",
    card: "bg-sky-50 border-sky-200",
    body: "text-sky-900",
    sub: "text-sky-700",
  },
  capability_gap: {
    label: "Not available yet",
    card: "bg-amber-50 border-amber-200",
    body: "text-amber-900",
    sub: "text-amber-700",
  },
  genuine_limitation: {
    label: "Can't answer this as asked",
    card: "bg-slate-50 border-slate-300",
    body: "text-slate-900",
    sub: "text-slate-600",
  },
  unrecognized_or_invalid: {
    label: "Couldn't classify this request",
    card: "bg-slate-50 border-slate-300",
    body: "text-slate-900",
    sub: "text-slate-600",
  },
};

export default function LimitationNotice({ limitation }: { limitation: GracefulLimitationResponse }) {
  const style = KIND_STYLES[limitation.kind];

  return (
    <Card className={style.card}>
      <SectionLabel>{style.label}</SectionLabel>
      <p className={`text-sm leading-relaxed font-medium mb-2 ${style.body}`}>{limitation.limitation}</p>
      {limitation.whyItMatters && <p className={`text-sm leading-relaxed mb-2 ${style.sub}`}>{limitation.whyItMatters}</p>}
      {limitation.nearestValidAlternative && (
        <p className={`text-sm font-medium ${style.body}`}>{limitation.nearestValidAlternative}</p>
      )}
      {limitation.clarifyingQuestion && <p className={`text-sm italic mt-2 ${style.sub}`}>{limitation.clarifyingQuestion}</p>}
      {limitation.recommendedSources && limitation.recommendedSources.length > 0 && (
        <ul className={`mt-2 list-disc list-outside pl-5 text-sm ${style.sub}`}>
          {limitation.recommendedSources.map((s, idx) => (
            <li key={idx}>{s}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

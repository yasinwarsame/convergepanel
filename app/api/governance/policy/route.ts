/**
 * Org governance policy: GET (read) / POST (admin update).
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import type { GovernancePolicy } from "@/lib/governance/evaluateGovernance";
import { loadGovernancePolicy, saveGovernancePolicyMerge } from "@/lib/governance/governancePolicyStore";
import { writeAuditEvent } from "@/lib/governance/auditLog";
import { checkAdminOnly, resolveGovernanceRequestUser } from "@/lib/governance/authCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_POST_KEYS = new Set([
  "minConsensusToApprove",
  "minConsensusToAvoidReview",
  "sensitiveMinConsensusToApprove",
  "sensitiveMinConsensusToAvoidReview",
  "blockIfSourceBackedMissingSources",
  "reviewIfAnyModelSubstituted",
  "reviewIfAnyModelFailed",
  "sensitiveDomainsEnabled",
  "reviewIfEvidenceQualityWeak",
  "reviewIfVerificationVerdictIn",
  "comment",
]);

const VERDICT_LABELS = new Set(["Disputed", "Unverifiable", "Partially True", "Confirmed"]);

function validatePolicyPartial(body: Record<string, unknown>):
  | { ok: true; partial: Partial<GovernancePolicy> }
  | { ok: false; fields: Record<string, string>; message: string } {
  const fields: Record<string, string> = {};
  const partial: Partial<GovernancePolicy> = {};

  const num = (k: string, v: unknown) => {
    if (v === undefined) return;
    if (typeof v !== "number" || Number.isNaN(v) || v < 0 || v > 100) {
      fields[k] = "Must be a number between 0 and 100";
      return;
    }
    (partial as Record<string, unknown>)[k] = v;
  };

  const bool = (k: string, v: unknown) => {
    if (v === undefined) return;
    if (typeof v !== "boolean") {
      fields[k] = "Must be a boolean";
      return;
    }
    (partial as Record<string, unknown>)[k] = v;
  };

  num("minConsensusToApprove", body.minConsensusToApprove);
  num("minConsensusToAvoidReview", body.minConsensusToAvoidReview);
  num("sensitiveMinConsensusToApprove", body.sensitiveMinConsensusToApprove);
  num("sensitiveMinConsensusToAvoidReview", body.sensitiveMinConsensusToAvoidReview);

  bool("blockIfSourceBackedMissingSources", body.blockIfSourceBackedMissingSources);
  bool("reviewIfAnyModelSubstituted", body.reviewIfAnyModelSubstituted);
  bool("reviewIfAnyModelFailed", body.reviewIfAnyModelFailed);
  bool("sensitiveDomainsEnabled", body.sensitiveDomainsEnabled);
  bool("reviewIfEvidenceQualityWeak", body.reviewIfEvidenceQualityWeak);

  if (body.reviewIfVerificationVerdictIn !== undefined) {
    if (!Array.isArray(body.reviewIfVerificationVerdictIn)) {
      fields.reviewIfVerificationVerdictIn = "Must be an array of strings";
    } else if (!body.reviewIfVerificationVerdictIn.every((x) => typeof x === "string")) {
      fields.reviewIfVerificationVerdictIn = "Must contain only strings";
    } else {
      const arr = body.reviewIfVerificationVerdictIn as string[];
      const bad = arr.find((x) => !VERDICT_LABELS.has(x));
      if (bad !== undefined) {
        fields.reviewIfVerificationVerdictIn = `Invalid verdict label: ${bad}`;
      } else {
        partial.reviewIfVerificationVerdictIn = arr;
      }
    }
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_POST_KEYS.has(key) && body[key] !== undefined) {
      fields[key] = "Unknown or read-only field";
    }
  }

  if (Object.keys(fields).length > 0) {
    return {
      ok: false,
      fields,
      message: "Validation failed",
    };
  }

  return { ok: true, partial };
}

export async function GET(request: NextRequest) {
  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  const resolved = await resolveGovernanceRequestUser(request);
  if (!resolved.ok) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Authentication required" } },
      { status: 401 }
    );
  }

  try {
    const policy = await loadGovernancePolicy();
    console.log(`[governance/policy] Returning policy for uid=${resolved.uid}:`, {
      policyVersion: policy.policyVersion,
      keys: Object.keys(policy),
    });
    return NextResponse.json({ ok: true, policy });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to load policy";
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: msg } },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  const resolved = await resolveGovernanceRequestUser(request);
  if (!resolved.ok) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Authentication required" } },
      { status: 401 }
    );
  }

  const isAdmin = await checkAdminOnly(resolved.uid);
  if (!isAdmin) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "forbidden", message: "Only admins can update governance policy" },
      },
      { status: 403 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "validation_error", message: "Invalid JSON body", fields: { body: "Invalid JSON" } },
      },
      { status: 400 }
    );
  }

  const validated = validatePolicyPartial(body);
  if (!validated.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "validation_error", message: validated.message, fields: validated.fields },
      },
      { status: 400 }
    );
  }

  const policyKeys = Object.keys(validated.partial) as (keyof GovernancePolicy)[];
  if (policyKeys.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "validation_error",
          message: "No valid policy fields to update",
          fields: { body: "Provide at least one policy field" },
        },
      },
      { status: 400 }
    );
  }

  const comment =
    typeof body.comment === "string" && body.comment.trim() ? body.comment.trim() : "Policy updated";

  try {
    const policy = await saveGovernancePolicyMerge(
      validated.partial,
      resolved.uid,
      resolved.email,
      comment,
      policyKeys as string[]
    );
    await writeAuditEvent({
      runId: "policy",
      collection: "runs",
      runType: "research",
      action: "policy_updated",
      byUid: resolved.uid,
      byEmail: resolved.email,
      comment,
      policyVersion: policy.policyVersion,
      changes: policyKeys as string[],
    });
    return NextResponse.json({ ok: true, policy });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to save policy";
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: msg } },
      { status: 500 }
    );
  }
}

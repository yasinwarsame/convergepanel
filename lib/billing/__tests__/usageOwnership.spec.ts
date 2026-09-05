/**
 * Phase BILLING-WEBHOOK-B1-C7 — BILLING-USAGE-Q1, as a structural invariant.
 *
 * The exploit was not subtle: the self-serve plan-sync endpoint called the
 * plan-change usage reset unconditionally, and any authenticated user may
 * invoke that endpoint for their own account. Run out of runs, press sync, run
 * again. The behavioural tests prove the specific route no longer does it;
 * this one states the rule that made it a bug, so the next automatic writer
 * cannot reintroduce it by importing the same helper.
 *
 * THE RULE. Billing synchronization owns Stripe customer identity, subscription
 * identity, status, plan, cadence and billing-cycle facts. It does not own run
 * usage. Only the canonical calendar-month transition may reset a counter.
 *
 * The admin subscription-sync endpoint is deliberately excluded: it is gated on
 * an admin custom claim and cannot be reached by a self-service user, so it is
 * a privileged manual tool rather than an automatic writer. That exclusion is
 * named here so it stays a decision rather than an oversight.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/**
 * Comments are stripped before every check. These files carry long
 * explanations OF these rules — including the name of the helper they must not
 * call — and prose about a defect must not read as the defect.
 */
const codeOf = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every path that reconciles billing state without a human deciding to. */
const AUTOMATIC_BILLING_WRITERS = [
  "app/api/stripe/webhook/route.ts",
  "lib/stripe/subscriptionValidation.ts",
  "app/api/billing/sync-plan/route.ts",
  "lib/stripe/webhookHelpers.ts",
];

/** Fields a run consumes. A synchronization path may read them, never write them. */
const USAGE_FIELDS = ["runsThisMonth", "videoRunsThisMonth", "tokensUsedCurrentPeriod", "totalRuns"];

describe("BILLING-USAGE-Q1 — billing synchronization does not own run usage", () => {
  for (const file of AUTOMATIC_BILLING_WRITERS) {
    it(`${file} does not import or call the plan-change usage reset`, () => {
      const code = codeOf(file);
      expect(code).not.toMatch(/import\s*\{[^}]*resetUsageForNewPlan/);
      expect(code).not.toMatch(/resetUsageForNewPlan\s*\(/);
    });

    it(`${file} writes no usage field`, () => {
      const code = codeOf(file);
      for (const field of USAGE_FIELDS) {
        expect(code).not.toMatch(new RegExp(`${field}\\s*:`));
      }
      expect(code).not.toMatch(/usageMonth\s*:/);
    });
  }

  it("the usage reset helper is reachable only from the admin-gated sync endpoint", () => {
    const admin = read("app/api/admin/sync-subscription/route.ts");
    expect(admin).toMatch(/resetUsageForNewPlan/);
    // ...and that endpoint is privileged, so it is not a self-service reset.
    expect(admin).toMatch(/requireAdminApiAccess/);
  });

  it("the canonical calendar-month transition still owns the reset", () => {
    const usage = read("lib/stripe/usage.ts");
    expect(usage).toMatch(/storedMonth !== currentMonth/);
    expect(usage).toMatch(/runsThisMonth: 0/);
  });
});

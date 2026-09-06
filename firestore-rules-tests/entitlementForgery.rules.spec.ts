/**
 * Phase FIRESTORE-AUTHZ-P0.1 — the exploit, end to end.
 *
 * A rules test that only asserts "permission denied" proves the rule changed.
 * It does not prove the vulnerability mattered. This one closes the loop:
 *
 *   browser write  ->  Firestore authorization  ->  server entitlement input
 *
 * It runs the SAME attack against the OLD rule text and the NEW one, and then
 * feeds the resulting stored document — not a hand-built fixture — into the
 * real `calculateEffectiveEntitlement()` that every paid-capability decision
 * in the application consults.
 */

import { readFileSync } from "fs";
import { initializeTestEnvironment, assertFails, assertSucceeds, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { calculateEffectiveEntitlement } from "../lib/admin/entitlements";

const ME = "uid_victimless_attacker";
const MY_EMAIL = "attacker@example.test";

/** Exactly what `firestore.rules` said before this phase. */
const OLD_RULES = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      allow list: if request.auth != null && request.auth.token.admin == true;
    }
    match /appConfig/modelKeys {
      allow read, write: if request.auth != null && request.auth.token.admin == true;
    }
    match /{document=**} { allow read, write: if false; }
  }
}`;

const FREE_USER = { uid: ME, email: MY_EMAIL, plan: "free", subscriptionStatus: "none", runsThisMonth: 8, usageMonth: "2026-09" };

/** What a user would write from a devtools console to buy nothing and get everything. */
const FORGED_ENTITLEMENT = { override: { active: true, plan: "5_models", runLimitMonthly: 999999 } };

async function withRules(rules: string, fn: (env: RulesTestEnvironment) => Promise<void>) {
  const env = await initializeTestEnvironment({
    projectId: "convergepanel-forgery-test",
    firestore: { rules, host: "127.0.0.1", port: 8080 },
  });
  try {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "users", ME), FREE_USER); });
    await fn(env);
  } finally {
    await env.cleanup();
  }
}

/** Read the document back through the privileged path, as a server would. */
async function storedDoc(env: RulesTestEnvironment): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), "users", ME));
    data = (snap.data() ?? {}) as Record<string, unknown>;
  });
  return data;
}

describe("BILLING-FIRESTORE-AUTHZ-P0 — client-forged entitlement", () => {
  it("BASELINE: under the OLD rules the attack succeeded and the resolver honoured it", async () => {
    await withRules(OLD_RULES, async (env) => {
      const db = env.authenticatedContext(ME, { email: MY_EMAIL }).firestore();

      // The attack: an ordinary user, their own credentials, one write.
      await assertSucceeds(updateDoc(doc(db, "users", ME), FORGED_ENTITLEMENT));

      // And the server believed it.
      const entitlement = calculateEffectiveEntitlement(await storedDoc(env) as never);
      expect(entitlement.plan).toBe("5_models");
      expect(entitlement.source).toBe("override");
      expect(entitlement.runLimitMonthly).toBe(999999);
    });
  });

  it("FIXED: the same attack is refused, and the resolver still says free", async () => {
    await withRules(readFileSync("firestore.rules", "utf8"), async (env) => {
      const db = env.authenticatedContext(ME, { email: MY_EMAIL }).firestore();

      await assertFails(updateDoc(doc(db, "users", ME), FORGED_ENTITLEMENT));

      // The stored document is untouched, so the resolver's input never changed.
      const after = await storedDoc(env);
      expect(after.override).toBeUndefined();
      const entitlement = calculateEffectiveEntitlement(after as never);
      expect(entitlement.plan).toBe("free");
      expect(entitlement.source).toBe("free");
      expect(entitlement.overrideActive).toBeFalsy();
    });
  });

  it("FIXED: the paid-plan route to the same outcome is refused too", async () => {
    await withRules(readFileSync("firestore.rules", "utf8"), async (env) => {
      const db = env.authenticatedContext(ME, { email: MY_EMAIL }).firestore();

      // Not just `override` — every other field the resolver trusts.
      await assertFails(updateDoc(doc(db, "users", ME), { plan: "full", subscriptionStatus: "active" }));
      await assertFails(updateDoc(doc(db, "users", ME), { planFromStripe: "5_models", subscriptionStatusFromStripe: "active" }));

      const entitlement = calculateEffectiveEntitlement(await storedDoc(env) as never);
      expect(entitlement.plan).toBe("free");
    });
  });

  it("FIXED: quota cannot be replenished by hand", async () => {
    await withRules(readFileSync("firestore.rules", "utf8"), async (env) => {
      const db = env.authenticatedContext(ME, { email: MY_EMAIL }).firestore();

      await assertFails(updateDoc(doc(db, "users", ME), { runsThisMonth: 0 }));
      await assertFails(updateDoc(doc(db, "users", ME), { usageMonth: "2099-01" }));

      const after = await storedDoc(env);
      expect(after.runsThisMonth).toBe(8);
      expect(after.usageMonth).toBe("2026-09");
    });
  });
});

/**
 * Phase FIRESTORE-AUTHZ-P0.1 — the entitlement-forgery attack surface.
 *
 * These run against a real Firestore emulator loading the real
 * `firestore.rules`, as an ordinary authenticated browser user. Every write
 * here is one a user could issue from a devtools console with nothing but
 * their own credentials and the public Firebase web config.
 *
 * The old rule was `allow read, write: if request.auth.uid == uid` — no field
 * restriction at all — so every "must be denied" case below SUCCEEDED before
 * this change, and each one forges an input that a server-side authorization
 * or quota decision then trusts.
 */

import { readFileSync } from "fs";
import { initializeTestEnvironment, assertFails, assertSucceeds, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, serverTimestamp } from "firebase/firestore";

const PROJECT_ID = "convergepanel-rules-test";
const ME = "uid_me";
const OTHER = "uid_other";
const MY_EMAIL = "me@example.test";
const ADMIN_EMAIL = "admin@convergepanel.com";

let env: RulesTestEnvironment;

/** The document a real user ends up with once the server has done its work. */
const SERVER_STATE = {
  uid: ME,
  email: MY_EMAIL,
  name: "Me",
  plan: "free",
  planFromStripe: null,
  subscriptionStatus: "none",
  subscriptionStatusFromStripe: null,
  billingInterval: null,
  monthlyLimit: 8,
  maxModelsPerRun: 2,
  runsThisMonth: 7,
  videoRunsThisMonth: 2,
  usageMonth: "2026-09",
  tokensUsedCurrentPeriod: 1000,
  totalRuns: 42,
  role: "user",
  isDisabled: false,
  onboardingCompleted: true,
};

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterAll(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  // Seed via the privileged path, exactly as the Admin SDK would.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", ME), SERVER_STATE);
    await setDoc(doc(ctx.firestore(), "users", OTHER), { ...SERVER_STATE, uid: OTHER, email: "other@example.test" });
  });
});

const asMe = () => env.authenticatedContext(ME, { email: MY_EMAIL }).firestore();
const asOther = () => env.authenticatedContext(OTHER, { email: "other@example.test" }).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const myDoc = (db = asMe()) => doc(db, "users", ME);

describe("P0 — a browser cannot forge entitlement", () => {
  /** Every field a server authorization or quota decision reads. */
  const FORGERIES: Array<[string, Record<string, unknown>]> = [
    ["grant themselves a paid plan", { plan: "full" }],
    ["grant a paid plan via the Stripe-owned field", { planFromStripe: "5_models" }],
    ["mark the subscription active", { subscriptionStatus: "active" }],
    ["mark the Stripe status active", { subscriptionStatusFromStripe: "active" }],
    ["raise the model cap", { maxModelsPerRun: 5 }],
    ["raise the monthly run limit", { monthlyLimit: 100000 }],
    ["reset the run counter to regain quota", { runsThisMonth: 0 }],
    ["reset the video counter", { videoRunsThisMonth: 0 }],
    ["roll the usage month forward", { usageMonth: "2099-01" }],
    ["zero the token counter", { tokensUsedCurrentPeriod: 0 }],
    ["rewrite the lifetime run count", { totalRuns: 0 }],
    ["change the billing cadence", { billingInterval: "year" }],
    ["forge a Stripe customer id", { stripeCustomerId: "cus_forged" }],
    ["forge a Stripe subscription id", { stripeSubscriptionId: "sub_forged" }],
    ["forge a billing cycle start", { billingCycleStart: new Date().toISOString() }],
    ["create an admin override", { override: { active: true, plan: "5_models", runLimitMonthly: 999999 } }],
    ["write the entitlements block directly", { entitlements: { planEffective: "5_models", runLimitMonthly: 999999, source: "override" } }],
    ["make themselves admin", { role: "admin" }],
    ["make themselves a reviewer", { role: "reviewer" }],
    ["suspend themselves (any change to the flag)", { isDisabled: true }],
    ["grant themselves governance reviewer rights", { governanceReviewerEnabled: true }],
    ["assign themselves as reviewer for a workspace", { governanceReviewerFor: ["ws_1"] }],
    ["change the email the admin-role fallback reads", { email: ADMIN_EMAIL }],
    ["change their own uid", { uid: OTHER }],
  ];

  for (const [name, patch] of FORGERIES) {
    it(`DENIED: ${name}`, async () => {
      await assertFails(updateDoc(myDoc(), patch));
    });
  }

  it("DENIED: a SUSPENDED user cannot re-enable their own account", async () => {
    // Seeded disabled, so `isDisabled: false` is a real change and therefore a
    // real attack — the seed in the other cases already holds `false`, which
    // would make the write a no-op and prove nothing.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", ME), { ...SERVER_STATE, isDisabled: true });
    });
    await assertFails(updateDoc(myDoc(), { isDisabled: false }));
  });

  it("DENIED: a legal profile edit smuggling one protected field alongside it", async () => {
    await assertFails(updateDoc(myDoc(), { name: "Legit", plan: "full" }));
  });

  it("DENIED: deleting a protected field", async () => {
    await assertFails(updateDoc(myDoc(), { runsThisMonth: deleteField() }));
  });

  it("DENIED: nulling a protected field", async () => {
    await assertFails(updateDoc(myDoc(), { plan: null }));
  });

  it("DENIED: changing a protected field's type", async () => {
    await assertFails(updateDoc(myDoc(), { runsThisMonth: "0" }));
  });

  it("DENIED: replacing the whole document via a merge write", async () => {
    await assertFails(setDoc(myDoc(), { plan: "full", runsThisMonth: 0 }, { merge: true }));
  });

  it("DENIED: replacing the whole document wholesale", async () => {
    await assertFails(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, plan: "full" }));
  });

  it("DENIED: mutating a nested key inside the override map", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", ME), { ...SERVER_STATE, override: { active: false, plan: "3_models" } });
    });
    await assertFails(updateDoc(myDoc(), { "override.active": true }));
    await assertFails(updateDoc(myDoc(), { "override.plan": "5_models" }));
    await assertFails(updateDoc(myDoc(), { "override.expiresAt": "2099-01-01T00:00:00.000Z" }));
  });

  it("DENIED: seeding protected state at CREATE time", async () => {
    await env.clearFirestore();
    const db = asMe();
    await assertFails(setDoc(doc(db, "users", ME), { uid: ME, email: MY_EMAIL, plan: "full" }));
    await assertFails(setDoc(doc(db, "users", ME), { uid: ME, email: MY_EMAIL, override: { active: true, plan: "5_models" } }));
    await assertFails(setDoc(doc(db, "users", ME), { uid: ME, email: MY_EMAIL, role: "admin" }));
    await assertFails(setDoc(doc(db, "users", ME), { uid: ME, email: MY_EMAIL, runsThisMonth: 0, usageMonth: "2099-01" }));
  });

  it("DENIED: seeding an admin email at CREATE time to win the role fallback", async () => {
    await env.clearFirestore();
    await assertFails(setDoc(doc(asMe(), "users", ME), { uid: ME, email: ADMIN_EMAIL }));
  });

  it("DENIED: creating a document whose uid disagrees with the path", async () => {
    await env.clearFirestore();
    await assertFails(setDoc(doc(asMe(), "users", ME), { uid: OTHER, email: MY_EMAIL }));
  });

  it("DENIED: deleting the authoritative user document", async () => {
    await assertFails(deleteDoc(myDoc()));
  });
});

describe("P0 — cross-user attacks", () => {
  it("DENIED: reading another user's document", async () => {
    await assertFails(getDoc(doc(asMe(), "users", OTHER)));
  });
  it("DENIED: updating another user's profile", async () => {
    await assertFails(updateDoc(doc(asMe(), "users", OTHER), { name: "pwned" }));
  });
  it("DENIED: granting another user a plan", async () => {
    await assertFails(updateDoc(doc(asMe(), "users", OTHER), { plan: "full" }));
  });
  it("DENIED: draining another user's quota", async () => {
    await assertFails(updateDoc(doc(asMe(), "users", OTHER), { runsThisMonth: 99999 }));
  });
  it("DENIED: deleting another user's document", async () => {
    await assertFails(deleteDoc(doc(asMe(), "users", OTHER)));
  });
  it("DENIED: creating a document for a user who has none", async () => {
    await env.clearFirestore();
    await assertFails(setDoc(doc(asMe(), "users", OTHER), { uid: OTHER, email: "other@example.test" }));
  });
});

describe("P0 — unauthenticated access", () => {
  it("DENIED: anonymous read", async () => { await assertFails(getDoc(doc(anon(), "users", ME))); });
  it("DENIED: anonymous write", async () => { await assertFails(setDoc(doc(anon(), "users", ME), { plan: "full" })); });
  it("DENIED: anonymous create", async () => {
    await env.clearFirestore();
    await assertFails(setDoc(doc(anon(), "users", "uid_new"), { uid: "uid_new", email: "x@example.test" }));
  });
});

describe("P0 — an admin CLIENT is still not a server writer", () => {
  const asAdminClient = () => env.authenticatedContext("uid_admin", { email: ADMIN_EMAIL, admin: true }).firestore();

  it("DENIED: an admin's browser cannot grant another user a plan", async () => {
    await assertFails(updateDoc(doc(asAdminClient(), "users", ME), { plan: "full" }));
  });
  it("DENIED: an admin's browser cannot create an override", async () => {
    await assertFails(updateDoc(doc(asAdminClient(), "users", ME), { override: { active: true, plan: "5_models" } }));
  });
  it("DENIED: an admin's browser cannot disable an account", async () => {
    await assertFails(updateDoc(doc(asAdminClient(), "users", ME), { isDisabled: true }));
  });
  it("ALLOWED: an admin may still list users, which the admin UI needs", async () => {
    const { query, collection, getDocs } = await import("firebase/firestore");
    await assertSucceeds(getDocs(query(collection(asAdminClient(), "users"))));
  });
});

describe("legitimate client behaviour still works", () => {
  it("ALLOWED: the user reads their own document", async () => {
    await assertSucceeds(getDoc(myDoc()));
  });

  it("ALLOWED: the profile page saves name, phone and address", async () => {
    await assertSucceeds(updateDoc(myDoc(), {
      name: "New Name", phone: "+1 555 0100",
      address: { line1: "1 Test St", city: "Testville", country: "US" },
      updatedAt: serverTimestamp(),
    }));
  });

  it("ALLOWED: onboarding records its answers", async () => {
    await assertSucceeds(setDoc(myDoc(), {
      onboardingRole: "analyst", primaryUseCase: "research", expectedUsage: "weekly",
      referralSource: "search", onboardingCompleted: true, updatedAt: serverTimestamp(),
    }, { merge: true }));
  });

  it("ALLOWED: sign-in refreshes lastLoginAt and re-sends unchanged identity", async () => {
    await assertSucceeds(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("ALLOWED: signup creates the document with client-owned fields only", async () => {
    await env.clearFirestore();
    await assertSucceeds(setDoc(doc(asMe(), "users", ME), {
      uid: ME, email: MY_EMAIL, name: "Me", onboardingCompleted: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastLoginAt: serverTimestamp(),
    }));
  });

  it("ALLOWED: the profile page creates a minimal document when one is missing", async () => {
    await env.clearFirestore();
    await assertSucceeds(setDoc(doc(asMe(), "users", ME), {
      email: MY_EMAIL, uid: ME, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
  });

  it("REGRESSION: the allowlist is fail-closed — one unknown field denies an otherwise legal write", async () => {
    await assertSucceeds(updateDoc(myDoc(), { name: "Fine" }));
    await assertFails(updateDoc(myDoc(), { name: "Fine", someFutureEntitlementField: true }));
  });
});

describe("other collections", () => {
  it("DENIED: a non-admin cannot read or write model keys", async () => {
    await assertFails(getDoc(doc(asOther(), "appConfig", "modelKeys")));
    await assertFails(setDoc(doc(asOther(), "appConfig", "modelKeys"), { openai: "sk-forged" }));
  });
  it("DENIED: no overlapping rule opens an arbitrary collection", async () => {
    await assertFails(setDoc(doc(asMe(), "runs", "run_1"), { uid: ME }));
    await assertFails(setDoc(doc(asMe(), "workspaces", "ws_1"), { ownerUid: ME }));
    await assertFails(getDoc(doc(asMe(), "appConfig", "anything")));
  });
});

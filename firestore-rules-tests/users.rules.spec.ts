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

/**
 * Phase P0.1-R4 — THE PRODUCTION SIGNUP WRITE, IN ONE PLACE.
 *
 * R3 found these fixtures asserting `{ merge: true }` while production issued
 * a bare `setDoc` — a full REPLACE — so the suite proved nothing about the
 * shape the app actually sends, and a real signup failure hid behind green
 * tests. Both the payload AND the options argument now live here, once, and
 * every signup case goes through `productionSignupWrite()`. A change to the
 * persistence mode has to come through this helper, so the fixture cannot
 * silently drift from `app/signup/page.tsx` again.
 */
const SIGNUP_PAYLOAD = () => ({
  uid: ME,
  email: MY_EMAIL,
  name: "Me",
  onboardingCompleted: false,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  lastLoginAt: serverTimestamp(),
});
/** Mirrors app/signup/page.tsx: setDoc(ref, payload, { merge: true }). */
const productionSignupWrite = (db = asMe()) => setDoc(doc(db, "users", ME), SIGNUP_PAYLOAD(), { merge: true });
/** The pre-R4 behaviour, retained as a negative control: a destructive replace. */
const legacyReplacingSignupWrite = (db = asMe()) => setDoc(doc(db, "users", ME), SIGNUP_PAYLOAD());

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
  it("DENIED: even an admin's browser cannot LIST users", async () => {
    // Phase P0.1-R2: the admin UI is served by /api/admin/* through the Admin
    // SDK, which bypasses these rules. A client list grant was dead weight and
    // strictly broader than the cross-user `get` denied above.
    const { query, collection, getDocs } = await import("firebase/firestore");
    await assertFails(getDocs(query(collection(asAdminClient(), "users"))));
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
    await assertSucceeds(productionSignupWrite());
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

describe("R2 — the identity pin, not key absence, is the control", () => {
  /** What the five server bootstrap paths actually write: no uid, no email. */
  const BOOTSTRAPPED = { plan: "free", runsThisMonth: 0, usageMonth: "2026-09", totalRuns: 0 };

  async function seed(doc_: Record<string, unknown>) {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", ME), doc_);
    });
  }

  // ---------- availability: the R1 lockout, in every shape ----------

  it("REGRESSION: sign-in writes uid+email onto a server-bootstrapped document", async () => {
    await seed(BOOTSTRAPPED);
    await assertSucceeds(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("REGRESSION: a document missing only uid accepts the correct uid", async () => {
    await seed({ ...BOOTSTRAPPED, email: MY_EMAIL });
    await assertSucceeds(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("REGRESSION: a document missing only email accepts the caller's own email", async () => {
    await seed({ ...BOOTSTRAPPED, uid: ME });
    await assertSucceeds(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("REGRESSION: the team-membership bootstrap shape also accepts sign-in", async () => {
    await seed({ teamId: "team_1", teamRole: "member" });
    await assertSucceeds(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("an already-correct document still accepts the ordinary repeated sign-in", async () => {
    await seed({ ...SERVER_STATE });
    await assertSucceeds(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("a profile edit carrying uid and email alongside it still succeeds", async () => {
    await seed({ ...SERVER_STATE });
    await assertSucceeds(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, name: "Renamed", updatedAt: serverTimestamp() }, { merge: true }));
  });

  it("the stale mirror can self-heal to the caller's current verified address", async () => {
    await seed({ ...SERVER_STATE, email: "old-address@example.test" });
    await assertSucceeds(setDoc(myDoc(), { email: MY_EMAIL, lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("signup's full payload still works on a bootstrapped document", async () => {
    await seed(BOOTSTRAPPED);
    await assertSucceeds(productionSignupWrite());
  });

  // ---------- the pin still refuses every forgery ----------

  it("REGRESSION: a foreign uid is refused even though the key is now allowed", async () => {
    await seed(BOOTSTRAPPED);
    await assertFails(setDoc(myDoc(), { uid: OTHER, lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("REGRESSION: an arbitrary forged uid is refused", async () => {
    await seed({ ...SERVER_STATE });
    await assertFails(updateDoc(myDoc(), { uid: "uid_totally_made_up" }));
  });

  it("REGRESSION: another user's email is refused", async () => {
    await seed(BOOTSTRAPPED);
    await assertFails(setDoc(myDoc(), { email: "other@example.test", lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("REGRESSION: an allowlisted admin address is refused", async () => {
    await seed(BOOTSTRAPPED);
    await assertFails(setDoc(myDoc(), { email: ADMIN_EMAIL, lastLoginAt: serverTimestamp() }, { merge: true }));
  });

  it("REGRESSION: nulling either identity field is refused", async () => {
    await seed({ ...SERVER_STATE });
    await assertFails(updateDoc(myDoc(), { uid: null }));
    await assertFails(updateDoc(myDoc(), { email: null }));
  });

  it("REGRESSION: DELETING a correct identity field is refused — absence must not evade the pin", async () => {
    await seed({ ...SERVER_STATE });
    await assertFails(updateDoc(myDoc(), { uid: deleteField() }));
    await assertFails(updateDoc(myDoc(), { email: deleteField() }));
  });

  it("REGRESSION: a wrong type is refused", async () => {
    await seed({ ...SERVER_STATE });
    await assertFails(updateDoc(myDoc(), { uid: 12345 }));
    await assertFails(updateDoc(myDoc(), { email: 12345 }));
  });

  it("REGRESSION: a legitimate profile edit smuggling a forged identity is refused whole", async () => {
    await seed({ ...SERVER_STATE });
    await assertFails(updateDoc(myDoc(), { name: "Legit", email: ADMIN_EMAIL }));
    await assertFails(updateDoc(myDoc(), { name: "Legit", uid: OTHER }));
  });

  it("REGRESSION: admitting the identity keys did not admit any authority field", async () => {
    // Seeded with a NON-ZERO counter deliberately: `affectedKeys()` excludes
    // same-value writes, so attempting `runsThisMonth: 0` against a document
    // that already holds 0 proves nothing. The attack is a real decrease.
    await seed({ ...BOOTSTRAPPED, runsThisMonth: 7 });
    await assertFails(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, plan: "full" }, { merge: true }));
    await assertFails(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, role: "admin" }, { merge: true }));
    await assertFails(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, override: { active: true, plan: "5_models" } }, { merge: true }));
    await assertFails(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, runsThisMonth: 0 }, { merge: true }));
    await assertFails(setDoc(myDoc(), { uid: ME, email: MY_EMAIL, usageMonth: "2099-01" }, { merge: true }));
  });

  it("REGRESSION: another user cannot write identity onto my bootstrapped document", async () => {
    await seed(BOOTSTRAPPED);
    await assertFails(setDoc(doc(asOther(), "users", ME), { uid: ME, email: MY_EMAIL }, { merge: true }));
  });
});

describe("R2 — client list/query is closed to every principal", () => {
  it("REGRESSION: an ordinary authenticated user cannot enumerate users", async () => {
    const { query, collection, getDocs, where, limit, orderBy } = await import("firebase/firestore");
    await assertFails(getDocs(query(collection(asMe(), "users"))));
    await assertFails(getDocs(query(collection(asMe(), "users"), limit(1))));
    await assertFails(getDocs(query(collection(asMe(), "users"), orderBy("plan"))));
  });

  it("REGRESSION: a query narrowed to the caller's OWN document is still refused", async () => {
    // Even a self-scoped query is a list operation. `get` remains the only
    // supported client read, so there is no partial list surface to reason about.
    const { query, collection, getDocs, where } = await import("firebase/firestore");
    await assertFails(getDocs(query(collection(asMe(), "users"), where("uid", "==", ME))));
  });

  it("REGRESSION: a query that would expose another user is refused", async () => {
    const { query, collection, getDocs, where } = await import("firebase/firestore");
    await assertFails(getDocs(query(collection(asMe(), "users"), where("email", "==", "other@example.test"))));
    await assertFails(getDocs(query(collection(asMe(), "users"), where("plan", "==", "full"))));
  });

  it("REGRESSION: an unauthenticated principal cannot enumerate users", async () => {
    const { query, collection, getDocs } = await import("firebase/firestore");
    await assertFails(getDocs(query(collection(anon(), "users"))));
  });

  it("the owner's single-document get still works — the supported read is unchanged", async () => {
    await assertSucceeds(getDoc(myDoc()));
  });
});

describe("R4 — signup uses the real production persistence shape", () => {
  const BOOTSTRAPPED_R4 = { plan: "free", runsThisMonth: 3, usageMonth: "2026-09", totalRuns: 11 };

  async function seedDoc(d: Record<string, unknown>) {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", ME), d);
    });
  }
  const stored = async (): Promise<Record<string, unknown>> => {
    let out: Record<string, unknown> = {};
    await env.withSecurityRulesDisabled(async (ctx) => {
      out = ((await getDoc(doc(ctx.firestore(), "users", ME))).data() ?? {}) as Record<string, unknown>;
    });
    return out;
  };

  it("REGRESSION: signup succeeds when a server bootstrap won the race", async () => {
    await seedDoc(BOOTSTRAPPED_R4);
    await assertSucceeds(productionSignupWrite());
  });

  it("REGRESSION: every server-owned field survives signup untouched", async () => {
    await seedDoc({
      ...BOOTSTRAPPED_R4, plan: "full",
      tokensUsedCurrentPeriod: 4242, isDisabled: true, role: "reviewer",
      override: { active: true, plan: "5_models" },
    });
    await assertSucceeds(productionSignupWrite());
    const after = await stored();
    expect(after.plan).toBe("full");
    expect(after.runsThisMonth).toBe(3);
    expect(after.usageMonth).toBe("2026-09");
    expect(after.totalRuns).toBe(11);
    expect(after.tokensUsedCurrentPeriod).toBe(4242);
    expect(after.isDisabled).toBe(true);
    expect(after.role).toBe("reviewer");
    expect(after.override).toEqual({ active: true, plan: "5_models" });
  });

  it("the client-owned signup fields are actually written", async () => {
    await seedDoc(BOOTSTRAPPED_R4);
    await assertSucceeds(productionSignupWrite());
    const after = await stored();
    expect(after.uid).toBe(ME);
    expect(after.email).toBe(MY_EMAIL);
    expect(after.name).toBe("Me");
    expect(after.onboardingCompleted).toBe(false);
  });

  it("signup on a genuinely absent document still creates it", async () => {
    await env.clearFirestore();
    await assertSucceeds(productionSignupWrite());
    const after = await stored();
    expect(after.uid).toBe(ME);
    expect(after.email).toBe(MY_EMAIL);
  });

  it("NEGATIVE CONTROL: the pre-R4 destructive replace is still denied — the rules did not change", async () => {
    // What production used to send. It removes plan/runsThisMonth/usageMonth/
    // totalRuns; those removals enter affectedKeys() and the rules refuse them.
    // Proof that R4 changed the APPLICATION, not the security boundary.
    await seedDoc(BOOTSTRAPPED_R4);
    await assertFails(legacyReplacingSignupWrite());
    const after = await stored();
    expect(after.plan).toBe("free");
    expect(after.runsThisMonth).toBe(3);
  });

  it("NEGATIVE CONTROL: merge is not a licence to write authority fields", async () => {
    await seedDoc(BOOTSTRAPPED_R4);
    await assertFails(setDoc(myDoc(), { ...SIGNUP_PAYLOAD(), plan: "full" }, { merge: true }));
    await assertFails(setDoc(myDoc(), { ...SIGNUP_PAYLOAD(), role: "admin" }, { merge: true }));
    await assertFails(setDoc(myDoc(), { ...SIGNUP_PAYLOAD(), runsThisMonth: 0 }, { merge: true }));
  });

  it("NEGATIVE CONTROL: merge does not relax the identity pin", async () => {
    await seedDoc(BOOTSTRAPPED_R4);
    await assertFails(setDoc(myDoc(), { ...SIGNUP_PAYLOAD(), uid: OTHER }, { merge: true }));
    await assertFails(setDoc(myDoc(), { ...SIGNUP_PAYLOAD(), email: ADMIN_EMAIL }, { merge: true }));
  });
});

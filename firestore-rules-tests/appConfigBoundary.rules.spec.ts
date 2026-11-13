/**
 * SEC-2 / S4 — the provider-key access boundary.
 *
 * `appConfig/*` holds provider credentials (`modelKeys`) and the governance
 * policy (`governancePolicy`). Both are read and written only by the server
 * through the Admin SDK, which rules do not govern. Before S4 a client token
 * carrying `admin: true` could read and overwrite `appConfig/modelKeys`
 * directly. Rules cannot read the live Auth record, so a demoted admin kept
 * that reach until their ID token expired (up to an hour).
 *
 * Every principal a browser can present (unauthenticated, an ordinary user,
 * an `admin` claim, and an `admin` claim with a verified email) is denied get,
 * list, create, update and delete on the whole `appConfig` subtree. The
 * documents are seeded through the privileged path first, so each "read
 * denied" is against a document that really exists.
 */
import { readFileSync } from "fs";
import { initializeTestEnvironment, assertFails, assertSucceeds, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

const RULES = readFileSync("firestore.rules", "utf8");

/** The `appConfig` documents the server uses, plus an unknown sibling and a nested path under the wildcard. */
const PATHS = ["appConfig/modelKeys", "appConfig/governancePolicy", "appConfig/somethingNew", "appConfig/modelKeys/history/h1"] as const;

const ME = "uid_ordinary";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-appconfig-boundary-rules",
    firestore: { rules: RULES, host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080) },
  });
});
afterAll(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "appConfig/modelKeys"), { openai: "sk-real", anthropic: "sk-ant-real" });
    await setDoc(doc(db, "appConfig/governancePolicy"), { schemaVersion: 1, threshold: 70 });
    await setDoc(doc(db, "appConfig/somethingNew"), { v: 1 });
    await setDoc(doc(db, "appConfig/modelKeys/history/h1"), { v: 1 });
    await setDoc(doc(db, "users", ME), { uid: ME, email: "ordinary@example.test", plan: "free" });
  });
});

const principals = () =>
  [
    ["unauthenticated", env.unauthenticatedContext().firestore()],
    ["ordinary user", env.authenticatedContext(ME, { email: "ordinary@example.test", email_verified: true }).firestore()],
    ["admin claim", env.authenticatedContext("uid_admin", { admin: true }).firestore()],
    ["admin claim + verified email", env.authenticatedContext("uid_admin2", { admin: true, email: "root@example.test", email_verified: true }).firestore()],
  ] as const;
const PRINCIPAL_IDS = [0, 1, 2, 3];

describe("positive controls", () => {
  it("the seeded appConfig documents exist (read through the privileged path)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      for (const p of PATHS) expect([p, (await getDoc(doc(ctx.firestore(), p))).exists()]).toEqual([p, true]);
    });
  });

  it("the harness can grant something legitimate under the same rules: an owner reads their own user document", async () => {
    const [, db] = principals()[1];
    const snap = await assertSucceeds(getDoc(doc(db, "users", ME)));
    expect(snap.data()?.uid).toBe(ME);
  });

  it("BASELINE: under the pre-S4 rule an admin-claim client could read and overwrite the provider keys", async () => {
    // Re-adds the pre-S4 grant next to the catch-all, so the baseline does not depend on the shape of the S4 block.
    const CATCH_ALL = "    // Default deny all other documents\n";
    expect(RULES.split(CATCH_ALL)).toHaveLength(2);
    const pre = RULES.replace(CATCH_ALL, "    match /appConfig/modelKeys { allow read, write: if request.auth != null && request.auth.token.admin == true; }\n" + CATCH_ALL);
    const old = await initializeTestEnvironment({
      projectId: "demo-appconfig-boundary-baseline",
      firestore: { rules: pre, host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080) },
    });
    try {
      await old.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "appConfig/modelKeys"), { openai: "sk-real" }); });
      const db = old.authenticatedContext("uid_admin", { admin: true }).firestore();
      const snap = await assertSucceeds(getDoc(doc(db, "appConfig/modelKeys")));
      expect(snap.data()?.openai).toBe("sk-real");
      await assertSucceeds(setDoc(doc(db, "appConfig/modelKeys"), { openai: "sk-forged" }));
    } finally {
      await old.clearFirestore();
      await old.cleanup();
    }
  });
});

describe("no client principal can read appConfig", () => {
  it.each(PRINCIPAL_IDS)("principal #%i: get of every appConfig path is denied", async (i) => {
    const [, db] = principals()[i];
    for (const p of PATHS) await assertFails(getDoc(doc(db, p)));
  });

  it.each(PRINCIPAL_IDS)("principal #%i: list of the appConfig collection and a nested collection is denied", async (i) => {
    const [, db] = principals()[i];
    await assertFails(getDocs(collection(db, "appConfig")));
    await assertFails(getDocs(collection(db, "appConfig/modelKeys/history")));
  });
});

describe("no client principal can write appConfig", () => {
  it.each(PRINCIPAL_IDS)("principal #%i: create, update, overwrite and delete are denied", async (i) => {
    const [, db] = principals()[i];
    await assertFails(setDoc(doc(db, "appConfig/brandNew"), { openai: "sk-forged" }));
    for (const p of PATHS) {
      await assertFails(setDoc(doc(db, p), { openai: "sk-forged" }));
      await assertFails(updateDoc(doc(db, p), { openai: "sk-forged" }));
      await assertFails(deleteDoc(doc(db, p)));
    }
  });

  it("the denied writes changed nothing: the stored keys and policy are the seeded values", async () => {
    for (const [, db] of principals()) {
      await assertFails(setDoc(doc(db, "appConfig/modelKeys"), { openai: "sk-forged" }));
      await assertFails(updateDoc(doc(db, "appConfig/governancePolicy"), { threshold: 0 }));
    }
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(doc(ctx.firestore(), "appConfig/modelKeys"))).data()).toEqual({ openai: "sk-real", anthropic: "sk-ant-real" });
      expect((await getDoc(doc(ctx.firestore(), "appConfig/governancePolicy"))).data()).toEqual({ schemaVersion: 1, threshold: 70 });
    });
  });
});

/**
 * Rules grant if ANY matching statement allows, so an explicit `if false`
 * block cannot be observed by a request: with or without it, and whether it
 * matches `{doc=**}` or one document, the default deny already denies. Its job
 * is to make the boundary explicit so it never depends on the catch-all. That
 * shape is pinned here, against the real file.
 */
describe("the explicit boundary is the only appConfig rule and covers the whole subtree", () => {
  it("one appConfig match, the recursive wildcard, deny-only, and no claim-based helper", () => {
    expect(RULES.match(/match \/appConfig\b/g)).toHaveLength(1);
    expect(RULES).toMatch(/match \/appConfig\/\{doc=\*\*\} \{\s*allow read, write: if false;\s*\}/);
    expect(RULES).not.toMatch(/token\.admin/);
    expect(RULES).not.toMatch(/isAdminClaim/);
  });
});

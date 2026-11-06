/**
 * I-1 M-2 — the Production build guard (lib/firebase/productionBuildConfigGuard.js, called from next.config.js).
 * Fixtures only; no real values.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { resolveBrowserFirebaseConfig, UNAVAILABLE_FIREBASE_PROJECT_ID, PRODUCTION_FIREBASE_WEB_API_KEY, PRODUCTION_FIREBASE_PROJECT_ID, PRODUCTION_FIREBASE_PROJECT_NUMBER } from "../projectIsolation";
const guard = require("../productionBuildConfigGuard") as {
  productionBuildConfigProblems: (env: Record<string, string | undefined>) => string[];
  assertProductionBuildConfig: (env: Record<string, string | undefined>) => void;
  APPROVED_PRODUCTION_WEB_CONFIG: Record<string, string>;
};

const PROD = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaSyCUr6oygS_YWxpdXa2pXVryebPzSnOUxdo",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "convergepanel.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "convergepanel",
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "convergepanel.firebasestorage.app",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "907484474744",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:907484474744:web:19a931809616da203f6c8d",
};
const PREVIEW = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaPreview",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "convergepanel-preview.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "convergepanel-preview",
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "convergepanel-preview.firebasestorage.app",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "111111111111",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:111111111111:web:def",
};
const PROD_BUILD = { VERCEL: "1", VERCEL_ENV: "production", NEXT_PUBLIC_VERCEL_ENV: "production" };

describe("Production build guard (M-2)", () => {
  it("a valid Production build passes", () => {
    expect(guard.productionBuildConfigProblems({ ...PROD_BUILD, ...PROD })).toEqual([]);
    expect(() => guard.assertProductionBuildConfig({ ...PROD_BUILD, ...PROD })).not.toThrow();
  });
  it.each(Object.keys(PROD))("a Production build fails when %s is missing, empty or has surrounding whitespace", (k) => {
    for (const bad of [undefined, "", ` ${(PROD as Record<string, string>)[k]}`]) {
      const env = { ...PROD_BUILD, ...PROD, [k]: bad };
      expect(() => guard.assertProductionBuildConfig(env)).toThrow(new RegExp(`Refusing to build: .*${k}`));
    }
  });
  it("the pinned approved configuration is the fixture, and the runtime rule pins the same Production identity", () => {
    expect(guard.APPROVED_PRODUCTION_WEB_CONFIG).toEqual(PROD);
    expect(Object.isFrozen(guard.APPROVED_PRODUCTION_WEB_CONFIG)).toBe(true);
    expect(guard.APPROVED_PRODUCTION_WEB_CONFIG.NEXT_PUBLIC_FIREBASE_API_KEY).toBe(PRODUCTION_FIREBASE_WEB_API_KEY);
    expect(guard.APPROVED_PRODUCTION_WEB_CONFIG.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe(PRODUCTION_FIREBASE_PROJECT_ID);
    expect(guard.APPROVED_PRODUCTION_WEB_CONFIG.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID).toBe(PRODUCTION_FIREBASE_PROJECT_NUMBER);
  });
  it.each([
    ["another project's valid-looking API key", "NEXT_PUBLIC_FIREBASE_API_KEY", "AIzaSyD" + "x".repeat(32)],
    ["the placeholder API key", "NEXT_PUBLIC_FIREBASE_API_KEY", "firebase-config-unavailable"],
    ["a quoted API key", "NEXT_PUBLIC_FIREBASE_API_KEY", `"${PRODUCTION_FIREBASE_WEB_API_KEY}"`],
    ["a truncated API key", "NEXT_PUBLIC_FIREBASE_API_KEY", PRODUCTION_FIREBASE_WEB_API_KEY.slice(0, -1)],
    ["another web app of the Production project", "NEXT_PUBLIC_FIREBASE_APP_ID", "1:907484474744:web:0000000000000000000000"],
    ["the legacy appspot bucket (not the approved one)", "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "convergepanel.appspot.com"],
    ["a custom auth domain (needs a reviewed pin change)", "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "auth.convergepanel.com"],
  ])("a Production build is refused for %s", (_l, k, v) => {
    expect(() => guard.assertProductionBuildConfig({ ...PROD_BUILD, ...PROD, [k]: v })).toThrow(new RegExp(`${k} does not match the approved Production web-app configuration`));
  });
  it("the placeholder identity is never accepted as Production configuration", () => {
    expect(() => guard.assertProductionBuildConfig({ ...PROD_BUILD, ...PROD, NEXT_PUBLIC_FIREBASE_PROJECT_ID: UNAVAILABLE_FIREBASE_PROJECT_ID })).toThrow(/placeholder/);
  });
  it("a Production build carrying non-Production (Preview) config fails (it would break Production sign-in)", () => {
    const problems = guard.productionBuildConfigProblems({ ...PROD_BUILD, ...PREVIEW });
    expect(problems.length).toBe(6);
    expect(() => guard.assertProductionBuildConfig({ ...PROD_BUILD, ...PREVIEW })).toThrow(/NEXT_PUBLIC_FIREBASE_PROJECT_ID does not match the approved Production web-app configuration/);
  });
  it("a Production build without NEXT_PUBLIC_VERCEL_ENV fails (the browser would silently refuse Production)", () => {
    expect(() => guard.assertProductionBuildConfig({ VERCEL: "1", VERCEL_ENV: "production", ...PROD })).toThrow(/NEXT_PUBLIC_VERCEL_ENV must be exactly "production"/);
  });
  it("disagreeing deployment identities fail", () => {
    expect(() => guard.assertProductionBuildConfig({ VERCEL: "1", VERCEL_ENV: "preview", NEXT_PUBLIC_VERCEL_ENV: "production", ...PROD })).toThrow(/disagree/);
  });
  it("a Vercel build without VERCEL_ENV fails (system environment variables not exposed)", () => {
    expect(() => guard.assertProductionBuildConfig({ VERCEL: "1", ...PROD })).toThrow(/VERCEL_ENV is missing on a Vercel build/);
  });
  it.each([
    ["Preview build", { VERCEL: "1", VERCEL_ENV: "preview", NEXT_PUBLIC_VERCEL_ENV: "preview" }],
    ["development build", { VERCEL: "1", VERCEL_ENV: "development", NEXT_PUBLIC_VERCEL_ENV: "development" }],
    ["CI / local build (no Vercel variables)", {}],
  ])("%s is not checked (independent of Production configuration)", (_l, envBase) => {
    expect(guard.productionBuildConfigProblems({ ...envBase })).toEqual([]);
    expect(guard.productionBuildConfigProblems({ ...envBase, ...PREVIEW })).toEqual([]);
  });
  it("failure messages name variables, never values", () => {
    try {
      guard.assertProductionBuildConfig({ ...PROD_BUILD, ...PROD, NEXT_PUBLIC_FIREBASE_APP_ID: "1:999:web:SECRETLIKE" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(String(e)).not.toMatch(/SECRETLIKE|AIzaSy/);
    }
  });
  it("parity with the runtime browser rule: whatever the guard accepts, the browser accepts as Production", () => {
    const cases = [PROD, { ...PROD, NEXT_PUBLIC_FIREBASE_APP_ID: "" }, PREVIEW, { ...PROD, NEXT_PUBLIC_FIREBASE_PROJECT_ID: UNAVAILABLE_FIREBASE_PROJECT_ID }, { ...PROD, NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaSyD" + "x".repeat(32) }];
    expect(guard.productionBuildConfigProblems({ ...PROD_BUILD, ...PROD })).toEqual([]); // positive control
    for (const c of cases) {
      const guardOk = guard.productionBuildConfigProblems({ ...PROD_BUILD, ...c }).length === 0;
      const runtime = resolveBrowserFirebaseConfig(
        { apiKey: c.NEXT_PUBLIC_FIREBASE_API_KEY, authDomain: c.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, projectId: c.NEXT_PUBLIC_FIREBASE_PROJECT_ID, storageBucket: c.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET, messagingSenderId: c.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID, appId: c.NEXT_PUBLIC_FIREBASE_APP_ID },
        "production",
      );
      const runtimeProdOk = runtime.status === "ok" && runtime.config.projectId === "convergepanel";
      // The build guard is STRICTER than the runtime rule (it pins the exact approved config), never looser.
      if (guardOk) expect(runtimeProdOk).toBe(true);
    }
  });
  it("next.config.js runs the guard before building", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "next.config.js"), "utf8");
    expect(src).toMatch(/require\("\.\/lib\/firebase\/productionBuildConfigGuard"\)\.assertProductionBuildConfig\(process\.env\);/);
    expect(() => {
      jest.isolateModules(() => {
        const saved = { ...process.env };
        try {
          process.env.VERCEL = "1";
          process.env.VERCEL_ENV = "production";
          delete process.env.NEXT_PUBLIC_VERCEL_ENV;
          require("../../../next.config.js");
        } finally {
          for (const k of ["VERCEL", "VERCEL_ENV", "NEXT_PUBLIC_VERCEL_ENV"]) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
          }
        }
      });
    }).toThrow(/firebase-build-guard/);
  });
});

/**
 * Phase BILLING-ANNUAL-C1 — `resolveApprovedPriceId()`: the plan/cadence →
 * approved Price mapping contract. `lib/plans` reads the STRIPE_* env vars
 * at import time, so each scenario re-imports it in isolation with the env
 * it needs.
 */

const ENV_KEYS = ["STRIPE_PRICE_3_MODELS", "STRIPE_3_MODELS_ANNUAL", "STRIPE_PRICE_5_MODELS", "STRIPE_5_MODELS_ANNUAL", "Stripe_5_Models_Annual"];

function withEnv(env: Record<string, string | undefined>, fn: (resolve: typeof import("@/lib/billing/approvedPrice").resolveApprovedPriceId) => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    jest.isolateModules(() => {
      const { resolveApprovedPriceId } = require("@/lib/billing/approvedPrice");
      fn(resolveApprovedPriceId);
    });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const FULL_ENV = { STRIPE_PRICE_3_MODELS: "price_lite_m", STRIPE_3_MODELS_ANNUAL: "price_lite_y", STRIPE_PRICE_5_MODELS: "price_full_m", STRIPE_5_MODELS_ANNUAL: "price_full_y" };

it("maps the full 2×2 matrix to four DISTINCT configured Prices", () => {
  withEnv(FULL_ENV, (resolve) => {
    expect(resolve("lite", "month")).toEqual({ ok: true, priceId: "price_lite_m" });
    expect(resolve("lite", "year")).toEqual({ ok: true, priceId: "price_lite_y" });
    expect(resolve("full", "month")).toEqual({ ok: true, priceId: "price_full_m" });
    expect(resolve("full", "year")).toEqual({ ok: true, priceId: "price_full_y" });
  });
});

it("Full annual resolves ONLY from STRIPE_5_MODELS_ANNUAL — never from the monthly variable", () => {
  withEnv(FULL_ENV, (resolve) => {
    const r = resolve("full", "year");
    expect(r.ok && r.priceId).toBe("price_full_y");
    expect(r.ok && r.priceId).not.toBe("price_full_m");
  });
});

it("the legacy-cased Stripe_5_Models_Annual variable is honored when the canonical one is absent", () => {
  withEnv({ ...FULL_ENV, STRIPE_5_MODELS_ANNUAL: undefined, Stripe_5_Models_Annual: "price_full_y_legacy" }, (resolve) => {
    expect(resolve("full", "year")).toEqual({ ok: true, priceId: "price_full_y_legacy" });
  });
});

it("monthly and annual mapping collapsing to the SAME Price is refused (interval_collision), for both plans", () => {
  withEnv({ ...FULL_ENV, STRIPE_5_MODELS_ANNUAL: "price_full_m" }, (resolve) => {
    expect(resolve("full", "year")).toMatchObject({ ok: false, reason: "interval_collision" });
    expect(resolve("full", "month")).toMatchObject({ ok: false, reason: "interval_collision" });
    expect(resolve("lite", "year")).toEqual({ ok: true, priceId: "price_lite_y" });
  });
  withEnv({ ...FULL_ENV, STRIPE_3_MODELS_ANNUAL: "price_lite_m" }, (resolve) => {
    expect(resolve("lite", "year")).toMatchObject({ ok: false, reason: "interval_collision" });
  });
});

it("a missing annual variable is not_configured (never silently falls back to the monthly Price)", () => {
  withEnv({ ...FULL_ENV, STRIPE_5_MODELS_ANNUAL: undefined }, (resolve) => {
    const r = resolve("full", "year");
    expect(r).toMatchObject({ ok: false, reason: "not_configured" });
    expect(resolve("full", "month")).toEqual({ ok: true, priceId: "price_full_m" });
  });
});

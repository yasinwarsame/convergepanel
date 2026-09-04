#!/usr/bin/env node
/**
 * Billing Annual Correction, Phase BILLING-ANNUAL-C1 — READ-ONLY operator check
 * that every configured Stripe Price bills on the cadence the app sells it as.
 *
 *   npm run billing:verify-prices
 *
 * Reads STRIPE_SECRET_KEY and the four plan Price env vars from the current
 * shell environment (e.g. after `vercel env pull --environment=production`),
 * retrieves each Price, and exits non-zero on any mismatch. Prints masked
 * Price IDs only; never prints the secret key. Makes no writes.
 */

const EXPECTED = [
  ["STRIPE_PRICE_3_MODELS", "3-Model monthly", "month", 9999],
  ["STRIPE_3_MODELS_ANNUAL", "3-Model annual", "year", 95990],
  ["STRIPE_PRICE_5_MODELS", "Full monthly", "month", 16999],
  ["STRIPE_5_MODELS_ANNUAL", "Full annual", "year", 163190],
];

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set in this shell.");
  process.exit(2);
}
const mask = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "MISSING");

async function getPrice(id) {
  const res = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let failures = 0;
const seen = new Map();
for (const [envName, label, interval, cents] of EXPECTED) {
  const id = process.env[envName] || (envName === "STRIPE_5_MODELS_ANNUAL" ? process.env.Stripe_5_Models_Annual : undefined);
  if (!id) {
    console.error(`FAIL ${label}: ${envName} is not set`);
    failures++;
    continue;
  }
  if (seen.has(id)) {
    console.error(`FAIL ${label}: ${envName} reuses the same Price as ${seen.get(id)} (${mask(id)})`);
    failures++;
  }
  seen.set(id, envName);
  try {
    const p = await getPrice(id);
    const rec = p.recurring || {};
    const problems = [];
    if (!p.active) problems.push("inactive");
    if (rec.interval !== interval) problems.push(`interval=${rec.interval} (expected ${interval})`);
    if (rec.interval_count !== 1) problems.push(`interval_count=${rec.interval_count}`);
    if (p.unit_amount !== cents) problems.push(`amount=${p.unit_amount} (expected ${cents})`);
    if (p.currency !== "usd") problems.push(`currency=${p.currency}`);
    const line = `${label}: ${mask(id)} ${(p.unit_amount / 100).toFixed(2)} ${String(p.currency).toUpperCase()} / ${rec.interval} x${rec.interval_count} active=${p.active}`;
    if (problems.length) {
      console.error(`FAIL ${line} — ${problems.join(", ")}`);
      failures++;
    } else {
      console.log(`OK   ${line}`);
    }
  } catch (err) {
    console.error(`FAIL ${label}: could not retrieve ${mask(id)} (${err.message})`);
    failures++;
  }
}
if (failures) {
  console.error(`\n${failures} problem(s) found. Do NOT sell the affected plan until corrected.`);
  process.exit(1);
}
console.log("\nAll configured Stripe Prices match their sold cadence and amount.");

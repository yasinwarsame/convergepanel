/**
 * Order 5 Phase 0 — structural isolation of the Provider Search Evidence
 * counters: pure modules stay pure, nothing downstream (governance, Source
 * Authority / Standing, adaptive schema, UI, API routes, Firestore helpers)
 * imports them, and the flag is server-only with a false default.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(rel);
  }
  return out;
}

const PURE = ["lib/providers/perplexitySearchEvidenceObservation.ts", "lib/providers/searchResultUrlScreen.ts"];
const EMITTER = "lib/providers/providerSearchEvidencePhase0Emitter.ts";
const PHASE0_MODULES = /(providers\/|\.\/)(perplexitySearchEvidenceObservation|searchResultUrlScreen|providerSearchEvidencePhase0Emitter)["']/;

describe("pure observer modules", () => {
  it.each(PURE)("%s has no I/O, env, logging or Source Authority dependency", (file) => {
    const src = read(file);
    for (const forbidden of [
      /from ["']@\/lib\/firebase/,
      /from ["']@\/lib\/firestore/,
      /firebase-admin/,
      /from ["']@\/lib\/env["']/,
      /process\.env/,
      /from ["']@\/lib\/logger["']/,
      /console\./,
      /sourceAuthority|sourceStanding|publisherClass/i,
      /from ["']@\/lib\/governance/,
      /\bfetch\(/,
    ]) {
      expect(src).not.toMatch(forbidden);
    }
  });

  it("the emitter only logs: no Firestore, env, fetch or Source Authority", () => {
    const src = read(EMITTER);
    for (const forbidden of [/firebase/, /firestore/, /from ["']@\/lib\/env["']/, /process\.env/, /\bfetch\(/, /sourceAuthority|sourceStanding/i, /from ["']@\/lib\/governance/]) {
      expect(src).not.toMatch(forbidden);
    }
  });
});

describe("nothing downstream consumes the Phase-0 modules", () => {
  it("the only production importer is lib/runPanelExecution.ts (via the emitter)", () => {
    const importers = [...walk("lib"), ...walk("app"), ...walk("components")]
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => PHASE0_MODULES.test(read(f)))
      .sort();
    expect(importers).toEqual(["lib/providers/perplexitySearchEvidenceObservation.ts", "lib/providers/providerSearchEvidencePhase0Emitter.ts", "lib/runPanelExecution.ts"].sort());
  });
});

describe("flag", () => {
  it("is read only in lib/env.ts, server-side, exact 'true'", () => {
    const readers = [...walk("lib"), ...walk("app"), ...walk("components"), ...walk("hooks")]
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => read(f).includes("process.env.PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED"));
    expect(readers).toEqual(["lib/env.ts"]);
    expect(read("lib/env.ts")).toContain('export const PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED = process.env.PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED === "true";');
  });

  it("has no NEXT_PUBLIC_ variant anywhere and is not referenced by client code", () => {
    for (const f of [...walk("lib"), ...walk("app"), ...walk("components"), ...walk("hooks")].filter((x) => !x.includes("__tests__"))) {
      const src = read(f);
      expect(src).not.toMatch(/NEXT_PUBLIC_PROVIDER_SEARCH/);
      if (/^["']use client["']/m.test(src) || f.startsWith("components/") || f.startsWith("hooks/")) {
        expect(src).not.toContain("PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED");
      }
    }
    expect(read("next.config.js")).not.toContain("PROVIDER_SEARCH_EVIDENCE");
  });

  it("defaults to false when the variable is unset (and for anything but exact 'true')", () => {
    const saved = process.env.PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED;
    for (const value of [undefined, "", "TRUE", "1", "yes", "true "]) {
      jest.isolateModules(() => {
        if (value === undefined) delete process.env.PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED;
        else process.env.PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED = value;
        jest.spyOn(console, "error").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
        expect(require("@/lib/env").PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED).toBe(false);
      });
    }
    jest.isolateModules(() => {
      process.env.PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED = "true";
      expect(require("@/lib/env").PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED).toBe(true);
    });
    if (saved === undefined) delete process.env.PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED;
    else process.env.PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED = saved;
  });
});

describe("emission site", () => {
  it("is gated by the flag in runPanelExecution and passes no uid / run id / question / context", () => {
    const src = read("lib/runPanelExecution.ts");
    const call = src.slice(src.indexOf("if (PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED) {"));
    const block = call.slice(0, call.indexOf("}\n") + 2);
    expect(block).toContain("emitProviderSearchEvidencePhase0({");
    for (const forbidden of ["uid", "runId", "trimmedQuestion", "context", "normalizedResults"]) {
      expect(block).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("relative paths are stable", () => {
    expect(relative(ROOT, join(ROOT, EMITTER))).toBe(EMITTER);
  });
});

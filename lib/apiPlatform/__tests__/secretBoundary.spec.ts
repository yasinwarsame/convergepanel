/**
 * API secret boundary (docs/product/api-0/secret-boundary.md §5; owner Addendum 1 D3 / OQ-1).
 *
 * Pins: one reader (lib/apiPlatform/secrets.server.ts), `server-only` first, an explicit importer
 * allow-list, lib/env.ts byte-identical (Order 6), no NEXT_PUBLIC_ exposure, fail-closed decoding,
 * and deterministic purpose-separated subkeys. Every repository scan has a positive control.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  API_SECRET_NAMES,
  MIN_PEPPER_BYTES,
  RESERVED_API_SECRET_NAMES,
  SUBKEY_LABELS,
  deriveSubkey,
  hmacWith,
  readApiKeyPeppers,
} from "@/lib/apiPlatform/secrets.server";

const ROOT = path.resolve(__dirname, "../../..");
const MODULE = "lib/apiPlatform/secrets.server.ts";
const ALL_NAMES = [...Object.values(API_SECRET_NAMES), ...RESERVED_API_SECRET_NAMES];

/** Importers allowed to import the secrets module (non-test). Empty on the boundary branch; API-1a adds keys.ts. */
const IMPORTER_ALLOW_LIST: readonly string[] = [];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "coverage", "docs", "__tests__", "firestore-rules-tests", "public"]);
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|jsx)$/;

function codeFiles(dir = ROOT, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) codeFiles(abs, out);
    else if (CODE_EXT.test(name) && !TEST_FILE.test(name)) out.push(path.relative(ROOT, abs).split(path.sep).join("/"));
  }
  return out;
}

const FILES = codeFiles();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const b64 = (n: number) => randomBytes(n).toString("base64url");

describe("single reader", () => {
  it("positive control: the scan sees the module and ordinary code", () => {
    expect(FILES).toContain(MODULE);
    expect(FILES).toContain("lib/env.ts");
    expect(FILES.length).toBeGreaterThan(500);
  });

  it.each(ALL_NAMES)("%s is named only in the secrets module", (name) => {
    const hits = FILES.filter((f) => read(f).includes(name));
    expect(hits).toEqual([MODULE]);
  });

  it("no reserved or implemented name is a NEXT_PUBLIC_ variable, and next.config.js names none", () => {
    for (const n of ALL_NAMES) expect(n.startsWith("NEXT_PUBLIC_")).toBe(false);
    const cfg = read("next.config.js");
    for (const n of ALL_NAMES) expect(cfg).not.toContain(n);
  });
});

describe("server-only guard and importer allow-list", () => {
  it("first statement is import \"server-only\"", () => {
    const first = read(MODULE).split("\n").find((l) => l.trim() !== "");
    expect(first).toBe('import "server-only";');
  });

  /** Every module specifier in a file: static import/export-from, side-effect import, require(), import(), any quote style. */
  const SPECIFIER_RES = [
    /\b(?:import|export)\b[^;]*?\bfrom\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s*["'`]([^"'`]+)["'`]/g,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  const TARGETS = new Set(["lib/apiPlatform/secrets.server", "lib/apiPlatform/secrets"]);

  function resolveSpecifier(fromFile: string, spec: string): string | null {
    let rel: string;
    if (spec.startsWith("@/")) rel = spec.slice(2);
    else if (spec.startsWith(".")) rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    else return null; // bare package
    return rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "").replace(/\/index$/, "");
  }

  function importsSecrets(fromFile: string, src: string): boolean {
    for (const re of SPECIFIER_RES) {
      for (const m of src.matchAll(re)) {
        const r = resolveSpecifier(fromFile, m[1]);
        if (r !== null && TARGETS.has(r)) return true;
      }
    }
    return false;
  }

  it("positive control: the resolver catches every import form, from anywhere", () => {
    const cases: [string, string][] = [
      ["app/x/route.ts", 'import { x } from "@/lib/apiPlatform/secrets.server";'],
      ["lib/billing/a.ts", "import { x } from '../apiPlatform/secrets.server';"],
      ["lib/apiPlatform/keys.ts", 'import { x } from "./secrets.server";'],
      ["lib/apiPlatform/index.ts", 'export * from "./secrets.server";'],
      ["lib/apiPlatform/sub/deep.ts", 'export { readApiKeyPeppers } from "../secrets.server";'],
      ["lib/apiPlatform/t.ts", 'import type { PepperSet } from "./secrets.server";'],
      ["lib/apiPlatform/s.ts", 'import "./secrets.server";'],
      ["components/C.tsx", 'const s = require("../lib/apiPlatform/secrets.server")'],
      ["lib/apiPlatform/d.ts", "const s = await import(`./secrets.server`);"],
      ["lib/apiPlatform/e.ts", 'import { x } from "./secrets.server.ts";'],
    ];
    for (const [file, src] of cases) expect([file, importsSecrets(file, src)]).toEqual([file, true]);
    expect(importsSecrets("lib/apiPlatform/k.ts", 'import { x } from "./secretsOther";')).toBe(false);
    expect(importsSecrets("lib/other/k.ts", 'import { x } from "./secrets.server";')).toBe(false);
  });

  it("only allow-listed non-test files import the module", () => {
    const importers = FILES.filter((f) => f !== MODULE && importsSecrets(f, read(f)));
    expect(importers.sort()).toEqual([...IMPORTER_ALLOW_LIST].sort());
  });

  it("the module imports no logger and never writes to the console", () => {
    const src = read(MODULE);
    expect(src).not.toMatch(/from\s+["']@\/lib\/logger["']/);
    expect(src).not.toMatch(/\bconsole\./);
  });

  it("reads process.env at call time, not at module load (behavioural, after import)", () => {
    const value = b64(32);
    expect(readApiKeyPeppers().status).toBe("unavailable");
    process.env.API_KEY_PEPPER = value;
    try {
      const r = readApiKeyPeppers();
      expect(r.status === "available" && r.current.equals(Buffer.from(value, "base64url"))).toBe(true);
    } finally {
      delete process.env.API_KEY_PEPPER;
    }
    expect(readApiKeyPeppers().status).toBe("unavailable");
  });

  it("the only process.env reference is the default argument of readApiKeyPeppers", () => {
    const refs = read(MODULE).split("\n").filter((l) => l.includes("process.env"));
    expect(refs).toEqual(["export function readApiKeyPeppers(env: NodeJS.ProcessEnv = process.env): PepperSet {"]);
  });
});

describe("Order 6: lib/env.ts is unchanged", () => {
  it("git blob of lib/env.ts is still 2b81ae72 and it names no API secret", () => {
    const buf = readFileSync(path.join(ROOT, "lib/env.ts"));
    const blob = createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
    expect(blob).toBe("2b81ae7239ea4fd655b8320d5bf726c778149a20");
    for (const n of ALL_NAMES) expect(buf.toString("utf8")).not.toContain(n);
  });
});

describe("readApiKeyPeppers (fail closed)", () => {
  const cur = b64(32);
  it.each([
    [{}, "missing"],
    [{ API_KEY_PEPPER: "" }, "missing"],
    [{ API_KEY_PEPPER: "   " }, "missing"],
    [{ API_KEY_PEPPER: "not base64url!!" }, "not_base64url"],
    [{ API_KEY_PEPPER: b64(MIN_PEPPER_BYTES - 1) }, "too_short"],
    [{ API_KEY_PEPPER: cur, API_KEY_PEPPER_PREVIOUS: "%%%" }, "not_base64url"],
    [{ API_KEY_PEPPER: cur, API_KEY_PEPPER_PREVIOUS: b64(8) }, "too_short"],
    [{ API_KEY_PEPPER: cur, API_KEY_PEPPER_PREVIOUS: cur }, "previous_equals_current"],
  ] as const)("%j → unavailable(%s), never the value", (env, reason) => {
    const r = readApiKeyPeppers(env as NodeJS.ProcessEnv);
    expect(r).toEqual({ status: "unavailable", reason });
    expect(JSON.stringify(r)).not.toContain(cur);
  });

  it.each(["", "   "])("an empty previous pepper (%j) is ignored, not an outage", (prev) => {
    const r = readApiKeyPeppers({ API_KEY_PEPPER: cur, API_KEY_PEPPER_PREVIOUS: prev } as NodeJS.ProcessEnv);
    expect(r.status).toBe("available");
    if (r.status === "available") expect(r.previous).toBeNull();
  });

  it("valid current, no previous → decoded Buffer, previous null", () => {
    const r = readApiKeyPeppers({ API_KEY_PEPPER: cur } as NodeJS.ProcessEnv);
    expect(r.status).toBe("available");
    if (r.status !== "available") return;
    expect(Buffer.isBuffer(r.current)).toBe(true);
    expect(r.current.equals(Buffer.from(cur, "base64url"))).toBe(true);
    expect(r.previous).toBeNull();
  });

  it("valid current + distinct previous → both decoded", () => {
    const prev = b64(48);
    const r = readApiKeyPeppers({ API_KEY_PEPPER: ` ${cur} `, API_KEY_PEPPER_PREVIOUS: prev } as NodeJS.ProcessEnv);
    expect(r.status).toBe("available");
    if (r.status !== "available") return;
    expect(r.current.equals(Buffer.from(cur, "base64url"))).toBe(true);
    expect(r.previous?.equals(Buffer.from(prev, "base64url"))).toBe(true);
  });

  it("reads at call time (rotation applies on the next call)", () => {
    const env: NodeJS.ProcessEnv = { API_KEY_PEPPER: cur };
    const a = readApiKeyPeppers(env);
    env.API_KEY_PEPPER = b64(32);
    const b = readApiKeyPeppers(env);
    expect(a.status === "available" && b.status === "available" && !a.current.equals(b.current)).toBe(true);
  });

  it("defaults to process.env and is unavailable when the test environment has no pepper", () => {
    expect(process.env.API_KEY_PEPPER).toBeUndefined();
    expect(readApiKeyPeppers()).toEqual({ status: "unavailable", reason: "missing" });
  });
});

describe("deriveSubkey", () => {
  const pepper = randomBytes(32);
  it("is deterministic, 32 bytes, purpose-separated and never the raw pepper", () => {
    const a = deriveSubkey(pepper, SUBKEY_LABELS.keyVerifier);
    expect(a.length).toBe(32);
    expect(deriveSubkey(pepper, SUBKEY_LABELS.keyVerifier).equals(a)).toBe(true);
    expect(deriveSubkey(pepper, SUBKEY_LABELS.listCursor).equals(a)).toBe(false);
    expect(a.equals(pepper)).toBe(false);
    expect(deriveSubkey(randomBytes(32), SUBKEY_LABELS.keyVerifier).equals(a)).toBe(false);
  });

  it("matches an independent HKDF-SHA256 computation (RFC 5869, empty salt)", () => {
    const label = SUBKEY_LABELS.keyVerifier;
    const { createHmac } = jest.requireActual("node:crypto") as typeof import("node:crypto");
    const extract = createHmac("sha256", Buffer.alloc(32)).update(pepper).digest();
    const expand = createHmac("sha256", extract).update(Buffer.concat([Buffer.from(label, "utf8"), Buffer.from([1])])).digest();
    expect(deriveSubkey(pepper, label).equals(expand)).toBe(true);
  });

  it("rejects an unknown label and an invalid pepper", () => {
    expect(() => deriveSubkey(pepper, "cp-api/other/v1" as never)).toThrow("unknown label");
    expect(() => deriveSubkey(Buffer.alloc(8), SUBKEY_LABELS.keyVerifier)).toThrow("invalid pepper");
  });

  it("hmacWith is HMAC-SHA256 with the subkey", () => {
    const k = deriveSubkey(pepper, SUBKEY_LABELS.listCursor);
    const { createHmac } = jest.requireActual("node:crypto") as typeof import("node:crypto");
    expect(hmacWith(k, "abc").equals(createHmac("sha256", k).update("abc").digest())).toBe(true);
  });
});

/**
 * R-16 — anti-drift contract for the self-hosted pdf.js worker.
 *
 * Every oracle here is computed by the test itself (its own sha256, its own
 * read of the lockfile and of the served bytes). Nothing trusts the values the
 * materializer returns about itself.
 *
 * These prove the build-time copy/verify mechanism. They are NOT browser proof:
 * whether a real browser under the real CSP loads the worker is only settled by
 * the authenticated preview acceptance.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const m = require("../materialize.js") as {
  PUBLIC_URL_BASE: string;
  materialize: (root: string) => { version: string; url: string };
  verify: (root: string) => { version: string; url: string };
  servedWorkerUrl: (version: string) => string;
};

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const REAL_PKG_DIR = path.join(REPO_ROOT, "node_modules", "pdfjs-dist");

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

function tmpRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "pdfjs-worker-"));
  roots.push(r);
  return r;
}

/** A synthetic project: lockfile + installed package + worker source. */
function fakeProject(opts: {
  locked?: string;
  installed?: string;
  workerBody?: string | null;
}): string {
  const root = tmpRoot();
  const locked = opts.locked ?? "6.3.289";
  const installed = opts.installed ?? "6.3.289";
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/pdfjs-dist": { version: locked } } })
  );
  const pkg = path.join(root, "node_modules", "pdfjs-dist");
  fs.mkdirSync(path.join(pkg, "build"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: installed }));
  const body = opts.workerBody === undefined ? `/*w*/const f="${installed}";` : opts.workerBody;
  if (body !== null) fs.writeFileSync(path.join(pkg, "build", "pdf.worker.min.mjs"), body);
  return root;
}

const served = (root: string, v: string) =>
  path.join(root, "public", "vendor", "pdfjs", v, "pdf.worker.min.mjs");

describe("materialize — the real installed pdfjs-dist", () => {
  it("serves bytes identical to the installed worker, at the lockfile's version", () => {
    const root = tmpRoot();
    fs.copyFileSync(path.join(REPO_ROOT, "package-lock.json"), path.join(root, "package-lock.json"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(REAL_PKG_DIR, path.join(root, "node_modules", "pdfjs-dist"), "dir");

    const lockVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"))
      .packages["node_modules/pdfjs-dist"].version;
    const installedVersion = JSON.parse(fs.readFileSync(path.join(REAL_PKG_DIR, "package.json"), "utf8")).version;
    expect(installedVersion).toBe(lockVersion);

    m.materialize(root);

    const out = served(root, lockVersion);
    const sourceSha = sha(fs.readFileSync(path.join(REAL_PKG_DIR, "build", "pdf.worker.min.mjs")));
    expect(sha(fs.readFileSync(out))).toBe(sourceSha);
    // The only thing under public/vendor/pdfjs is that one version directory.
    expect(fs.readdirSync(path.join(root, "public", "vendor", "pdfjs"))).toEqual([lockVersion]);
    expect(m.servedWorkerUrl(lockVersion)).toBe(`/vendor/pdfjs/${lockVersion}/pdf.worker.min.mjs`);
  });
});

describe("materialize — fails closed", () => {
  it("F: missing worker source fails and produces no artifact", () => {
    const root = fakeProject({ workerBody: null });
    expect(() => m.materialize(root)).toThrow(/worker source missing/);
    expect(fs.existsSync(path.join(root, "public"))).toBe(false);
  });

  it("E: installed version differing from the lockfile fails", () => {
    const root = fakeProject({ locked: "6.3.289", installed: "6.0.227" });
    expect(() => m.materialize(root)).toThrow(/does not match the lockfile/);
    expect(fs.existsSync(path.join(root, "public"))).toBe(false);
  });

  it("E: a worker from a different pdfjs-dist release fails", () => {
    const root = fakeProject({ workerBody: `/*w*/const f="6.0.227";` });
    expect(() => m.materialize(root)).toThrow(/does not embed version "6\.3\.289"/);
    expect(fs.existsSync(path.join(root, "public"))).toBe(false);
  });

  it("wipes a previously materialized version instead of keeping it", () => {
    const root = fakeProject({});
    const stale = served(root, "6.0.227");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "old worker");
    m.materialize(root);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(path.join(root, "public", "vendor", "pdfjs"))).toEqual(["6.3.289"]);
  });
});

describe("verify — the served artifact", () => {
  it("passes on an untouched materialization", () => {
    const root = fakeProject({});
    m.materialize(root);
    expect(() => m.verify(root)).not.toThrow();
  });

  it("G: one altered byte in the served worker fails", () => {
    const root = fakeProject({});
    m.materialize(root);
    const out = served(root, "6.3.289");
    const bytes = fs.readFileSync(out);
    bytes[0] = bytes[0] ^ 0x01;
    fs.writeFileSync(out, bytes);
    expect(() => m.verify(root)).toThrow(/served worker sha256 .* != installed source/);
  });

  it("G: a stale extra version directory fails", () => {
    const root = fakeProject({});
    m.materialize(root);
    fs.mkdirSync(path.dirname(served(root, "6.0.227")), { recursive: true });
    fs.writeFileSync(served(root, "6.0.227"), "old worker");
    expect(() => m.verify(root)).toThrow(/stale entries/);
  });

  it("G: an extra file beside the worker fails", () => {
    const root = fakeProject({});
    m.materialize(root);
    fs.writeFileSync(path.join(path.dirname(served(root, "6.3.289")), "extra.js"), "x");
    expect(() => m.verify(root)).toThrow(/unexpected files next to the worker/);
  });

  it("a copy step that produced nothing fails", () => {
    const root = fakeProject({});
    expect(() => m.verify(root)).toThrow(/served worker missing/);
  });
});

describe("build integration", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

  it("the build script materializes the worker before next build", () => {
    const build: string = pkg.scripts.build;
    const steps = build.split("&&").map((s: string) => s.trim());
    expect(steps[0]).toBe("node scripts/pdfjs-worker/materialize.js");
    expect(steps.indexOf("next build")).toBeGreaterThan(0);
  });

  it("the dev script materializes the worker before next dev", () => {
    expect(pkg.scripts.dev).toBe("node scripts/pdfjs-worker/materialize.js && next dev");
  });

  it("the generated worker is gitignored, never committed", () => {
    const ignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").split("\n");
    expect(ignore).toContain("/public/vendor/pdfjs/");
  });
});

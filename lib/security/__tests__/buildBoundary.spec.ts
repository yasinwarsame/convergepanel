/**
 * PR #295 build boundary — unit-level proof of Layer A (the webpack plugin, run under the REAL webpack 5
 * that Next.js 14 bundles) and Layer B (the post-build checker, on synthetic build directories).
 * The full-build proof (real `next build` of this repository, positive build + mutant builds) is recorded
 * in the PR's exact-head evidence; CI runs the real build + checker on every PR (Quality Gate).
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { CpBuildBoundaryPlugin, isForbidden, forbiddenSet, FORBIDDEN_FILES, VIOLATION } = require("../buildBoundary");
const { checkBuildBoundary, classifyResourceless, TOOL_LITERALS } = require("../../../scripts/security/check-build-boundary");

const REPO = join(__dirname, "..", "..", "..");

describe("isForbidden (canonical identity)", () => {
  const set = forbiddenSet(REPO);
  it.each(FORBIDDEN_FILES as string[])("flags the tool file %s, with or without a query", (f: string) => {
    expect(isForbidden(join(REPO, f), set)).toBe(true);
    expect(isForbidden(`${join(REPO, f)}?raw`, set)).toBe(true);
  });
  it("flags anything under scripts/admin and nothing else", () => {
    expect(isForbidden(join(REPO, "scripts/admin/set-system-admin-claim.ts"), set)).toBe(true);
    expect(isForbidden(join(REPO, "lib/admin/privilegedAccess.ts"), set)).toBe(false);
    expect(isForbidden(join(REPO, "scripts/security/check-build-boundary.js"), set)).toBe(false);
    expect(isForbidden("lib/admin/systemAdminClaimSafety.ts", set)).toBe(false); // relative = not a resolved resource
    expect(isForbidden("", set)).toBe(false);
  });
  it("flags a symlink that resolves to the tool (realpath)", () => {
    const d = mkdtempSync(join(tmpdir(), "cpbb-link-"));
    try {
      const link = join(d, "innocent.ts");
      symlinkSync(join(REPO, "lib/admin/systemAdminClaimSafety.ts"), link);
      expect(isForbidden(link, set)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("Layer A under the real webpack 5 bundled by Next.js", () => {
  const wp = require("next/dist/compiled/webpack/webpack");
  if (wp.init) wp.init();
  const webpack = wp.webpack;

  function project(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "cpbb-wp-"));
    writeFileSync(join(root, "package.json"), "{}");
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), c);
    }
    return root;
  }
  function compile(root: string, entry: string, extra: Record<string, unknown> = {}): Promise<{ errors: string[]; manifests: any[] }> {
    const distDir = join(root, ".next");
    return new Promise((resolve, reject) => {
      webpack({
        mode: "production",
        context: root,
        entry: join(root, entry),
        target: "node",
        output: { path: join(distDir, "out"), filename: "[name].js" },
        resolve: { extensions: [".ts", ".js"], alias: { "private-next-root-dir": root } },
        module: { rules: [{ test: /\.ts$/, type: "javascript/auto" }] },
        optimization: { minimize: false },
        plugins: [new CpBuildBoundaryPlugin({ root, compilerName: "server", distDir, nonce: "unit", writeManifests: true })],
        ...extra,
      }).run((err: Error | null, stats: any) => {
        if (err) return reject(err);
        const errors = stats.compilation.errors.map((e: Error) => String(e.message));
        let manifests: any[] = [];
        try {
          const md = join(distDir, "cp-build-boundary");
          manifests = require("node:fs").readdirSync(md).map((f: string) => JSON.parse(readFileSync(join(md, f), "utf8")));
        } catch { /* none */ }
        resolve({ errors, manifests });
      });
    });
  }
  const TOOL = { "lib/admin/systemAdminClaimSafety.ts": 'module.exports = "operator_clock_out_of_tolerance";\n', "lib/admin/systemAdminClaimExecution.ts": "module.exports = 1;\n" };

  it("POSITIVE: a clean entry compiles and its manifest lists the module", async () => {
    const root = project({ ...TOOL, "app/route.js": 'require("../lib/ok");\n', "lib/ok.js": "module.exports = 1;\n" });
    try {
      const r = await compile(root, "app/route.js");
      expect(r.errors).toEqual([]);
      expect(r.manifests[0].resources).toEqual(expect.arrayContaining(["app/route.js", "lib/ok.js"]));
      expect(r.manifests[0].nonce).toBe("unit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it.each([
    ["direct relative require", 'require("../lib/admin/systemAdminClaimSafety");\n', {}],
    ["private-next-root-dir alias (Round 4 #1)", 'require("private-next-root-dir/lib/admin/systemAdminClaimSafety");\n', {}],
    ["nested package.json main (Round 4 #2)", 'require("../lib/x");\n', { "lib/x/index.js": "module.exports = 0;\n", "lib/x/package.json": '{"main":"../admin/systemAdminClaimSafety.ts"}' }],
    ["dynamic import()", 'import("../lib/admin/systemAdminClaimExecution");\n', {}],
    ["extension-less file that requires the tool", 'require("../lib/x/gate");\n', { "lib/x/gate": 'module.exports = require("../admin/systemAdminClaimSafety");\n' }],
  ] as Array<[string, string, Record<string, string>]>)("NEGATIVE: %s fails the compilation with %s", async (_label, code, extra) => {
    const root = project({ ...TOOL, ...extra, "app/route.js": code });
    try {
      const r = await compile(root, "app/route.js");
      // The security invariant, stated exactly: the compiler resolved the tool AND the gate failed the compilation.
      expect(r.manifests.flatMap((m: any) => m.resources).some((x: string) => x.startsWith("lib/admin/systemAdminClaim")) || r.errors.some((e) => e.includes(VIOLATION))).toBe(true);
      expect(r.errors.some((e) => e.includes(VIOLATION) && e.includes("lib/admin/systemAdminClaim"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("INVARIANT: a require.context over lib/admin never emits tool code without a violation (positive proof for contexts is in the real-build matrix)", async () => {
    const root = project({ ...TOOL, "app/route.js": 'const c = require.context("../lib/admin", false, /\\.ts$/); c.keys().forEach(c);\n' });
    try {
      const r = await compile(root, "app/route.js");
      const out = readFileSync(join(root, ".next/out/main.js"), "utf8");
      const emitted = out.includes("operator_clock_out_of_tolerance");
      const violated = r.errors.some((e) => e.includes(VIOLATION));
      expect(!emitted || violated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("NEGATIVE: a worker entry (new Worker(new URL(..., import.meta.url))) fails the compilation (Round 4 #3)", async () => {
    const root = project({ ...TOOL, "app/route.mjs": 'import { Worker } from "node:worker_threads";\nnew Worker(new URL("../lib/admin/systemAdminClaimExecution.ts", import.meta.url));\n' });
    try {
      const r = await compile(root, "app/route.mjs", { externalsPresets: { node: true } });
      expect(r.errors.some((e) => e.includes(VIOLATION))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});

describe("Layer B checker on synthetic build directories (fails closed)", () => {
  /** A minimal repository + build that satisfies every positive control. */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "cpbb-chk-"));
    const w = (f: string, c: string) => {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), c);
    };
    w("package.json", "{}");
    w("lib/admin/systemAdminClaimSafety.ts", TOOL_LITERALS.map((l: string) => JSON.stringify(l)).join(";\n"));
    w("lib/admin/systemAdminClaimExecution.ts", "export {};\n");
    w("lib/admin/privilegedAccess.ts", "export {};\n");
    w(".next/BUILD_ID", "b");
    w(".next/server/app/page.js.nft.json", JSON.stringify({ version: 1, files: ["../../../lib/admin/privilegedAccess.ts"] }));
    w(".next/server/app/page.js", "module.exports=1;");
    const man = (compiler: string, resources: string[], other: unknown[] = [], externals: unknown[] = []) =>
      w(`.next/cp-build-boundary/${compiler}.1.1.json`, JSON.stringify({ version: 1, nonce: "n", compiler, compilationName: compiler, child: false, moduleCount: resources.length, resources, externals, other }));
    man("server", ["app/api/admin/access/route.ts", "lib/admin/privilegedAccess.ts", "lib/admin/auditLog.ts", "app/api/admin/set-role/route.ts"]);
    man("edge-server", ["middleware.ts"]);
    man("client", ["components/AuthProvider.tsx"]);
    return { root, w, man };
  }
  const run = (root: string, nonce: string | null = "n") => checkBuildBoundary({ root, dist: ".next", nonce });

  it("POSITIVE: complete, matching evidence passes", () => {
    const { root } = fixture();
    try {
      const r = run(root);
      expect(r.failures).toEqual([]);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["no nonce", (f: any) => f, null, /no nonce/],
    ["stale nonce", (f: any) => f, "other", /stale or foreign/],
    ["forbidden module in a manifest", (f: any) => f.man("server", ["app/api/admin/access/route.ts", "lib/admin/privilegedAccess.ts", "lib/admin/auditLog.ts", "app/api/admin/set-role/route.ts", "lib/admin/systemAdminClaimSafety.ts"]), "n", /FORBIDDEN module/],
    ["forbidden traced file", (f: any) => f.w(".next/server/app/x.js.nft.json", JSON.stringify({ version: 1, files: ["../../../scripts/admin/set-system-admin-claim.ts"] })), "n", /FORBIDDEN traced file/],
    ["tool literal in an emitted chunk", (f: any) => f.w(".next/server/chunks/9.js", `x="${TOOL_LITERALS[0]}"`), "n", /FORBIDDEN tool literal/],
    ["missing positive control", (f: any) => f.man("edge-server", ["other.ts"]), "n", /positive control middleware\.ts missing/],
    ["unknown module type", (f: any) => f.man("client", ["components/AuthProvider.tsx"], [{ type: "MysteryModule", id: "m" }]), "n", /unrecognised module type MysteryModule/],
    ["resource-less module via a non-entry loader", (f: any) => f.man("client", ["components/AuthProvider.tsx"], [{ type: "NormalModule", loaders: ["other:/x/evil-loader.js"], id: "e" }]), "n", /non-entry loader/],
    ["forbidden external", (f: any) => f.man("client", ["components/AuthProvider.tsx"], [], [{ request: "commonjs ./lib/admin/systemAdminClaimExecution.ts" }]), "n", /FORBIDDEN external/],
    ["no traces", (f: any) => rmSync(join(f.root, ".next/server/app/page.js.nft.json")), "n", /no server app \.nft\.json/],
    ["no build", (f: any) => rmSync(join(f.root, ".next/BUILD_ID")), "n", /BUILD_ID missing/],
  ] as Array<[string, (f: any) => unknown, string | null, RegExp]>)("NEGATIVE: %s fails", (_l, mutate, nonce, re) => {
    const f = fixture();
    try {
      mutate(f);
      const r = run(f.root, nonce);
      expect(r.ok).toBe(false);
      expect(r.failures.some((m: string) => re.test(m))).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("classifies exactly the resource-less shapes seen in the real Next 14 build", () => {
    expect(classifyResourceless({ type: "NormalModule", loaders: ["next:next-app-loader"] })).toBeNull();
    expect(classifyResourceless({ type: "CompatGetDefaultExportRuntimeModule", moduleType: "runtime" })).toBeNull();
    expect(classifyResourceless({ type: "ContextModule", context: "node_modules/require-in-the-middle" })).toBeNull();
    expect(classifyResourceless({ type: "NormalModule", loaders: [] })).toMatch(/no loader/);
    expect(classifyResourceless({ type: "RawModule" })).toMatch(/unrecognised/);
  });
});

describe("the required Quality Gate runs the real build and the boundary gate on every PR (workflow pin)", () => {
  const wf = readFileSync(join(REPO, ".github/workflows/quality-gate.yml"), "utf8");
  // Parse the steps of the required job by name, in order. The job ends at the
  // next top-level job key (the Jest shard job follows it in the same file).
  const jobStart = wf.indexOf("name: Quality Gate");
  const nextJob = wf.slice(jobStart).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  const job = nextJob === -1 ? wf.slice(jobStart) : wf.slice(jobStart, jobStart + nextJob);
  const steps = job
    .split(/\n(?= {6}- name: )/)
    .filter((chunk) => /^ {6}- name: /.test(chunk))
    .map((chunk) => ({ name: /^ {6}- name: ([^\n]+)/.exec(chunk)![1].trim(), body: chunk.slice(chunk.indexOf("\n") + 1) }));
  const idx = (n: string) => steps.findIndex((s) => s.name === n);

  it("the step parser sees every step of the job (positive control)", () => {
    expect(steps.map((x) => x.name)).toEqual(["Checkout", "Verify the build is of the exact PR head", "Set up Node", "Install dependencies", "Type check", "Lint", "Build", "Build boundary gate", "Security-test falsifiability pre-flight", "Download Jest shard results", "Test"]);
  });

  it("the job is the required 'Quality Gate' job and triggers on pull requests to main", () => {
    expect(wf).toMatch(/\n {4}name: Quality Gate\n/);
    expect(wf).toMatch(/on:\n {2}pull_request:\n {4}branches: \[main\]/);
  });

  it("Build runs `npm run build` with the per-run nonce, and the gate runs right after it with the same nonce", () => {
    const b = idx("Build");
    const g = idx("Build boundary gate");
    expect(b).toBeGreaterThan(-1);
    expect(g).toBe(b + 1);
    expect(steps[b].body).toMatch(/run: npm run build/);
    expect(steps[b].body).toMatch(/CP_BUILD_BOUNDARY_NONCE: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    expect(steps[g].body).toMatch(/run: node scripts\/security\/check-build-boundary\.js --dist \.next/);
    expect(steps[g].body).toMatch(/CP_BUILD_BOUNDARY_NONCE: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  });

  it("neither step can be skipped or soft-failed", () => {
    for (const n of ["Build", "Build boundary gate"]) {
      const s = steps[idx(n)].body;
      expect({ n, if: /\n\s+if:/.test(`\n${s}`), soft: /continue-on-error/.test(s) }).toEqual({ n, if: false, soft: false });
    }
  });

  it("on a pull request the build is verified to be of the exact PR head", () => {
    const v = steps[idx("Verify the build is of the exact PR head")];
    expect(v).toBeDefined();
    expect(v.body).toMatch(/git rev-parse HEAD\^2/);
    expect(v.body).toMatch(/github\.event\.pull_request\.head\.sha/);
    expect(wf).toMatch(/fetch-depth: 2/);
  });

  it("next.config.js installs the boundary on every compiler", () => {
    const cfg = readFileSync(join(REPO, "next.config.js"), "utf8");
    expect(cfg).toMatch(/require\("\.\/lib\/security\/buildBoundary"\)/);
    expect(cfg).toMatch(/webpack: \(config, ctx\) => withBuildBoundary\(config, ctx\)/);
  });
});

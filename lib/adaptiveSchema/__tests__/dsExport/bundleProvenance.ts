/**
 * Order 6 / S-E.2 (R6): which bundle produced each render of exportSuite.mjs.
 *
 * A bundle's identity comes from its build (exportSuite.mjs): `id` is the sha256 of the bundle file, and `sources` is
 * esbuild's own record of which file it compiled for each of the five changed production paths, with that file's git
 * blob id. Each render carries the `id` of the module that produced it. The caller passes the blob ids it expects for
 * each role, read independently (HEAD: the working tree; BASE: the pinned 0249a4e5 blob ids), so a role is established
 * by what was compiled, never by a name.
 *
 * Roles:
 *   - `base` (unchanged-main reproduction, checked against the goldens): rendered by the BASE bundle;
 *   - `historical`, `variants`, `created`, `redownload` (the candidate): rendered by the HEAD bundle. A historical
 *     compatibility check that compared two BASE renders would pass vacuously; this rejects it.
 */
export type BundleSource = { path: string; blob: string; origin: "tree" | "vendored" };
export type BundleIdentity = { id: string; sources: BundleSource[] };
type Rendered = { bundle?: string };
export type ProvenanceSuite = {
  bundles: { head: BundleIdentity; base: BundleIdentity };
  base: Record<string, Rendered>;
  historical: Record<string, Rendered>;
  variants: Record<string, Rendered>;
  created: Record<string, Rendered>;
  redownload: Record<string, Rendered>;
};

const CANDIDATE_SECTIONS = ["historical", "variants", "created", "redownload"] as const;

export function provenanceViolations(suite: ProvenanceSuite, expected: { head: Record<string, string>; base: Record<string, string> }): string[] {
  const out: string[] = [];
  const { head, base } = suite.bundles ?? ({} as ProvenanceSuite["bundles"]);
  if (!head?.id || !base?.id) return ["bundle identities missing"];
  if (!/^[0-9a-f]{64}$/.test(head.id) || !/^[0-9a-f]{64}$/.test(base.id)) out.push("bundle id is not a sha256 of the bundle file");
  if (head.id === base.id) out.push("HEAD and BASE bundles are the same build");
  const roles = [
    ["head", head, "tree"],
    ["base", base, "vendored"],
  ] as const;
  for (const [role, identity, origin] of roles) {
    const want = expected[role];
    const paths = identity.sources.map((s) => s.path);
    if (new Set(paths).size !== paths.length) out.push(`${role}: a changed production path was compiled more than once`);
    if ([...paths].sort().join("|") !== Object.keys(want).sort().join("|")) out.push(`${role}: compiled ${JSON.stringify(paths)}, expected ${JSON.stringify(Object.keys(want))}`);
    for (const s of identity.sources) {
      if (want[s.path] !== s.blob) out.push(`${role}: ${s.path} compiled blob ${s.blob}, expected ${want[s.path]}`);
      if (s.origin !== origin) out.push(`${role}: ${s.path} compiled from ${s.origin}, expected ${origin}`);
    }
  }
  for (const p of Object.keys(expected.head)) if (expected.head[p] === expected.base[p]) out.push(`${p}: candidate and baseline sources are identical`);
  const check = (section: string, entries: Record<string, Rendered>, want: string, role: string) => {
    const keys = Object.keys(entries ?? {});
    if (keys.length === 0) out.push(`${section}: no renders`);
    for (const k of keys) {
      const got = entries[k].bundle;
      if (got !== want) out.push(`${section}.${k}: rendered by ${got === head.id ? "HEAD" : got === base.id ? "BASE" : JSON.stringify(got)}, expected ${role}`);
    }
  };
  check("base", suite.base, base.id, "BASE");
  for (const section of CANDIDATE_SECTIONS) check(section, suite[section], head.id, "HEAD");
  return out;
}

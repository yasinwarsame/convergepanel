/**
 * Result-file containment against AMBIGUOUS repository state, with a real git
 * binary and real temp directories (never the real repository, never Firebase):
 *
 *  - a linked worktree moved with `mv` (git still lists its OLD path, prunable)
 *  - a worktree path containing a newline (`--porcelain` without `-z`)
 *  - inherited GIT_* variables redirecting `git -C <repoRoot>`
 *  - a `.git` entry in any ancestor (a checkout git does not list at all)
 *  - a directory moved into a checkout after the post-create check (pre-write re-check)
 *
 * The module is imported as a namespace so the realIo/runCli tests here still
 * run (and fail on their assertions, not on an import) against a head that
 * predates parseWorktreeListPorcelainZ / gitEnv.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as cli from "../set-system-admin-claim";
import type { CliIo } from "../set-system-admin-claim";

const PROJECT = "cp-rehearsal-1";
const BASE_ARGV = [`--confirm-project=${PROJECT}`, "--credentials=/keys/sa.json", "--target-uid=TargetUid0000000000000000001", "--operation=grant"];

/** process.env without any GIT_* variable (the test's own git must not be redirected either). */
const hostEnvNoGit = (): NodeJS.ProcessEnv => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^GIT_/i.test(k)) delete e[k];
  return e;
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", env: { ...hostEnvNoGit(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } },
  );

/** Runs `fn` with extra process.env entries, restoring the exact previous values afterwards. */
function withEnv<T>(extra: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(extra)) saved.set(k, process.env[k]);
  Object.assign(process.env, extra);
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let base: string;
let repo: string;
let play: string;
beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sac-wt-")));
  repo = path.join(base, "repo");
  play = path.join(base, "play");
  fs.mkdirSync(repo);
  fs.mkdirSync(play);
  g(repo, "init", "-q");
  fs.mkdirSync(path.join(repo, "scripts", "admin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "scripts", "admin", "tool.ts"), "export {};\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "repo initial");
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const filesUnder = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((ent) => {
    const full = path.join(d, ent.name);
    return ent.isDirectory() ? (ent.name === ".git" ? [] : filesUnder(full)) : ent.name === ".git" ? [] : [full];
  });

/** The real CLI with the real io (real git enumeration, real fs); only output, clock and identity of the run are stubbed. */
async function runReal(resultFile: string, over: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let factoryCalls = 0;
  const io: CliIo = {
    ...cli.realIo(repo),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    nowMs: () => Date.parse("2026-11-05T10:00:00Z"),
    randomPart: () => "wt",
    ...over,
  };
  const code = await cli.runCli({
    argv: [...BASE_ARGV, `--result-file=${resultFile}`],
    env: { NODE_ENV: "development" },
    repoRoot: repo,
    io,
    firebase: () => {
      factoryCalls++;
      throw new Error("never reached: /keys/sa.json does not exist on disk");
    },
  });
  return { code, out, err: err.join("\n"), factoryCalls };
}

describe("A: a linked worktree moved with `mv` cannot receive the result file", () => {
  beforeEach(() => {
    g(repo, "worktree", "add", "-q", "--detach", path.join(play, "wt-tomove"), "HEAD");
    fs.renameSync(path.join(play, "wt-tomove"), path.join(play, "wt-moved"));
  });

  it("precondition: git still lists the OLD path and marks it prunable", () => {
    const listed = g(repo, "worktree", "list", "--porcelain");
    expect(listed).toContain(`worktree ${path.join(play, "wt-tomove")}\n`);
    expect(listed).toContain("prunable");
    expect(fs.existsSync(path.join(play, "wt-moved", ".git"))).toBe(true);
  });

  it("end to end (real git, real fs): --result-file inside the moved worktree => exit 2, refused, NOTHING created there, no credential read", async () => {
    const moved = path.join(play, "wt-moved");
    for (const target of [path.join(moved, "x.json"), path.join(moved, "scripts", "admin", "x.json")]) {
      const r = await runReal(target);
      expect({ target, code: r.code, refused: /\[result_path_(invalid|inside_repo)\]/.test(r.err), factory: r.factoryCalls }).toEqual({ target, code: 2, refused: true, factory: 0 });
    }
    expect(filesUnder(moved)).toEqual([path.join(moved, "scripts", "admin", "tool.ts")]);
  });

  it("enumeration layer: realIo.gitWorktreeRoots refuses (null) while a worktree is prunable", () => {
    expect(cli.realIo(repo).gitWorktreeRoots()).toBeNull();
  });

  it("CONTROL: after `git worktree repair <new path>` the list is unambiguous and contains the moved worktree", () => {
    g(path.join(play, "wt-moved"), "worktree", "repair");
    expect(cli.realIo(repo).gitWorktreeRoots()).toEqual([repo, path.join(play, "wt-moved")]);
  });

  it("D: even an outside path is refused while the worktree state is ambiguous, and the message says repair/prune", async () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    const r = await runReal(path.join(outside, "ok.json"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("[result_path_invalid]");
    expect(r.err).toMatch(/git worktree repair/);
    expect(r.err).toMatch(/git worktree prune/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("CONTROL: once pruned/repaired, the same outside path is accepted and written", async () => {
    g(path.join(play, "wt-moved"), "worktree", "repair");
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    const r = await runReal(path.join(outside, "ok.json"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("[credentials_file_unreadable]");
    expect(JSON.parse(fs.readFileSync(path.join(outside, "ok.json"), "utf8"))).toMatchObject({ status: "refused" });
  });
});

describe("checkout layer: a `.git` entry in any ancestor (no enumeration needed)", () => {
  it("a SEPARATE clone (not a worktree of this repo, so never listed) => result_path_inside_repo, nothing created", async () => {
    const clone = path.join(base, "clone");
    g(base, "clone", "-q", repo, clone);
    const target = path.join(clone, "scripts", "admin", "x.json");
    const r = await runReal(target);
    expect(r.code).toBe(2);
    expect(r.err).toContain("[result_path_inside_repo]");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("the moved worktree is refused by the `.git` layer alone (enumeration stubbed to the repaired, correct list WITHOUT it)", async () => {
    g(repo, "worktree", "add", "-q", "--detach", path.join(play, "wt-tomove"), "HEAD");
    fs.renameSync(path.join(play, "wt-tomove"), path.join(play, "wt-moved"));
    const target = path.join(play, "wt-moved", "x.json");
    const r = await runReal(target, { gitWorktreeRoots: () => [repo] });
    expect(r.code).toBe(2);
    expect(r.err).toContain("[result_path_inside_repo]");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("a `.git` appearing in an ancestor between validation and the create => refused by the post-create walk, own file removed", async () => {
    const outside = path.join(base, "outside");
    const sub = path.join(outside, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const target = path.join(sub, "r.json");
    const real = cli.realIo(repo);
    const r = await runReal(target, {
      // The location check's last io call is lstatKind(target): this runs between validation and create.
      lstatKind: (p) => {
        const k = real.lstatKind(p);
        if (p === target) fs.mkdirSync(path.join(outside, ".git"));
        return k;
      },
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("[result_path_invalid]");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("CONTROL: no `.git` anywhere above => accepted and written", async () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    const r = await runReal(path.join(outside, "ok.json"));
    expect(r.err).toContain("[credentials_file_unreadable]");
    expect(fs.existsSync(path.join(outside, "ok.json"))).toBe(true);
  });
});

describe("NIT: the directory moved INTO a checkout after the post-create check => the report is NOT written there", () => {
  it.each([
    ["moved into a directory with a .git entry", "checkout-dir"],
    ["moved into the repository itself", "repo"],
  ])("%s: write refused (RESULT FILE NOT WRITTEN), the file left behind is empty", async (_l, where) => {
    const outside = path.join(base, "outside");
    const sub = path.join(outside, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const dest = where === "repo" ? repo : path.join(base, "checkout");
    if (where !== "repo") {
      fs.mkdirSync(dest);
      fs.mkdirSync(path.join(dest, ".git"));
    }
    const target = path.join(sub, "r.json");
    const real = cli.realIo(repo);
    let moved = false;
    const r = await runReal(target, {
      // readSecretFile runs after createResultFile and before the final write.
      readSecretFile: (p) => {
        if (!moved) {
          moved = true;
          fs.renameSync(sub, path.join(dest, "sub"));
        }
        return real.readSecretFile(p);
      },
    });
    expect(moved).toBe(true);
    expect(r.code).toBe(2);
    expect(r.err).toContain("RESULT FILE NOT WRITTEN");
    expect(fs.readFileSync(path.join(dest, "sub", "r.json"), "utf8")).toBe("");
  });

  it("CONTROL: the same run with no move writes the report", async () => {
    const sub = path.join(base, "outside", "sub");
    fs.mkdirSync(sub, { recursive: true });
    const target = path.join(sub, "r.json");
    const real = cli.realIo(repo);
    const r = await runReal(target, { readSecretFile: (p) => real.readSecretFile(p) });
    expect(r.err).not.toContain("RESULT FILE NOT WRITTEN");
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toMatchObject({ status: "refused" });
  });
});

describe("B: NUL-delimited enumeration (`--porcelain -z`)", () => {
  const NL_OK = process.platform !== "win32";
  it("a linked worktree whose path contains a NEWLINE is listed exactly", () => {
    if (!NL_OK) return;
    const nl = path.join(play, "wt\nnl");
    g(repo, "worktree", "add", "-q", "--detach", nl, "HEAD");
    expect(cli.realIo(repo).gitWorktreeRoots()).toEqual([repo, nl]);
  });
  it("end to end: the result file inside that newline worktree is refused, nothing created", async () => {
    if (!NL_OK) return;
    const nl = path.join(play, "wt\nnl");
    g(repo, "worktree", "add", "-q", "--detach", nl, "HEAD");
    const target = path.join(nl, "x.json");
    const r = await runReal(target);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/\[result_path_inside_repo\]/);
    expect(fs.existsSync(target)).toBe(false);
  });

  const WT = "worktree /r\0HEAD 0123456789abcdef0123456789abcdef01234567\0branch refs/heads/main\0\0";
  it("parser: the documented record shapes are accepted (detached, locked with a multi-line reason, bare)", () => {
    const out = `${WT}worktree /r/wt\nnl\0HEAD 0123\0detached\0locked a\nb\0\0worktree /bare.git\0bare\0\0worktree /r/wt2\0HEAD 1\0detached\0locked\0\0`;
    expect(cli.parseWorktreeListPorcelainZ(out)).toEqual(["/r", "/r/wt\nnl", "/bare.git", "/r/wt2"]);
  });
  it.each<[string, string]>([
    ["empty output", ""],
    ["no record terminator", WT.slice(0, -1)],
    ["no NUL at all (newline output)", WT.replace(/\0/g, "\n")],
    ["a prunable worktree", `${WT}worktree /r/wt\0HEAD 1\0detached\0prunable gitdir file points to non-existent location\0\0`],
    ["bare prunable flag", `${WT}worktree /r/wt\0HEAD 1\0prunable\0\0`],
    ["an unknown attribute", `${WT}worktree /r/wt\0HEAD 1\0future thing\0\0`],
    ["a repeated attribute", `${WT}worktree /r/wt\0HEAD 1\0HEAD 2\0\0`],
    ["two worktree lines in one record", `worktree /r\0worktree /s\0\0`],
    ["a record not starting with worktree", `HEAD 1\0worktree /r\0\0`],
    ["a relative worktree path", `worktree r\0HEAD 1\0\0`],
    ["an empty worktree path", `worktree \0HEAD 1\0\0`],
    ["an empty record", `\0\0${WT}`],
    ["HEAD without a value", `worktree /r\0HEAD\0\0`],
    ["detached with a value", `worktree /r\0detached yes\0\0`],
    ["trailing garbage after the last record", `${WT}x`],
  ])("parser refuses (null, never a partial list): %s", (_l, out) => {
    expect(cli.parseWorktreeListPorcelainZ(out)).toBeNull();
  });
});

describe("C: every git invocation runs with a sanitized environment", () => {
  let foreign: string;
  beforeEach(() => {
    foreign = path.join(base, "foreign");
    fs.mkdirSync(foreign);
    g(foreign, "init", "-q");
    g(foreign, "commit", "-q", "--allow-empty", "-m", "foreign initial");
    g(foreign, "worktree", "add", "-q", "--detach", path.join(base, "foreign-wt"), "HEAD");
  });
  const repoSha = () => g(repo, "rev-parse", "HEAD").trim();

  it.each<[string, () => Record<string, string>]>([
    ["GIT_DIR", () => ({ GIT_DIR: path.join(foreign, ".git") })],
    ["GIT_DIR + GIT_WORK_TREE", () => ({ GIT_DIR: path.join(foreign, ".git"), GIT_WORK_TREE: foreign })],
    ["GIT_COMMON_DIR", () => ({ GIT_COMMON_DIR: path.join(foreign, ".git") })],
  ])("%s pointing at another repository does not redirect worktree enumeration or the recorded commit", (_l, extra) => {
    const clean = cli.realIo(repo).gitWorktreeRoots();
    expect(clean).toEqual([repo]);
    const redirected = withEnv(extra(), () => ({ roots: cli.realIo(repo).gitWorktreeRoots(), git: cli.realIo(repo).git() }));
    expect(redirected).toEqual({ roots: [repo], git: { sha: repoSha(), dirty: false } });
  });

  it("GIT_INDEX_FILE pointing at an empty index does not make a clean tree 'dirty'", () => {
    const empty = path.join(base, "empty-index");
    const io = withEnv({ GIT_INDEX_FILE: empty }, () => cli.realIo(repo).git());
    expect(io).toEqual({ sha: repoSha(), dirty: false });
  });

  it("GIT_CONFIG_COUNT/KEY/VALUE cannot hide an untracked file in scripts/admin from the dirty flag", () => {
    fs.writeFileSync(path.join(repo, "scripts", "admin", "planted.ts"), "export {};\n");
    const io = withEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "status.showUntrackedFiles", GIT_CONFIG_VALUE_0: "no" }, () => cli.realIo(repo).git());
    expect(io).toEqual({ sha: repoSha(), dirty: true });
  });

  it("end to end under GIT_DIR redirection: a result file inside this repo's linked worktree is still refused", async () => {
    const wt = path.join(play, "wt");
    g(repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
    const target = path.join(wt, "x.json");
    const r = await withEnv({ GIT_DIR: path.join(foreign, ".git") }, () => runReal(target));
    expect(r.code).toBe(2);
    expect(r.err).toContain("[result_path_inside_repo]");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("gitEnv: drops EVERY GIT_* variable (any case), keeps the rest, disables system/global config and optional locks, never mutates its input", () => {
    const host = {
      PATH: "/usr/bin",
      HOME: "/home/op",
      GIT_DIR: "/x",
      GIT_COMMON_DIR: "/x",
      GIT_WORK_TREE: "/x",
      GIT_INDEX_FILE: "/x",
      GIT_CEILING_DIRECTORIES: "/x",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "k",
      GIT_CONFIG_VALUE_0: "v",
      GIT_CONFIG_PARAMETERS: "'a.b'='c'",
      GIT_CONFIG_GLOBAL: "/evil",
      GIT_CONFIG_SYSTEM: "/evil",
      GIT_OBJECT_DIRECTORY: "/x",
      git_dir: "/x",
      UNSET: undefined,
    };
    const before = JSON.stringify(host);
    const env = cli.gitEnv(host);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/op", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_OPTIONAL_LOCKS: "0" });
    expect(JSON.stringify(host)).toBe(before);
  });
});

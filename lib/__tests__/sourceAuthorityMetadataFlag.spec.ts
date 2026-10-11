/**
 * Order 4 Slice 2a — the REAL `lib/env.ts` binding for SOURCE_AUTHORITY_METADATA_ENABLED.
 * Each case loads env.ts in an isolated module registry with the variable set
 * (or deleted) and restores process.env afterwards, so no other test sees it.
 * Contract: enabled only for the literal string "true"; absent → OFF.
 */
const KEY = "SOURCE_AUTHORITY_METADATA_ENABLED";

function loadFlag(value: string | undefined): unknown {
  const prior = Object.prototype.hasOwnProperty.call(process.env, KEY) ? process.env[KEY] : undefined;
  const hadPrior = Object.prototype.hasOwnProperty.call(process.env, KEY);
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    let flag: unknown;
    jest.isolateModules(() => {
      flag = (jest.requireActual("@/lib/env") as Record<string, unknown>)[KEY];
    });
    return flag;
  } finally {
    if (hadPrior) process.env[KEY] = prior;
    else delete process.env[KEY];
    warn.mockRestore();
    error.mockRestore();
  }
}

it("ABSENT → false (the default is OFF)", () => {
  expect(loadFlag(undefined)).toBe(false);
});

it.each([["false"], ["1"], ["TRUE"], ["True"], ["yes"], [" true"], [""]])("%p → false (only the literal \"true\" enables it)", (value) => {
  expect(loadFlag(value)).toBe(false);
});

it('"true" → true (positive control)', () => {
  expect(loadFlag("true")).toBe(true);
});

it("process.env is restored after every load", () => {
  const before = Object.prototype.hasOwnProperty.call(process.env, KEY) ? process.env[KEY] : "<absent>";
  loadFlag("true");
  loadFlag(undefined);
  expect(Object.prototype.hasOwnProperty.call(process.env, KEY) ? process.env[KEY] : "<absent>").toBe(before);
});

it("is independent of the publisher-class flag (one never enables the other)", () => {
  const prior = process.env.SOURCE_PUBLISHER_CLASS_ENABLED;
  process.env.SOURCE_PUBLISHER_CLASS_ENABLED = "true";
  try {
    expect(loadFlag(undefined)).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.SOURCE_PUBLISHER_CLASS_ENABLED;
    else process.env.SOURCE_PUBLISHER_CLASS_ENABLED = prior;
  }
});

it("is server-only: no NEXT_PUBLIC_ twin exists and no client/component file reads it", () => {
  const { readFileSync, readdirSync, statSync } = jest.requireActual("fs") as typeof import("fs");
  const { join, relative } = jest.requireActual("path") as typeof import("path");
  const root = join(__dirname, "..", "..");
  expect(readFileSync(join(root, "lib/env.ts"), "utf8")).not.toContain("NEXT_PUBLIC_SOURCE_AUTHORITY_METADATA");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", "__tests__"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, "utf8").includes(KEY)) offenders.push(relative(root, p));
    }
  };
  for (const top of ["components", "hooks", "lib/client"]) walk(join(root, top));
  expect(offenders).toEqual([]);
});

/**
 * Order 6 S-1b.1 — the REAL `lib/env.ts` binding for DS_PROVENANCE_ROUTE_VIEW_ENABLED
 * (the route acceptance suite mocks `@/lib/env`). Each case loads env.ts in an
 * isolated module registry with the variable set (or deleted) and restores
 * process.env afterwards. Contract: enabled only for the literal string "true";
 * absent → OFF.
 */
const KEY = "DS_PROVENANCE_ROUTE_VIEW_ENABLED";

function loadFlag(value: string | undefined): unknown {
  const hadPrior = Object.prototype.hasOwnProperty.call(process.env, KEY);
  const prior = process.env[KEY];
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

it.each([["false"], ["1"], ["TRUE"], ["True"], ["yes"], [" true"], ["true "], [""]])("%p → false (only the literal \"true\" enables it)", (value) => {
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

it("is a server-only flag (no NEXT_PUBLIC variant is exported)", () => {
  let env: Record<string, unknown> = {};
  jest.isolateModules(() => {
    env = jest.requireActual("@/lib/env") as Record<string, unknown>;
  });
  expect(Object.keys(env).filter((k) => /DS_PROVENANCE/.test(k))).toEqual([KEY]);
});

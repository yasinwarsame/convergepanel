/**
 * Order 4 — Z: the REAL `lib/env.ts` binding for SOURCE_PUBLISHER_CLASS_ENABLED.
 * Each case loads env.ts in an isolated module registry with the variable set
 * (or deleted) and restores process.env afterwards, so no other test sees it.
 * Contract: enabled only for the literal string "true"; absent → OFF.
 */
const KEY = "SOURCE_PUBLISHER_CLASS_ENABLED";

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

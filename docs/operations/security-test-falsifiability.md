# Security-test falsifiability — a standing rule

Seven review rounds on the administrator-authority workstream found the same
defect class every time: **an assertion that reads as a security proof but cannot
fail.** The shipped code was correct in every instance. What failed was the
evidence — and each round the fix introduced a new variant of the same mistake.

The shapes found so far, in the order they were found:

| Shape | Example | Why it cannot fail |
|---|---|---|
| Nullish masking | `expect(v.visibleUserIds ?? undefined).not.toBeNull()` | `??` fires on `null`, so the value meaning "filter removed" becomes `undefined` first |
| Label instead of data | `expect(queueScope).not.toBe("admin_global")` | the label is decoration; `visibleUserIds: null` under another label is the actual breach |
| Wrong response key | `expect(body.items ?? []).toEqual([])` | the route emits `runs`; `items` never exists |
| Positive satisfied by a 4xx | `expect(res.status).not.toBe(401)` on a 400 | a malformed fixture 400s before the guarded work, proving nothing |
| Denial with no positive control | `expect(fn).not.toHaveBeenCalled()` | nothing calls `fn` on any path, so absence is guaranteed |
| Assertion on a self-composed string | building the log line in the test | the real call site is never inspected |
| All-negative with no anchor | `expect(raw).not.toContain("ev-theirs")` | the fixture may no longer contain `ev-theirs` at all |
| `some` where all are required | `expect(effects().some(...)).toBe(true)` | skipping one required effect still passes |
| Stub hiding the subject | `jest.mock(Component, () => () => null)` | the gate under test is not rendered |

## The rule

For every security assertion, answer these before claiming the test is evidence:

1. **What positive fixture proves the protected data or effect exists?** If the
   response is empty for every identity, an exclusion assertion proves nothing.
2. **What mutation would violate this assertion?**
3. **Does that mutation actually make the test fail?** Run it. A test not
   observed failing is not known to work.
4. **Is the request reaching the guard being tested,** or is an earlier
   validation error producing the denial?
5. **Is the asserted response property real?** Grep the route for the key.
6. **Does the test data survive every production filter** — recency, status,
   type, integrity — or is it filtered out before authorization matters?

## Self-validation, specifically

- For "OWNER_B is absent": the same suite must first show OWNER_B **is** in the
  source dataset and would appear without the filter.
- For "effect X not called": the same suite must show X **is** called in the
  matching authorized positive case.
- For "control hidden": the same test family must show it **renders** for the
  tier that should see it.

`scripts/security-test-preflight.mjs` mechanically flags the shapes above across
specs changed on the branch. It is a lint, not a proof — it catches known
variants, not the next one. Steps 1–6 are the part that does the work.

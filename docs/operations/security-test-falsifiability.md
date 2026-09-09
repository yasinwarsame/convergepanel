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

### What the pre-flight actually covers

`scripts/security-test-preflight.mjs` runs in the required Quality Gate over
**every tracked spec** (`--all`; the changed-files mode is for local use and
cannot resolve `origin/main` on a CI runner).

It does **not** flag "the shapes above". That claim was wrong when it was
written and the C7-R4 review called it out: the table above lists nine shapes,
and the scanner implements seven detectors, only some of which correspond to
table rows. Exactly what is mechanical, and what is not:

| Shape from the table | Detector? |
|---|---|
| `??`-masking before a null assertion | ✅ `nullish-mask` |
| wrong response key (`|| []` over an absent key) | ✅ `default-mask` |
| `some` where all are required | ✅ `some-effects` |
| label instead of data | ❌ human review only |
| positive satisfied by a 4xx | ❌ human review only |
| denial with no positive control | ❌ human review only |
| assertion on a self-composed string | ❌ human review only |
| all-negative with no anchor | ❌ human review only |
| stub hiding the subject | ❌ human review only |

Plus four detectors with no row above: `truthy-authority`, `empty-body`,
`multiline-empty-body` and `skipped-test`. Three mapped + four unmapped = the
seven detectors the scanner registers.

**Six of the nine documented shapes have no detector at all.** A green gate says
nothing about them. That matters because the single most damaging defect found
in this workstream — C7 proving log redaction while stubbing out the module that
did the leaking — is "stub hiding the subject", an unmechanised row.

Known blind spots even within the implemented detectors, all confirmed by
review rather than assumed: matching is line-based and literal, so
`|| []`/`?? []` closed with `toHaveLength(0)` instead of `toEqual([])`, an
`expect(...)` wrapped across lines, `.some(` written on anything but a literal
`effects()`, and an authority assertion whose subject does not contain
`admin`/`authority`/`scope`/`visible` all pass unflagged. The multi-line empty
body IS now detected; deeper structural variants are not.

It is a lint, not a proof — it catches known variants, not the next one, and a
deliberately vacuous test is easy to write past it. Steps 1–6 are the part that
does the work.

### What `--self-test` does and does not guarantee

`--self-test` runs first in CI, and
`scripts/__fixtures__/known-vacuous-shapes.txt` declares the required detector
ids independently of the implementation. Stated precisely — an earlier version
of this paragraph claimed an absolute that a review falsified in one
experiment:

- **Breaking a detector is caught.** If a registered detector stops firing on
  its own recorded defect, the liveness check fails.
- **One-sided detector removal is caught.** Delete a detector while its
  `EXPECT-SHAPE` tag remains and the fixture declares an id with no
  implementation — failure. (`--all` still reports clean in that state, which is
  exactly why the self-test exists.)
- **One-sided fixture removal is caught.** Delete a tag while the detector
  remains and a detector has no coverage — failure.
- **A coordinated edit to BOTH files is NOT mechanically prevented.** Removing a
  detector *and* its fixture tag in the same change passes green. That is a
  two-file edit visible in review, not an impossibility, and it is not claimed
  to be one. Adding a third source to chase an absolute would just move the
  same problem.

The scanner's CLI contract — a violation exits nonzero, a clean scan exits
zero, and a scan that examined zero files fails rather than reporting clean —
is pinned by `scripts/__tests__/securityPreflightWiring.spec.ts`. Before that,
changing the final line to `process.exit(0)` left CI printing "1 flagged
construct(s)" and passing.

### Named residuals in the governance log-redaction suite

These are holes, recorded so they stop being invisible. None is a live leak
today; each is a way a future regression passes review the way the last two did.

- **`logger.redact()` hashes rather than removes.** `lib/logger.ts` replaces
  values under the keys `uid`, `userId` and `firebaseUid` with
  `uid:<8 hex of a truncated 32-bit non-cryptographic hash>`. A leak routed
  through `logger.warn(msg, { uid })` therefore never appears as the raw canary
  and is invisible to the redaction assertions. Worse, the hash is stable, so it
  is itself a per-user correlation identifier — the exact harm cited as the
  reason for stripping the caller uid from the queue diagnostic. **Hashing is
  not redaction, and the suite does not cover it.**
- **Uncaptured sinks.** The capture patches `console.log/warn/error/debug/info`.
  `console.dir`, `console.trace`, `console.table` and direct
  `process.stdout.write` bypass it. A structural test asserts the governance
  modules do not use them, which keeps the claim and the reality together — but
  it is a source check, not interception.
- **Substring and encoding forms.** Assertions use exact substring matching, so
  a truncated identifier (`uid.slice(0, -2)`) or a base64-encoded one passes.
- **Mocked modules on the request path.** `runWorkspaceIntegrity` is stubbed and
  the real function receives the whole run document; a log added inside it would
  not be observed. The audit writer was un-stubbed in C8 for exactly this
  reason; this one remains.

### Residuals added in C13 (named, not claimed covered)

- **Deferred logging is outside automatic capture.** The governance redaction
  hook asserts after the tested route's promise resolves. A log emitted from a
  `setTimeout`, `setImmediate`, or a floating promise fires later and is not
  inspected — verified by mutation, and verified that an *awaited* macrotask at
  the same position IS caught, so this is a timing boundary rather than an
  unreachable branch. The current governance path defers nothing: `route.ts`
  awaits `writeAuditEvent`, `auditLog.ts` awaits its write, and there is no
  `void`, detached `.catch`, timer or microtask anywhere on it. Automatic
  capture covers logging completed before the route promise resolves; deferred
  or floating logging is review debt and is **not** claimed covered.
- **Aliased and computed sinks.** The structural test that asserts governance
  modules use no uncaptured sink is a literal-substring source scan. It sees
  `console.dir`; it does not see `const out = process.stdout; out.write(...)`
  or `console["di" + "r"]`. The claim is "no governance module contains these
  tokens", not "no uncaptured sink can exist".
- **Mint-detector limits.** Authority-minting is detected by two textual
  signatures (a `setCustomUserClaims` call with an admin-true claim object, in
  `admin: true`, `"admin": true` or shorthand form; or a bootstrap-route
  reference alongside a uid). Wrapper indirection, computed member access,
  concatenated route paths, and minting tools written outside `scripts/` or in
  a non-JS/TS language are **not** detected. Those are review responsibilities.
- **The probe's route marker is not attestation.** `x-convergepanel-admin-secret-probe`
  is world-readable in a public repository. Any server can emit it. What makes a
  containment proof meaningful is the bound two-phase transition at the
  canonical Production origin — accepted before the rotation, rejected after —
  not the header.

---

## Phase FIRST-ADMIN-C14 — evidence table

R10 falsified two C13 claims outright. Both are retired here, and each row below
names the mutation that must fail for the row to be worth anything.

| Property | Positive anchor | Negative assertion | Breaking mutation | Result |
|---|---|---|---|---|
| Production origin cannot be overridden | wrapper reaches `https://convergepanel.com/api/admin/set-admin` | requested URL never contains a foreign host, with the C13 env vars set | give `runProductionTwoPhase` an `origin` parameter | KILLED |
| The loopback seam is not a canonical seam | canonical origin still reachable with both flags on | foreign https origin refused `ERR_NOT_CANONICAL_PRODUCTION_ORIGIN`, 0 requests | canonical clause honours `allowInsecureLoopback` for every host | KILLED |
| Test seams are not production seams | tests drive `createContainmentProof` directly | shipped CLI source contains neither env var and never calls the low-level API | CLI restores env-driven origin | KILLED |
| Loopback predicate is exact | genuine loopback reachable | `localhost.`, `localhost.attacker.example`, `127.0.0.1.evil.test` refused | `===` → `.includes()` | KILLED |
| PRE precedes mint/rotate/deploy | every `BOOTSTRAP_*` step present once | step indices are strictly ordered | swap `BOOTSTRAP_PRECHECK` with `BOOTSTRAP_ROTATE_SECRET` | KILLED |
| Incident sequence starts the probe first | `CONTAINMENT_PROBE_OLD_SECRET` is step a | probe index < rotate index < deploy index | restore rotate-first ordering | KILLED |
| Sequence steps are all MUST | every row ends `\| MUST \|` | no `MAY`/`SHOULD`/`OPTIONAL` row | `BOOTSTRAP_PRECHECK` → MAY | KILLED |
| POST 429 remains armed | later rejection still proves | state stays `POST_PENDING`, never `ABORTED` | any non-rejected post-check aborts (the C13 behaviour) | KILLED |
| POST 5xx / transport / redirect remain armed | same | same | classify transport failure as `REJECTED` | KILLED |
| POST accepted is retryable, not proof | retry after propagation proves | outcome `NOT_YET_CONTAINED`, still armed | accepted POST destroys the armed state | KILLED |
| A 429 is never a verdict | rejection proves | 429 is neither `PROVEN` nor exit 2 | classify 429 as `REJECTED` | KILLED |
| Exact old secret reused across retries | proof succeeds on retry | env var replaced/deleted/blanked mid-proof, wire body unchanged | re-read secret at POST; re-read origin at POST | KILLED (both) — **corrected in C15; the C14 wording claimed this while the test never mutated `process.env`, so the secret half survived** |
| URL refusal issues zero requests | genuine loopback reachable | exact code + 0 fetch calls + 0 server hits + secret absent | remove plain-http / canonical / all guards | KILLED |
| `.doc()` throw is caught | ordinary identifiers still allowed | `allowed:false`, no partial write, no throw to caller | hoist `.doc()` outside `try` | KILLED |
| `mock.calls` rewrite cannot hide a leak | clean transcript passes | assertion throws with the R10 six-line attack applied | rewrite `mock.calls` inside the capture | KILLED |
| Object mutation after logging cannot hide a leak | clean transcript passes | assertion throws | store references instead of snapshots | KILLED |
| Spy implementation replacement is detected | integrity passes untouched | integrity throws after a swap | — (asserted directly) | n/a |
| Nested canary detection has no serialize seam | clean transcript passes | nested value, object key, Error `code`, array element all detected | drop recursive descent; equality instead of substring | KILLED |

### Residuals added in C14

- **The proof is memory-bound, by design.** If the process exits between a
  successful PRE and a successful POST, that PRE evidence is gone and the
  same-process proof cannot be completed. C14 makes *transient POST observations*
  survivable inside a live process; it does not add crash recovery, and it
  deliberately does not tell an operator to restore the old secret to rebuild a
  pre-check. That would re-open the hole the rotation just closed.
- **`--observe --non-production-target <origin>`** still contacts an arbitrary
  https host and sends the old secret there. It is a non-production diagnostic:
  it warns on every run, names the origin it contacted, and can never print
  `PRODUCTION_CONTAINMENT_PROVEN`. Production mode shares none of this path.
- **An equivalent mutant is documented, not hidden.** Relaxing
  `requireCanonical`/`allowInsecureLoopback` *inside* `runProductionTwoPhase`
  changes nothing observable, because the origin there is a constant —
  `resolveEndpoint` returns a byte-identical result either way. The regression it
  would enable (reintroducing an origin parameter) is caught by a separate
  mutation that does fail.
- **`redactionExemption` remains a test-controlled escape hatch.** A test that
  declares `capture-fidelity` skips the automatic canary scan. Capture-integrity
  is now asserted on every test regardless, but the content scan is still
  opt-outable by a test that edits itself.


---

## Phase FIRST-ADMIN-C15 — two evidence channels, and an honest boundary

R11 falsified C14 the way R10 falsified C13, and for the same underlying reason:
a single mutable test mechanism was declared authoritative. Three lines inside
the ingress function sanitised the arguments before they were recorded, and the
identity check could not see it because it stores the tampered function as its
own expected reference.

### What is claimed now — and what is not

**Claimed.** A real sensitive-log regression cannot be hidden by **one localized
edit** to either evidence channel: the other channel still detects the leak, or
the cross-channel comparison fails loudly.

**Not claimed.** That this harness is tamper-proof. It is not, and no
application-level test suite is. A coordinated edit that changes the production
leak, both channels, both deny-set walks, the fidelity comparison and the
lifecycle backstop together will make the suite lie. That is stated here rather
than defended against, because defending against it is not achievable and
pretending otherwise is what produced C12, C13 and C14.

### The two channels

| | Channel A — raw Jest ledger | Channel B — ingress snapshot |
|---|---|---|
| Source | `spy.mock.calls`, read at assertion time | deep-frozen copy taken inside the installed sink implementation |
| Holds | live references | structural snapshots |
| Blind to | post-log object mutation; later ledger rewriting | anything done *at* ingress |
| Immune to | edits inside our ingress function | later `mock.calls` rewriting/clearing |
| Walk | `ledgerContains` | `snapshotContains` (a separate implementation, deliberately not shared) |

Ordering is reconciled from Jest's own `mock.invocationCallOrder`, not from
channel B — channel A is never derived from channel B, nor the reverse, and
neither passes through a shared pre-filtered list.

### Single-local-edit attack matrix (measured)

| Local edit | Channel A | Channel B | Fidelity | Suite result |
|---|---|---|---|---|
| production leak only | detects | detects | agree | **16 failed** |
| leak + ingress sanitiser *(the R11 attack)* | detects | sanitised | diverges | **16 failed** |
| leak + `mock.calls` rewrite *(the R10 attack)* | sanitised | detects | diverges | **16 failed** |
| leak + `mock.calls` cleared | emptied | detects | diverges | **33 failed** |
| ingress drops a call (no leak) | detects call | missing | diverges | **17 failed** |
| ingress rewrites content (no leak) | original | rewritten | diverges | **17 failed** |
| ingress drops an argument (no leak) | original arity | short | diverges | **45 failed** |
| `mock.calls` rewrite (no leak) | rewritten | original | diverges | **16 failed** |
| spy implementation replaced | — | — | identity fails | **137 failed** |
| `finalize()` deleted from `afterEach` | — | — | — | **3 failed** (lifecycle backstop) |
| finalizer returns early | — | — | — | **13 failed** |
| cross-channel count check removed | — | — | — | **18 failed** |
| per-call canary fidelity check removed | — | — | — | **1 failed** |
| raw-ledger deny scan skipped | — | — | — | **16 failed** |
| snapshot deny scan skipped | — | — | — | **16 failed** |
| any single traversal leg removed (nested value, object key, `Error.details`, in either walk) | — | — | — | **1–8 failed** |

One measured **equivalent mutant**: an ingress sanitiser whose regex matches
nothing when no leak is present records byte-identical events, so nothing can
observe it. It is equivalent, not undetected — the variants above that *do*
change recorded events are all caught.

### Residuals added or corrected in C15

- **`lib/governance/auditLog.ts` is NOT branch-covered by this suite.** Five
  catch-block `console.error` sites log a plaintext `runId`, and every caller
  mocks the module, so those bodies never execute in these tests. The STRUCTURAL
  module list asserts only "this file contains no uncaptured sink token"; that
  narrowing is now stated in the suite and pinned by a test. This is named debt,
  not coverage.
- **`redactionExemption` remains a test-controlled opt-out** from the content
  scan. Spy identity is still checked for exempt tests, but a test can still
  exempt itself from the deny-set assertion.
- **The lifecycle backstop is structural.** It proves `finalize()` is registered
  in a live `afterEach`; it does not prove redaction ran. The runtime proof is
  the leak mutations above.
- **`--observe --non-production-target <origin>`** still sends the old secret to
  an arbitrary https host: explicit flag, warning on every run, names the origin,
  cannot print the proof token.
- **Process death still loses PRE.** C15 adds no crash recovery, and the runbook
  does not tell an operator to restore the old secret to rebuild a pre-check.
- Unchanged carried debt: deferred/aliased/computed logging sinks; mint-detector
  and scanner blind spots; `/api/admin/login` limiter coverage; the shared
  invitation budget.

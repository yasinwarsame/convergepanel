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
and the scanner implements the detectors enumerated below, only some of which
correspond to table rows. Exactly what is mechanical, and what is not:

| Shape from the table | Detector? |
|---|---|
| `??`-masking before a null assertion | ✅ `nullish-mask` |
| wrong response key (`|| []` over an absent key) | ✅ `default-mask` |
| `some` where all are required | ✅ `some-effects` |
| assertion on a self-composed string | ✅ `self-referential-source-assertion` |
| label instead of data | ❌ human review only |
| positive satisfied by a 4xx | ❌ human review only |
| denial with no positive control | ❌ human review only |
| all-negative with no anchor | ❌ human review only |
| stub hiding the subject | ❌ human review only |

### Registered detectors

Phase FIRST-ADMIN-C17 (R13): this document previously stated a detector count of
**seven** in prose while the scanner registered **eight**, and that eighth
detector appeared nowhere here at all. Counts in prose drift silently, so the contract is now **set equality
over stable IDs**, asserted by `scripts/__tests__/securityPreflightWiring.spec.ts`
against this table, the scanner's registrations, and the `--self-test` fixture.

| Detector ID | Vacuity class it detects | Scope / limits |
|---|---|---|
| `nullish-mask` | `??` masking a security value before a null/empty assertion | line-based, literal |
| `default-mask` | `\|\| []` turning an absent key into a passing empty assertion | line-based, literal |
| `truthy-authority` | truthiness on an authority value | subject must contain `admin`/`authority`/`scope`/`visible` |
| `some-effects` | `some()` where every listed effect is mandatory | literal `effects()` only |
| `empty-body` | single-line empty test body | — |
| `multiline-empty-body` | empty test body across lines | two-line lookahead, not a parser |
| `skipped-test` | `it.skip` / `todo` / `xit` / `xdescribe` | — |
| `self-referential-source-assertion` | reading the test's OWN source and asserting a literal over it, so the expected text is present because the assertion contains it | two-line lookahead; **does not** catch the assertion placed 3+ lines below the read, an aliased `const f = __filename`, or the `expect(src.includes("…")).toBe(true)` form — all three demonstrated by review |

**Five of the nine documented shapes have no detector at all.** A green gate says
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

### Single-local-edit attack matrix

Outcome is the contract; failure counts are not. C15 published exact counts and
R12 could not reproduce five of them — they depend on which unrelated anchors a
given mutation happens to disturb, so they are diagnostics, not properties.

| Single local edit (real production leak present unless noted) | Outcome |
|---|---|
| ingress sanitiser *(the R11 attack)* | FAIL |
| raw `mock.calls` rewrite *(the R10 attack)* | FAIL |
| raw `mock.calls` cleared | FAIL |
| ingress drops a call / rewrites content / drops an argument (no leak) | FAIL |
| `mock.calls` rewrite (no leak) | FAIL |
| spy implementation replaced | FAIL |
| **sink removed from Channel A only** | FAIL |
| **sink removed from Channel B only** | FAIL |
| **sink removed from BOTH channels** | FAIL (declared-contract parity) |
| **sink removed from the declared contract only** | FAIL |
| **`logger.debug` retargeted to an uncaptured sink** | FAIL (source-derived contract) |
| `finalize()` deleted from `afterEach` / returns early | FAIL |
| cross-channel fidelity removed | FAIL |
| either channel's deny scan skipped | FAIL |
| any single traversal leg removed, in either walk | FAIL |
| a sensitive canary deleted | FAIL |

One narrowly **equivalent mutant**: an ingress sanitiser whose predicate matches
no log event actually emitted by the covered paths records byte-identical events
for that baseline, so nothing can observe it. C15 generalised this to "an
ingress sanitiser is equivalent", which is wrong — R12 measured a *realistic*
sanitiser (one whose predicate matches a real event) failing with no leak
present. Only the never-matching form is equivalent, and that is a tautology
rather than a result.

### Residuals added or corrected in C15

- **`lib/governance/auditLog.ts` — corrected in C16.** C15 stated that no test
  reaches its raw-`runId` error sites and that every caller mocks the module.
  **Both were false.** Measured with a throw-probe: four of the five sites
  execute (`writeAdaptiveAdminAuditEvent`, `…Assignment…`, `…PanelFinalization…`,
  `…PanelOverride…`), driven by four lib-level specs that import the REAL module;
  only `writeAdaptiveExportAdminAuditEvent` is undriven. It is the route-level
  callers that mock it. Those four sites are **executed but not
  redaction-asserted** — partial coverage, carried as debt. The disposition is
  now enumerated from source and asserted, replacing a C15 "pin" whose regex
  matched its own source line and therefore could never fail.
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

---

## Phase FIRST-ADMIN-C16 — the sink set, and residuals C15 got wrong

R12 found the remaining single point of failure sitting **upstream** of the two
evidence channels: both consumed one `CONSOLE_METHODS` array, so deleting one
token installed no spy at all and a real `ownerUid` leak ran green.

There are now three independently-derived sink concepts — `CHANNEL_A_SINKS`,
`CHANNEL_B_SINKS`, and a set computed by **reading shipped source at test time**
(`productionSinks()`, over `lib/logger.ts` and the covered governance modules).
Spies are installed for the union, so removing a sink from one channel does not
stop the other from seeing it — it makes them disagree. Editing both channels
still fails the declared-contract assertion; retargeting `logger.debug` to an
uncaptured sink still fails the source-derived assertion.

Source fact worth recording: `logger.info` maps to `console.log`, **not**
`console.info`, and no covered module calls `console.info` today. It is captured
defensively, and the declared set is asserted to be exactly the source set plus
that one documented extra.

### Residuals added or corrected in C16

- **No in-suite end-to-end PTY test proves the real CLI path.** C15 claimed this
  was documented debt; it was not recorded anywhere. Stating it now: every
  in-suite `--production-two-phase` test asserts only the non-TTY refusal, and
  the CLI→wrapper→canonical-URL chain is closed **structurally** (no namespace
  imports, no origin env reads) rather than behaviourally. Independent reviews
  have exercised the real executable under a PTY with locally intercepted
  transport and observed only the canonical URL; CI does not.
- **The child-process-heavy suites are load sensitive.** `probeAdminSecret.spec.ts`
  spawns dozens of node processes and binds real sockets against Jest's default
  timeout. Under heavy parallel load (three concurrent reviewers) an independent
  review saw 1–4 failures in 2 of 5 full runs that did not reproduce unloaded.
  Exact-head CI is green and isolated reruns are authoritative for mutation
  claims. This is P3 test-infrastructure debt — it does **not** license
  dismissing a reproducible failure as flake.
- **Prose rewording is not mechanically understood.** The operator-instruction
  guard prohibits a small set of *claim shapes* across every discovered site; it
  does not claim to detect arbitrary rewordings. The normative, machine-checkable
  obligations are the structured `BOOTSTRAP_*` sequence order and the
  `BOOTSTRAP_POST_RATE_LIMITED | MUST_PRESERVE_PROCESS` row, both asserted.
- **The operator-site list is discovered, not declared.** Any tracked non-test
  file mentioning an operator token must be classified in the manifest; an
  unclassified discovery fails, which is what stops a future `CLAUDE.md`-shaped
  file from escaping.

### Residuals carried from R13 (Phase FIRST-ADMIN-C17)

None of these is closed; each is named so a reader does not infer coverage.

- **The self-referential detector has three known evasions**, all demonstrated by
  review and listed in the detector table above: the assertion placed 3+ lines
  below the `readFileSync(__filename)`, an aliased `const f = __filename`, and
  the `expect(src.includes("…")).toBe(true)` form. It is a two-line lookahead,
  not a parser, and is not being turned into one.
- **The stale-instruction guard is a finite shape set.** It rejects the shapes
  listed in `bootstrapProbeInvariant.spec.ts`, each self-validated to fire. A
  paraphrase naming neither `401` nor the proof token is not detected. The
  normative obligations remain the ordered `BOOTSTRAP_*` sequence and the
  `BOOTSTRAP_POST_RATE_LIMITED | MUST_PRESERVE_PROCESS` row.
- **`EXECUTED` / `UNDRIVEN` in the auditLog disposition table are declared**, not
  continuously enforced. The *site list* is source-derived and falsifiable; the
  execution column was established by throw-probe at C16 and re-measured
  independently at R13, but nothing re-measures it on every run.
- **`ALL_INSTALLED_SINKS` leaves a two-assertion margin.** Removing a sink from
  it stays red, but via only the spy-installation check and the verbatim-recovery
  anchor rather than the content channels.
- **`productionSinks()` matches a commented-out `console.x(` token**, producing a
  false alarm. Over-inclusive, never under-inclusive — it cannot hide a leak.
- **Sink discovery is textual**, so `console["trace"](…)` is invisible to it.
- **`README.md` restates the observation semantics** rather than deferring to the
  runbook; currently consistent, but duplicated and able to drift.
- **`§B.6` has no literal heading** in the runbook; `README.md` and the route
  docstring point at it as a section name.
- **The raw-ledger deny scan can be removed from `finalize()`** with no test
  noticing when no leak is present. With a leak the other channel still fires.

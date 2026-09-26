/**
 * TEAM_EXPORT_E2_A — `GET /api/workspaces/{workspaceId}/runs/{runId}/exports`:
 * the authorized Team Research export HISTORY list. Metadata only. No
 * rendering, no streaming, no regeneration, no creation, no writes, and the
 * frozen `reportSnapshot` never leaves the server through this route.
 *
 * Workspace sibling of `GET /api/user/runs/[runId]/exports`, which stays
 * owner-only and is untouched by this PR.
 *
 * DELIBERATE, DECLARED DIVERGENCES FROM PERSONAL. This route argues below that
 * fixing a shared behaviour on one surface only trades a shared inconsistency for
 * a divergence between two surfaces clients expect to match — so where it does
 * exactly that, it says so here rather than leaving it to be discovered:
 *   1. `SHARED_EXPORT_HISTORY_MISSING_NEXT_CURSOR_HARDENING` — E2A-S15 below.
 *      Personal derives `nextCursor` without a finiteness guard (it does have a
 *      length guard), so it could emit `hasMore: true` with no usable cursor.
 *      Like divergence 2, this is HARDENING rather than a fix for a live bug:
 *      the real helper cannot currently produce the trigger, because
 *      `orderBy("reportVersion")` excludes documents lacking the field,
 *      `hasMore` implies a non-empty page, and `reportVersion` is only ever
 *      `counter + 1` from a `FieldValue.increment`-only counter. E2-A still
 *      refuses to ship a response shape that can trap a paging client, so it is
 *      hardened HERE ONLY and Personal is left untouched and tracked.
 *   2. `SHARED_EXPORT_METADATA_BLIND_CAST_HARDENING` — the optional-chained
 *      `exportMetadata` read below. Personal's identical read stays unguarded.
 *      Neither surface has a demonstrated crash path (see the retraction at that
 *      site), so this is hardening, not a fix on one side of a live bug.
 * Both are one-surface changes justified by the same rule the empty-query case is
 * DEFERRED under: do it on both together, unless shipping the defect knowingly is
 * itself the worse outcome.
 *
 * WHAT IS SHARED WITH PERSONAL. Of the EXPORT-LIST logic, one thing:
 * `listAdaptiveExportRecords`. It owns the query —
 * `orderBy("reportVersion","desc")`, the `where("<", cursor)` range,
 * `limit+1`/`hasMore`, and the `[1,50]` clamp (pinned in
 * `lib/firestore/__tests__/adaptiveExports.spec.ts`). Route-level authority and
 * request handling are entirely separate. (This is deliberately NOT a claim that
 * the two routes share only one module: they both import the same
 * `resolveRequestIdentity`, `logIdentityResolutionFailure`, `env`, `adminDb` and
 * `logger`, as any two routes in this codebase do, and their `getUid` helpers are
 * near-verbatim duplicates. Generic infrastructure being shared is not the point;
 * the point is which EXPORT-LIST semantics have one implementation.) Everything
 * else in the export-list path that looks shared is DUPLICATED source, and the
 * three cases are no longer alike: the query-parameter parse and the
 * `format !== "docx"` hash rule are byte-identical in both routes today, while
 * the `nextCursor` derivation has DELIBERATELY diverged (E2A-S15 added a
 * finiteness guard and an integrity path here that Personal does not have). An
 * earlier revision of this header called all three "identical today"; that became
 * false the moment E2A-S15 landed, and is corrected rather than left. None of the
 * three is pinned across the two routes by any test. An earlier version of
 * this header claimed "ordering, the cursor contract and the [1,50] clamp have
 * one implementation rather than two"; the cursor contract's client-facing half
 * is two implementations, so the claim was false and is withdrawn rather than
 * re-scoped. No inventory of duplications is maintained here — one that drifts
 * out of date is worse than none; the rule is simply that nothing in this file
 * may be described as shared unless it is literally the same function.
 *
 * SECURITY INVARIANTS. Each carries an id and names, VERBATIM, the tests that bear
 * on it; a claim without one is description, not a guarantee. The table IS the
 * ordering contract — there is deliberately no second numbered restatement of the
 * execution order, because that is a second thing to drift.
 *
 * READ THE MARKERS, because R11's reviewer was right that an unmarked list reads as
 * if every entry is a falsifier and 14 of them are not:
 *   (F) FALSIFIER — violate the invariant in this route and this test fails. This is
 *       what makes the invariant a guarantee.
 *   (C) CONTROL — proves a fake, a mode or a mechanism DISCRIMINATES, so the
 *       falsifier above it cannot pass vacuously. It does not fail on a route
 *       violation and is not claimed to.
 *   (M) MECHANISM — falsifies the proof machinery itself, usually against a
 *       synthetic input and without entering the route. Necessary, and separately
 *       not sufficient: R11 shipped a round where every (M) passed while the route
 *       path invoked none of them, which is why E2A-S8E now pins the WIRING too.
 *
 *   E2A-S1  Workspace admission precedes ALL target-associated I/O — the run,
 *           the Project and the export subcollection.
 *           → "E2A-S1 a NON-MEMBER performs zero run, Project and export I/O"
 *   E2A-S2  `research.read` precedes ALL target-associated I/O, same three reads.
 *           → "E2A-S2 a caller WITHOUT research.read performs zero run, Project and export I/O"
 *   E2A-S3  Global export feature state is concealed until admission and
 *           `research.read` have both succeeded.
 *           → "a non-member cannot distinguish the flag state"
 *           → "a caller without research.read cannot distinguish the flag state"
 *           → "POSITIVE CONTROL: an authorized reader DOES observe the flag"
 *   E2A-S4  Pagination input must not create an externally observable error
 *           distinction before Workspace authorization.
 *           → "an unauthorized caller cannot distinguish pagination validity"
 *           FALSIFIER, stated precisely because the obvious one does not work:
 *           MOVING the parse above admission proves nothing — it is pure
 *           computation that never errors, so relocating it is an equivalent
 *           mutant and the suite stays green (verified twice, R1 and R2). The
 *           violating mutation is to make paging validation RESPOND — a 400
 *           `invalid_cursor` — BEFORE authorization; that kills the named test,
 *           while the identical 400 placed after authorization does not. The
 *           invariant is response-scoped, not source-line-scoped.
 *   E2A-S5  A malformed `runId` cannot redirect the reference to another
 *           document or subcollection.
 *           → "rejects %p before any document path is constructed" (6 it.each cases)
 *   E2A-S6  Current Workspace/run/Project authority governs history access —
 *           never historical membership.
 *           → "E2A-S6 CROSS-WORKSPACE: a run bound to another Workspace is concealed and never listed"
 *           → "E2A-S6 a Project belonging to another Workspace is concealed"
 *           → "E2A-S6/S7 a FORMER member — including the export creator — is concealed"
 *   E2A-S7  Creator identity is not authority: `createdBy` is metadata. A
 *           currently authorized NON-creator may list; a removed creator may not.
 *           → "E2A-S7 a current reader who did NOT create the exports receives them"
 *   E2A-S8A SOURCE ACCESS (the primary secrecy invariant). The LIST projection
 *           NEVER READS `reportSnapshot`, nor any other persisted property the
 *           DTO does not consume. Proved by a `Proxy` around every record the
 *           list helper returns, which records each property access and every
 *           attempt to enumerate the record wholesale.
 *           → "E2A-S8A a normal list reads only allow-listed source properties"
 *           → "E2A-S8A the record is never enumerated or spread wholesale"
 *           → "E2A-S8A the allowed-read policy is DEFAULT-DENY, so an unclassified property is still caught"
 *           → "§5 instrumentation is applied by the MOCK BOUNDARY, so a raw mockResolvedValue cannot opt out"
 *           → "§8 MECHANISM PROOF: every clone/serialize/enumerate operation fires the tripwire"
 *           → "§9/§10 a SWALLOWED structuredClone still leaves the access recorded"
 *           → "MECHANISM PROOF: the trap fires on a forbidden read, and on enumeration"
 *   E2A-S8B OUTPUT SECRECY — the actual security property. Frozen report content
 *           must never appear in anything the client receives: the fully
 *           materialized body, or any response header name or value. Proved
 *           INDEPENDENTLY of S8A by a canary that lives inside real frozen content
 *           and is registered PER REQUEST from the records the route was handed, so
 *           an empty registry or a canary deleted from a fixture cannot pass.
 *           (An earlier revision of this row described S8B as response SHAPE; that
 *           is now S8C, and the two are different properties — see §21 below.)
 *           (F) → "returns metadata newest-first for an authorized Research reader"
 *               and every other ordinary route test: the scan runs INSIDE the secured
 *               helper, so a route that leaks into the body or a header fails them all.
 *               R11's reviewer was right that the eight entries below are (M), not (F) —
 *               an unmarked list implied S8B had a route-level falsifier when it did not.
 *           (M) → "§9 POSITIVE CONTROL: a canary in the JSON BODY fails the scan"
 *           (M) → "§9/§16 POSITIVE CONTROL: a canary in a response HEADER VALUE fails the scan — the R10 blind channel"
 *           (M) → "§9/§16 POSITIVE CONTROL: a canary in a response HEADER NAME fails the scan, despite platform lowercasing"
 *           (M) → "§9/§13 POSITIVE CONTROL: a canary in Set-Cookie and in statusText fails the scan"
 *           (M) → "§9/§15 POSITIVE CONTROL: the exact R10 leak — util.inspect of a real report-bearing record — fails the scan"
 *           (M) → "§9/§17 POSITIVE CONTROL: a descriptor-obtained value reaching the response fails the scan"
 *           (M) → "§9/§18 POSITIVE CONTROL: a structuredClone-obtained value reaching the response fails the scan"
 *           (C) → "§9 NEGATIVE CONTROL: a clean approved response passes the scan"
 *           (F) → "§11 the real fixtures carry their canaries, so deleting one cannot be silent"
 *   E2A-S8C DTO CONTRACT. Every successful LIST response conforms to the approved
 *           metadata shape — envelope keys, item keys, and the permitted structure
 *           of the one nested object it carries. Validated UNCONDITIONALLY on every
 *           success by a checker written independently from this route's projection,
 *           because a route cannot be its own oracle. Depth matters: `Object.keys`
 *           is depth-1, and R5 hid a snapshot leaf under `governanceStatusAtExport`.
 *           (F) → "E2A-S8B deep-equals the expected response, so no nested extra survives"
 *           (M) → "E2A-S8B MECHANISM PROOF: a value nested inside an ALLOWED key is caught"
 *           (M) → "§20 S8C rejects data nested inside the ALLOWED governance object, with every top-level key intact"
 *           (M) → "§20 S8C rejects a non-string smuggled into governance `conditions`"
 *           (M) → "§20 S8C rejects a raw container in a scalar field, and an unapproved item key"
 *           (M) → "§19 S8C's absent-key tolerance is BOUNDED to the one documented field"
 *           (M) → "§19/§20 each enumerated S8C violation is rejected, with its own diagnostic"
 *           (D) → "§31 the DERIVED assertions are redundant, not unfalsifiable — their violations are still rejected"
 *               R12 reported 4 such assertions; R13 measured 6 and found the named set
 *               wrong in both directions, including one that is NOT deletable — three
 *               refusal assertions were derived only because NOTHING DROVE THEM. R14 gave
 *               the refusal envelope a real driver and re-measured from a green baseline:
 *               exactly TWO of the oracle's 26 assertions are derived, governance
 *               `:isObject` and `envelope:isObject`, both ordering guards. The universal
 *               "every sub-assertion can fail" wording stays withdrawn: F assertions have
 *               direct falsifiers, D assertions are intentionally redundant, and removing
 *               a D changes no rejection behaviour.
 *           (F) → "§4/§5 E2A-S8C covers REFUSALS too, and every refusal assertion is load-bearing"
 *               The validator runs on EVERY response, so a refusal carrying a payload fails
 *               as well as a malformed success. R13 found the title previously cited here
 *               named no test at all, and that three of the four refusal assertions had no
 *               driver — which is why deleting them was silent.
 *           (F) → "§4 the refusal-envelope allow-list CONTENTS are pinned, not just its existence"
 *   E2A-S8E SINGLE ENTRY POINT, AND THE WIRING OF WHAT IT ENFORCES. No route
 *           invocation escapes the secured request helper, and no check the helper
 *           performs can go missing quietly. TWO layers, of which the FIRST is
 *           load-bearing:
 *             A — FAIL CLOSED at `resolveRequestIdentity`, the route's unconditional
 *                 first call, keyed on the EXACT REQUEST INSTANCE. The registration map
 *                 and the async-context store are private to a closure that exports only
 *                 the operations tests legitimately need — there is no registrar, setter
 *                 or reset to reach — so a request the helper did not register is refused
 *                 however it is reached and whatever else is in flight. Two distinct
 *                 guarantees, separately falsified: REGISTRATION LIFETIME (the entry
 *                 exists only for its own invocation) and ROUTE-ENTRY CONSUMPTION (a
 *                 registered request may enter exactly once).
 *             C — a structural audit of the single raw call site and of the single call to
 *                 the required-check runner. A SCOPE CONTROL, explicitly not the barrier:
 *                 R13 defeated the text-matching version with an alias plus a computed
 *                 property, which is why the barrier is now visibility rather than text.
 *           HISTORY, because three rounds died here. R10 deleted the structural test as
 *           "redundant to the global afterEach" and then deleted that afterEach. R11
 *           replaced it with ACCOUNTING, which review broke three ways. R12's flag asked
 *           "is SOME request secured" rather than "is THIS one", and a module singleton
 *           let a concurrent request erase another's evidence. R13 then forged a
 *           registration through the visible map. Hence closure-private state plus a
 *           registry that holds its own assertions, rather than a fourth thing to check
 *           afterwards.
 *           (F) → "§47 a raw route entry FAILS CLOSED, through every reaching mechanism"
 *           (F) → "§47 a route entry from a lifecycle hook is refused just the same"
 *           (F) → "§12 (R11) swallowing the refusal yields NO response to leak in"
 *           (F) → "§14 GUARANTEE A — REGISTRATION LIFETIME: after the invocation, the request is no longer registered"
 *           (F) → "§11/§12/§13 GUARANTEE B — CONSUMPTION: a second entry is refused WHILE the registration is still live"
 *           (F) → "§13/§15 EVERY required check REJECTS its own violation — so a no-op body fails here"
 *           (F) → "§26/§27/§28 registry MEMBERSHIP is pinned, so deleting an entry cannot narrow the contract silently"
 *           (F) → "§14 negative-control coverage matches the registry exactly, in both directions"
 *           (F) → "R13 §7 LAYER C: the required-check RUNNER is invoked inside the secured helper, exactly once"
 *           (C) → "R13 §7 LAYER C: the raw route handler is called only inside the secured helper, or inside the pinned attack region"
 *           (M) → "R14 §30 every executable test cited by this invariant table resolves"
 *   E2A-S15 A paging envelope is never self-contradictory: `hasMore: true` is
 *           emitted only together with a usable continuation cursor.
 *           → "a page that cannot yield a continuation cursor is an integrity failure, not a trap"
 *           → "a NON-NUMERIC reportVersion is refused the same way"
 *           → "hasMore with an EMPTY page cannot crash or invent a cursor"
 *           → "POSITIVE CONTROL: hasMore with a usable terminal reportVersion still pages"
 *           → "a NON-FINITE terminal reportVersion (%s) is refused — it serializes to null, which is the trap" (3 cases)
 *           → "reportVersion 0 IS a usable cursor and must still page — the guard tests finiteness, not truthiness"
 *   E2A-S9  LIST is gated on `research.read`, NOT `exports.create`.
 *           → "E2A-S9 a role with research.read but WITHOUT exports.create can list"
 *   E2A-S9b The gate asks for `research.read` SPECIFICALLY, not a capability
 *           that today's role matrix happens to co-grant.
 *           → "a caller holding reviews.read AND exports.create but NOT research.read is refused"
 *   E2A-S10 This route owns NO pagination policy: it forwards a finite,
 *           truncated cursor/limit (or `undefined`) and never clamps.
 *           → "does not clamp in the route — the helper owns the [1,50] bound (one implementation)"
 *   E2A-S11 Admission is evaluated for the AUTHENTICATED caller against the
 *           ADDRESSED Workspace — not merely called in the right order. R2
 *           found both dimensions unpinned: `uid: "attacker-static"` and
 *           `workspaceId: runId` each passed the whole suite.
 *           → "E2A-S11a admission receives the AUTHENTICATED caller's uid"
 *           → "E2A-S11b admission receives the ADDRESSED workspaceId"
 *           → both CONTROLs, which prove the fake discriminates per dimension
 *   E2A-S12 The Project-integrity read targets `validated.projectId` — not some
 *           other id that happens to be in scope. `getProject(workspaceId)`
 *           previously passed the whole suite.
 *           → "E2A-S12 getProject receives validated.projectId"
 *   E2A-S13 An UNFILED run (`projectId === null`) is listable and performs NO
 *           Project read.
 *           → "E2A-S13 an UNFILED run (projectId null) lists WITHOUT any Project read"
 *   E2A-S14 The export-history read is scoped to the addressed run.
 *           → "E2A-S14 the helper receives the addressed runId"
 *
 * WHY THE SECRECY PROOF WAS RESTRUCTURED, AND WHAT IT NOW RESTS ON.
 *
 * Five review rounds each found the NEXT missing `reportSnapshot` leaf. That was
 * not bad luck: an exhaustive, hand-maintained inventory of that subtree cannot
 * be made safe. An `undefined` optional leaf, an empty array, an open `Record`,
 * an `unknown`-typed field, an uncovered member of the 9-variant `result` union,
 * or any field added later each makes a sentinel-based proof vacuous — and
 * `JSON.stringify` erases the difference between "absent from the response" and
 * "absent from the fixture", which is what made every one of those gaps look
 * like a pass. R4 showed the same erasure defeats the key-set allow-list, since
 * `Object.keys()` on a parsed response never sees an undefined-valued key
 * either.
 *
 * So the primary mechanism is no longer completeness of the data. It is
 * ABSENCE OF ACCESS (E2A-S8A): the projection never reads `reportSnapshot` at
 * all, which holds at every depth, for every optional field, for every union
 * variant and for every field added in future, without the fixture needing to
 * anticipate any of them. Two independent mechanisms now carry the boundary:
 *   S8A  runtime source-access instrumentation applied AT THE MOCK BOUNDARY, so
 *        no fixture class can opt out (R6 found four input classes that had),
 *        in TWO independent modes because neither covers every JS operation:
 *        a DEFAULT-DENY `Proxy` (explicit reads, destructuring, `Reflect.get`,
 *        off-policy reads, `ownKeys`/descriptor enumeration) and a PLAIN-OBJECT
 *        ACCESSOR tripwire (`structuredClone`, `JSON.stringify`, spread,
 *        `Object.values`/`entries`/`assign`) — the latter exists because
 *        `structuredClone(proxy)` throws before any trap runs. Both RECORD
 *        rather than throw, so a caught exception cannot erase the evidence.
 *        The property list is this endpoint's ALLOWED-READ POLICY, not a mirror
 *        of the persisted type: an earlier revision claimed it was exhaustive
 *        over `AdaptiveResearchExportV1` so "a new field cannot sit
 *        unclassified", which was false — the test compared it against another
 *        literal in the same unchecked file. Withdrawn. Default-deny carries the
 *        property instead: a read of anything off-policy, future fields
 *        included, fails regardless of what the type declares;
 *   S8B  a DEEP equality assertion on the response, which — unlike the depth-1
 *        `Object.keys` check it replaces — catches a forbidden value nested
 *        inside an allowed key.
 * Their independence is demonstrated, not assumed: with the output assertions
 * neutralised a `reportSnapshot` read still fails, and with the trap neutralised
 * an extra defined DTO key still fails.
 *
 * The representative real-schema snapshots are retained as INTEGRATION EVIDENCE
 * — they show the route behaves correctly against realistic, deeply-populated
 * data of both families, including model prose, citations, trust scores and
 * concrete result content. They are no longer asked to be exhaustive, and no
 * claim here depends on them being so.
 *
 * RETRACTED MECHANISM, stated plainly because it was load-bearing and false.
 * Earlier revisions of this header, the spec docblock, the PR body and commit
 * `f76c109d`'s message all claimed that `satisfies` in the route spec pins every
 * required leaf at compile time via the Quality Gate's `tsc --noEmit`. It does
 * not, and it never did: `tsconfig.json` excludes every spec file by glob,
 * `tsc --listFilesOnly` contains zero route-spec files, and ts-jest transpiles
 * without type-checking. The decisive probe — inserting
 * `const x: number = "a string"` into the spec — yields `tsc` exit 0 and a green
 * Jest run. `satisfies` in that file is editor assistance and nothing more; it
 * supplies no enforced evidence, and no proof here relies on it. The historical
 * commit message is left intact.
 *
 * OBSERVABILITY, CLASSIFIED. The following warnings are CONTRACTUAL operational
 * signals, each asserted on its structured fields (an earlier revision opened
 * this paragraph with a count that disagreed with its own list — no count is
 * given now, the list is the contract):
 *   • `filed run's Project unresolved` — parity with the canonical read and E1,
 *     which both warn here; E2-A used to log nothing at all.
 *   • the E2A-S15 continuation-cursor warning — the ONLY operator signal
 *     separating a PERMANENT data-integrity 503 from the transient ones, whose
 *     status, errorCode and message are byte-identical.
 *   • the cross-Workspace Project integrity anomaly — the sole trace of a
 *     cross-tenant filing inconsistency, so it is asserted too.
 * The remaining warnings (`run read failed`, `project read failed`,
 * `export history read failed`) are INCIDENTAL and deliberately unasserted. R6
 * noted the S15 argument could be read as applying to them; it does not, and the
 * difference is stated rather than glossed: those three conditions are TRANSIENT
 * and self-resolving, so the operator question is "is the datastore healthy",
 * answered by the surrounding infrastructure, not "which of four identical 503s
 * was this". Nothing in this file claims they are pinned, and nothing should.
 *
 * E2A-S8A IS UNAVOIDABLE ACROSS *TWO* DIMENSIONS (§28). R6 closed record shape:
 * instrumentation moved to the mock boundary so no test could opt out of being
 * instrumented. R8 closed the other one only partly, and R9 finishes it: the
 * REQUEST/AUTHORITY CONTEXT. A leak gated on who created the export, on the
 * caller's role, on an unfiled run, on `?cursor=`/`?limit=`, on a degraded
 * Project or on the record count was invisible, because those contexts existed
 * in no instrumented test. Worst of it: every fixture is created by a different
 * uid than the caller — deliberately, to prove E2A-S7 — so the most common
 * production case, a member listing their own exports, had NO test at all, and
 * emitting the whole frozen report for exactly those records passed the suite.
 * A mode default cannot fix a missing fixture value; only the context matrix can.
 *
 * THE FINAL PROOF MODEL — THREE INVARIANTS, THREE MECHANISMS, NO SUBSTITUTIONS.
 *
 * R9 ended the attempt to prove secrecy by trapping every way of reading an
 * object. That claim is not defensible in JavaScript: `util.inspect` reaches a
 * Proxy's target without firing a trap AND renders an accessor as `[Getter]`
 * without invoking it; `Object.getOwnPropertyDescriptor(x, p).value` hands over
 * the value on a plain object; a persisted field the harness fixture does not
 * define cannot be observed by an accessor at all. Enumerating that surface is
 * not a winnable strategy, so it is no longer the claimed invariant.
 *
 *   E2A-S8A  SOURCE DISCIPLINE. The projection should not consult forbidden
 *            persistence sources while building the DTO.
 *            Mechanism: the Proxy / accessor instrumentation.
 *   E2A-S8B  OUTPUT SECRECY — the actual security property. Frozen report content
 *            must never appear in the SERIALIZED response. Mechanism: a unique
 *            canary inside real frozen content, scanned in the fully materialized
 *            body by the central request helper. Operation-independent by
 *            construction: it does not care which primitive produced the value,
 *            including primitives nobody here has thought of.
 *   E2A-S8C  DTO CONTRACT. The response conforms to the approved metadata shape.
 *            Mechanism: deep response-shape assertions.
 *
 * WHAT EACH DOES NOT PROVE, stated because conflating them is how the last three
 * rounds went wrong. S8B does NOT prove source non-access: a route could inspect
 * secret data and choose not to return it, and only S8A sees that. S8A does NOT
 * prove the response is clean: a value obtained through an unobservable primitive
 * would reach the body unseen, and only S8B catches it. S8C catches a shape
 * violation that leaks nothing. The three are complementary, and the record mode
 * matters — though NOT in the way an earlier revision of this paragraph said. It
 * claimed the canary was "only meaningful against a PRODUCTION-SHAPED plain
 * record" and that the third mode was "necessary, not optional". R10's reviewer
 * measured that and it is false: with a `util.inspect` leak in the route, `plain`
 * fails 20/20 context rows and `proxy` fails 20/20 (Node reads a Proxy's TARGET, so
 * the value reaches the body), while `accessor` fails 0/20 because `util.inspect`
 * renders an accessor as `[Getter]` without invoking it. The accurate statement is
 * narrower: ONE mode can mask ONE operation, Proxy mode does not mask it, and
 * `plain` mode is ADDITIONAL production-shape coverage — the mode that matches what
 * the route really receives, and the only one indistinguishable from production to
 * a `structuredClone`-rejecting path. No mode is the sole meaningful one.
 *
 * SUPPORTING STRUCTURE, AND NO ONE PIECE PROVES THE WHOLE:
 *   1. BOUNDARY INSTRUMENTATION — every list result is wrapped inside the module
 *      mock, so no test can opt out of being instrumented.
 *   2. ACCESS DETECTION — two modes, each covering the operation classes it has
 *      been empirically shown to see: the Proxy for reads/destructuring/
 *      `Reflect.get`/off-policy reads/enumeration, the plain-object accessor for
 *      `structuredClone`/`JSON.stringify`/spread/`Object.values`/`entries`/
 *      `assign`. Neither covers the other's set; one shared input-class table is
 *      run under BOTH, so mode coverage cannot drift.
 *   3. UNIVERSAL ENFORCEMENT, IN TWO PARTS — because R10 proved one part alone is
 *      not enough. (a) The postcondition is asserted INSIDE the secured request
 *      helper for every request, against a witness local to that invocation, so no
 *      test and no input class can forget it: R7 is why, since with enforcement
 *      opt-in a leak gated on `reportVersion === 0` put the whole frozen report on
 *      the wire with the suite green. (b) A top-level `afterEach` separately proves
 *      no route entry happened OUTSIDE that helper (E2A-S8E), because R10 showed
 *      that (a) without (b) is bypassed by simply calling the handler. An earlier
 *      revision of this bullet described (a) as a global `afterEach` covering "any
 *      invocation path"; no such hook existed. There is no opt-out flag either way;
 *      mechanism self-tests use a private sink and never enter the route.
 *   4. ACCESSOR BY DEFAULT — the plain-object tripwire is what ordinary route
 *      tests get, because it is the mode that observes value-obtaining operations
 *      (`structuredClone`, `v8.serialize`, `util.inspect`, getter traversal). The
 *      Proxy runs as an ADDITIONAL focused matrix for the classes only it sees —
 *      key enumeration and descriptor access, which obtain no values. Neither mode
 *      dominates universally and the division of labour is measured, not asserted:
 *      a MECHANISM PROOF test shows `Object.keys` fires the Proxy and not the
 *      accessor.
 *   5. THREE SEPARATE AXES, each with its own table. No table covers another's
 *      axis, none is exhaustive across all three, and none claims to be — an
 *      earlier revision described the first as though the split were cleaner than
 *      it is, since that table does carry four record-shape rows of its own:
 *        • REQUEST/AUTHORITY CONTEXT — 20 rows over the request and authority
 *          branches, including the creator-self case, each running under all three
 *          record modes and each PROVING ITS OWN PRECONDITION against the actual
 *          `Request` before any security assertion. R9 found a row could be
 *          neutered and still pass; R10 then found four rows whose preconditions
 *          asserted their own row literal, which removing the query from the real
 *          request left green. Rows are also checked for DISTINCT OBSERVABLE
 *          EFFECT, so a decorative duplicate collides.
 *        • RECORD SHAPE — the input-class table: `format: "docx"`, `json`,
 *          present-but-hashless `exportMetadata`, absent `exportMetadata`, the
 *          legacy family, and the `reportVersion` variants.
 *        • SOURCE OPERATION / MECHANISM — the Proxy matrix for the classes only it
 *          observes, plus the mechanism self-tests that falsify each defence.
 *   6. A PER-REQUEST PRIVATE WITNESS. Enforcement lives INSIDE the central request
 *      helper, asserted against a `const` sink local to that one invocation, which
 *      no test can reach (see the precise scope below). R8 defeated a reassignable sink;
 *      R9 then defeated the `const` sink plus monotonic counter that replaced it,
 *      by re-marking the module-level baseline the counter was COMPARED TO. Fixing
 *      the operand would only have moved the target again, so the whole category is
 *      gone: a test receives the response, never control of the assertions.
 *      SCOPED PRECISELY, and rewritten in R13 because both earlier versions of this
 *      paragraph over-claimed. There is no module-level slot at all now: the
 *      per-invocation context is reached by EXACT REQUEST IDENTITY through a
 *      `WeakMap` (which a test cannot enumerate) for authorization, and by
 *      `AsyncLocalStorage` (scoped to one async flow) for propagation to collaborator
 *      mocks that never receive the request. R12 broke the previous design two ways
 *      this closes: a concurrent request's unconditional cleanup erased another's
 *      evidence, and "some request is secured" admitted a raw aliased entry. Residual,
 *      stated plainly and deliberately bounded (see the threat-model note in the
 *      spec): a spec author
 *      who rewrites this harness can still defeat it — no in-file mechanism can stop
 *      its own file — but forgetting, which is what actually happened repeatedly
 *      here, is now structurally impossible.
 *   Also: an ALLOWED CONTAINER IS NOT AN ALLOWED SUBTREE. `exportMetadata` is
 *   trapped one level deep with its own allow-list (`fileHash` only), because a
 *   depth-1 policy could not see `exportMetadata.requestingUser`.
 *
 * SCOPE OF S8A, stated exactly. It covers every read that participates in
 * producing the HTTP response, which is what the invariant is about. A
 * fire-and-forget `setTimeout(() => … , 0)` scheduled during the request and
 * never awaited is NOT detected, and is deliberately not claimed: it cannot
 * affect the response that was already returned. The AWAITED form — any deferred
 * read the response actually waits on — IS detected, verified by mutation. The
 * distinction is response-producing work versus post-response background work,
 * and only the former is an HTTP disclosure path.
 *
 * A PROOF MECHANISM MUST ITSELF BE FALSIFIED BEFORE PROSE RELIES ON IT. That
 * rule exists because of the retraction above: the claim was documented from
 * inspection, never probed. Every mechanism this file cites now has a test that
 * deliberately triggers the defect it claims to catch.
 *
 * THE AUTHORITY-MOCK RULE (adopted in R2). A mocked security collaborator
 * is not proven by having been called: its security-relevant arguments must be
 * pinned, and where practical the fake must BEHAVE DIFFERENTLY when they are
 * wrong. Caller identity, Workspace identity, Project identity, capability
 * identity and run identity are all argument-sensitive in the spec, each with a
 * CONTROL test proving the fake discriminates — otherwise the fake becomes the
 * next assertion that cannot fail.
 *
 * WHY THE FLAG IS CHECKED LATE. The Personal route checks
 * `ADAPTIVE_RESEARCH_EXPORT_ENABLED` before its owner check, which it can afford
 * because it owes non-owners no concealment. This route deliberately does NOT
 * copy that ordering: it inherits E1-S8, so an unauthorized caller must not be
 * able to determine whether Workspace export is globally enabled. The same
 * reasoning applies to query-parameter validation (E2A-S4) — a 400 about a bad
 * cursor would tell a non-member the route exists and reached its paging layer.
 *
 * PAGINATION SEMANTICS, stated per input class rather than as one sweeping
 * "malformed values fall back to the first page and the default size" — R2
 * showed that sentence was false for one of the four classes:
 *
 *   absent      (`?`)                 → `undefined`; the helper applies its own
 *                                       default page size of 30. First page.
 *   malformed   (`?cursor=abc`)       → `undefined`; genuine fallback, as above.
 *   finite      (`?cursor=12.7`)      → truncated to `12`; forwarded as given.
 *   EMPTY       (`?cursor=`)          → `0`, NOT absent. `searchParams.get()`
 *                                       returns `""` rather than `null`, and
 *                                       `Number("") === 0`, which is finite. The
 *                                       helper then applies
 *                                       `where("reportVersion","<",0)` and a run
 *                                       WITH exports reports none. `?limit=`
 *                                       likewise forwards `0`, which the helper
 *                                       clamps UP to 1 instead of defaulting to 30.
 *
 * The empty-string case is a DEFECT, tracked as
 * SHARED_EXPORT_HISTORY_EMPTY_QUERY_PARAM_NORMALIZATION and deliberately NOT
 * fixed here. The identical parse exists in the Personal list, and normalizing
 * it on one surface only would replace a shared inconsistency with a divergence
 * between two surfaces that clients reasonably expect to behave alike. It is
 * characterized by tests ("empty query parameters — inherited behaviour,
 * characterized not endorsed") so the behaviour is recorded rather than
 * discovered again, and the future fix updates BOTH surfaces together. E2A-S4 is
 * unaffected: all four classes remain equally unobservable before authorization.
 *
 * DELIBERATELY ABSENT, and each absence is load-bearing rather than an
 * oversight: no export verdict, no plan/entitlement check, no classification or
 * governance re-evaluation, and no audit event. LIST is a read of export history
 * by a current Research reader, deferring per-item authorization to the
 * regeneration route. Plan and the frozen-governance verdict belong to E2-B,
 * which will require `exports.create`; folding them in here would quietly turn a
 * read into E1.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { ADAPTIVE_RESEARCH_EXPORT_ENABLED } from "@/lib/env";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import type { TeamWorkspaceErrorBody } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { runNotFoundConcealedResponse } from "@/lib/projects/projectErrorResponse";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { getProject } from "@/lib/firestore/projects";
import { listAdaptiveExportRecords } from "@/lib/firestore/adaptiveExports";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG = "[api/workspaces/runs/exports GET]";

/** The export-history metadata DTO. Its key set is pinned by the spec's allow-list assertion, so drift is caught there rather than asserted in prose; correspondence with the Personal list item is not claimed as a guarantee. `reportSnapshot` is absent by construction — this is an allow-list projection, not a denylist. */
export interface TeamAdaptiveExportListItem {
  exportId: string;
  reportVersion: number;
  schemaId: string;
  schemaFamily: "milestone2" | "legacy";
  format: string;
  artifactStatus: string;
  createdAt: string;
  createdBy: string;
  governanceStatusAtExport: unknown;
  classification: string;
  fileHash?: string;
  hashAlgorithm?: "sha256";
  hashReproducible?: boolean;
}

/** Derived purely from `format` — DOCX regeneration cannot reproduce its original whole-file hash. Duplicates the Personal list's one-line derivation; identical today, pinned together by no test (see the header's shared-vs-duplicated note). */
function isHashReproducible(format: string): boolean {
  return format !== "docx";
}

function errorResponse(status: number, errorCode: string, message: string) {
  return NextResponse.json({ ok: false, errorCode, message }, { status });
}

/**
 * R2 P3-5/§25: the shared `teamRunLookupUnavailableResponse()` says "We couldn't
 * verify your access right now", which is accurate for an ADMISSION lookup
 * failure and wrong for a failure three stages later, after access was already
 * verified. The shared helper is NOT route-owned — `teamRunAccessDeniedResponse`
 * maps `lookup_failed` through it and E1 and the canonical read both emit it —
 * so editing its text would change other routes' user-facing strings. Instead
 * this route keeps the PRIMARY contract byte-identical (503 +
 * `team_workspace_unavailable`, the same status and errorCode the family uses)
 * and supplies a stage-accurate generic message for its own post-authorization
 * failures. Clients must key on status/errorCode, never on wording.
 */
function unavailableAfterAuthorization(): { status: number; body: TeamWorkspaceErrorBody } {
  const base = teamRunLookupUnavailableResponse();
  return { status: base.status, body: { ...base.body, message: "We couldn't load this export history right now. Please try again in a moment." } };
}

/** The shared Team/Project helpers return a `{status, body}` envelope; emitting them this way keeps the concealment vocabulary identical across the Team run family. */
function shared(envelope: { status: number; body: unknown }) {
  return NextResponse.json(envelope.body as Record<string, unknown>, { status: envelope.status });
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/runs/[runId]/exports", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return errorResponse(401, "unauthorized", "Please sign in.");
  }
  return errorResponse(401, "auth_error", "Authentication failed.");
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { workspaceId, runId } = params;

  // E2A-S5 — before any document path is constructed from it.
  if (!validateRunIdSyntax(runId).ok) {
    return shared(runNotFoundConcealedResponse());
  }

  // `!adminDb` only. The feature flag is checked LATER (E2A-S3). That this
  // infrastructure branch answers with the family's concealed 404 rather than
  // the sibling detail route's 503 is a known, separately tracked divergence,
  // unchanged here.
  if (!adminDb) {
    return shared(runNotFoundConcealedResponse());
  }

  // ── E2A-S1: admission must precede any target-run or export I/O ──
  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    return shared(teamRunAccessDeniedResponse(access.reason));
  }

  // ── E2A-S2 / E2A-S9: `research.read`, NOT `exports.create` ──
  // History is a READ of the Research run's export metadata, so it is gated
  // exactly like the canonical Team detail read. A reviewer or viewer — who
  // holds `research.read` but is denied `exports.create` — can therefore see
  // that exports exist without being able to create or download one.
  if (!access.capabilities.includes("research.read")) {
    return shared(teamRunInsufficientCapabilityResponse());
  }

  // ── E2A-S3: global feature state concealed until authorization ──
  // As with E1-S8, the deliberate cost is that a disabled surface still
  // performs the reads admission and capability evaluation require; the
  // protected property is only that an unauthorized caller cannot observe
  // flag state.
  if (!ADAPTIVE_RESEARCH_EXPORT_ENABLED) {
    return shared(runNotFoundConcealedResponse());
  }

  // ── E2A-S4: pagination input creates no observable error ──
  // The finite/truncation guards are duplicated from the Personal list — same
  // source today, not a shared implementation. `Number.isFinite` also rejects
  // ±Infinity and `Math.trunc` keeps a fractional value out of Firestore's
  // `.limit()`/`.where("<", …)`. `listAdaptiveExportRecords` re-applies its own clamp regardless, so
  // a client can never force an unbounded read. Malformed values fall back to
  // the first page and the default size rather than erroring — and THAT, not
  // this block's position, is what makes paging unobservable to an
  // unauthorized caller. Keep it that way: adding a 4xx for bad paging would
  // create the oracle, and it would do so wherever the parse happens to sit.
  const cursorParam = req.nextUrl.searchParams.get("cursor");
  const limitParam = req.nextUrl.searchParams.get("limit");
  const parsedCursor = cursorParam !== null ? Number(cursorParam) : NaN;
  const parsedLimit = limitParam !== null ? Number(limitParam) : NaN;
  const beforeReportVersion = Number.isFinite(parsedCursor) ? Math.trunc(parsedCursor) : undefined;
  const limit = Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : undefined;

  // ── E2A-S6: the run must be canonically bound to THIS Workspace ──
  let data: Record<string, unknown>;
  try {
    const snap = await adminDb.collection("runs").doc(runId).get();
    if (!snap.exists) {
      return shared(runNotFoundConcealedResponse());
    }
    data = (snap.data() ?? {}) as Record<string, unknown>;
  } catch (err: unknown) {
    logger.warn(`${LOG} run read failed`, { workspaceId, runId, error: err instanceof Error ? err.message : String(err) });
    return shared(unavailableAfterAuthorization());
  }

  const validated = validateTeamRunRowShape(data, workspaceId);
  if (!validated.ok) {
    // Includes the cross-Workspace case: a run whose own `workspaceId` is not
    // the addressed one is concealed, never merely refused.
    return shared(runNotFoundConcealedResponse());
  }

  // ── E2A-S6: Project binding integrity, mirroring the canonical read ──
  // Same helper and same three outcomes as the detail read and E1: a run filed
  // in another Workspace's Project is an integrity anomaly and is concealed, so
  // export history cannot be listed for a run the canonical read would refuse.
  if (validated.projectId !== null) {
    const projectResult = await getProject(validated.projectId);
    if (projectResult.status === "firestore_unavailable" || projectResult.status === "read_failed") {
      logger.warn(`${LOG} project read failed`, { workspaceId, runId, errorCategory: projectResult.status });
      return shared(unavailableAfterAuthorization());
    }
    if (projectResult.status === "found" && projectResult.project.workspaceId !== workspaceId) {
      logger.warn(`${LOG} run filed in a Project of another Workspace (integrity anomaly)`, { workspaceId, runId });
      return shared(runNotFoundConcealedResponse());
    }
    // R3 P2: `not_found` and `malformed` are NOT integrity anomalies — a
    // Project document that is simply gone says nothing about which Workspace
    // this run belongs to, which `validateTeamRunRowShape` already settled. The
    // canonical Team detail read logs and renders the run without a Project
    // label, and E1 logs and exports; E2-A carries no Project label either, so
    // it logs and lists. Behaviourally the two statuses are identical in all
    // three routes — the distinction survives in `errorCategory`, not in the
    // response — and turning them into a refusal would make export history
    // unlistable for a run the canonical read still renders. E2-A previously
    // logged NOTHING here, so a run listing against a vanished Project left no
    // operator trace at all; that asymmetry with its two siblings is fixed.
    if (projectResult.status !== "found") {
      logger.warn(`${LOG} filed run's Project unresolved`, { workspaceId, runId, errorCategory: projectResult.status });
    }
  }

  // ── The list itself ──
  // E2A-S7: authority was settled entirely above, from the CURRENT caller's
  // Workspace standing. Nothing below consults `createdBy`; it is projected as
  // metadata only, so a current reader who created none of these exports sees
  // them, and a removed creator sees nothing because they never get here.
  const listResult = await listAdaptiveExportRecords(runId, { limit, beforeReportVersion });
  if (!listResult.ok) {
    // R1 normalised this to 503 (one condition, one contract). R2 P3-1/§28 then
    // found the 500 `list_failed` fallback it left behind was DEAD BY TYPE:
    // `ListAdaptiveExportsResult`'s failure arm is exactly
    // `{ reason: "firestore_unavailable" | "read_failed" }`, so once both are
    // handled `reason` narrows to `never`. The comment claiming "an unexpected
    // reason still falls through to 500" described a branch no in-type value can
    // reach, and the test that "proved" it could only do so by making an untyped
    // mock return a reason production cannot produce. Both are gone: a future
    // added reason now breaks the BUILD here instead of being silently laundered
    // into 503, which is the property the dead branch only pretended to give.
    //
    // `read_failed` is the only reason reachable from THIS route —
    // `firestore_unavailable` is returned solely when the helper sees
    // `!adminDb`, which the guard near the top of GET already answered. It is
    // handled because it is in the union, not because it can arrive.
    switch (listResult.reason) {
      case "firestore_unavailable":
      case "read_failed":
        logger.warn(`${LOG} export history read failed`, { workspaceId, runId, errorCategory: listResult.reason });
        return shared(unavailableAfterAuthorization());
      default: {
        const unhandledReason: never = listResult.reason;
        throw new Error(`Unhandled export-history failure reason: ${String(unhandledReason)}`);
      }
    }
  }

  // E2A-S8A/S8B: an explicit allow-list projection. `reportSnapshot`,
  // `generatedBy`, `failureReason` and the record's own `version`/`runId`/
  // `schemaVersion` are absent because they are never READ here — the spec's
  // access trap proves that, rather than inferring it from the output. Note what
  // is NOT claimed: `governanceStatusAtExport` IS copied, wholesale and
  // un-narrowed, and its milestone2 form carries verbatim reviewer `conditions`.
  // That is deliberate and not a disclosure — the canonical Team detail read
  // already returns those conditions to every `research.read` holder — but an
  // earlier revision said "the governance record … never copied here", which was
  // wrong. Only `GovernanceRecordV1` is absent; the export's frozen status is not.
  const items: TeamAdaptiveExportListItem[] = listResult.records.map((r) => ({
    exportId: r.exportId,
    reportVersion: r.reportVersion,
    schemaId: r.schemaId,
    schemaFamily: r.schemaFamily,
    format: r.format,
    artifactStatus: r.artifactStatus,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    governanceStatusAtExport: r.governanceStatusAtExport,
    classification: r.classification,
    // BLIND_CAST_HARDENING. `exportMetadata` is declared required on
    // `AdaptiveResearchExportV1`, but nothing validates it at runtime:
    // `normalizeAdaptiveExportRecord` returns `raw as AdaptiveResearchExportV1`
    // with no shape check, so the type is an assumption about persisted data,
    // not a guarantee about it. Unguarded, `r.exportMetadata.fileHash` threw a
    // TypeError out of GET — the one failure path with no `{ok:false,errorCode}`
    // envelope — and a single malformed document would break the whole page for
    // every reader. The record still lists; only its hash trio is omitted, which
    // is already the contract for a record that produced no bytes, and no hash
    // value is ever synthesized.
    //
    // SUPERSEDED CLAIM, recorded deliberately. An earlier revision of this
    // comment (and of commit 8a5ef05d's message, which is left intact for
    // auditability) asserted this shape was "REACHABLE from historical data":
    // that a legacy document whose only hash carrier was the flat
    // `"exportMetadata.fileHash"` key would arrive with no `exportMetadata`.
    // R3 source-traced it and that is FALSE. The pre-fix
    // `markAdaptiveExportReady` wrote the flat key via
    // `.set({ "exportMetadata.fileHash": hash }, { merge: true })` onto a
    // document `createAdaptiveExportRecord` had ALREADY written with a full
    // nested `exportMetadata`. (Attribution corrected in R6: the flat-key WRITE
    // was introduced in fe1891f, the same commit as the create writer; 86185a6
    // is the FIX that replaced it with a nested merge. An earlier revision named
    // 86185a6 as the bug.) Legacy records therefore carry BOTH,
    // and `normalizeAdaptiveExportRecord` merges the flat value in and strips
    // the key. NO writer in this repository has been demonstrated to produce a
    // record lacking `exportMetadata`. The guard is justified by the blind cast
    // at a public API boundary, not by a known producer.
    ...(r.exportMetadata?.fileHash
      ? { fileHash: r.exportMetadata.fileHash, hashAlgorithm: "sha256" as const, hashReproducible: isHashReproducible(r.format) }
      : {}),
  }));

  // ── E2A-S15: a paging envelope is never self-contradictory ──
  // R3 reproduced the trap: a record whose `reportVersion` is missing or
  // non-numeric (this route reads blind-cast historical persistence, so it
  // cannot assume otherwise) produced `hasMore: true` with `nextCursor`
  // ABSENT — `JSON.stringify` drops `undefined`, which also violated this
  // route's own envelope allow-list — and a client paging on `nextCursor`
  // re-requests page 1 for ever.
  //
  // The two tempting repairs are both lies: `hasMore: false` would claim the
  // history is complete when it is not, and synthesizing a cursor would invent
  // a position in someone's audit history. So a page that cannot yield a valid
  // continuation is treated as what it is — malformed persisted data — and
  // answered with this route's existing service-unavailable envelope. No new
  // public error vocabulary, and the caller is told to retry rather than handed
  // a contradiction.
  const lastReportVersion = items.length > 0 ? items[items.length - 1].reportVersion : null;
  // `Number.isFinite` performs no coercion, so it already rejects `null`, a
  // string and `undefined` as well as NaN/±Infinity. An earlier revision also
  // tested `typeof === "number"`; R4 correctly classified removing that as an
  // EQUIVALENT MUTANT, so it is removed rather than kept and decorated with a
  // test that could only pass by manufacturing a distinction that does not exist.
  const nextCursor = listResult.hasMore && Number.isFinite(lastReportVersion) ? lastReportVersion : null;
  if (listResult.hasMore && nextCursor === null) {
    logger.warn(`${LOG} export history page cannot yield a continuation cursor`, {
      workspaceId,
      runId,
      itemCount: items.length,
      lastReportVersionType: typeof lastReportVersion,
      lastReportVersionFinite: Number.isFinite(lastReportVersion),
    });
    return shared(unavailableAfterAuthorization());
  }

  return NextResponse.json({ ok: true, runId, exports: items, hasMore: listResult.hasMore, nextCursor });
}

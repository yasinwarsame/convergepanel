# API key pepper rotation (owner ruling R-7)

**Status:** policy and procedure for draft PR #327 (`feat/api-1a-foundation`, API-1a, DARK: no route, rollout switches `false`). The owner approved ruling R-7, the credential rotation policy. This file records that ruling and the procedure that follows from it. Items marked **PROPOSAL** need the owner's approval before first use.

**No real credential was created, read or rotated to write this document or its tests.** Every pepper in the test suites is `randomBytes(32)` generated in-process. No environment variable was added, changed or read on any Vercel, Firebase or Stripe project. No Production system was called. The emulator suite runs against a local `demo-` project.

## 1. The ruling (R-7)

1. **No automatic lazy rehash-on-read.** This is deferred. A key hashed under the previous pepper is never rewritten when it is used.
2. **Credential authentication is READ-ONLY.** The authentication path makes no write of any kind: no rehash, no `lastUsedAt`, no counters.
3. **Customers move by explicit key replacement and revocation.** That means `rotateApiKey` / `revokeApiKey`, which are management actions with same-transaction audit rows. Nothing is upgraded silently.
4. **Previous-pepper support is bounded** to an approved rotation period.

This supersedes the doc's tenancy-and-auth.md §4.2 sentence "each successful verify under the old pepper rewrites the hash under the new one". The amendment text is in api-1a-contract-reconciliation.md R-7.

## 2. How hashing and peppers work today (code at #327)

| Piece | Where | Behaviour |
|---|---|---|
| Pepper reader | `lib/apiPlatform/secrets.server.ts` `readApiKeyPeppers()` | Reads `API_KEY_PEPPER` and the optional `API_KEY_PEPPER_PREVIOUS` **at call time** (every request), never at module load. This is the only module that names them (pinned by `secretBoundary.spec.ts`). |
| Decoding | `decodeSecret()` | Trimmed; strict base64url (`[A-Za-z0-9_-]` plus up to two `=`); decoded length ≥ `MIN_PEPPER_BYTES` (32). |
| Subkey | `deriveSubkey(pepper, "cp-api/key-verifier/v1")` | HKDF-SHA256 with an empty salt, 32 bytes. Throws on an unknown label or a pepper under 32 bytes. |
| Hash | `keys.ts` `computeKeyHash()` | `hex(HMAC-SHA256(subkey, "<mode>:<keyId>:<secret>"))`. |
| Stored | `store.ts` `createApiKey` / `rotateApiKey` | `hash` plus `hashVersion: 1`. **Minting always uses the CURRENT pepper.** |
| Verify | `keys.ts` `keyHashMatches()` | Checks the current pepper and, when one is configured, the previous pepper. Both HMACs are always computed, so the timing does not show which pepper matched. Constant-time comparison. |
| Guard | `principal.ts` `requireApiPrincipal()` | Refuses `hashVersion !== 1`. Any pepper problem → `503 api_unavailable` before any lookup. |

`hashVersion` names the **algorithm** (construction v1), not the pepper. **A key record does not show which pepper produced its hash.** This matters for §6: the only signal is `createdAt` against the rotation start time.

Previous-pepper support is implemented (`API_KEY_PEPPER_PREVIOUS`). **Its time bound is operational, not enforced in code**: the window ends when an operator removes the variable. See §9 for the decision not to add a code-enforced expiry in this round.

## 3. Missing or malformed secret: fail closed

| Condition | Reader result | Authentication | Minting |
|---|---|---|---|
| `API_KEY_PEPPER` unset, empty or whitespace | `unavailable(missing)` | `503 api_unavailable`, before any key lookup | `peppers_unavailable`, nothing written |
| Not base64url (`+`, `/`, punctuation, embedded space, JSON) | `unavailable(not_base64url)` | 503 | refused |
| Decodes to < 32 bytes | `unavailable(too_short)` | 503 | refused |
| `API_KEY_PEPPER_PREVIOUS` set but malformed or short | `unavailable(…)` for the **whole set** (not ignored) | 503 | refused |
| Previous equals current | `unavailable(previous_equals_current)` | 503 | refused |
| Previous empty or whitespace | treated as absent | normal | normal |
| A `PepperSet` built some other way with a bad buffer, a missing `current`, an unknown status, `null`, or a throwing `peppers()` | — | 503 (`deriveSubkey` throws; the guard's catch fails closed) | refused |

There is no default, no development fallback and no empty-key HMAC. A bad pepper never produces a bypass. It makes the API unavailable, and it never makes a wrong key acceptable. These rows are pinned by `secretBoundary.spec.ts` ("readApiKeyPeppers (fail closed)") and `principalReadOnly.spec.ts` ("missing or malformed peppers make authentication unavailable, never a bypass", 12 env cases × 3 credentials + 7 injected cases + a valid-env control).

## 4. Read-only authentication: what is proven

- `PrincipalDeps` exposes only `peppers`, `getKey`, `getOrg`, `getApp` and `now`. The guard never receives a database handle.
- `principalReadOnly.spec.ts` proves the following:
  - every member the guard touches on 9 success and denial paths is one of those five, and no `set`, `defineProperty` or `delete` occurs on the deps (Proxy recorder, with a positive control);
  - deep-frozen stored records still authenticate, so the guard never writes to a record it read;
  - the whole fake store is byte-identical, with zero transactions, across success, revoked, rotated-in-overlap, rotated-after-overlap, wrong-secret and outage paths, and through a previous-pepper window (the hash is not rewritten), with a positive control;
  - `principal.ts` and `keys.ts` contain no writer call and import only their pinned modules.
- `store.emulator.spec.ts` ("R-7: authentication is READ-ONLY against real Firestore") compares every document's `updateTime` and data before and after 10 authentications against the emulator. The comparison is unchanged, and it has a positive control.

## 5. Rotation procedure

**Who approves:** the owner (repository owner / approver account), in writing, for every pepper change. The person who changes the variable is the owner, or a SYSTEM_ADMIN-tier operator the owner names for that rotation. ADMIN_PORTAL and GOVERNANCE_ADMIN do not grant this authority (docs/operations/admin-authority-tiers.md). Claude agents never create, read or change a pepper.

Steps (Production; each step is recorded in the deployment evidence log):

1. **Decide and record.** The owner approves a rotation. The approval states the reason (scheduled or compromise), the planned window end date (≤ the §6 bound) and the operator.
2. **Generate** a new pepper of ≥ 32 random bytes from a CSPRNG, base64url-encoded, in the operator's own secure environment. Never paste it into chat, tickets, logs or Git.
3. **Stage both values** as Vercel *Sensitive/Secret* variables in one change: `API_KEY_PEPPER_PREVIOUS` = the current value, `API_KEY_PEPPER` = the new value. Never leave a state where the old value appears in neither variable while old keys are still in use.
4. **Deploy** and verify. Confirm that the new deployment serves 100 % of traffic. With a disposable test-mode key minted *before* the rotation, authentication succeeds (previous-pepper path). A test key minted *after* the rotation also succeeds (current path). Record `T_rotation` = the time the new deployment was fully promoted.
   - Hazard: during promotion, old instances still mint under the old pepper as *current*. Keys minted then are hashed under the old pepper. Treat every key with `createdAt < T_rotation + propagation margin (PROPOSAL: 1 hour)` as old-pepper.
5. **Notify customers** with live keys created before `T_rotation`. Tell them to replace each key using **rotate** (`rotateApiKey`, overlap ≤ 30 days, never past the window end) or create-and-revoke, before the window end date.
6. **Track** remaining old-pepper keys: count of `apiKeys` with `revokedAt == null`, not expired, `rotatedTo == null` and `createdAt < T_rotation + margin`. This is a read-only query. Remind customers at the PROPOSAL cadence of 14, 7 and 1 days before the end.
7. **Close the window** (§8 conditions): remove `API_KEY_PEPPER_PREVIOUS`, deploy and verify. A pre-rotation test key now fails with `401 invalid_api_key`, and a post-rotation key still works.
8. **Record closure** in the evidence log: approval, `T_rotation`, the window end, how many keys were replaced and how many were still outstanding (now invalid).

## 6. Overlap window

- **PROPOSAL: the window is at most 30 days** from `T_rotation`. The default is 30 days for a scheduled rotation. This matches `MAX_ROTATION_OVERLAP_SECONDS`, the per-key overlap cap, so a customer who rotates on the last day still gets a full key overlap within the window.
- The window **expires** when `API_KEY_PEPPER_PREVIOUS` is removed (§5 step 7). It is never extended without a new written owner approval, and never beyond 60 days in total (PROPOSAL).
- During the window, every request computes two HMACs. This cost is accepted and bounded.

## 7. Old credentials

- A key hashed under the previous pepper is verified **only while** `API_KEY_PEPPER_PREVIOUS` holds that pepper. Once the variable is removed or replaced, the key returns `401 invalid_api_key`, the same answer as any wrong key. It is never upgraded and never rehashed.
- Customers move only by **explicit replacement**: rotate (`api_key.rotated`) or create plus revoke (`api_key.created` + `api_key.revoked`). The successor is always minted under the current pepper.
- Consequence: **closing the window invalidates every un-replaced key created before the rotation.** A scheduled rotation therefore requires customer communication. It is a customer-visible event, not a silent operation.

## 8. Conditions for removing the previous pepper

Remove `API_KEY_PEPPER_PREVIOUS` only when **all** of these hold:

1. the window end date has been reached, **or** the owner approves an early close (for example, every old-pepper key has been replaced);
2. the §5 step 6 count has been taken and recorded, and the owner has accepted the outstanding keys becoming invalid;
3. no deployment still running in Production serves the old pepper as `API_KEY_PEPPER` (the promotion is complete).

## 9. Emergency: pepper compromise

When the current pepper is known or suspected to be exposed:

1. **Owner decision within the incident.** Revoke the pepper immediately. Set a new `API_KEY_PEPPER` and **do not** set `API_KEY_PEPPER_PREVIOUS` to the compromised value. **Every existing key becomes invalid at once** (`401 invalid_api_key`). This is intended: a leaked pepper plus a leaked `apiKeys` collection would let an attacker test guesses offline. A key's 256-bit secret still cannot be guessed, but the pepper can no longer be trusted.
2. If the API must stay up and the keys are not believed to be exposed, the owner may instead choose a **short** window (PROPOSAL: ≤ 72 hours) with the compromised pepper as previous. This is a documented risk acceptance, never the default.
3. **Communicate**: email every org owner and admin with live keys. The message says that keys were invalidated, why, and how to create new ones. Post a status page entry.
4. **Re-issue**: customers create new keys through the management plane (fresh session ≤ 15 minutes for live keys, audited). Support does not mint keys for customers.
5. **Investigate** the exposure path and record the incident (SOC 2 incident process). Also rotate any other secret exposed by the same path.

## 10. Audit requirements

- **In-product (Firestore, same transaction as the mutation; quality contract I-8):** every key replacement and revocation writes `api_key.rotated`, `api_key.created` or `api_key.revoked` in the **same** transaction (`store.ts`; emulator-proven exactly-once under 20-way races). Authentication writes **no** audit row and **no** other row (R-7).
- **Pepper changes are outside Firestore.** They are environment changes, recorded in the deployment evidence log (§5 steps 1, 4, 7 and 8) with the approver, the operator, times and deployment IDs. The pepper value never appears there; at most a SHA-256 fingerprint of the decoded value, truncated to 8 hex characters, is recorded.
- **PROPOSAL (later stage):** a system-actor audit event (`{ kind: "system" }` actor, already in the §6 shape) for "pepper rotation started" and "pepper window closed", written once per org with live keys. Not implemented in API-1a.

## 11. Rollback constraints

- Pepper generations only move forward. A pepper that has been **removed** (window closed) or **revoked** (compromise) is never reinstated. Reinstating it would revive keys that customers were told are dead, and in a compromise it would re-trust a leaked secret.
- **A Vercel deployment keeps the environment values it was created with.** A variable change applies only to new deployments, and an instant rollback serves the old deployment *with its old values*. So:
  - rolling back to a deployment created **before** `T_rotation` restores the old pepper as current, with no previous pepper. Every key minted after `T_rotation` then fails. This is forbidden during and after a rotation, unless the owner accepts that outage in writing;
  - rolling back, after the window closed, to a deployment created **during** the window reopens the window (it still has `API_KEY_PEPPER_PREVIOUS`). This is forbidden after a compromise, and needs owner approval otherwise;
  - a safe rollback target is a deployment created after the last pepper change (verify its creation time against the evidence log). Otherwise redeploy the desired code with the current variables.
- Keys minted under the new pepper are invalid on any deployment that does not have the new pepper. So never roll the *variables* back past `T_rotation`.
- **PROPOSAL (gate before the first real rotation, not before #327 merges):** add a pepper-generation marker to new key records, for example `pepperGen` (an integer that increases monotonically) or a short pepper fingerprint. It would replace the `createdAt` heuristic in §5 step 6, and it is the prerequisite for any future lazy rehash. That is a separately approved change, because it alters the pinned record shape (`recordShapes.spec.ts`).

## 12. Deferred, and why

- **Code-enforced window expiry**, for example a `…_PREVIOUS_NOT_AFTER` timestamp: this would add a new environment variable name and a reader to the secret boundary. Under the ruling ("bounded … during an approved rotation period") the bound is an operator action with owner approval (§5–§8), so code enforcement is not required to satisfy R-7. The change is small, but it adds a new secret name. It needs its own approval because it changes the pinned secret-name list (`secretBoundary.spec.ts`).
- **Lazy rehash-on-read**: deferred by R-7.
- **`pepperGen` marker**: §11 PROPOSAL.

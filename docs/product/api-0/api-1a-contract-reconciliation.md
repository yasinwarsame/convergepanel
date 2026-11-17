# API-1a contract reconciliation (D-1, C-2)

**Status:** reconciliation record for draft PR #327 (`feat/api-1a-foundation`). The API-0 docs are reviewed in #325 (CLEAN at `75c2b86`) and are **not** edited here. This file lists every place where the API-1a code and the agreed contract (`docs/product/api-0/tenancy-and-auth.md` and `docs/product/api-platform-prd.md` at #325 `75c2b86`) differ, the resolution, and the exact doc text to amend in a follow-up docs PR after #325 merges.

Source of the findings: `ConvergePanel-Deployment-Evidence/2026-11-17-api-v1/03-quality-and-acceptance-contract.md` §9 (C-2, D-1).

Field names are pinned by `lib/apiPlatform/__tests__/recordShapes.spec.ts`. Changing one is a reviewed change to that spec, to this file and to the doc.

## A. Renamed in code to match the doc (no doc change needed)

| ID | Record | Before (code) | After (code = doc) | Doc reference |
|---|---|---|---|---|
| R-1 | `apiAuditEvents` | `type`, `at`, `subject` | `eventType`, `createdAt`, `target` | tenancy-and-auth §6 |
| R-2 | `apiKeys` | `verifier` | `hash` (with `hashVersion: 1`) | tenancy-and-auth §7; PRD §7.2 |
| R-3 | `apiOrganizations` | `apiPlan` | `plan` | tenancy-and-auth §7; PRD §12.1 |
| R-3a | `apiOrgMemberships` | `createdAt` | `addedAt`, plus `addedBy` and `inviteId` (`null` for the founding owner) | tenancy-and-auth §7 |

The audit `actor` keeps the §6 shape `{ kind: "user", uid } | { kind: "system" }` (`{ kind: "operator", uid }` arrives with the OD-13 support view). `target` stays identifier-only.

A record still carrying a pre-reconciliation name is refused: a key with `verifier` and no `hash` is `invalid_api_key`, and an org with `apiPlan` and no `plan` has no plan (`live_key_requires_plan`). No such record exists, because no API-1a code has run against any real database.

## B. Intentional differences: the doc must be amended after #325 merges

### R-4. Key hash construction

- **Code:** `hash = hex(HMAC-SHA256(HKDF-SHA256(pepper, info = "cp-api/key-verifier/v1"), "<mode>:<keyId>:<secret>"))`, with `hashVersion: 1` (`lib/apiPlatform/keys.ts`, `lib/apiPlatform/secrets.server.ts`).
- **Doc:** `hash = HMAC-SHA-256(pepper, secret)`.
- **Why:** the HKDF subkey keeps the raw pepper to one purpose, so the same secret can derive the list-cursor key (`cp-api/list-cursor/v1`) without key reuse (secret-boundary.md §3). Putting `mode` and `keyId` in the MAC input binds a hash to its key, so a stored hash cannot be replayed onto another key ID or mode.
- **Resolution:** keep the code. `hashVersion: 1` names this construction, and the principal refuses any other `hashVersion`.
- **Amend** tenancy-and-auth.md §4.2, first line: replace `` `hash = HMAC-SHA-256(pepper, secret)`, stored as hex with `hashVersion`. `` with `` `hash = hex(HMAC-SHA-256(HKDF-SHA-256(pepper, "cp-api/key-verifier/v1"), "<mode>:<keyId>:<secret>"))`, stored with `hashVersion: 1`. ``
- **Amend** PRD §7.2, Storage bullet: replace `` `hash = HMAC-SHA256(API_KEY_PEPPER, secret)` `` with `` `hash = HMAC-SHA256(HKDF(API_KEY_PEPPER, "cp-api/key-verifier/v1"), "<mode>:<keyId>:<secret>")` (`hashVersion: 1`) ``.

### R-5. Added capabilities

- **Code** (`lib/apiPlatform/orgCapabilities.ts`): adds `keys.orgWide.create` (owner, admin), `keys.revoke.own` (owner, admin, developer) and `settings.pipelineProcessing` (owner, admin; fresh session).
- **Doc §2 matrix:** has none of these. It expresses "developer: own keys" as a cell of `keys.revoke`. It states the org-wide rule only in PRD §7.3 ("unless created org-wide by an owner or admin").
- **Why:** each rule needs a named capability so `roleHasCapability` can enforce it in the store (defence in depth). `keys.revoke.own` makes the developer's "own keys" cell checkable. `keys.orgWide.create` enforces PRD §7.3. `settings.pipelineProcessing` is the owner/admin right to record or withdraw the org's Gemini pipeline-processing acknowledgement (Addendum 1 D6; checked by API-3 as `403 pipeline_processing_not_acknowledged`).
- **Not yet implemented from the doc:** `webhooks.manage`, `billing.manage`, `settings.retention`, `settings.modelResponseAccess`, `data.delete`, and the `developersMayCreateLiveKeys` org setting. They arrive with their stages. Until then a developer can never create a live key.
- **Amend** tenancy-and-auth.md §2. In the matrix, add these rows: `keys.orgWide.create` (✅ ✅ — — —); `keys.revoke.own` (✅ ✅ ✅ — —), with the `keys.revoke` row's developer cell changed from "own keys" to "—"; `settings.pipelineProcessing` (✅ ✅ — — —). Add `settings.pipelineProcessing` to the fresh-session list in §3.

### R-6. Rotation semantics

- **Code** (`rotateApiKey`): (a) a key rotates **once**: a second rotation is `already_rotated`, and under 20 parallel rotations exactly one commits (emulator-proven); (b) the successor keeps the original key's `expiresAt`, so it never outlives it; (c) the old key's overlap is capped at 30 days and never extends an earlier expiry; (d) `overlapSeconds = 0` revokes the old key immediately (`revokedAt`/`revokedBy` set); (e) the old key records `rotatedTo`.
- **Doc §4.5:** "create new key → customer deploys → revoke old. Optional `expiresAt` on the old key for overlap (max 30 days)." It says nothing about once-only rotation, successor expiry, overlap 0 or `rotatedTo`.
- **Resolution:** keep the code.
- **Amend** tenancy-and-auth.md §4.5, Rotate bullet, to read: "**Rotate:** one transaction creates the successor (same app, mode, scopes and `appScoped`, and the original's `expiresAt`) and sets the old key's `rotatedTo` and `expiresAt = min(existing expiry, now + overlap)`, with overlap ≤ 30 days. Overlap 0 revokes the old key at once. A key rotates at most once. Audit `api_key.rotated`." Also add `api_key.rotated` to the §6 event table, and add `rotatedTo` to the §7 `apiKeys` key fields.

### R-7. Previous-pepper hashes are not upgraded on use (known limitation: OWNER DECISION REQUIRED)

- **Doc §4.2:** "each successful verify under the old pepper rewrites the hash under the new one."
- **Code:** a key whose hash was made under `API_KEY_PEPPER_PREVIOUS` verifies during the rotation window (both peppers are always computed, for equal timing), but its hash is **not** rewritten. Once the previous pepper is removed, such a key stops working.
- **Why not implemented in API-1a:** a lazy rehash is a write on the data-plane hot path. It needs a transaction against concurrent revoke/rotate, so a rewrite cannot resurrect a revoked key. It would also need a pepper generation marker, because `hashVersion` names the algorithm, not the pepper. That fits API-1b/API-3, where the data plane and `lastUsedAt` sampling exist.
- **Owner decision required**, one of:
  1. *Lazy rehash* (the doc as written), added in API-1b with a pepper-generation field and a transactional rewrite;
  2. *No rehash*: pepper rotation requires every key to be rotated within the window. Amend §4.2 to "Rotation: `API_KEY_PEPPER_PREVIOUS` is accepted during a window; keys must be rotated before the previous pepper is removed. Hashes are not rewritten on use."
- Until decided, removing `API_KEY_PEPPER_PREVIOUS` invalidates every key minted before the pepper rotation.

### R-8. Optional key fields are stored as explicit `null`

- **Doc §7:** `expiresAt?`, `revokedAt?`, `revokedBy?` (optional).
- **Code:** they are always present, `null` when unset. The principal **requires** `revokedAt === null` for a usable key, so a record with `revokedAt` missing (malformed) is refused, never treated as unrevoked. `lastUsedAt` is not written in API-1a (no data plane yet).
- **Amend** tenancy-and-auth.md §7, `apiKeys` row: replace `expiresAt?`, `revokedAt?`, `revokedBy?` with `expiresAt`, `revokedAt`, `revokedBy`, `rotatedTo` (each `null` when unset; a missing `revokedAt` is malformed and refused).

### R-9. Extra stored identifiers

The documents also store their own ID (`orgId` on orgs, `appId` on apps, `keyId` on keys, `membershipId` on memberships, `auditId` on audit rows), plus `createdBy` on applications. The guards compare the stored ID with the looked-up one, so a document copied to another path is refused. Audit `target` may also carry `membershipRole` (`member.added`) and `replacedCredentialPrefix` (`api_key.rotated`). Both are identifiers, never secrets.
- **Amend** tenancy-and-auth.md §7: add a sentence under the table: "Each document also stores its own ID field, which the guards compare against the path."

### R-10. Management identity (C-2) and `identity_not_verified`

- **Doc §3:** management routes authenticate "only with the existing Firebase session through `resolveRequestIdentity()`". PRD §7.4 says the same.
- **Code:** `resolveRequestIdentity()` returns no `auth_time` and no account state, and it verifies bearers without revocation checking. So the 15-minute rule could not be fed from it (audit C-2). API-1a adds `lib/auth/resolveManagementIdentity.ts`. It applies the same strict cookie/bearer rules (a parity spec runs both resolvers on every combination), verifies with revocation checking, takes `auth_time` only from the verified token, and reads the live account: `disabled === false`, plus `emailVerified === true` for **every** org management capability. `resolveRequestIdentity()` is unchanged.
- **New error code:** `403 identity_not_verified` ("Verify your email address to perform this action."). A disabled or deleted account returns `401 session_required`, the same as no session, so account existence is not revealed. A `getUser` failure returns `503 api_unavailable`.
- **Amend** tenancy-and-auth.md §3, first bullet: replace "through `resolveRequestIdentity()` (`lib/auth/resolveRequestIdentity.ts`: cookie `__session` or bearer ID token, fails closed on mismatch)" with "through `resolveManagementIdentity()` (`lib/auth/resolveManagementIdentity.ts`): the `resolveRequestIdentity()` cookie/bearer consistency rules, verification with revocation checking, `auth_time` from the verified token, and a live account read requiring `disabled === false` and `emailVerified === true` (`403 identity_not_verified`)". Make the same change in PRD §7.4, and add `identity_not_verified` to the PRD §9.5 error table and the OpenAPI error catalog (audit C-4).

## C. Not differences (checked)

- Collections: `apiOrganizations`, `apiApplications`, `apiKeys`, `apiOrgMemberships`, `apiAuditEvents` match §7.
- Audit is written in the same transaction as the mutation (§6), proven against the emulator (`store.emulator.spec.ts`). The 20-way rotate and revoke races each produce exactly one audit row.
- `plan` has no shape in the doc. API-1a stores `{ planId, status }` and enables live keys only for a compile-time-approved `planId` (`lib/apiPlatform/apiPlans.ts`, currently empty). If the docs PR wants to document the shape, add to §7: "`plan`: `{ planId, status: "active" | "inactive" } | null`".

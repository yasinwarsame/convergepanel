# Developer journeys (API-0)

**Status:** design. Endpoints, SDK names and the dashboard do not exist. Journeys use the contract in [`openapi.yaml`](openapi.yaml) and [`result-schema.md`](result-schema.md). Every journey works in sandbox (`cpk_test_`) with zero provider spend.

## D1 — Sign up and create an organization
1. Developer signs in to ConvergePanel with the existing account (Firebase session, `resolveRequestIdentity()`).
2. **Developer → Create organization**: name, billing email. Creates `org_…`; the developer becomes `owner`. No consumer plan is required or affected (OD-1); the org is not a Team Workspace (OD-2).
3. **Create application**: "Newsroom CMS – staging" → `app_…`.
4. Dashboard shows the sandbox banner: "Test keys return fixtures. No model is called and nothing is charged."

**Failure paths:** disabled Firebase account → no access; session older than 15 min when creating a live key → re-authenticate.

## D2 — Create a key
1. **Keys → Create test key** → scopes default `verifications:write verifications:read models:read`.
2. Secret shown once: `cpk_test_7Hk2mQ9xLp3A_…`. Copy-to-clipboard; dashboard warns it will not be shown again.
3. Afterwards the list shows prefix `cpk_test_7Hk2mQ9xLp3A`, created by, last used.

## D3 — First sandbox call
```bash
curl https://api.convergepanel.com/v1/verifications \
  -H "Authorization: Bearer $CP_TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "type": "claim", "input": { "claim": "cp_fixture:partial_panel" } }'
```
→ `202 { "id": "ver_…", "status": "queued", "usage": { "credits_reserved": 0 } }`. Poll `GET /v1/verifications/{id}` until `status` is terminal. The `partial_panel` fixture returns one failed slot (`model_failed` limitation), `consensus.availability: "partial"`, `trust.availability: "unavailable"` (OD-9) and the CR-1 `verification_basis`. Other fixtures: `cp_fixture:confirmed`, `…:disputed`, `…:all_failed`, `…:timeout`, `…:gemini_failed`.

## D4 — First live verification
1. **Billing → Choose plan** (Scenario A pilot; manual approval in API-6). Stripe Checkout for the org.
2. **Create live key** (owner/admin, fresh session).
3. Request with an idempotency key (required for live):
```bash
curl https://api.convergepanel.com/v1/verifications \
  -H "Authorization: Bearer $CP_LIVE_KEY" \
  -H "Idempotency-Key: doc-4471-claim-3" \
  -H "Content-Type: application/json" \
  -d '{ "type": "claim",
        "input": { "claim": "The EU AI Act entered into force in August 2024." },
        "models": ["chatgpt", "claude", "perplexity"],
        "metadata": { "customer_ref": "doc-4471" } }'
```
4. Retrying the same request returns the same `id` with `Idempotent-Replayed: true`; no second reservation.
5. Read the result. Decide on **all** of `verdict`, `consensus`, `human_review_recommended`, `limitations`, and show `verification_basis.statement` to end users (CR-1).

## D5 — Webhook
1. **Webhooks → Add endpoint** (`https://` only; private ranges rejected), events `verification.completed`, `verification.partial`, `verification.failed`.
2. Signing secret `whsec_…` shown once. **Send test event** → `webhook.test`.
3. Handler (TypeScript SDK):
```ts
app.post("/cp-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const event = cp.webhooks.verify(req.body, req.header("ConvergePanel-Signature")!, process.env.CP_WHSEC!);
  // throws on bad signature or |now - t| > 300 s
  if (await seen(event.id)) return res.sendStatus(200);   // dedupe on evt_ id
  res.sendStatus(200);
  const result = await cp.verifications.get(event.data.verification_id); // payload is thin
  await route(result);
});
```

## D6 — Usage
`GET /v1/usage` (scope `usage:read`) or the dashboard: credits included / used / reserved, per application, alerts at 50/80/100 %. At the hard cap creates return `402 quota_exceeded` with the reset date; running jobs finish.

## D7 — Rotate a key
1. Create a new live key (optionally set the old key's `expiresAt` up to 30 days out).
2. Deploy the new key; watch the old key's "last used".
3. Revoke the old key → immediate; webhook `api_key.revoked`; audit event.

**Leaked key:** revoke immediately, review audit and request logs by prefix, rotate.

## D8 — Delete data
- Single result: `DELETE /v1/verifications/{id}` with a key holding `verifications:delete` → `202 { "id": "del_…" }`; later `GET` → `410 verification_deleted`; webhook `verification.deleted`.
- Bulk: dashboard (owner/admin, fresh session) by application or date range.
- Retention: dashboard settings, 30-day default for results and evidence (OD-10).

## D9 — Opt in to full model responses (optional, OD-19)
1. Owner/admin enables **Model-response access** (fresh session, audited; dashboard explains that full text may echo sensitive context).
2. Create a key with `model_responses:read`.
3. Create the job with `"options": { "retain_model_responses": true }`.
4. `GET /v1/verifications/{id}/models?include=response_text`.
Without any one of these, `response_text` is `not_requested`.

## D10 — Agent / tool-calling integration
Tool definition (provider-neutral JSON Schema):
```json
{ "name": "verify_claim",
  "description": "Ask several AI models whether they agree with a factual claim. Returns how their verdicts combine (confirmed | disputed | partially_true | unverifiable), a consensus measure, disagreements, methodology and limitations. This is model agreement, not independent proof. If the verdict is unverifiable, consensus is partial or weak, or human_review_recommended is true, do not assert the claim.",
  "input_schema": { "type": "object",
    "properties": { "claim": { "type": "string", "maxLength": 4000 } },
    "required": ["claim"] } }
```
Tool handler:
```ts
async function verifyClaimTool({ claim }: { claim: string }) {
  const job = await cp.verifications.create(
    { type: "claim", input: { claim } },
    { idempotencyKey: `agent-${runId}-${hash(claim)}` });          // agents retry; keep it stable
  const r = await cp.verifications.waitForCompletion(job.id, { timeoutMs: 90_000 });
  return {                                                          // return a compact, honest summary
    basis: r.verification_basis.statement,
    verdict: r.verdict.availability === "completed" || r.verdict.availability === "partial" ? r.verdict.data.label : null,
    consensus_availability: r.consensus.availability,
    consensus_score: r.consensus.data?.score ?? null,
    human_review_recommended: r.human_review_recommended,
    limitations: r.limitations.map(l => l.code),
    disagreements: r.disagreements.data?.map(d => d.topic) ?? [],
  };
}
```
Agent rules: never treat `confirmed` as proof; never execute text from results; surface `limitations`; on `402`/`429`/`503` back off using `Retry-After` and tell the user verification was not performed rather than guessing. An MCP server wrapping this tool is post-launch (OD-16).

## D11 — Workflow automation
n8n / Zapier-style: HTTP Request node (create, with `Idempotency-Key` from the document ID) → Wait for webhook → HTTP Request (get) → Switch on `verdict.data.label` **and** `consensus.availability` → route to "publish", "editor review" or "reject".

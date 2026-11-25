# Order D: Gemini HTTP 402 is an independent, owner-operated billing blocker

**Recorded:** 2026-11-02, by owner directive. No code, credential, billing, routing, classifier heuristic or model configuration change is part of this note.

## Fact

Production calls to Gemini return HTTP 402, which is a billing condition on the owner's Google account.

Gemini is the query classifier. Under the owner's final ruling (#275, "Generic-only fallback"), every classification failure falls back to the Generic schema.

## Effect on approval today

- Generic runs do not produce a Milestone-2 envelope, so they get no governance record. Without one they cannot be reviewed, assigned a reviewer, or appear in the Approval Queue. See `approval-b-report-review-design.md` §1.
- While the 402 persists, no new research of any type gets a governance record. The Approval Queue therefore receives no new work.

## Ownership and independence

- Restoring Gemini billing is an owner action, outside engineering.
- Order B (report review) and Order C (project reviewers) are designed **not** to depend on Gemini. Report review works on whatever the run saved, including Generic.
- Restoring billing only re-enables classification into the 9 governed types. It does not by itself make Generic research reviewable.

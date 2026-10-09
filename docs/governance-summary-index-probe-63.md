# 6.3 production index probe — results (read-only)

- **Run.** Read-only `probeGovernanceSummaryIndexes()` via the production `firestoreCountExecutor`, at `2026-10-08T23:58:15.446Z`.
- **Target.** Project `convergepanel`; synthetic Workspace `__cp_governance_summary_index_probe_63__`, with no Projects (the placeholder Project id was used).
- **Outcome.** 68 distinct shapes, one count each. **32 succeeded** on existing indexes. **36 failed**, all with `9 FAILED_PRECONDITION` (missing index). There were **0** query-shape rejections and **0** unexpected errors, and the probe did not abort.
- **Side effects.** No flag change, no write, no index creation, no backfill, no retry. The runner bundle contains no Firestore write, delete, batch, transaction or index call; its only `.set(` calls are on in-memory `Map`s.

## Unique required composite indexes (18), decoded from Firestore's own `create_composite` payloads

Every index is `COLLECTION` scope with all fields `ASCENDING`. Firestore's own field order is shown, including its implicit `__name__` suffix, which is not specified in an index definition. **None is created; each requires separate authorization.**

| # | Collection | Exact ordered fields (Firestore) | Query shapes requiring it |
|---|---|---|---|
| 1 | `runs` | `governanceStatus`, `projectId`, `status`, `workspaceId`, `governanceReviewedAt`, `__name__` | workspaceId == W ∧ status == "complete" ∧ governanceStatus == <status> ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ status == "complete" ∧ governanceStatus == <status> ∧ governanceReviewedAt > "" ∧ projectId in [Project batch] |
| 2 | `runs` | `adaptiveOutput.version`, `governanceStatus`, `projectId`, `status`, `workspaceId`, `governanceReviewedAt`, `__name__` | workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceStatus == <status> ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceStatus == <status> ∧ governanceReviewedAt > "" ∧ projectId in [Project batch] |
| 3 | `runs` | `projectId`, `status`, `workspaceId`, `governanceStatus`, `__name__` | workspaceId == W ∧ status == "complete" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ projectId == null<br>workspaceId == W ∧ status == "complete" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ projectId == <Project> |
| 4 | `runs` | `adaptiveOutput.version`, `projectId`, `status`, `workspaceId`, `governanceStatus`, `__name__` | workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ projectId == null<br>workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ projectId == <Project> |
| 5 | `runs` | `projectId`, `status`, `workspaceId`, `governanceReviewedAt`, `governanceStatus`, `__name__` | workspaceId == W ∧ status == "complete" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ status == "complete" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ governanceReviewedAt > "" ∧ projectId == <Project> |
| 6 | `runs` | `adaptiveOutput.version`, `projectId`, `status`, `workspaceId`, `governanceReviewedAt`, `governanceStatus`, `__name__` | workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ governanceReviewedAt > "" ∧ projectId == <Project> |
| 7 | `runs` | `projectId`, `status`, `workspaceId`, `governanceReviewedAt`, `__name__` | workspaceId == W ∧ status == "complete" ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ status == "complete" ∧ governanceReviewedAt > "" ∧ projectId in [Project batch] |
| 8 | `runs` | `adaptiveOutput.version`, `projectId`, `status`, `workspaceId`, `governanceReviewedAt`, `__name__` | workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceReviewedAt > "" ∧ projectId in [Project batch] |
| 9 | `runs` | `adaptiveOutput.version`, `projectId`, `status`, `workspaceId`, `governanceRecord.automatedGovernance.status`, `__name__` | workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.automatedGovernance.status not-in ["passed","flagged","blocked","not_evaluated","error"] ∧ projectId == null<br>workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.automatedGovernance.status not-in ["passed","flagged","blocked","not_evaluated","error"] ∧ projectId == <Project> |
| 10 | `runs` | `adaptiveOutput.version`, `projectId`, `status`, `workspaceId`, `governanceRecord.humanReview.status`, `__name__` | workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.humanReview.status not-in ["unreviewed","pending","approved","approved_with_conditions","changes_requested","rejected"] ∧ projectId == null<br>workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.humanReview.status not-in ["unreviewed","pending","approved","approved_with_conditions","changes_requested","rejected"] ∧ projectId == <Project> |
| 11 | `verifications` | `governanceStatus`, `projectId`, `type`, `workspaceId`, `governanceReviewedAt`, `__name__` | workspaceId == W ∧ type == "claim_verification" ∧ governanceStatus == <status> ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ type == "claim_verification" ∧ governanceStatus == <status> ∧ governanceReviewedAt > "" ∧ projectId in [Project batch] |
| 12 | `verifications` | `projectId`, `type`, `workspaceId`, `governanceStatus`, `__name__` | workspaceId == W ∧ type == "claim_verification" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ projectId == null<br>workspaceId == W ∧ type == "claim_verification" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ projectId == <Project> |
| 13 | `verifications` | `projectId`, `type`, `workspaceId`, `governanceReviewedAt`, `governanceStatus`, `__name__` | workspaceId == W ∧ type == "claim_verification" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ type == "claim_verification" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ governanceReviewedAt > "" ∧ projectId == <Project> |
| 14 | `verifications` | `projectId`, `type`, `workspaceId`, `governanceReviewedAt`, `__name__` | workspaceId == W ∧ type == "claim_verification" ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ type == "claim_verification" ∧ governanceReviewedAt > "" ∧ projectId in [Project batch] |
| 15 | `videoVerifications` | `governanceStatus`, `projectId`, `type`, `workspaceId`, `governanceReviewedAt`, `__name__` | workspaceId == W ∧ type == "video_verification" ∧ governanceStatus == <status> ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ type == "video_verification" ∧ governanceStatus == <status> ∧ governanceReviewedAt > "" ∧ projectId in [Project batch] |
| 16 | `videoVerifications` | `projectId`, `type`, `workspaceId`, `governanceStatus`, `__name__` | workspaceId == W ∧ type == "video_verification" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ projectId == null<br>workspaceId == W ∧ type == "video_verification" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ projectId == <Project> |
| 17 | `videoVerifications` | `projectId`, `type`, `workspaceId`, `governanceReviewedAt`, `governanceStatus`, `__name__` | workspaceId == W ∧ type == "video_verification" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ type == "video_verification" ∧ governanceStatus not-in ["approved","needs_review","blocked"] ∧ governanceReviewedAt > "" ∧ projectId == <Project> |
| 18 | `videoVerifications` | `projectId`, `type`, `workspaceId`, `governanceReviewedAt`, `__name__` | workspaceId == W ∧ type == "video_verification" ∧ governanceReviewedAt > "" ∧ projectId == null<br>workspaceId == W ∧ type == "video_verification" ∧ governanceReviewedAt > "" ∧ projectId in [Project batch] |

## Firestore error that requested each index (verbatim)

**#1** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGhQKEGdvdmVybmFuY2VTdGF0dXMQARoNCglwcm9qZWN0SWQQARoKCgZzdGF0dXMQARoPCgt3b3Jrc3BhY2VJZBABGhgKFGdvdmVybmFuY2VSZXZpZXdlZEF0EAEaDAoIX19uYW1lX18QAQ
```
**#2** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGhoKFmFkYXB0aXZlT3V0cHV0LnZlcnNpb24QARoUChBnb3Zlcm5hbmNlU3RhdHVzEAEaDQoJcHJvamVjdElkEAEaCgoGc3RhdHVzEAEaDwoLd29ya3NwYWNlSWQQARoYChRnb3Zlcm5hbmNlUmV2aWV3ZWRBdBABGgwKCF9fbmFtZV9fEAE
```
**#3** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGg0KCXByb2plY3RJZBABGgoKBnN0YXR1cxABGg8KC3dvcmtzcGFjZUlkEAEaFAoQZ292ZXJuYW5jZVN0YXR1cxABGgwKCF9fbmFtZV9fEAE
```
**#4** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGhoKFmFkYXB0aXZlT3V0cHV0LnZlcnNpb24QARoNCglwcm9qZWN0SWQQARoKCgZzdGF0dXMQARoPCgt3b3Jrc3BhY2VJZBABGhQKEGdvdmVybmFuY2VTdGF0dXMQARoMCghfX25hbWVfXxAB
```
**#5** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGg0KCXByb2plY3RJZBABGgoKBnN0YXR1cxABGg8KC3dvcmtzcGFjZUlkEAEaGAoUZ292ZXJuYW5jZVJldmlld2VkQXQQARoUChBnb3Zlcm5hbmNlU3RhdHVzEAEaDAoIX19uYW1lX18QAQ .
The query contains range and inequality filters on multiple fields, please refer to the documentation for index selection best practices: https://cloud.google.com/firestore/docs/query-data/multiple-range-fields.
```
**#6** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGhoKFmFkYXB0aXZlT3V0cHV0LnZlcnNpb24QARoNCglwcm9qZWN0SWQQARoKCgZzdGF0dXMQARoPCgt3b3Jrc3BhY2VJZBABGhgKFGdvdmVybmFuY2VSZXZpZXdlZEF0EAEaFAoQZ292ZXJuYW5jZVN0YXR1cxABGgwKCF9fbmFtZV9fEAE .
The query contains range and inequality filters on multiple fields, please refer to the documentation for index selection best practices: https://cloud.google.com/firestore/docs/query-data/multiple-range-fields.
```
**#7** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGg0KCXByb2plY3RJZBABGgoKBnN0YXR1cxABGg8KC3dvcmtzcGFjZUlkEAEaGAoUZ292ZXJuYW5jZVJldmlld2VkQXQQARoMCghfX25hbWVfXxAB
```
**#8** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGhoKFmFkYXB0aXZlT3V0cHV0LnZlcnNpb24QARoNCglwcm9qZWN0SWQQARoKCgZzdGF0dXMQARoPCgt3b3Jrc3BhY2VJZBABGhgKFGdvdmVybmFuY2VSZXZpZXdlZEF0EAEaDAoIX19uYW1lX18QAQ
```
**#9** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGhoKFmFkYXB0aXZlT3V0cHV0LnZlcnNpb24QARoNCglwcm9qZWN0SWQQARoKCgZzdGF0dXMQARoPCgt3b3Jrc3BhY2VJZBABGi8KK2dvdmVybmFuY2VSZWNvcmQuYXV0b21hdGVkR292ZXJuYW5jZS5zdGF0dXMQARoMCghfX25hbWVfXxAB
```
**#10** `runs`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Ckpwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy9ydW5zL2luZGV4ZXMvXxABGhoKFmFkYXB0aXZlT3V0cHV0LnZlcnNpb24QARoNCglwcm9qZWN0SWQQARoKCgZzdGF0dXMQARoPCgt3b3Jrc3BhY2VJZBABGicKI2dvdmVybmFuY2VSZWNvcmQuaHVtYW5SZXZpZXcuc3RhdHVzEAEaDAoIX19uYW1lX18QAQ
```
**#11** `verifications`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=ClNwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy92ZXJpZmljYXRpb25zL2luZGV4ZXMvXxABGhQKEGdvdmVybmFuY2VTdGF0dXMQARoNCglwcm9qZWN0SWQQARoICgR0eXBlEAEaDwoLd29ya3NwYWNlSWQQARoYChRnb3Zlcm5hbmNlUmV2aWV3ZWRBdBABGgwKCF9fbmFtZV9fEAE
```
**#12** `verifications`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=ClNwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy92ZXJpZmljYXRpb25zL2luZGV4ZXMvXxABGg0KCXByb2plY3RJZBABGggKBHR5cGUQARoPCgt3b3Jrc3BhY2VJZBABGhQKEGdvdmVybmFuY2VTdGF0dXMQARoMCghfX25hbWVfXxAB
```
**#13** `verifications`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=ClNwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy92ZXJpZmljYXRpb25zL2luZGV4ZXMvXxABGg0KCXByb2plY3RJZBABGggKBHR5cGUQARoPCgt3b3Jrc3BhY2VJZBABGhgKFGdvdmVybmFuY2VSZXZpZXdlZEF0EAEaFAoQZ292ZXJuYW5jZVN0YXR1cxABGgwKCF9fbmFtZV9fEAE .
The query contains range and inequality filters on multiple fields, please refer to the documentation for index selection best practices: https://cloud.google.com/firestore/docs/query-data/multiple-range-fields.
```
**#14** `verifications`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=ClNwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy92ZXJpZmljYXRpb25zL2luZGV4ZXMvXxABGg0KCXByb2plY3RJZBABGggKBHR5cGUQARoPCgt3b3Jrc3BhY2VJZBABGhgKFGdvdmVybmFuY2VSZXZpZXdlZEF0EAEaDAoIX19uYW1lX18QAQ
```
**#15** `videoVerifications`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Clhwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy92aWRlb1ZlcmlmaWNhdGlvbnMvaW5kZXhlcy9fEAEaFAoQZ292ZXJuYW5jZVN0YXR1cxABGg0KCXByb2plY3RJZBABGggKBHR5cGUQARoPCgt3b3Jrc3BhY2VJZBABGhgKFGdvdmVybmFuY2VSZXZpZXdlZEF0EAEaDAoIX19uYW1lX18QAQ
```
**#16** `videoVerifications`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Clhwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy92aWRlb1ZlcmlmaWNhdGlvbnMvaW5kZXhlcy9fEAEaDQoJcHJvamVjdElkEAEaCAoEdHlwZRABGg8KC3dvcmtzcGFjZUlkEAEaFAoQZ292ZXJuYW5jZVN0YXR1cxABGgwKCF9fbmFtZV9fEAE
```
**#17** `videoVerifications`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Clhwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy92aWRlb1ZlcmlmaWNhdGlvbnMvaW5kZXhlcy9fEAEaDQoJcHJvamVjdElkEAEaCAoEdHlwZRABGg8KC3dvcmtzcGFjZUlkEAEaGAoUZ292ZXJuYW5jZVJldmlld2VkQXQQARoUChBnb3Zlcm5hbmNlU3RhdHVzEAEaDAoIX19uYW1lX18QAQ .
The query contains range and inequality filters on multiple fields, please refer to the documentation for index selection best practices: https://cloud.google.com/firestore/docs/query-data/multiple-range-fields.
```
**#18** `videoVerifications`
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/convergepanel/firestore/indexes?create_composite=Clhwcm9qZWN0cy9jb252ZXJnZXBhbmVsL2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy92aWRlb1ZlcmlmaWNhdGlvbnMvaW5kZXhlcy9fEAEaDQoJcHJvamVjdElkEAEaCAoEdHlwZRABGg8KC3dvcmtzcGFjZUlkEAEaGAoUZ292ZXJuYW5jZVJldmlld2VkQXQQARoMCghfX25hbWVfXxAB
```

## Production creation and post-creation proof (owner-authorized)

- **Re-list before creating.** Production had 32 indexes and none of the 18. A non-vacuity control confirmed the comparison does match an existing index.
- **Creation.** Each of the 18 was created as its own targeted Firestore Admin v1 `POST`, with no `firebase deploy` and no delete or modify. The feature flag was not set in any Vercel environment.
- **State.** All 18 reached `READY`. Production now has **50** indexes, and `firestore.indexes.json` holds the identical set: 50 = 50, none only in one, none not READY.
- **Probe re-run** at `2026-10-09T08:47:13.805Z`, same synthetic Workspace: **68/68 shapes succeeded**. There were 0 missing-index, 0 query-shape and 0 unexpected failures, the probe did not abort, and every count was 0 (no real data). No 19th index was requested.

| # | Production index resource | State |
|---|---|---|
| 1 | `collectionGroups/runs/indexes/CICAgNjaxJEK` | READY |
| 2 | `collectionGroups/runs/indexes/CICAgPj-pYIK` | READY |
| 3 | `collectionGroups/runs/indexes/CICAgPigw5IK` | READY |
| 4 | `collectionGroups/runs/indexes/CICAgPigw5IJ` | READY |
| 5 | `collectionGroups/runs/indexes/CICAgLjy1YQK` | READY |
| 6 | `collectionGroups/runs/indexes/CICAgNirk5QK` | READY |
| 7 | `collectionGroups/runs/indexes/CICAgJjm4YQK` | READY |
| 8 | `collectionGroups/runs/indexes/CICAgLiTpokK` | READY |
| 9 | `collectionGroups/runs/indexes/CICAgPi9lIEK` | READY |
| 10 | `collectionGroups/runs/indexes/CICAgPi9ipAK` | READY |
| 11 | `collectionGroups/verifications/indexes/CICAgNir940K` | READY |
| 12 | `collectionGroups/verifications/indexes/CICAgNjp84oK` | READY |
| 13 | `collectionGroups/verifications/indexes/CICAgJjmtZUK` | READY |
| 14 | `collectionGroups/verifications/indexes/CICAgNjpr5sK` | READY |
| 15 | `collectionGroups/videoVerifications/indexes/CICAgPi97okK` | READY |
| 16 | `collectionGroups/videoVerifications/indexes/CICAgPiftYMK` | READY |
| 17 | `collectionGroups/videoVerifications/indexes/CICAgLjyi5UK` | READY |
| 18 | `collectionGroups/videoVerifications/indexes/CICAgPi9-ZgK` | READY |

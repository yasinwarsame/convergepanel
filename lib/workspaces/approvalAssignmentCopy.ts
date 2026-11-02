/**
 * Approval-assignment clarity (owner Order A, 2026-11-02). One source for the copy that tells users which control
 * assigns RESPONSIBILITY and which one asks someone to APPROVE.
 *
 * Presentation only. Nothing here changes who can see or do anything, what is stored, or how the Approval Queue reads
 * assignments:
 *   - Project "Manage assignees" writes projects/{id}.assigneeUids (responsibility).
 *   - Research "Assign" writes runs/{id}.assigneeUid (responsibility).
 *   - "Assign reviewer" on the research's review page writes runs/{id}/humanReviewAssignment/current, the only record
 *     the Approval Queue's "Assigned to me" tab reads.
 * Approval review needs the research to have a review record (today only some result types do); without one the
 * review page cannot offer "Assign reviewer".
 */

export const PROJECT_ASSIGNMENT_EXPLANATION =
  "Assigning people here marks who is responsible for this Project. It does not make anyone an approver or request approval, and it does not change what anyone can see or do.";

export const RESEARCH_ASSIGNMENT_EXPLANATION =
  "Assigning research marks who is responsible for it. It is not an approval request: to ask someone to approve research, use “Assign reviewer” on its review page. Assignment does not change what anyone can see or do.";

export const REVIEWER_ASSIGNMENT_HEADING = "Reviewer assignment";

export const REVIEWER_ASSIGNMENT_EXPLANATION =
  "Assigning a reviewer here asks them to approve this research. While the review is pending, it appears in their Approval Queue under “Assigned to me”.";

export const APPROVAL_NOT_AVAILABLE_HEADING = "Approval review";

export const APPROVAL_NOT_AVAILABLE_MESSAGE =
  "This research result can’t be submitted for approval: it has no review record, so a reviewer can’t be assigned and it won’t appear in the Approval Queue. Assigning it with “Assign” marks responsibility only.";

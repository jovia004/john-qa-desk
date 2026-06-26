# Ready for Testing — Validation Rules (OS project)

These rules are the single source of truth for the dashboard's "Check Readiness"
action. Scope: the **OS** (Ordering Services) Jira project only. Validation is
read-only — never comment, transition, or reassign.

## 1) Status handling
- The current Jira status is **not** a validation requirement.
- Do **not** fail validation only because the ticket is already in `Testing` or
  another later status.
- Current Jira status must never appear as a failed validation point.

## 2) Determine Ticket Type
Classify the ticket as **Feature**, **Bug**, **Incident**, or **Epic**, using
issue type, labels, summary, and description. If the description contains
`inc-XXXX` (case-insensitive), classify it as **Incident**.

Preferred detection order: (1) Jira description, (2) structured Jira fields, (3)
Jira comments as a fallback.

## 3) Required Fields (by Type)

### Feature — Required
- **User Story / Acceptance Criteria** (non-empty)
- **Test Target** (see §4)

### Bug — Required
- **Problem Statement**, satisfied by ONE of:
  - **Expected Result** and **Actual Result** (non-empty), or
  - **Steps to Reproduce** (non-empty), or
  - A reasonable explanation of the problem that is not one-sentence filler
- **User Story / Acceptance Criteria / Fix** (non-empty)
- **Test Target** (see §4)

### Incident — Required
- **Steps to Reproduce** (non-empty)
- **Root Cause** (non-empty)
- **User Story / Acceptance Criteria / Fix** (non-empty)
- **Test Target** (see §4)

### Epic — Required
- **Epic validation is OUT OF SCOPE for now.** Return result `SKIPPED`.

## 4) Test Target rule (OS project)
For **OS** tickets, the Test Target requirement is satisfied when the description
or a comment contains **an API endpoint or a URL link**:
- Count a URL as valid when it uses `http`/`https`, has a real host, and the
  path/query is specific enough for a tester to know what to open. Auth-gated
  deep links (login redirect / 401 / 403) are still valid — judge from the URL,
  not the login page.
- Count an API endpoint (path like `/api/...`, a method+path, or a documented
  endpoint reference) as valid.
- **Reject** as Test Target: a bare domain / root path, a generic home or
  dashboard page, a plain Jira/docs/PR/folder link with no concrete target, a
  malformed URL, or a dead link.

## 5) Field interpretation
- **Acceptance Criteria** may also be satisfied by a description section titled
  `QA`, `QA Focus`, `QA test scenarios`, `Test Plan`, or `Test Scenarios` when
  it contains clear tester-facing steps or checks. Do **not** count a vague QA
  note, a heading with no real steps, or loose implementation notes.

## 6) Outcome
- Missing **any** required field → **NOT Ready for Testing** (`FAIL`).
- All required fields present → **Ready for Testing** (`PASS`).
- Collect a list of the specific **failed requirements**.
- When category or evidence is ambiguous, fail the relevant check rather than
  guessing.

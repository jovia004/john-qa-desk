# John's QA Desk

Sprint / due-date QA dashboard for Jira — view tickets by sprint or due date, check readiness with LLM, generate and review test cases, move tickets to Testing, and post a structured test plan as a Jira comment.

## Requirements

- Node.js ≥ 18 (uses native `fetch`, `crypto`, `--watch`)

## Setup

```bash
cp .env.example .env
# fill in .env (see variables below)
npm install
npm run dev        # hot-reload dev
# npm start        # production
```

Open <http://localhost:1111> (or the `PORT` you set).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `JIRA_BASE_URL` | ✅ | e.g. `https://yourorg.atlassian.net` |
| `JIRA_EMAIL` | ✅ | Atlassian account email |
| `JIRA_API_TOKEN` | ✅ | API token from id.atlassian.com |
| `JIRA_PROJECTS` | ✅ | Comma-separated project keys, e.g. `OS` |
| `JIRA_STORY_POINTS_FIELD` | — | Default `customfield_10016`. Check `GET /rest/api/3/field` if SP writes fail. |
| `TESTING_STATUSES` | — | Default `ready for testing,testing,in qa,qa`. Comma-separated, case-insensitive. |
| `PORT` | — | Default `5173` |
| `READINESS_MODEL` | ✅ for Check Readiness | LLM model for readiness validation. Provider auto-detected: `gpt-*/o*` → OpenAI, `claude-*` → Anthropic. |
| `TC_MODEL` | — | LLM model for TC generation. Falls back to `READINESS_MODEL` if blank. |
| `OPENAI_API_KEY` | if using OpenAI | — |
| `OPENAI_BASE_URL` | — | Default `https://api.openai.com/v1` |
| `ANTHROPIC_API_KEY` | if using Anthropic | — |
| `ANTHROPIC_BASE_URL` | — | Default `https://api.anthropic.com` |

> Tip for OpenAI reasoning models (`o3`, `o4-mini`): the server automatically routes `max_completion_tokens` instead of `max_tokens` and increases the budget so reasoning tokens don't eat the output.

## Jira API token

Create one at <https://id.atlassian.com/manage-profile/security/api-tokens>.

## Features

### Sprint / Due-date view
- Toggle between **Sprint** mode (last / current / next sprint) and **Due Date** mode (year → specific date, default = nearest upcoming date).
- Table shows: Key, Summary, Status, Priority, Assignee. Click column headers to sort.
- Double-click a row to open the ticket in Jira.

### Status Drawer
- Click the sprint badge (e.g. `▦ Sprint 42`) to open a drawer showing all tickets grouped by status column: **Ready for Testing → Testing → Ready to Release → Test Failed**.

### Check Readiness (Ready for Testing column)
- Right-click a card → **Check Readiness**: sends the ticket's description, ACs, and comments to the LLM with your project's readiness rules (`rules/readyfortest.md`).
- Returns PASS / FAIL / SKIPPED with detailed failure points.
- Result is cached in `sessionStorage` and shown as a badge on the card.

### Move to Testing
- Right-click → **Move to Testing**: transitions the ticket to the first available testing-pipeline status via the Jira Transitions API.

### Prepare TC (Testing column)
- Right-click → **Prepare TC**: generates test cases from the ticket's acceptance criteria using the TC LLM model.
- Per-case review lifecycle (Test Bridge Phase 1):
  - **Approve** / **Feedback** (with text) / **Remove** per case.
  - **Submit** revises feedback-flagged cases via LLM; removed cases are dropped.
  - **Accept** (enabled when all remaining cases are approved + all ACs covered) locks the plan and posts a structured ADF comment to Jira.
- **Regenerate** is smart: gap-fills uncovered ACs first → self-heals stale cache → no-op if AC hash unchanged → partial regen if ACs changed.
- AC coverage indicator shows `X/Y` ACs covered by generated cases.

### CSV Export
- Download button exports cases in TestRail-compatible 12-column CSV (RFC-4180):
  `Title, Suite, Section, Type, Priority, Preconditions, Steps, Expected, Automated, Estimate, References, Result`

### Readiness rules
- `rules/readyfortest.md` — plain-text rule file loaded at startup by Check Readiness.
- Scope this file to your project's definition-of-ready criteria.

## Project structure

```
server.js          — Express backend: Jira client, LLM client, all API routes
public/
  index.html       — Single-page app shell + Tailwind CDN
  app.js           — All frontend logic
rules/
  readyfortest.md  — Readiness validation rules (must be present at startup)
.env.example       — Template; copy to .env and fill in
```

## Notes

- All state (TC plans, readiness verdicts) is stored in `sessionStorage` — survives reload, clears on tab close. Not shared across users/tabs.
- No auth is applied. Bind to `localhost` only, or add a reverse proxy with auth before sharing.
- `.env` is gitignored and must never be committed.

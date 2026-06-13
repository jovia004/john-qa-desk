# QA Dashboard

Sprint dashboard for Jira — pick a project, see last/current/next sprint, list "Ready for Testing / Testing" tickets, assign story points, and bulk-add to the next sprint.

## Setup

```bash
cp .env.example .env
# edit .env with your Jira base URL, email, API token, project keys
npm install
npm run dev
```

Open <http://localhost:5173>.

## Jira API token

Create one at <https://id.atlassian.com/manage-profile/security/api-tokens>.

## Notes

- `JIRA_STORY_POINTS_FIELD` defaults to `customfield_10016`. If story-point writes fail, check `GET {JIRA_BASE_URL}/rest/api/3/field` for the right id.
- `TESTING_STATUSES` controls which statuses appear in the table (comma-separated, case-insensitive).
- Sprint lock logic is not implemented — all sprint tickets in the testing statuses are listed.

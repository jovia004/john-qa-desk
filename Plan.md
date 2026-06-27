# John's QA Desk — Pending Work

## ✅ Phase A — Hygiene & fixes (DONE)
- Committed `rules/readyfortest.md` to git (was untracked → 500 error on fresh clone)
- Stub menu actions show "Soon" badge (non-interactive)
- Removed duplicate "Review TC" menu item
- Fixed OS hard-coding in readiness prompt → uses `JIRA_PROJECTS[0]`
- Added `engines.node >=18` to `package.json`
- Rewrote README to cover all current features
- Synced `.env.example` (PORT, JIRA_PROJECTS default)

---

## ✅ Phase B — Server-side persistence (DONE)
- `data/store.json` — lightweight JSON file store (gitignored)
- `GET /api/store` — full snapshot
- `PUT /api/store/readiness/:key` — save readiness verdict
- `PUT /api/store/tc/:key` — save TC plan
- Client: `setReadiness` / `setTcStore` write-through to server on every change
- Client: `hydrateFromServer()` at init — seeds sessionStorage from server (survives tab close, shared across tabs)

---

## ✅ Phase C — Stub actions (DONE — stubs only)
- **Check Readiness** ✅ wired and working
- **Move to Testing** ✅ wired and working
- **Prepare TC** ✅ wired and working (full Phase 1 review lifecycle)
- **Check Ready to Release** — 🔲 Coming Soon
- **Check MR** — 🔲 Coming Soon (needs `GITLAB_TOKEN` in `.env`)
- **Check Zync Pre Flight score** — 🔲 Coming Soon (needs Zync API details)
- **Test Failed column** — 🔲 No menu actions yet (Phase D)

---

## 🔲 Phase D — Execution (NOT STARTED — next up)

The big one. Builds on Phase B persistence.

### D1 — Per-case execution UI
- Add **Pass / Fail / Blocked** buttons to each TC card in the modal
- Execution result stored per case in `STORE.tc[key]`
- Visual state: green (Pass), red (Fail), amber (Blocked), grey (not run)
- Show execution summary: `X passed / Y failed / Z blocked / N not run`

### D2 — Execution notes
- Text input per case for execution notes (what happened, env used, etc.)
- Stored alongside the execution result in the case object

### D3 — Evidence (file/screenshot attachment)
- File upload per case (drag-drop, paste, or file picker)
- Screenshot capture (clipboard paste → base64 or blob)
- Stored in `data/evidence/` on server (separate from `store.json`)
- New multipart endpoint: `POST /api/ticket/:key/evidence` (Jira attachments need `X-Atlassian-Token: no-check` + multipart — different from current JSON-only `jira()`)

### D4 — Log execution to Jira
- "Log Results" button — posts execution summary as a Jira comment (reuse ADF builder)
- Format: table of Pass/Fail/Blocked per TC + notes
- Requires multipart `jira()` variant for evidence attachments

---

## 🔲 Phase E — Architecture & quality (LATER)

- Split `server.js` (~900 lines) into `jira.js / llm.js / tc.js / routes/` when Phase D lands
- Split `public/app.js` (~1400+ lines) into ES modules
- Add minimal tests for pure logic (coverage calc, CSV builder, ADF builder, review state)
- Add auth / token gate before any shared/team deployment
- Wire **Check RTR** — LLM rule check using `rules/readyforrelease.md` (file already drafted, endpoint not yet built)
- Wire **Check MR** — GitLab API via Jira remote links (needs `GITLAB_TOKEN`)
- Wire **Check Zync** — needs Zync API details from team
- Add menu actions for **Test Failed** column (reopen, log defect)

---

## 🔑 Credentials to rotate (URGENT)
- `JIRA_API_TOKEN` — appeared in chat history
- `OPENAI_API_KEY` — appeared in chat history
- Rotate at: https://id.atlassian.com and https://platform.openai.com

---

## Notes
- `data/store.json` is gitignored — holds all persisted readiness verdicts + TC plans
- `rules/readyfortest.md` — edit this to update Check Readiness rules for OS project
- Default port: `1111` (set in `.env`)
- Always dark mode, no toggle

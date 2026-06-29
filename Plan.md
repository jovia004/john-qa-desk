# John's QA Desk — Pending Work

_Last updated: 2026-06-29_

---

## ✅ Phase A — Hygiene & fixes (DONE)
- Committed `rules/readyfortest.md` to git
- Stub menu actions show "Soon" badge (non-interactive)
- Removed duplicate "Review TC" menu item
- Fixed OS hard-coding in readiness prompt → uses `JIRA_PROJECTS[0]`
- Added `engines.node >=18` to `package.json`
- Rewrote README to cover all current features
- Synced `.env.example` (PORT, JIRA_PROJECTS default)

---

## ✅ Phase B — Server-side persistence (DONE)
- `data/store.json` — lightweight JSON file store (gitignored)
- Write-through: `setReadiness` / `setTcStore` persist to server on every change
- `hydrateFromServer()` at init — seeds sessionStorage from server snapshot

---

## ✅ Phase C — Stub actions (DONE — stubs only)
- **Check Readiness** ✅ wired and working
- **Move to Testing** ✅ wired and working
- **Prepare TC** ✅ wired and working (full Phase 1 review lifecycle: Approve/Feedback/Remove → Submit → Accept → Jira comment)
- **Check Ready to Release** — 🔲 Coming Soon
- **Check MR** — 🔲 Coming Soon (needs `GITLAB_TOKEN` in `.env`)
- **Check Zync Pre Flight score** — 🔲 Coming Soon (needs Zync API details)
- **Test Failed column** — 🔲 No menu actions yet

---

## ✅ Phase D — Execution (PARTIALLY DONE)

### ✅ D1 — Per-case execution UI (DONE)
- Pass / Fail / Blocked toggle buttons on each TC card when plan is accepted
- Card border + corner label reflect execution state (green/red/amber)
- Execution summary bar: X Passed / Y Failed / Z Blocked / N Pending

### ✅ D2 — Execution notes (DONE)
- Notes textarea per case, auto-saved on input
- Stored in the case object alongside the execution result

### ✅ D4 — Log execution to Jira (DONE)
- "Log Execution to Jira" green button in modal header
- `POST /api/ticket/:key/log-execution` — posts ADF table (TC# / Title / Result / Notes)
- CSV `Result` column now populated from execution result

### 🔲 D3 — Evidence (NOT STARTED)
- File/screenshot attachment per case (drag-drop, clipboard paste, file picker)
- Store in `data/evidence/` on server
- New multipart endpoint: `POST /api/ticket/:key/evidence`
- Jira attachment upload needs `X-Atlassian-Token: no-check` + multipart (different from current JSON-only `jira()`)
- Discuss scope before building: drag-drop only? clipboard paste? mobile QR upload?

---

## 🔲 Phase E — Stub actions (wire when ready)
- **Check RTR** — LLM release gate using `rules/readyforrelease.md`
- **Check MR** — GitLab API via Jira remote links (needs `GITLAB_TOKEN` in `.env`)
- **Check Zync** — needs Zync API details from team
- **Test Failed column** — add menu actions (reopen ticket, log defect)

---

## 🔲 Phase F — Architecture & quality (LATER)
- Split `server.js` (~1000 lines) into `jira.js / llm.js / tc.js / routes/`
- Split `public/app.js` (~1500 lines) into ES modules
- Add minimal tests (coverage calc, CSV builder, ADF builder, review state)
- Add auth / token gate before any shared/team deployment

---

## 🔑 Credentials to rotate (URGENT)
- `JIRA_API_TOKEN` — appeared in chat history
- `OPENAI_API_KEY` — appeared in chat history
- Rotate at: https://id.atlassian.com and https://platform.openai.com

---

## Notes
- `data/store.json` — gitignored, holds all persisted verdicts + TC plans + execution results
- `rules/readyfortest.md` — edit to update Check Readiness rules for OS project
- Default port: `1111` (set in `.env`)
- Always dark mode, no toggle

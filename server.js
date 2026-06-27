import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// --- Persistent store -------------------------------------------------------
// Lightweight JSON file store for readiness verdicts and TC plans.
// Keyed by issue key within two namespaces: { readiness: {}, tc: {} }
const DATA_DIR  = path.join(__dirname, 'data')
const STORE_FILE = path.join(DATA_DIR, 'store.json')
mkdirSync(DATA_DIR, { recursive: true })
let STORE = { readiness: {}, tc: {} }
try { STORE = JSON.parse(readFileSync(STORE_FILE, 'utf8')) } catch { /* first run */ }
if (!STORE.readiness) STORE.readiness = {}
if (!STORE.tc) STORE.tc = {}

let _saveTimer = null
function saveStore() {
  clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    try { writeFileSync(STORE_FILE, JSON.stringify(STORE, null, 2)) } catch (e) { console.error('store write failed', e) }
  }, 500)
}

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECTS = '',
  JIRA_STORY_POINTS_FIELD = 'customfield_10016',
  TESTING_STATUSES = 'ready for testing,testing,in qa,qa',
  PORT = 5173,
  ANTHROPIC_API_KEY = '',
  ANTHROPIC_BASE_URL = 'https://api.anthropic.com',
  OPENAI_API_KEY = '',
  OPENAI_BASE_URL = 'https://api.openai.com/v1',
  READINESS_MODEL = 'gpt-4o',
  TC_MODEL = '', // optional: stronger/reasoning model for Prepare TC; falls back to READINESS_MODEL
} = process.env

// Pick the provider from the model id: gpt-*/o1/o3/o4 → OpenAI, claude-* → Anthropic.
const providerForModel = (m) => (/^(gpt-|o\d)/i.test(m) ? 'openai' : 'anthropic')
const apiKeyForProvider = (p) => (p === 'openai' ? OPENAI_API_KEY : ANTHROPIC_API_KEY)
// OpenAI reasoning models (o1/o3/o4…) reject `temperature` and use `max_completion_tokens`.
const isOpenAiReasoning = (m) => /^o\d/i.test(m)

const READINESS_PROVIDER = providerForModel(READINESS_MODEL)
const READINESS_API_KEY = apiKeyForProvider(READINESS_PROVIDER)

const RESOLVED_TC_MODEL = TC_MODEL || READINESS_MODEL
const TC_PROVIDER = providerForModel(RESOLVED_TC_MODEL)
const TC_API_KEY = apiKeyForProvider(TC_PROVIDER)

const PROJECTS = JIRA_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
const TESTING = TESTING_STATUSES.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.warn('⚠️  Jira env vars missing — copy .env.example to .env and fill it in.')
}
// `warn`/`log` are defined just below; the line above runs at import time before they exist.

const authHeader = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')

// --- Logging helpers --------------------------------------------------------
const ts = () => new Date().toISOString()
function log(...args)  { console.log(`[${ts()}]`, ...args) }
function warn(...args) { console.warn(`[${ts()}] ⚠️ `, ...args) }
// Centralized error responder: logs server-side (with the route) AND returns JSON.
function sendError(res, e, req) {
  const where = req ? `${req.method} ${req.originalUrl}` : ''
  console.error(`[${ts()}] ❌ ${where}\n   ${e?.stack || e?.message || e}`)
  res.status(500).json({ error: String(e?.message || e) })
}

async function jira(pathAndQuery, opts = {}) {
  const url = `${JIRA_BASE_URL}${pathAndQuery}`
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`[${ts()}] ❌ Jira ${res.status} ${opts.method || 'GET'} ${pathAndQuery}: ${text.slice(0, 300)}`)
    throw new Error(`Jira ${res.status} ${pathAndQuery}: ${text.slice(0, 500)}`)
  }
  return text ? JSON.parse(text) : null
}

// Cache board id per project — Jira's sprint endpoint needs a board.
const boardCache = new Map()
async function boardIdFor(project) {
  if (boardCache.has(project)) return boardCache.get(project)
  const data = await jira(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}&type=scrum`)
  const board = data.values?.[0]
  if (!board) throw new Error(`No scrum board found for project ${project}`)
  boardCache.set(project, board.id)
  return board.id
}

async function sprintsFor(project) {
  const boardId = await boardIdFor(project)
  const out = []
  for (const state of ['active', 'future', 'closed']) {
    let startAt = 0
    while (true) {
      const data = await jira(`/rest/agile/1.0/board/${boardId}/sprint?state=${state}&startAt=${startAt}&maxResults=50`)
      out.push(...(data.values || []))
      if (data.isLast || !data.values?.length) break
      startAt += data.values.length
    }
  }
  return out
}

function pickSprints(sprints) {
  const active = sprints.filter(s => s.state === 'active').sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0))
  const closed = sprints.filter(s => s.state === 'closed').sort((a, b) => new Date(b.endDate || 0) - new Date(a.endDate || 0))
  const future = sprints.filter(s => s.state === 'future').sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0))
  return {
    current: active[0] || null,
    last: closed[0] || null,
    next: future[0] || null,
  }
}

const app = express()
app.use(express.json({ limit: '4mb' })) // prior TC payloads on regenerate can be large

// Request logger — logs API calls with status + duration. Skips static assets.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  const started = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    const line = `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms.toFixed(0)}ms)`
    if (res.statusCode >= 500) console.error(`[${ts()}] ${line}`)
    else if (res.statusCode >= 400) warn(line)
    else log(line)
  })
  next()
})

app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/config', async (_req, res) => {
  const hasJira = Boolean(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN)
  let projects = PROJECTS.map(key => ({ key, name: key }))
  if (hasJira) {
    projects = await Promise.all(PROJECTS.map(async key => {
      try {
        const p = await jira(`/rest/api/3/project/${encodeURIComponent(key)}`)
        return { key, name: p.name || key }
      } catch { return { key, name: key } }
    }))
  }
  res.json({ projects, hasJira, jiraBase: JIRA_BASE_URL || '' })
})

app.get('/api/sprints', async (req, res) => {
  try {
    const project = String(req.query.project || '')
    if (!project) return res.status(400).json({ error: 'project required' })
    const all = await sprintsFor(project)
    // Sprints often span multiple boards in the same project; keep only ones
    // whose name starts with the project key (matches the dashboard convention).
    const prefix = project.toUpperCase()
    const sprints = all.filter(s => (s.name || '').toUpperCase().startsWith(prefix))
    res.json({ sprints, picked: pickSprints(sprints.length ? sprints : all) })
  } catch (e) {
    sendError(res, e, req)
  }
})

app.get('/api/tickets', async (req, res) => {
  try {
    const project = String(req.query.project || '')
    const sprintId = String(req.query.sprintId || '')
    if (!project || !sprintId) return res.status(400).json({ error: 'project and sprintId required' })

    const fields = ['summary', 'status', 'priority', 'assignee', 'issuetype', JIRA_STORY_POINTS_FIELD].join(',')
    // Use the agile sprint endpoint (the classic /rest/api/3/search is deprecated
    // and returns empty for many sprints). Paginate so large sprints aren't truncated.
    const rawIssues = []
    let startAt = 0
    while (true) {
      const data = await jira(`/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue?fields=${fields}&startAt=${startAt}&maxResults=100`)
      rawIssues.push(...(data.issues || []))
      const total = data.total ?? rawIssues.length
      if (rawIssues.length >= total || !data.issues?.length) break
      startAt += data.issues.length
    }

    const issues = rawIssues
      .filter(i => (i.fields.project?.key || i.key.split('-')[0]) === project)
      .map(i => ({
      key: i.key,
      project,
      summary: i.fields.summary,
      status: i.fields.status?.name || '',
      priority: i.fields.priority?.name || '',
      assignee: i.fields.assignee?.displayName || 'Unassigned',
      assigneeAvatar: i.fields.assignee?.avatarUrls?.['24x24'] || null,
      storyPoints: i.fields[JIRA_STORY_POINTS_FIELD] ?? null,
    }))

    const testing = issues.filter(i => TESTING.includes(i.status.toLowerCase()))
    res.json({ all: issues, testing })
  } catch (e) {
    sendError(res, e, req)
  }
})

function mapIssue(i, project) {
  return {
    key: i.key,
    project: i.fields.project?.key || project,
    summary: i.fields.summary,
    status: i.fields.status?.name || '',
    priority: i.fields.priority?.name || '',
    assignee: i.fields.assignee?.displayName || 'Unassigned',
    assigneeAvatar: i.fields.assignee?.avatarUrls?.['24x24'] || null,
    storyPoints: i.fields[JIRA_STORY_POINTS_FIELD] ?? null,
    duedate: i.fields.duedate || null,
  }
}

async function searchJql(jql, fields, maxResults = 200) {
  // Use the new endpoint (POST /rest/api/3/search/jql) — the classic GET /search is deprecated.
  const out = []
  let nextPageToken = undefined
  do {
    const body = { jql, fields, maxResults: Math.min(maxResults - out.length, 100) }
    if (nextPageToken) body.nextPageToken = nextPageToken
    const data = await jira(`/rest/api/3/search/jql`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    out.push(...(data.issues || []))
    nextPageToken = data.nextPageToken
  } while (nextPageToken && out.length < maxResults)
  // Warn if we stopped at the cap while more results likely remain.
  if (nextPageToken && out.length >= maxResults) {
    warn(`searchJql hit cap of ${maxResults}; results truncated. JQL: ${jql}`)
  }
  return out
}

// Exact-ish count for a JQL without fetching rows (Jira's approximate-count endpoint).
async function jiraCount(jql) {
  const data = await jira('/rest/api/3/search/approximate-count', {
    method: 'POST',
    body: JSON.stringify({ jql }),
  })
  return Number(data.count ?? 0)
}

app.get('/api/duedates', async (req, res) => {
  try {
    const project = String(req.query.project || '')
    if (!project) return res.status(400).json({ error: 'project required' })
    const jql = `project = ${project} AND duedate is not EMPTY AND statusCategory != Done ORDER BY duedate ASC`
    const issues = await searchJql(jql, ['duedate'], 500)
    const counts = new Map()
    for (const i of issues) {
      const d = i.fields.duedate
      if (!d) continue
      counts.set(d, (counts.get(d) || 0) + 1)
    }
    const dates = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({ date, count }))

    // Count open tickets that have NO due date set (for the "No due date" chip).
    const noDueDateJql = `project = ${project} AND duedate is EMPTY AND statusCategory != Done`
    const noDueDate = await jiraCount(noDueDateJql)

    res.json({ dates, noDueDate })
  } catch (e) {
    sendError(res, e, req)
  }
})

app.get('/api/tickets/by-duedate', async (req, res) => {
  try {
    const project = String(req.query.project || '')
    const dates = String(req.query.dates || '').split(',').map(s => s.trim()).filter(Boolean)
    if (!project || !dates.length) return res.status(400).json({ error: 'project and dates required' })

    // "none" is the sentinel for tickets with no due date set.
    const realDates = dates.filter(d => d !== 'none')
    const wantsNone = dates.includes('none')
    const clauses = []
    if (realDates.length) clauses.push(`duedate in (${realDates.map(d => `"${d}"`).join(',')})`)
    if (wantsNone) clauses.push('duedate is EMPTY')
    const dueClause = clauses.length > 1 ? `(${clauses.join(' OR ')})` : clauses[0]
    const jql = `project = ${project} AND ${dueClause}`
    const fields = ['summary', 'status', 'priority', 'assignee', 'issuetype', 'duedate', JIRA_STORY_POINTS_FIELD]
    const issues = await searchJql(jql, fields, 500)
    const all = issues.map(i => mapIssue(i, project))
    const testing = all.filter(i => TESTING.includes(i.status.toLowerCase()))
    res.json({ all, testing })
  } catch (e) {
    sendError(res, e, req)
  }
})

// Flatten Atlassian Document Format (ADF) JSON to plain text.
function adfToText(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  let out = ''
  if (node.type === 'text' && typeof node.text === 'string') out += node.text
  if (node.type === 'hardBreak') out += '\n'
  if (Array.isArray(node.content)) {
    for (const child of node.content) out += adfToText(child)
  }
  // Block-level nodes get a trailing newline so structure survives.
  if (['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'tableRow'].includes(node.type)) {
    out += '\n'
  }
  return out
}

// Read the readiness rules fresh each request so edits take effect without restart.
function readinessRules() {
  return readFileSync(path.join(__dirname, 'rules', 'readyfortest.md'), 'utf8')
}

// Provider- and model-aware LLM call (raw fetch — matches the codebase style).
// Returns the assistant's text. `model` defaults to READINESS_MODEL; pass another
// (e.g. a reasoning model) to override per feature.
async function llm(userText, { system, maxTokens = 1500, model = READINESS_MODEL } = {}) {
  const provider = providerForModel(model)

  if (provider === 'openai') {
    const reasoning = isOpenAiReasoning(model)
    const body = {
      model,
      response_format: { type: 'json_object' },
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: userText },
      ],
    }
    if (reasoning) {
      // o-series: no temperature; reasoning tokens count against the completion
      // budget, so give generous headroom or the JSON output gets truncated.
      body.max_completion_tokens = Math.max(maxTokens + 12000, 16000)
    } else {
      body.max_tokens = maxTokens
      body.temperature = 0 // low variance — stable regeneration / verdicts
    }
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[${ts()}] ❌ OpenAI ${res.status} (${model}): ${text.slice(0, 300)}`)
      throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = JSON.parse(text)
    return data.choices?.[0]?.message?.content || ''
  }

  // Anthropic Messages API (Claude 4.x: no temperature param)
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`[${ts()}] ❌ Anthropic ${res.status}: ${text.slice(0, 300)}`)
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`)
  }
  const data = JSON.parse(text)
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
}

// Strip code fences and parse the outermost JSON object from a model response.
function parseJsonObject(raw) {
  let s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = s.indexOf('{'), end = s.lastIndexOf('}')
  if (start !== -1 && end !== -1) s = s.slice(start, end + 1)
  return JSON.parse(s)
}

function parseVerdict(raw) {
  const v = parseJsonObject(raw)
  return {
    type: String(v.type || 'Unknown'),
    result: /^pass$/i.test(v.result) ? 'PASS' : /^skip/i.test(v.result) ? 'SKIPPED' : 'FAIL',
    failedPoints: Array.isArray(v.failedPoints) ? v.failedPoints.map(String) : [],
    notes: typeof v.notes === 'string' ? v.notes : '',
  }
}

function normalizeTcCase(c) {
  return {
    title: String(c.title || 'Untitled test case'),
    section: String(c.section || ''),
    automationType: String(c.automationType || 'Manual'),
    estimate: String(c.estimate || ''),
    preconditions: Array.isArray(c.preconditions) ? c.preconditions.map(String) : (c.preconditions ? [String(c.preconditions)] : []),
    testData: String(c.testData || '-'),
    priority: String(c.priority || 'Medium'),
    type: String(c.type || 'Functional'),
    coverage: /^(positive|negative|edge)$/i.test(c.coverage) ? c.coverage.toLowerCase() : 'positive',
    steps: Array.isArray(c.steps) ? c.steps.map((s) => ({ action: String(s.action || ''), expectedResult: String(s.expectedResult || '') })) : [],
    expectedResults: Array.isArray(c.expectedResults) ? c.expectedResults.map(String) : (c.expectedResults ? [String(c.expectedResults)] : []),
    linkedAcceptanceCriteriaIds: Array.isArray(c.linkedAcceptanceCriteriaIds) ? c.linkedAcceptanceCriteriaIds.map(String) : [],
    status: 'generated',
  }
}

// Fingerprint the AC source (description + comments) so we can tell if anything changed.
function sourceFingerprint(text) {
  return createHash('sha256').update(String(text || '')).digest('hex')
}
// Normalize AC text for change-detection matching across (noisy) re-extractions.
function normAc(text) {
  return String(text || '').toLowerCase().replace(/[^\w ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const TC_CLARITY_RULES = `Write every test case to a high, reviewer-ready standard:
- Title: specific and action-based (what is verified, under what condition).
- Preconditions: concrete and complete — environment, auth/role, and exact data state required.
- Steps: atomic and ordered; each step is ONE action; include the exact endpoint/method,
  payload, field, or UI action where known (no vague "verify it works").
- Expected Result: specific and MEASURABLE — exact status codes, exact messages/text,
  resulting persisted state, or computed values. Never "works as expected".
- Test Data: concrete sample values (real-looking ids/payloads), not placeholders.
- For each AC, cover the relevant dimensions as warranted: happy path, validation
  (missing/invalid/malformed input), authentication/authorization, error handling,
  boundary/edge values, and data integrity/persistence. Do not pad with trivial duplicates,
  but do NOT artificially limit the count — be thorough and clear.`

const TC_GEN_SYSTEM = `You are a senior QA engineer generating a thorough, clear test plan for a Jira ticket.

STEP 1 — Acceptance Criteria: Read the description AND comments and extract every
acceptance criterion / required behavior as a testable list. If the ticket states explicit
ACs, use them verbatim; otherwise infer concrete, testable criteria from the described
behavior. Assign stable ids "AC-1", "AC-2", … in order.

STEP 2 — Test Cases: For EVERY acceptance criterion, design complete coverage — at least one
positive case plus the negative, auth, boundary/edge, and data-integrity cases that the AC
warrants. Link each case to the AC id(s) it validates via linkedAcceptanceCriteriaIds.

${TC_CLARITY_RULES}

Return STRICT JSON and nothing else:
{"acceptanceCriteria":[{"id":"AC-1","text":"..."}],
 "cases":[{
   "title":"clear action-based title",
   "section":"API > <Domain> > <Action> or Service > <Name> > <Flow>",
   "automationType":"Manual|API Automation|To Be Automated",
   "estimate":"e.g. 1m","preconditions":["..."],"testData":"sample or -",
   "priority":"High|Medium|Low","type":"Functional|Regression|Acceptance",
   "coverage":"positive|negative|edge",
   "steps":[{"action":"do X with exact input","expectedResult":"specific measurable result"}],
   "expectedResults":["specific measurable outcome"],
   "linkedAcceptanceCriteriaIds":["AC-1"]
 }]}`

async function generateFullTc(ticketBlock) {
  const parsed = parseJsonObject(await llm(ticketBlock, { system: TC_GEN_SYSTEM, maxTokens: 8000, model: RESOLVED_TC_MODEL }))
  const acceptanceCriteria = (Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria : [])
    .map((a, i) => ({ id: String(a.id || `AC-${i + 1}`), text: String(a.text || '') }))
  const cases = (Array.isArray(parsed.cases) ? parsed.cases : []).map(normalizeTcCase)
  return { acceptanceCriteria, cases }
}

async function extractAcsOnly(ticketBlock) {
  const sys = `Extract every acceptance criterion / required behavior from the description AND comments as a testable list. Assign ids AC-1, AC-2,… in order. Return STRICT JSON: {"acceptanceCriteria":[{"id":"AC-1","text":"..."}]}`
  const parsed = parseJsonObject(await llm(ticketBlock, { system: sys, maxTokens: 1500, model: RESOLVED_TC_MODEL }))
  return (Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria : [])
    .map((a, i) => ({ id: String(a.id || `AC-${i + 1}`), text: String(a.text || '') }))
}

// Generate cases covering a specific subset of ACs (used for gap-fill and partial regen).
async function generateCasesForAcs(ticketBlock, acs) {
  if (!acs.length) return []
  const sys = `You are a senior QA engineer. For EACH acceptance criterion below, design complete coverage (positive, plus negative/auth/boundary/data-integrity as warranted); link each case via linkedAcceptanceCriteriaIds.

${TC_CLARITY_RULES}

Return STRICT JSON: {"cases":[ ...case shape with title, section, automationType, estimate, preconditions[], testData, priority, type, coverage, steps[{action,expectedResult}], expectedResults[], linkedAcceptanceCriteriaIds[] ... ]}.`
  const input = `${ticketBlock}\n\nAcceptance criteria to cover:\n${acs.map(a => `${a.id}: ${a.text}`).join('\n')}`
  const parsed = parseJsonObject(await llm(input, { system: sys, maxTokens: 4000, model: RESOLVED_TC_MODEL }))
  return (Array.isArray(parsed.cases) ? parsed.cases : []).map(normalizeTcCase)
}

function uncoveredAcs(acceptanceCriteria, cases) {
  const covered = new Set(cases.flatMap(c => c.linkedAcceptanceCriteriaIds))
  return acceptanceCriteria.filter(a => !covered.has(a.id))
}

function coverageOf(acceptanceCriteria, cases) {
  const u = uncoveredAcs(acceptanceCriteria, cases)
  return { total: acceptanceCriteria.length, covered: acceptanceCriteria.length - u.length, uncovered: u.map(a => a.id) }
}

// --- ADF (Atlassian Document Format) builders for the Accept → Jira comment ---
function adfTextNode(s, marks) {
  const text = String(s ?? '')
  const node = { type: 'text', text }
  if (marks) node.marks = marks
  return node
}
function adfPara(str, marks) {
  const text = String(str ?? '').trim()
  return text ? { type: 'paragraph', content: [adfTextNode(text, marks)] } : { type: 'paragraph' }
}
function adfHeading(level, text) {
  return { type: 'heading', attrs: { level }, content: [adfTextNode(text || ' ')] }
}
function adfList(type, items) {
  const valid = (items || []).map(t => String(t ?? '').trim()).filter(Boolean)
  if (!valid.length) return null
  return { type, content: valid.map(t => ({ type: 'listItem', content: [adfPara(t)] })) }
}

function buildTestPlanAdf({ cases, coverage, accepter }) {
  const date = new Date().toISOString().slice(0, 10)
  const content = [adfHeading(3, 'QA Test Plan')]
  const cov = coverage && coverage.total != null ? `${coverage.covered}/${coverage.total} AC covered` : ''
  const header = [`${cases.length} test case${cases.length === 1 ? '' : 's'}`, cov, accepter ? `Accepted by ${accepter}` : 'Accepted', date].filter(Boolean).join(' · ')
  content.push(adfPara(header, [{ type: 'em' }]))

  cases.forEach((c, i) => {
    content.push(adfHeading(4, `${c.testCaseNumber || `TC${i + 1}`}: ${c.title || 'Untitled'}`))
    const meta = []
    if (c.priority) meta.push(`Priority: ${c.priority}`)
    if (c.type) meta.push(`Type: ${c.type}`)
    if ((c.linkedAcceptanceCriteriaIds || []).length) meta.push(`ACs: ${c.linkedAcceptanceCriteriaIds.join(', ')}`)
    if (meta.length) content.push(adfPara(meta.join('   |   '), [{ type: 'strong' }]))

    const pre = adfList('bulletList', c.preconditions)
    if (pre) { content.push(adfPara('Preconditions', [{ type: 'strong' }])); content.push(pre) }

    const steps = (c.steps || []).filter(s => String(s.action || '').trim())
    if (steps.length) {
      content.push(adfPara('Steps', [{ type: 'strong' }]))
      content.push({
        type: 'orderedList',
        content: steps.map(s => {
          const li = [adfPara(s.action)]
          if (String(s.expectedResult || '').trim()) li.push(adfPara(`Expected: ${s.expectedResult}`, [{ type: 'em' }]))
          return { type: 'listItem', content: li }
        }),
      })
    }

    const exp = adfList('bulletList', c.expectedResults)
    if (exp) { content.push(adfPara('Expected Results', [{ type: 'strong' }])); content.push(exp) }
  })

  return { type: 'doc', version: 1, content }
}

// Lightweight: current AC-source fingerprint for a ticket (no LLM call).
// Used to backfill a baseline on caches generated before sourceHash existed.
app.get('/api/ticket/:key/tc-source-hash', async (req, res) => {
  try {
    const key = req.params.key
    const issue = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=description,comment`)
    const f = issue.fields || {}
    const descriptionText = adfToText(f.description).trim()
    const comments = (f.comment?.comments || [])
      .map(c => `- ${c.author?.displayName || '?'}: ${adfToText(c.body).trim()}`)
      .filter(Boolean).join('\n')
    res.json({ key, sourceHash: sourceFingerprint(`${descriptionText}\n---\n${comments}`) })
  } catch (e) {
    sendError(res, e, req)
  }
})

app.post('/api/ticket/:key/prepare-tc', async (req, res) => {
  try {
    if (!TC_API_KEY) {
      const keyName = TC_PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
      return res.status(400).json({ error: `TC generation not configured — set ${keyName} (model ${RESOLVED_TC_MODEL}) in .env, then restart.` })
    }
    const key = req.params.key
    const body = req.body || {}
    const regenerate = body.regenerate === true

    // Read-only fetch — description AND comments (ACs sometimes live in comments).
    const issue = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,comment`)
    const f = issue.fields || {}
    const summary = f.summary || ''
    const descriptionText = adfToText(f.description).trim()
    const comments = (f.comment?.comments || [])
      .map(c => `- ${c.author?.displayName || '?'}: ${adfToText(c.body).trim()}`)
      .filter(Boolean).join('\n')

    const ticketBlock = `Ticket: ${key}\nSummary: ${summary}\n\nDescription:\n${descriptionText || '(empty)'}\n\nComments:\n${comments || '(none)'}`
    const sourceHash = sourceFingerprint(`${descriptionText}\n---\n${comments}`)

    try {
      // Targeted gap-fill: generate cases only for the given uncovered ACs.
      // Runs regardless of the source hash — an incomplete plan must be able to self-heal.
      if (Array.isArray(body.gapFill) && body.gapFill.length) {
        const acs = body.gapFill.map((a, i) => ({ id: String(a.id || `AC-${i + 1}`), text: String(a.text || '') }))
        const cases = await generateCasesForAcs(ticketBlock, acs)
        return res.json({ key, cases, sourceHash })
      }

      if (regenerate) {
        // (2) No-op if the AC source hasn't changed since last generation.
        if (body.priorHash && body.priorHash === sourceHash) {
          return res.json({ key, unchanged: true, sourceHash })
        }

        const priorAcs = (Array.isArray(body.priorAcceptanceCriteria) ? body.priorAcceptanceCriteria : [])
          .map(a => ({ id: String(a.id), text: String(a.text) }))
        const priorCases = (Array.isArray(body.priorCases) ? body.priorCases : []).map(normalizeTcCase)

        // Re-extract the canonical AC list, then diff against prior by normalized text.
        const newAcs = await extractAcsOnly(ticketBlock)
        const priorByNorm = new Map(priorAcs.map(a => [normAc(a.text), a]))
        const priorIdToNewId = new Map()
        const changedAcs = []
        for (const na of newAcs) {
          const pa = priorByNorm.get(normAc(na.text))
          if (pa) priorIdToNewId.set(pa.id, na.id) // unchanged → carry prior cases
          else changedAcs.push(na)                 // new/reworded → regenerate
        }

        // (3) Keep prior cases for unchanged ACs (relinked to the new ids); drop the rest.
        const carried = []
        for (const c of priorCases) {
          const remapped = (c.linkedAcceptanceCriteriaIds || []).map(id => priorIdToNewId.get(id)).filter(Boolean)
          if (remapped.length) carried.push({ ...c, linkedAcceptanceCriteriaIds: remapped })
        }

        // Regenerate only the changed/new ACs.
        let cases = [...carried, ...await generateCasesForAcs(ticketBlock, changedAcs)]
        // Safety: cover anything still uncovered.
        let gaps = uncoveredAcs(newAcs, cases)
        if (gaps.length) cases = [...cases, ...await generateCasesForAcs(ticketBlock, gaps)]

        return res.json({
          key,
          acceptanceCriteria: newAcs,
          cases,
          sourceHash,
          coverage: coverageOf(newAcs, cases),
          regen: { changedAcIds: changedAcs.map(a => a.id), unchangedCount: priorIdToNewId.size },
        })
      }

      // Fresh full generation.
      const { acceptanceCriteria, cases } = await generateFullTc(ticketBlock)
      let merged = cases
      const gaps = uncoveredAcs(acceptanceCriteria, merged)
      if (gaps.length) merged = [...merged, ...await generateCasesForAcs(ticketBlock, gaps)]

      return res.json({ key, acceptanceCriteria, cases: merged, sourceHash, coverage: coverageOf(acceptanceCriteria, merged) })
    } catch {
      return res.status(502).json({ error: 'Model returned malformed test-case output. Try again.' })
    }
  } catch (e) {
    sendError(res, e, req)
  }
})

// Submit: regenerate the feedback-flagged cases, applying each case's feedback. Stateless —
// the client sends the cases to revise; we return revised versions keyed by the same id.
app.post('/api/ticket/:key/revise-tc', async (req, res) => {
  try {
    if (!TC_API_KEY) {
      const keyName = TC_PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
      return res.status(400).json({ error: `TC generation not configured — set ${keyName} (model ${RESOLVED_TC_MODEL}) in .env, then restart.` })
    }
    const key = req.params.key
    const toRevise = (Array.isArray(req.body?.cases) ? req.body.cases : []).filter(c => c && c.id && String(c.feedback || '').trim())
    if (!toRevise.length) return res.json({ key, cases: [] })

    // Fetch ticket context for grounding.
    const issue = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,comment`)
    const f = issue.fields || {}
    const descriptionText = adfToText(f.description).trim()
    const comments = (f.comment?.comments || []).map(c => `- ${c.author?.displayName || '?'}: ${adfToText(c.body).trim()}`).filter(Boolean).join('\n')
    const ticketBlock = `Ticket: ${key}\nSummary: ${f.summary || ''}\n\nDescription:\n${descriptionText || '(empty)'}\n\nComments:\n${comments || '(none)'}`

    const sys = `You are a senior QA engineer revising existing test cases based on reviewer feedback.
For EACH input case, produce an improved version that addresses its "feedback" while keeping the
same intent and its linkedAcceptanceCriteriaIds. Keep the SAME "id" on each revised case.

${TC_CLARITY_RULES}

Return STRICT JSON: {"cases":[{ "id":"<same id>", title, section, automationType, estimate,
preconditions[], testData, priority, type, coverage, steps[{action,expectedResult}],
expectedResults[], linkedAcceptanceCriteriaIds[] }]}`

    const input = `${ticketBlock}\n\nRevise these cases:\n${toRevise.map(c => JSON.stringify({ id: c.id, title: c.title, steps: c.steps, expectedResults: c.expectedResults, linkedAcceptanceCriteriaIds: c.linkedAcceptanceCriteriaIds, feedback: c.feedback })).join('\n')}`

    let revised = []
    try {
      const parsed = parseJsonObject(await llm(input, { system: sys, maxTokens: 4000, model: RESOLVED_TC_MODEL }))
      revised = (Array.isArray(parsed.cases) ? parsed.cases : []).map(c => ({ ...normalizeTcCase(c), id: String(c.id || '') }))
    } catch {
      return res.status(502).json({ error: 'Model returned malformed output. Try Submit again.' })
    }
    res.json({ key, cases: revised })
  } catch (e) {
    sendError(res, e, req)
  }
})

function buildExecutionLogAdf({ cases, logger }) {
  const date = new Date().toISOString().slice(0, 10)
  const pass    = cases.filter(c => c.exec?.result === 'pass').length
  const fail    = cases.filter(c => c.exec?.result === 'fail').length
  const blocked = cases.filter(c => c.exec?.result === 'blocked').length
  const pending = cases.filter(c => !c.exec?.result).length
  const resultLabel = { pass: '✅ Pass', fail: '❌ Fail', blocked: '🚫 Blocked' }

  const headerRow = {
    type: 'tableRow', content: [
      { type: 'tableHeader', content: [adfPara('TC#', [{ type: 'strong' }])] },
      { type: 'tableHeader', content: [adfPara('Title', [{ type: 'strong' }])] },
      { type: 'tableHeader', content: [adfPara('Result', [{ type: 'strong' }])] },
      { type: 'tableHeader', content: [adfPara('Notes', [{ type: 'strong' }])] },
    ]
  }
  const rows = cases.map((c, i) => ({
    type: 'tableRow', content: [
      { type: 'tableCell', content: [adfPara(c.testCaseNumber || `TC${i + 1}`)] },
      { type: 'tableCell', content: [adfPara(c.title || '')] },
      { type: 'tableCell', content: [adfPara(resultLabel[c.exec?.result] || '⬜ Pending')] },
      { type: 'tableCell', content: [adfPara(c.exec?.notes || '')] },
    ]
  }))

  return {
    version: 1, type: 'doc', content: [
      adfHeading(3, '🧪 Execution Report'),
      adfPara([`Logged by ${logger || 'unknown'} · ${date}`, `✅ ${pass} Passed  ❌ ${fail} Failed  🚫 ${blocked} Blocked  ⬜ ${pending} Pending`].join('\n'), [{ type: 'em' }]),
      { type: 'table', content: [headerRow, ...rows] },
    ]
  }
}

// Log execution results to Jira as a comment.
app.post('/api/ticket/:key/log-execution', async (req, res) => {
  try {
    const key = req.params.key
    const cases = Array.isArray(req.body?.cases) ? req.body.cases : []
    if (!cases.length) return res.status(400).json({ error: 'No cases provided.' })
    let logger = ''
    try { logger = (await jira('/rest/api/3/myself')).displayName || '' } catch {}
    const adf = buildExecutionLogAdf({ cases, logger })
    const result = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST', body: JSON.stringify({ body: adf }),
    })
    res.json({ ok: true, commentId: String(result.id || '') })
  } catch (e) {
    sendError(res, e, req)
  }
})

// Accept: post the finalized test plan to the Jira ticket as a structured comment.
app.post('/api/ticket/:key/comment', async (req, res) => {
  try {
    const key = req.params.key
    const cases = Array.isArray(req.body?.cases) ? req.body.cases : []
    const coverage = req.body?.coverage || {}
    if (!cases.length) return res.status(400).json({ error: 'No cases to post.' })

    // Accepter name (read-only).
    let accepter = ''
    try { accepter = (await jira('/rest/api/3/myself')).displayName || '' } catch {}

    const adf = buildTestPlanAdf({ cases, coverage, accepter })
    const result = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: adf }),
    })
    res.json({ ok: true, commentId: String(result.id || ''), accepter })
  } catch (e) {
    sendError(res, e, req)
  }
})

app.post('/api/ticket/:key/check-readiness', async (req, res) => {
  try {
    if (!READINESS_API_KEY) {
      const keyName = READINESS_PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
      return res.status(400).json({ error: `Readiness check not configured — set ${keyName} (model ${READINESS_MODEL}) in .env, then restart.` })
    }
    const key = req.params.key

    // Read-only fetch of everything the rules need.
    const fields = 'summary,description,comment,issuetype,labels,status'
    const issue = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`)
    const f = issue.fields || {}
    const issueType = f.issuetype?.name || 'Unknown'

    // Epic is out of scope per the rules — short-circuit without an LLM call.
    if (issueType.toLowerCase() === 'epic') {
      return res.json({ key, type: 'Epic', result: 'SKIPPED', failedPoints: [], notes: 'Epic validation is out of scope.' })
    }

    const descriptionText = adfToText(f.description).trim()
    const comments = (f.comment?.comments || []).map(c => `- ${c.author?.displayName || '?'}: ${adfToText(c.body).trim()}`).join('\n')
    const labels = (f.labels || []).join(', ')

    const ticketBlock = [
      `Key: ${key}`,
      `Issue type: ${issueType}`,
      `Labels: ${labels || '(none)'}`,
      `Current status: ${f.status?.name || '(unknown)'}`,
      `Summary: ${f.summary || ''}`,
      ``,
      `Description:`,
      descriptionText || '(empty)',
      ``,
      `Comments:`,
      comments || '(none)',
    ].join('\n')

    const system = `You validate whether a Jira ticket in the ${PROJECTS[0] || 'given'} project is "Ready for Testing".
Apply ONLY the rules below. Be conservative: when evidence is ambiguous, fail the relevant check.
Return STRICT JSON and nothing else, shaped exactly as:
{"type":"Feature|Bug|Incident|Epic","result":"PASS|FAIL|SKIPPED","failedPoints":["..."],"notes":"short summary"}

RULES:
${readinessRules()}`

    const raw = await llm(
      `Validate this ticket and return the JSON verdict.\n\n${ticketBlock}`,
      { system, maxTokens: 1200 },
    )

    let verdict
    try {
      verdict = parseVerdict(raw)
    } catch {
      verdict = { type: issueType, result: 'FAIL', failedPoints: ['Could not validate — model returned malformed output.'], notes: '' }
    }
    res.json({ key, ...verdict })
  } catch (e) {
    sendError(res, e, req)
  }
})

app.post('/api/ticket/:key/transition', async (req, res) => {
  try {
    const key = req.params.key
    const target = String(req.body?.toStatus || '').trim().toLowerCase()
    if (!target) return res.status(400).json({ error: 'toStatus required' })

    // If the ticket is already in the target status, return gracefully
    // instead of erroring (e.g. someone else already moved it).
    const issue = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`)
    const currentStatus = issue.fields?.status?.name || ''
    if (currentStatus.toLowerCase() === target) {
      return res.json({ ok: true, alreadyThere: true, status: currentStatus })
    }

    const data = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
    const match = (data.transitions || []).find(t => (t.to?.name || '').toLowerCase() === target)
    if (!match) {
      const available = (data.transitions || []).map(t => t.to?.name).filter(Boolean)
      return res.status(409).json({ error: `No "${req.body.toStatus}" transition available. Options: ${available.join(', ') || 'none'}` })
    }
    await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    })
    res.json({ ok: true, transitionedTo: match.to.name })
  } catch (e) {
    sendError(res, e, req)
  }
})

app.put('/api/ticket/:key/story-points', async (req, res) => {
  try {
    const { points } = req.body || {}
    if (typeof points !== 'number') return res.status(400).json({ error: 'points (number) required' })
    await jira(`/rest/api/3/issue/${encodeURIComponent(req.params.key)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { [JIRA_STORY_POINTS_FIELD]: points } }),
    })
    res.json({ ok: true })
  } catch (e) {
    sendError(res, e, req)
  }
})

app.post('/api/bulk-add-to-sprint', async (req, res) => {
  try {
    const { sprintId, keys } = req.body || {}
    if (!sprintId || !Array.isArray(keys) || !keys.length) {
      return res.status(400).json({ error: 'sprintId and keys[] required' })
    }
    await jira(`/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue`, {
      method: 'POST',
      body: JSON.stringify({ issues: keys }),
    })
    res.json({ ok: true, moved: keys.length })
  } catch (e) {
    sendError(res, e, req)
  }
})

// --- Persistent store endpoints ---------------------------------------------
app.get('/api/store', (_req, res) => res.json(STORE))

app.put('/api/store/readiness/:key', (req, res) => {
  STORE.readiness[req.params.key] = req.body
  saveStore()
  res.json({ ok: true })
})

app.put('/api/store/tc/:key', (req, res) => {
  STORE.tc[req.params.key] = req.body
  saveStore()
  res.json({ ok: true })
})


// Unknown API route → JSON 404 (so the client never gets index.html for a typo'd endpoint).
app.use('/api', (req, res) => {
  warn(`404 ${req.method} ${req.originalUrl}`)
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.path}` })
})

// Global error handler — catches anything thrown outside a route's try/catch.
app.use((err, req, res, _next) => {
  console.error(`[${ts()}] ❌ Unhandled ${req.method} ${req.originalUrl}\n   ${err?.stack || err}`)
  res.status(500).json({ error: String(err?.message || err) })
})

app.listen(PORT, () => log(`QA Dashboard → http://localhost:${PORT}`))

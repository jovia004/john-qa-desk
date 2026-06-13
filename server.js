import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECTS = '',
  JIRA_STORY_POINTS_FIELD = 'customfield_10016',
  TESTING_STATUSES = 'ready for testing,testing,in qa,qa',
  PORT = 5173,
} = process.env

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
app.use(express.json())

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
    res.json({ dates })
  } catch (e) {
    sendError(res, e, req)
  }
})

app.get('/api/tickets/by-duedate', async (req, res) => {
  try {
    const project = String(req.query.project || '')
    const dates = String(req.query.dates || '').split(',').map(s => s.trim()).filter(Boolean)
    if (!project || !dates.length) return res.status(400).json({ error: 'project and dates required' })
    const dateList = dates.map(d => `"${d}"`).join(',')
    const jql = `project = ${project} AND duedate in (${dateList})`
    const fields = ['summary', 'status', 'priority', 'assignee', 'issuetype', 'duedate', JIRA_STORY_POINTS_FIELD]
    const issues = await searchJql(jql, fields, 500)
    const all = issues.map(i => mapIssue(i, project))
    const testing = all.filter(i => TESTING.includes(i.status.toLowerCase()))
    res.json({ all, testing })
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

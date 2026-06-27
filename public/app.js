const $ = (id) => document.getElementById(id)

const state = {
  projects: [],
  project: null,
  mode: 'duedate', // 'sprint' | 'duedate'
  sprints: { current: null, last: null, next: null },
  activeSprintKey: 'current',
  dueDates: [],            // [{date, count}]
  selectedYear: null,
  selectedDueDates: new Set(),
  tickets: [],             // filtered (Ready for Testing / Testing)
  allTickets: [],          // every ticket from the current scope
  showAll: false,          // toggle: show all vs testing-only
  sortBy: 'status',        // 'project' | 'key' | 'summary' | 'status' | 'assignee' | 'priority'
  sortDir: 'desc',         // 'asc' | 'desc'
}

const PRIORITY_RANK = { highest: 5, high: 4, medium: 3, low: 2, lowest: 1 }
const STATUS_RANK = {
  'blocked': 0,
  'to do': 1,
  'backlog': 2,
  'ready for development': 3,
  'design': 4,
  'technical design': 5,
  'development': 6,
  'pr review': 7,
  'ready for testing': 8,
  'testing': 9,
  'in qa': 9,
  'qa': 9,
  'ready for release': 10,
  'done': 11,
  'obsolete / cancelled': 12,
  'duplicate': 13,
}

function sortValue(t, key) {
  switch (key) {
    case 'priority': return PRIORITY_RANK[(t.priority || '').toLowerCase()] || 0
    case 'status': return STATUS_RANK[(t.status || '').toLowerCase()] ?? 99
    case 'key': {
      // Natural sort on key suffix (OS-28 < OS-100)
      const m = (t.key || '').match(/(\d+)/)
      return m ? Number(m[1]) : 0
    }
    default: return String(t[key] || '').toLowerCase()
  }
}

function updateSortIndicators() {
  document.querySelectorAll('.sort-h').forEach(th => {
    const ind = th.querySelector('.sort-ind')
    const active = th.dataset.sort === state.sortBy
    ind.textContent = active ? (state.sortDir === 'asc' ? '▲' : '▼') : ''
    th.classList.toggle('text-blue-600', active)
    th.classList.toggle('dark:text-blue-300', active)
  })
}

function onHeaderClick(e) {
  const th = e.target.closest('.sort-h')
  if (!th) return
  const key = th.dataset.sort
  if (state.sortBy === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'
  } else {
    state.sortBy = key
    // Sensible defaults: priority/status start desc, text columns start asc.
    state.sortDir = (key === 'priority' || key === 'status') ? 'desc' : 'asc'
  }
  renderTickets(state.showAll ? state.allTickets : state.tickets)
}

function sortTickets(list) {
  const { sortBy, sortDir } = state
  const dir = sortDir === 'asc' ? 1 : -1
  // Tiebreakers: priority desc, then key asc — except when those columns ARE the primary.
  return [...list].sort((a, b) => {
    const av = sortValue(a, sortBy), bv = sortValue(b, sortBy)
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    if (sortBy !== 'priority') {
      const ap = sortValue(a, 'priority'), bp = sortValue(b, 'priority')
      if (ap !== bp) return bp - ap // priority desc
    }
    return sortValue(a, 'key') - sortValue(b, 'key') // key asc
  })
}

const TOAST_ICONS = {
  success: `<svg class="w-4 h-4 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  error: `<svg class="w-4 h-4 text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`,
  info: `<svg class="w-4 h-4 text-blue-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`,
}

// type: 'success' | 'error' | undefined (plain)
function toast(msg, type, ms = 2500) {
  const el = $('toast')
  const icon = TOAST_ICONS[type] || ''
  el.innerHTML = `<span class="inline-flex items-center gap-2">${icon}<span>${escapeHtml(msg)}</span></span>`
  el.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), ms)
}

async function api(path, opts) {
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// Versioning so a slow earlier response can't overwrite a faster later one.
let _reqVersion = 0
function nextReqVersion() { return ++_reqVersion }
function isCurrent(v) { return v === _reqVersion }

// Centralized loading indicator — shows spinner on the Refresh button and
// a "Loading…" row in the table while any fetch is in flight.
let _busy = 0
function setBusy(on) {
  _busy = Math.max(0, _busy + (on ? 1 : -1))
  const active = _busy > 0
  const btn = $('refreshBtn'), icon = $('refreshIcon')
  if (btn) btn.disabled = active
  if (icon) icon.classList.toggle('animate-spin', active) // spin while loading, static when done
  // Mirror state on the drawer's refresh button.
  const dBtn = $('drawerRefresh'), dIcon = $('drawerRefreshIcon')
  if (dBtn) dBtn.disabled = active
  if (dIcon) dIcon.classList.toggle('animate-spin', active)
  if (active) {
    const body = $('ticketsBody')
    if (body && !body.querySelector('.loading-row')) {
      body.innerHTML = `<tr class="loading-row"><td colspan="7" class="text-center py-10">
        <span class="inline-flex items-center gap-2 text-slate-500">
          <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7" stroke-linecap="round"/></svg>
          Loading…
        </span>
      </td></tr>`
    }
  }
}

async function refreshAll() {
  // setBusy is managed inside loadTickets; keep current selection intact.
  await loadTickets()
}

function setPill(id, sprint) {
  const el = $(id)
  el.textContent = sprint?.name || '—'
}

function highlightPills() {
  const map = { last: 'lastSprintPill', current: 'currentSprintPill', next: 'nextSprintPill' }
  for (const [key, id] of Object.entries(map)) {
    const el = $(id)
    const active = key === state.activeSprintKey
    el.classList.toggle('pill-active', active)
    el.classList.toggle('pill-idle', !active)
  }
}

function selectSprint(key) {
  if (!state.sprints[key]) {
    toast(`No ${key} sprint available`)
    return
  }
  state.activeSprintKey = key
  highlightPills()
  loadTickets()
}

function renderTickets(tickets) {
  tickets = sortTickets(tickets)
  updateSortIndicators()
  const body = $('ticketsBody')
  if (!tickets.length) {
    const msg = state.showAll
      ? 'No tickets found for this selection.'
      : 'No Ready for Testing / Testing tickets. Flip "Show all tickets" to see everything.'
    body.innerHTML = `<tr><td colspan="7" class="text-center py-10 text-slate-500">${msg}</td></tr>`
    return
  }
  body.innerHTML = tickets.map(t => `
    <tr class="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
      <td class="py-3"><input type="checkbox" class="row-check" data-key="${t.key}" /></td>
      <td class="py-3 font-medium">${t.project}</td>
      <td class="py-3"><a class="text-blue-600 hover:underline" target="_blank" href="${jiraIssueUrl(t.key)}">${t.key}</a></td>
      <td class="py-3 max-w-md truncate" title="${escapeHtml(t.summary)}">${escapeHtml(t.summary)}</td>
      <td class="py-3"><span class="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">${escapeHtml(t.status)}</span></td>
      <td class="py-3">
        <div class="flex items-center gap-2">
          ${t.assigneeAvatar ? `<img src="${t.assigneeAvatar}" class="w-6 h-6 rounded-full" />` : ''}
          <span>${escapeHtml(t.assignee)}</span>
        </div>
      </td>
      <td class="py-3">${escapeHtml(t.priority)}</td>
    </tr>
  `).join('')

  // Shift-click range selection — delegate at the tbody level so it survives re-renders.
  // The first click anchors lastCheckedIndex; a subsequent shift-click extends
  // the selection (matching the second checkbox's checked state) over the range.
  if (!body._shiftBound) {
    body._shiftBound = true
    body._lastIdx = -1
    body.addEventListener('click', (e) => {
      const cb = e.target.closest('.row-check')
      if (!cb) return
      const all = [...body.querySelectorAll('.row-check')]
      const idx = all.indexOf(cb)
      if (e.shiftKey && body._lastIdx >= 0 && body._lastIdx !== idx) {
        const [lo, hi] = idx < body._lastIdx ? [idx, body._lastIdx] : [body._lastIdx, idx]
        for (let i = lo; i <= hi; i++) all[i].checked = cb.checked
      }
      body._lastIdx = idx
      updateBulkBtn()
    })
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

let _jiraBase = ''
function jiraIssueUrl(key) {
  return _jiraBase ? `${_jiraBase}/browse/${key}` : '#'
}

function updateBulkBtn() {
  const checked = document.querySelectorAll('.row-check:checked').length
  const btn = $('bulkAddBtn')
  btn.disabled = checked === 0 || !state.sprints.next
  btn.textContent = checked > 0 ? `Bulk add ${checked} to next sprint` : 'Bulk add to the next sprint'
}

async function loadSprints({ fetchTickets = true } = {}) {
  if (!state.project) return
  $('statusLine').textContent = 'Loading sprints…'
  try {
    const { picked } = await api(`/api/sprints?project=${encodeURIComponent(state.project)}`)
    state.sprints = picked
    setPill('lastSprintPill', picked.last)
    setPill('currentSprintPill', picked.current)
    setPill('nextSprintPill', picked.next)
    // Default to current if available, else fall back to last, else next.
    state.activeSprintKey = picked.current ? 'current' : (picked.last ? 'last' : 'next')
    highlightPills()
    $('statusLine').textContent = picked.current
      ? `Project: ${state.project} · Current sprint: ${picked.current.name}`
      : `Project: ${state.project} · No active sprint found.`
    // When primed in the background (e.g. Due-date mode), skip the ticket fetch.
    if (fetchTickets) await loadTickets()
  } catch (err) {
    $('statusLine').textContent = `Error: ${err.message}`
  }
}

async function loadTickets() {
  const v = nextReqVersion()
  setBusy(true)
  try {
    let all = [], testing = []
    if (state.mode === 'sprint') {
      const sprint = state.sprints[state.activeSprintKey]
      if (!sprint) return renderTickets([])
      ;({ all, testing } = await api(`/api/tickets?project=${encodeURIComponent(state.project)}&sprintId=${sprint.id}`))
    } else {
      const dates = [...state.selectedDueDates]
      if (!dates.length) return renderTickets([])
      ;({ all, testing } = await api(`/api/tickets/by-duedate?project=${encodeURIComponent(state.project)}&dates=${encodeURIComponent(dates.join(','))}`))
    }
    if (!isCurrent(v)) return
    state.allTickets = all
    state.tickets = testing
    renderTickets(state.showAll ? all : testing)
    updateBulkBtn()
  } catch (err) {
    if (isCurrent(v)) toast(`Tickets error: ${err.message}`, 'error')
  } finally {
    setBusy(false)
  }
}

async function loadDueDates() {
  const wrap = $('dueDateChips')
  wrap.innerHTML = '<span class="text-sm text-slate-500">Loading due dates…</span>'
  try {
    const { dates, noDueDate } = await api(`/api/duedates?project=${encodeURIComponent(state.project)}`)
    state.dueDates = dates
    state.noDueDateCount = noDueDate || 0
    populateYearSelect()
    pickDefaultYearAndDate()
    renderDueDateChips()
    loadTickets()
  } catch (err) {
    wrap.innerHTML = `<span class="text-sm text-red-500">Error: ${err.message}</span>`
  }
}

function yearsAvailable() {
  return [...new Set(state.dueDates.map(d => d.date.slice(0, 4)))].sort()
}

function populateYearSelect() {
  const sel = $('yearSelect')
  const years = yearsAvailable()
  sel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('')
}

function pickDefaultYearAndDate() {
  const years = yearsAvailable()
  if (!years.length) return
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const currentYear = today.slice(0, 4)
  state.selectedYear = years.includes(currentYear) ? currentYear : years[years.length - 1]
  $('yearSelect').value = state.selectedYear

  // Nearest date to today within the selected year (absolute distance in days).
  const inYear = state.dueDates.filter(d => d.date.startsWith(state.selectedYear))
  if (!inYear.length) return
  const todayMs = Date.parse(today)
  let nearest = inYear[0]
  let bestDiff = Math.abs(Date.parse(nearest.date) - todayMs)
  for (const d of inYear) {
    const diff = Math.abs(Date.parse(d.date) - todayMs)
    if (diff < bestDiff) { bestDiff = diff; nearest = d }
  }
  state.selectedDueDates.clear()
  state.selectedDueDates.add(nearest.date)
}

function renderDueDateChips() {
  const wrap = $('dueDateChips')
  const inYear = state.dueDates.filter(d => d.date.startsWith(state.selectedYear || ''))

  // "No due date" is a pinned chip (not tied to a year), shown when any exist.
  const noneActive = state.selectedDueDates.has('none')
  const noneChip = state.noDueDateCount > 0
    ? `<button data-date="none" class="dd-chip rounded-full px-4 py-2 text-sm font-medium ${noneActive ? 'pill-active' : 'pill-idle'}">No due date <span class="opacity-70">(${state.noDueDateCount})</span></button>`
    : ''

  if (!inYear.length && !noneChip) {
    wrap.innerHTML = '<span class="text-sm text-slate-500">No due dates for this year.</span>'
    return
  }

  wrap.innerHTML = inYear.map(d => {
    const active = state.selectedDueDates.has(d.date)
    return `<button data-date="${d.date}" class="dd-chip rounded-full px-4 py-2 text-sm font-medium ${
      active ? 'pill-active' : 'pill-idle'
    }">${d.date} <span class="opacity-70">(${d.count})</span></button>`
  }).join('') + noneChip
  wrap.querySelectorAll('.dd-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const date = btn.dataset.date
      // Single-select: clicking always sets this as the only selected date.
      state.selectedDueDates.clear()
      state.selectedDueDates.add(date)
      renderDueDateChips()
      loadTickets()
    })
  })
}

function onYearChange() {
  state.selectedYear = $('yearSelect').value
  // Drop selections no longer visible in this year, but keep the year-agnostic "none" chip.
  for (const d of [...state.selectedDueDates]) {
    if (d !== 'none' && !d.startsWith(state.selectedYear)) state.selectedDueDates.delete(d)
  }
  renderDueDateChips()
  loadTickets()
}

function setMode(mode) {
  state.mode = mode
  const sprintBtn = $('modeSprintBtn'), dueBtn = $('modeDueDateBtn')
  const setActive = (btn, active) => {
    btn.classList.toggle('btn-primary', active)
    btn.classList.toggle('btn-ghost', !active)
  }
  setActive(sprintBtn, mode === 'sprint')
  setActive(dueBtn, mode === 'duedate')
  $('sprintView').classList.toggle('hidden', mode !== 'sprint')
  $('dueDateView').classList.toggle('hidden', mode !== 'duedate')
  if (mode === 'sprint') {
    loadTickets()
  } else {
    if (!state.dueDates.length) loadDueDates()
    else loadTickets()
  }
}

async function bulkAdd() {
  const keys = [...document.querySelectorAll('.row-check:checked')].map(cb => cb.dataset.key)
  if (!keys.length || !state.sprints.next) return
  try {
    await api('/api/bulk-add-to-sprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sprintId: state.sprints.next.id, keys }),
    })
    toast(`Moved ${keys.length} ticket(s) to ${state.sprints.next.name}`, 'success')
    await loadTickets()
  } catch (err) {
    toast(`Bulk add failed: ${err.message}`, 'error')
  }
}

// --- Status drawer ---------------------------------------------------------
const DRAWER_COLUMNS = [
  { id: 'ready',   title: 'Ready for test',   match: s => /^ready for testing$/i.test(s) },
  { id: 'testing', title: 'Testing',          match: s => /^(testing|in qa|qa)$/i.test(s) },
  { id: 'release', title: 'Ready to release', match: s => /^ready for release$/i.test(s) },
  { id: 'failed',  title: 'Test failed',      match: s => /(test\s*failed|qa\s*failed|^failed$)/i.test(s) },
]
const CARD_MENU_ACTIONS = {
  ready:   [{ id: 'check-readiness', label: 'Check Readiness' }, { id: 'move-to-testing', label: 'Move to Testing' }],
  testing: [{ id: 'prepare-tc', label: 'Prepare TC' }, { id: 'check-rtr', label: 'Check Ready to Release', stub: true }],
  release: [{ id: 'check-mr', label: 'Check MR', stub: true }, { id: 'check-zync', label: 'Check Zync Pre Flight score', stub: true }],
  failed:  [],
}
const COLUMN_ACCENT = {
  ready:   'border-blue-600',
  testing: 'border-amber-500',
  release: 'border-emerald-500',
  failed:  'border-rose-500',
}

function renderDrawer() {
  // Scope label — reflect current filter
  const scopeEl = $('drawerScope')
  if (state.mode === 'sprint') {
    const s = state.sprints[state.activeSprintKey]
    scopeEl.textContent = s ? `${state.project} · ${s.name}` : state.project
  } else {
    const dates = [...state.selectedDueDates]
    scopeEl.textContent = `${state.project} · Due on ${dates.join(', ') || '—'}`
  }

  const cols = $('drawerColumns')
  cols.innerHTML = DRAWER_COLUMNS.map(col => {
    const items = (state.allTickets || []).filter(t => col.match(t.status || ''))
    const rows = items.length
      ? items.map(t => `
          <a href="${jiraIssueUrl(t.key)}" target="_blank"
             data-card data-key="${t.key}" data-col="${col.id}"
             class="block rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 p-3 mb-2">
            <div class="flex items-center justify-between text-xs text-slate-400">
              <span class="font-mono">${t.key}${readinessBadge(t.key)}</span>
              <span>${escapeHtml(t.priority || '')}</span>
            </div>
            <div class="text-sm text-slate-100 mt-1 line-clamp-2">${escapeHtml(t.summary || '')}</div>
            <div class="flex items-center gap-2 mt-2 text-xs text-slate-400">
              ${t.assigneeAvatar ? `<img src="${t.assigneeAvatar}" class="w-5 h-5 rounded-full"/>` : ''}
              <span>${escapeHtml(t.assignee || 'Unassigned')}</span>
            </div>
          </a>`).join('')
      : `<div class="text-sm text-slate-500 italic">No tickets.</div>`
    return `
      <div class="rounded-xl bg-slate-900/60 border-t-4 ${COLUMN_ACCENT[col.id]} border-x border-b border-slate-800 flex flex-col h-full min-h-0">
        <div class="flex items-center justify-between px-3 pt-3 pb-2 shrink-0">
          <div class="font-semibold text-slate-100">${col.title}</div>
          <span class="text-xs rounded-full bg-slate-800 px-2 py-0.5 text-slate-300">${items.length}</span>
        </div>
        <div class="flex-1 overflow-y-auto px-3 pb-3">${rows}</div>
      </div>`
  }).join('')
}

async function ensureAllTicketsLoaded() {
  // If we only have testing-only data cached, we still have allTickets from
  // the last loadTickets() — it includes every status. Re-fetch only if empty.
  if (state.allTickets.length) return
  await loadTickets()
}

async function openDrawer() {
  await ensureAllTicketsLoaded()
  renderDrawer()
  $('statusDrawer').classList.remove('translate-x-full')
  $('drawerBackdrop').classList.remove('hidden')
}
function closeDrawer() {
  $('statusDrawer').classList.add('translate-x-full')
  $('drawerBackdrop').classList.add('hidden')
}
function isDrawerOpen() {
  return !$('statusDrawer').classList.contains('translate-x-full')
}

// A small "already done" indicator for a menu row (e.g. TC already prepared).
function menuActionIndicator(actionId, ticketKey) {
  if (actionId === 'prepare-tc') {
    const store = getTcStore(ticketKey)
    const count = store ? ((store.generated || []).length + (store.manual || []).length) : 0
    if (count > 0) {
      return `<span class="inline-flex items-center gap-1 text-emerald-400 text-xs" title="${count} test case${count === 1 ? '' : 's'} prepared">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>${count}
      </span>`
    }
  }
  return ''
}

function openCardMenu(x, y, ticketKey, colId) {
  const actions = CARD_MENU_ACTIONS[colId] || []
  if (!actions.length) return
  const menu = $('cardMenu')
  menu.innerHTML = `
    <div class="px-3 py-1.5 text-xs text-slate-400 border-b border-slate-800 font-mono">${ticketKey}</div>
    ${actions.map(a => a.stub
      ? `<div class="w-full flex items-center justify-between gap-2 px-3 py-2 text-slate-500 cursor-not-allowed select-none">
           <span>${a.label}</span>
           <span class="text-xs bg-slate-800 text-slate-500 rounded px-1.5 py-0.5 leading-tight">Soon</span>
         </div>`
      : `<button data-action="${a.id}" data-key="${ticketKey}" data-col="${colId}"
                class="card-menu-item w-full flex items-center justify-between gap-2 text-left px-3 py-2 text-slate-100 hover:bg-slate-800">
           <span>${a.label}</span>${menuActionIndicator(a.id, ticketKey)}
         </button>`
    ).join('')}
  `
  // Position, clamped to viewport.
  menu.classList.remove('hidden')
  const { offsetWidth: w, offsetHeight: h } = menu
  const px = Math.min(x, window.innerWidth - w - 8)
  const py = Math.min(y, window.innerHeight - h - 8)
  menu.style.left = px + 'px'
  menu.style.top = py + 'px'

  menu.querySelectorAll('.card-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const { action, key, col } = btn.dataset
      runCardAction(action, key, col, btn)
    })
  })
}

const MENU_SPINNER = `<svg class="w-4 h-4 animate-spin inline-block" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7" stroke-linecap="round"/></svg>`

function setMenuItemBusy(btn, busy) {
  if (busy) {
    btn.dataset.label = btn.textContent.trim()
    btn.disabled = true
    btn.classList.add('opacity-80', 'pointer-events-none', 'relative')
    // Label stays in place; spinner is absolutely positioned on the right so
    // the menu item width never changes.
    btn.innerHTML = `<span>${btn.dataset.label}</span>` +
      `<span class="absolute right-2 top-1/2 -translate-y-1/2">${MENU_SPINNER}</span>`
  } else {
    btn.disabled = false
    btn.classList.remove('opacity-80', 'pointer-events-none', 'relative')
    if (btn.dataset.label) btn.textContent = btn.dataset.label
  }
}

async function runCardAction(action, key, col, btn) {
  switch (action) {
    case 'move-to-testing':
      return moveToTesting(key, btn)
    case 'check-readiness':
      return checkReadiness(key, btn)
    case 'prepare-tc':
      return prepareTc(key, btn)
    default:
      closeCardMenu()
      toast(`${action} is not available yet`, 'info')
  }
}

// --- Check Readiness -------------------------------------------------------
// Verdicts: sessionStorage for fast sync reads + write-through to server for persistence.
function readinessKey(key) { return `readiness:${key}` }
function getReadiness(key) {
  try { return JSON.parse(sessionStorage.getItem(readinessKey(key)) || 'null') } catch { return null }
}
function setReadiness(key, verdict) {
  try { sessionStorage.setItem(readinessKey(key), JSON.stringify(verdict)) } catch {}
  fetch(`/api/store/readiness/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(verdict),
  }).catch(() => {})
}


async function checkReadiness(key, btn) {
  setMenuItemBusy(btn, true)
  try {
    const verdict = await api(`/api/ticket/${encodeURIComponent(key)}/check-readiness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    setReadiness(key, verdict)
    closeCardMenu()
    renderDrawer() // repaint badge
    openReadinessModal(verdict)
    if (verdict.result === 'PASS') toast(`${key} is ready for test`, 'success')
    else if (verdict.result === 'SKIPPED') toast(`${key}: ${verdict.notes || 'skipped'}`, 'info')
    else toast(`${key} not ready (${verdict.failedPoints.length} issue${verdict.failedPoints.length === 1 ? '' : 's'})`, 'error')
  } catch (err) {
    setMenuItemBusy(btn, false)
    closeCardMenu()
    toast(`Readiness check failed: ${err.message}`, 'error')
  }
}

function readinessPill(result) {
  if (result === 'PASS') return '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-600 text-white">READY</span>'
  if (result === 'SKIPPED') return '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-slate-600 text-white">SKIPPED</span>'
  return '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-rose-600 text-white">NOT READY</span>'
}

function openReadinessModal(v) {
  const body = $('readinessModalBody')
  const points = v.result === 'FAIL' && v.failedPoints.length
    ? `<div class="mt-4">
         <div class="flex items-center justify-between mb-2">
           <div class="text-xs font-bold tracking-widest text-rose-400">FAILED REQUIREMENTS</div>
           <button id="readinessCopy" class="rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-medium hover:bg-slate-800 inline-flex items-center gap-1.5">
             <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
             <span>Copy</span>
           </button>
         </div>
         <ul class="space-y-2">${v.failedPoints.map(p => `<li class="flex gap-2 text-sm text-slate-200"><span class="text-rose-400">✗</span><span>${escapeHtml(p)}</span></li>`).join('')}</ul>
       </div>`
    : (v.result === 'PASS' ? '<div class="mt-4 text-sm text-emerald-400">All required fields present.</div>' : '')
  body.innerHTML = `
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="font-mono text-slate-400">${escapeHtml(v.key || '')}</span>
        ${readinessPill(v.result)}
      </div>
      <button id="readinessClose" class="rounded-lg border border-slate-700 p-2 inline-flex items-center justify-center hover:bg-slate-800">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="mt-3 text-sm text-slate-400">Detected type: <span class="text-slate-200 font-medium">${escapeHtml(v.type || 'Unknown')}</span></div>
    ${points}
    ${v.notes ? `<div class="mt-4 text-sm text-slate-400 border-t border-slate-800 pt-3">${escapeHtml(v.notes)}</div>` : ''}
  `
  $('readinessModal').classList.remove('hidden')
  $('readinessBackdrop').classList.remove('hidden')
  $('readinessClose').addEventListener('click', closeReadinessModal)

  const copyBtn = $('readinessCopy')
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = `${v.key} — Not ready for testing (${v.type}):\n` +
        v.failedPoints.map(p => `- ${p}`).join('\n')
      try {
        await navigator.clipboard.writeText(text)
        copyBtn.querySelector('span').textContent = 'Copied!'
        setTimeout(() => { const s = copyBtn.querySelector('span'); if (s) s.textContent = 'Copy' }, 1500)
      } catch {
        toast('Copy failed — clipboard blocked', 'error')
      }
    })
  }
}
function closeReadinessModal() {
  $('readinessModal').classList.add('hidden')
  $('readinessBackdrop').classList.add('hidden')
}

function readinessBadge(key) {
  const v = getReadiness(key)
  if (!v) return ''
  const map = {
    PASS:    ['bg-emerald-600/20 text-emerald-300 border-emerald-600/40', '✓ Ready'],
    FAIL:    ['bg-rose-600/20 text-rose-300 border-rose-600/40',          '✗ Not ready'],
    SKIPPED: ['bg-slate-600/20 text-slate-300 border-slate-600/40',       'Skipped'],
  }
  const [cls, label] = map[v.result] || map.SKIPPED
  return `<span class="ml-2 inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}">${label}</span>`
}

// --- Prepare TC ------------------------------------------------------------
// TC plans: sessionStorage for fast sync reads + write-through to server for persistence.
function tcKey(key) { return `tc:${key}` }
function getTcStore(key) {
  try { return JSON.parse(sessionStorage.getItem(tcKey(key)) || 'null') } catch { return null }
}
function setTcStore(key, store) {
  const normalized = assignCaseIds(store)
  try { sessionStorage.setItem(tcKey(key), JSON.stringify(normalized)) } catch {}
  fetch(`/api/store/tc/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalized),
  }).catch(() => {})
}

// Assign stable ids to every case (needed for review staging + targeted revision).
function assignCaseIds(store) {
  store.idSeq = store.idSeq || 0
  for (const c of [...(store.generated || []), ...(store.manual || [])]) {
    if (!c.id) c.id = `c${++store.idSeq}`
  }
  return store
}

// --- Review state (per case): review = 'approved' | 'feedback' | 'removed' | null ---
function findCase(key, id) {
  return allTcCases(key).find(c => c.id === id) || null
}
function setReview(key, id, review, feedback) {
  const store = getTcStore(key); if (!store) return
  const c = [...(store.generated || []), ...(store.manual || [])].find(x => x.id === id)
  if (!c) return
  c.review = review
  if (feedback !== undefined) c.feedback = feedback
  setTcStore(key, store)
}
function activeCases(key) { return allTcCases(key).filter(c => c.review !== 'removed') }
function hasPendingSubmit(key) {
  return allTcCases(key).some(c => c.review === 'removed' || (c.review === 'feedback' && String(c.feedback || '').trim()))
}
function isAcceptReady(key) {
  if (hasPendingSubmit(key)) return false
  const active = activeCases(key)
  if (!active.length) return false
  if (!active.every(c => c.review === 'approved')) return false
  // Coverage over active (non-removed) cases must be full.
  const store = getTcStore(key) || {}
  const acs = store.acceptanceCriteria || []
  const linked = new Set(active.flatMap(c => c.linkedAcceptanceCriteriaIds || []))
  return acs.length > 0 && acs.every(a => linked.has(a.id))
}

// Hard guard so rapid clicks / replaced buttons can't fire concurrent LLM calls.
let tcActionInFlight = false
// Whether the currently-open ticket's plan is accepted (locks review actions).
let tcLocked = false

// Persistent progress banner (the menu/spinner disappears once the menu closes,
// so we need a standalone indicator while the ~20-30s call runs).
function showPrepProgress(key) {
  let el = $('prepProgress')
  if (!el) {
    el = document.createElement('div')
    el.id = 'prepProgress'
    el.className = 'fixed bottom-6 left-6 z-[70] inline-flex items-center gap-2 rounded-lg bg-slate-900 text-white px-4 py-2 shadow-lg border border-slate-700'
    document.body.append(el)
  }
  el.innerHTML = `<svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7" stroke-linecap="round"/></svg><span>Preparing test cases for ${escapeHtml(key)}…</span>`
  el.classList.remove('hidden')
}
function hidePrepProgress() {
  $('prepProgress')?.remove()
}

// Whether to auto-open the dialog when prep finishes: only if you're still on the
// status board and haven't opened another modal in the meantime.
function isPrepStillRelevant() {
  const drawerOpen = !$('statusDrawer').classList.contains('translate-x-full')
  const tcOpen = !$('tcModal').classList.contains('hidden')
  const readinessOpen = !$('readinessModal').classList.contains('hidden')
  return drawerOpen && !tcOpen && !readinessOpen
}

// True when generated cases exist and ACs exist, but no case links any current AC id
// (stale/churned cache) — the coverage panel would show 0/N. Triggers a fresh rebuild.
function isTcStoreInconsistent(store) {
  const acIds = new Set((store?.acceptanceCriteria || []).map(a => a.id))
  const gen = store?.generated || []
  if (!gen.length || !acIds.size) return false
  const anyLinked = gen.some(c => (c.linkedAcceptanceCriteriaIds || []).some(id => acIds.has(id)))
  return !anyLinked
}

// Backfill the AC-source fingerprint for caches created before sourceHash existed,
// so the "unchanged → no-op" gate works on the next Regenerate.
async function backfillTcHash(key) {
  const store = getTcStore(key)
  if (!store || store.sourceHash) return
  try {
    const { sourceHash } = await api(`/api/ticket/${encodeURIComponent(key)}/tc-source-hash`)
    const cur = getTcStore(key)
    if (cur && !cur.sourceHash && sourceHash) setTcStore(key, { ...cur, sourceHash })
  } catch { /* non-fatal */ }
}

async function fetchTcResult(key, payload = {}) {
  const r = await api(`/api/ticket/${encodeURIComponent(key)}/prepare-tc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return {
    cases: r.cases || [],
    acceptanceCriteria: r.acceptanceCriteria || [],
    coverage: r.coverage || { total: 0, covered: 0, uncovered: [] },
    sourceHash: r.sourceHash || '',
    unchanged: r.unchanged === true,
    regen: r.regen || null,
  }
}

async function prepareTc(key, btn) {
  // Re-clicking reopens the existing set rather than silently regenerating
  // (which would change the cases and wipe manual additions). Use the modal's
  // Regenerate button to intentionally regenerate.
  const existing = getTcStore(key)
  if (existing && ((existing.generated || []).length || (existing.manual || []).length)) {
    closeCardMenu()
    openTcModal(key)
    backfillTcHash(key) // migrate stale caches so Regenerate can no-op
    return
  }
  if (tcActionInFlight) return
  tcActionInFlight = true
  setMenuItemBusy(btn, true)
  closeCardMenu()            // menu hides immediately; progress banner takes over
  showPrepProgress(key)
  try {
    const r = await fetchTcResult(key)
    setTcStore(key, { generated: r.cases, manual: [], acceptanceCriteria: r.acceptanceCriteria, coverage: r.coverage, sourceHash: r.sourceHash })
    hidePrepProgress()
    const summary = `${key}: ${r.cases.length} case${r.cases.length === 1 ? '' : 's'} · ${r.coverage.covered}/${r.coverage.total} AC covered`
    if (isPrepStillRelevant()) {
      openTcModal(key)
      toast(summary, 'success')
    } else {
      // You navigated away — don't surprise-open. It's cached and ready.
      toast(`${summary} — right-click → Prepare TC to view`, 'success')
    }
  } catch (err) {
    hidePrepProgress()
    toast(`TC generation failed: ${err.message}`, 'error')
  } finally {
    tcActionInFlight = false
  }
}

// Recompute AC coverage over active (non-removed) cases, including manual ones.
function acCoverage(key) {
  const store = getTcStore(key) || {}
  const acs = store.acceptanceCriteria || []
  const linked = new Set(activeCases(key).flatMap(c => c.linkedAcceptanceCriteriaIds || []))
  return { acs, linked, covered: acs.filter(a => linked.has(a.id)).length }
}

function allTcCases(key) {
  const store = getTcStore(key) || { generated: [], manual: [] }
  return [...(store.generated || []), ...(store.manual || [])]
}

// Test Bridge-style case card (white card, corner TC ribbon, colored chips).
function renderTcCard(tc, index) {
  const classLabels = [
    tc.priority && `<span class="case-label priority">${escapeHtml(tc.priority)}</span>`,
    tc.type && `<span class="case-label type">${escapeHtml(tc.type)}</span>`,
    tc.coverage === 'negative' && `<span class="case-label negative">Negative path</span>`,
    tc.coverage === 'edge' && `<span class="case-label edge">Edge case</span>`,
  ].filter(Boolean).join('')

  const acIds = tc.linkedAcceptanceCriteriaIds || []
  const acRow = acIds.length
    ? `<div class="case-label-row">${acIds.map(id => `<span class="case-label ac">${escapeHtml(id)}</span>`).join('')}</div>`
    : `<div class="case-label-row"><span class="case-label ac-missing">No AC linked</span></div>`

  const section = (title, inner) => `<div class="case-section"><h4>${title}</h4>${inner}</div>`

  const pre = (tc.preconditions || []).length
    ? section('Preconditions', `<ul class="case-detail-list">${tc.preconditions.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`)
    : ''
  const steps = (tc.steps || []).length
    ? section('Steps', `<ol class="case-detail-list">${tc.steps.map(s => `<li><p>${escapeHtml(s.action)}</p>${s.expectedResult ? `<p class="expected">${escapeHtml(s.expectedResult)}</p>` : ''}</li>`).join('')}</ol>`)
    : ''
  const expected = (tc.expectedResults || []).length
    ? section('Expected Results', `<ul class="case-detail-list">${tc.expectedResults.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`)
    : ''

  const ribbonLabel = tc.testCaseNumber || `TC${index + 1}`

  // Card state: execution mode (locked) or review mode (unlocked).
  const cardClass = tcLocked
    ? (tc.exec?.result === 'pass' ? 'is-pass' : tc.exec?.result === 'fail' ? 'is-fail' : tc.exec?.result === 'blocked' ? 'is-blocked' : (tc.status === 'manual' ? 'is-add' : ''))
    : (tc.review === 'approved' ? 'is-approved' : tc.review === 'feedback' ? 'is-feedback' : tc.review === 'removed' ? 'is-remove' : (tc.status === 'manual' ? 'is-add' : ''))
  const statusText = tcLocked
    ? (tc.exec?.result === 'pass' ? 'Pass' : tc.exec?.result === 'fail' ? 'Fail' : tc.exec?.result === 'blocked' ? 'Blocked' : '')
    : (tc.review === 'approved' ? 'Approved' : tc.review === 'feedback' ? 'Feedback' : tc.review === 'removed' ? 'Remove' : (tc.status === 'manual' ? 'Add' : ''))
  const statusLabel = statusText ? `<span class="case-status-label">${statusText}</span>` : ''

  // Execution buttons (locked) or review buttons (unlocked).
  let actions
  if (tcLocked) {
    actions = `<div class="exec-actions">
      <button class="action-pass${tc.exec?.result === 'pass' ? ' active' : ''}" data-exec-act="pass" data-tc-id="${tc.id}">✓ Pass</button>
      <button class="action-fail${tc.exec?.result === 'fail' ? ' active' : ''}" data-exec-act="fail" data-tc-id="${tc.id}">✗ Fail</button>
      <button class="action-blocked${tc.exec?.result === 'blocked' ? ' active' : ''}" data-exec-act="blocked" data-tc-id="${tc.id}">⊘ Blocked</button>
    </div>
    <textarea class="tc-input exec-notes" data-exec-notes="${tc.id}" rows="2" placeholder="Execution notes (optional)">${escapeHtml(tc.exec?.notes || '')}</textarea>`
  } else {
    const labels = {
      approve: tc.review === 'approved' ? 'Undo approval' : 'Approve',
      feedback: tc.review === 'feedback' ? 'Retract feedback' : 'Feedback',
      remove: tc.review === 'removed' ? 'Restore case' : 'Remove',
    }
    actions = `<div class="case-actions">
      <button class="action-approve" data-tc-act="approve" data-tc-id="${tc.id}">${labels.approve}</button>
      <button class="action-feedback" data-tc-act="feedback" data-tc-id="${tc.id}">${labels.feedback}</button>
      <button class="action-remove" data-tc-act="remove" data-tc-id="${tc.id}">${labels.remove}</button>
    </div>
    ${tc.review === 'feedback' ? `<textarea class="tc-input tc-feedback" data-tc-fb="${tc.id}" rows="2" placeholder="What should change in this case?">${escapeHtml(tc.feedback || '')}</textarea>` : ''}`
  }

  return `<li class="case-card ${cardClass}" data-tc-card="${tc.id}">
    <span class="case-number-ribbon" data-label="${escapeHtml(ribbonLabel)}"></span>
    ${statusLabel}
    <h3>${escapeHtml(tc.title)}</h3>
    ${classLabels ? `<div class="case-label-row">${classLabels}</div>` : ''}
    ${acRow}
    ${tc.section ? `<div class="case-section" style="color:#7a8494;font-size:12px;font-family:ui-monospace,monospace">${escapeHtml(tc.section)}</div>` : ''}
    ${pre}${steps}${expected}
    ${actions}
  </li>`
}

function renderAcCoverage(key) {
  const { acs, linked, covered } = acCoverage(key)
  if (!acs.length) return ''
  const full = covered === acs.length
  const accent = full ? '#1f9d57' : '#c93c37'
  const items = acs.map(a => {
    const ok = linked.has(a.id)
    return `<div class="tc-ac-item">
      <span style="color:${ok ? '#1f9d57' : '#c93c37'};font-weight:800">${ok ? '✓' : '✗'}</span>
      <span style="font-weight:800;color:#20242a;flex-shrink:0">${escapeHtml(a.id)}</span>
      <span style="color:#20242a">${escapeHtml(a.text)}</span>
    </div>`
  }).join('')
  return `<details class="tc-ac ${full ? 'full' : ''}" open>
    <summary style="cursor:pointer;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:12px;font-weight:800;letter-spacing:.06em;color:${accent}">ACCEPTANCE CRITERIA COVERAGE</span>
      <span style="font-weight:800;color:${accent}">${covered}/${acs.length}</span>
    </summary>
    <div style="margin-top:8px;display:grid;gap:2px">${items}</div>
  </details>`
}

function openTcModal(key) {
  const header = $('tcModalHeader')
  const body = $('tcModalBody')
  const store = getTcStore(key) || {}
  tcLocked = store.accepted === true
  const cases = allTcCases(key)

  header.innerHTML = `
    <div>
      <div class="eyebrow text-xs font-bold tracking-widest text-blue-400">PREPARE TEST CASES</div>
      <h2 class="text-xl font-bold text-white">${escapeHtml(key)} · ${cases.length} case${cases.length === 1 ? '' : 's'}${tcLocked ? ' · Accepted' : ''}</h2>
    </div>
    <div class="flex items-center gap-2">
      ${tcLocked ? '' : `<button id="tcRegenerate" class="btn-ghost rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium inline-flex items-center gap-2 hover:bg-slate-800" title="Regenerate (keeps manual cases)">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        <span>Regenerate</span>
      </button>`}
      ${tcLocked ? `<button id="tcLogExecution" class="rounded-lg px-3 py-2 text-sm font-semibold inline-flex items-center gap-2" style="background:#22c55e;color:#fff;border:0">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
        <span>Log Execution to Jira</span>
      </button>` : ''}
      <button id="tcDownload" class="btn-primary rounded-lg px-3 py-2 text-sm font-semibold inline-flex items-center gap-2">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
        <span>Download CSV</span>
      </button>
      <button id="tcClose" class="rounded-lg border border-slate-700 p-2 inline-flex items-center justify-center hover:bg-slate-800">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`

  const banner = tcLocked
    ? `<div style="background:#e7f7ee;border:1px solid #75d65f;border-radius:8px;padding:10px 14px;margin-bottom:12px;color:#1f7a45;font-weight:700">✓ Accepted${store.acceptedBy ? ` by ${escapeHtml(store.acceptedBy)}` : ''}${store.acceptedAt ? ` · ${escapeHtml(store.acceptedAt)}` : ''} — posted to Jira</div>`
    : ''

  body.innerHTML =
    banner +
    (tcLocked ? `<div id="tcExecSummary"></div>` : '') +
    renderAcCoverage(key) +
    `<ul class="case-list" id="tcCardList">${cases.map((tc, i) => renderTcCard(tc, i)).join('') || '<p style="color:#5d6673">No cases generated.</p>'}</ul>` +
    (tcLocked ? '' : `<div id="tcAddSlot"></div><div id="tcActionRow"></div>`)

  $('tcModal').classList.remove('hidden')
  $('tcBackdrop').classList.remove('hidden')
  $('tcClose').addEventListener('click', closeTcModal)
  $('tcDownload').addEventListener('click', () => downloadTcCsv(key))
  const logExecBtn = $('tcLogExecution')
  if (logExecBtn) logExecBtn.addEventListener('click', () => logExecution(key, logExecBtn))

  if (!tcLocked) {
    bindTcReview(key)
    renderTcActionRow(key)
    renderTcAddForm(key)
  } else {
    bindTcExecution(key)
    renderExecutionSummary(key)
  }

  const regenBtn = $('tcRegenerate')
  if (regenBtn) regenBtn.addEventListener('click', async (e) => {
    if (tcActionInFlight) return // ignore rapid repeat clicks
    tcActionInFlight = true
    const btn = e.currentTarget
    const label = btn.querySelector('span')
    const icon = btn.querySelector('svg')
    btn.disabled = true
    if (icon) icon.classList.add('animate-spin') // rotating spinner — process running
    if (label) label.textContent = 'Regenerating…'

    const restore = () => {
      btn.disabled = false
      if (icon) icon.classList.remove('animate-spin')
      if (label) label.textContent = 'Regenerate'
    }

    try {
      const prev = getTcStore(key) || { generated: [], manual: [] }

      // Coverage gap-fill: if any AC is currently uncovered (e.g. 3/4), generate cases
      // for just those ACs — even when the ticket source is unchanged. An incomplete
      // plan must be fixable; otherwise the no-op gate would trap it.
      const { acs, linked } = acCoverage(key)
      const uncovered = acs.filter(a => !linked.has(a.id))
      if (uncovered.length) {
        const r = await api(`/api/ticket/${encodeURIComponent(key)}/prepare-tc`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gapFill: uncovered }),
        })
        prev.generated = [...(prev.generated || []), ...(r.cases || [])]
        setTcStore(key, prev)
        openTcModal(key)
        toast(`${key}: filled ${uncovered.length} uncovered AC${uncovered.length === 1 ? '' : 's'} (+${(r.cases || []).length} case${(r.cases || []).length === 1 ? '' : 's'})`, 'success')
        return
      }

      // Self-heal: if the cached cases and AC list are out of sync (legacy churn —
      // cases link AC ids that don't exist in the current AC list), the partial/no-op
      // paths can't fix it. Do a clean FRESH generate to resync.
      if (isTcStoreInconsistent(prev)) {
        const fresh = await fetchTcResult(key) // no regenerate flag → full fresh
        setTcStore(key, { generated: fresh.cases, manual: prev.manual || [], acceptanceCriteria: fresh.acceptanceCriteria, coverage: fresh.coverage, sourceHash: fresh.sourceHash })
        openTcModal(key)
        toast(`${key}: rebuilt — ${fresh.coverage.covered}/${fresh.coverage.total} AC covered`, 'success')
        return
      }

      const r = await fetchTcResult(key, {
        regenerate: true,
        priorHash: prev.sourceHash || '',
        priorAcceptanceCriteria: prev.acceptanceCriteria || [],
        priorCases: prev.generated || [],
      })

      // (2) ACs unchanged since last generation → keep everything as-is.
      if (r.unchanged) {
        restore()
        toast(`${key}: acceptance criteria unchanged — test cases kept`, 'info')
        return
      }

      // (3) Only changed/new ACs were regenerated; unchanged ACs keep their cases.
      setTcStore(key, { generated: r.cases, manual: prev.manual || [], acceptanceCriteria: r.acceptanceCriteria, coverage: r.coverage, sourceHash: r.sourceHash })
      openTcModal(key) // re-render (rebuilds header, resets the button)
      const changed = r.regen?.changedAcIds?.length || 0
      toast(`${key}: regenerated ${changed} changed AC${changed === 1 ? '' : 's'} · ${r.coverage.covered}/${r.coverage.total} covered`, 'success')
    } catch (err) {
      restore()
      toast(`Regenerate failed: ${err.message}`, 'error')
    } finally {
      tcActionInFlight = false
    }
  })
}

// Review actions (Approve / Feedback / Remove) via delegation on the card list.
function bindTcReview(key) {
  const list = $('tcCardList')
  if (!list) return
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tc-act]')
    if (!btn) return
    const id = btn.dataset.tcId
    const act = btn.dataset.tcAct
    const c = findCase(key, id)
    if (!c) return
    if (act === 'approve') setReview(key, id, c.review === 'approved' ? null : 'approved')
    else if (act === 'remove') setReview(key, id, c.review === 'removed' ? null : 'removed')
    else if (act === 'feedback') setReview(key, id, c.review === 'feedback' ? null : 'feedback', c.review === 'feedback' ? '' : (c.feedback || ''))
    rerenderTcBody(key)
  })
  list.addEventListener('input', (e) => {
    const ta = e.target.closest('[data-tc-fb]')
    if (!ta) return
    // Save feedback text without a full re-render (keeps focus/caret).
    const store = getTcStore(key); if (!store) return
    const c = [...(store.generated || []), ...(store.manual || [])].find(x => x.id === ta.dataset.tcFb)
    if (c) { c.feedback = ta.value; setTcStore(key, store) }
  })
}

// Re-render only the body (cards + coverage + action row), preserving the header/modal.
function rerenderTcBody(key) {
  const store = getTcStore(key) || {}
  const cases = allTcCases(key)
  if (tcLocked) {
    const banner = `<div style="background:#e7f7ee;border:1px solid #75d65f;border-radius:8px;padding:10px 14px;margin-bottom:12px;color:#1f7a45;font-weight:700">✓ Accepted${store.acceptedBy ? ` by ${escapeHtml(store.acceptedBy)}` : ''}${store.acceptedAt ? ` · ${escapeHtml(store.acceptedAt)}` : ''} — posted to Jira</div>`
    $('tcModalBody').innerHTML =
      banner +
      `<div id="tcExecSummary"></div>` +
      renderAcCoverage(key) +
      `<ul class="case-list" id="tcCardList">${cases.map((tc, i) => renderTcCard(tc, i)).join('') || '<p style="color:#5d6673">No cases generated.</p>'}</ul>`
    bindTcExecution(key)
    renderExecutionSummary(key)
  } else {
    $('tcModalBody').innerHTML =
      renderAcCoverage(key) +
      `<ul class="case-list" id="tcCardList">${cases.map((tc, i) => renderTcCard(tc, i)).join('') || '<p style="color:#5d6673">No cases generated.</p>'}</ul>` +
      `<div id="tcAddSlot"></div><div id="tcActionRow"></div>`
    bindTcReview(key)
    renderTcActionRow(key)
    renderTcAddForm(key)
  }
}

// Cases not yet acted on (the dead-end the strict model creates).
function untouchedCases(key) {
  return activeCases(key).filter(c => !['approved', 'feedback', 'removed'].includes(c.review))
}

// The Submit/Accept primary button (mirrors Test Bridge: Submit until accept-ready),
// plus an "Approve all remaining" helper so partial review isn't a dead-end.
function renderTcActionRow(key) {
  const row = $('tcActionRow')
  if (!row) return
  const acceptReady = isAcceptReady(key)
  const pending = hasPendingSubmit(key)
  const label = acceptReady ? 'Accept' : 'Submit'
  const enabled = acceptReady || pending
  const bg = acceptReady ? '#3dbf72' : '#2563eb'
  const untouched = untouchedCases(key).length

  const helper = untouched > 0
    ? `<button id="tcApproveAll" style="background:#fff;color:#3dbf72;border:1px solid #3dbf72;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer">Approve all remaining (${untouched})</button>`
    : ''
  const hint = (!enabled && untouched > 0)
    ? `<span style="color:#5d6673;font-size:13px;align-self:center">${untouched} case${untouched === 1 ? '' : 's'} need a decision (approve / feedback / remove) to continue</span>`
    : ''

  row.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px">
    <div style="display:flex;gap:10px;align-items:center">${helper}${hint}</div>
    <button id="tcPrimary" ${enabled ? '' : 'disabled'} style="background:${enabled ? bg : '#c8ced6'};color:#fff;border:0;border-radius:8px;padding:9px 18px;font-weight:700;cursor:${enabled ? 'pointer' : 'not-allowed'}">${label}</button>
  </div>`

  const approveAll = $('tcApproveAll')
  if (approveAll) approveAll.addEventListener('click', () => {
    const store = getTcStore(key); if (!store) return
    for (const c of [...(store.generated || []), ...(store.manual || [])]) {
      if (c.review !== 'removed' && !['approved', 'feedback'].includes(c.review)) c.review = 'approved'
    }
    setTcStore(key, store)
    rerenderTcBody(key)
  })

  const btn = $('tcPrimary')
  if (btn && enabled) btn.addEventListener('click', () => acceptReady ? acceptPlan(key, btn) : submitReview(key, btn))
}

function renderExecutionSummary(key) {
  const el = $('tcExecSummary')
  if (!el) return
  const cases = activeCases(key)
  if (!cases.length) { el.innerHTML = ''; return }
  const pass    = cases.filter(c => c.exec?.result === 'pass').length
  const fail    = cases.filter(c => c.exec?.result === 'fail').length
  const blocked = cases.filter(c => c.exec?.result === 'blocked').length
  const pending = cases.length - pass - fail - blocked
  el.innerHTML = `<div class="exec-summary">
    <span class="exec-stat pass">✓ ${pass} Passed</span>
    <span class="exec-stat fail">✗ ${fail} Failed</span>
    <span class="exec-stat blocked">⊘ ${blocked} Blocked</span>
    <span class="exec-stat pending">○ ${pending} Pending</span>
  </div>`
}

function bindTcExecution(key) {
  document.querySelectorAll('[data-exec-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.execAct
      const id = btn.dataset.tcId
      const store = getTcStore(key); if (!store) return
      const c = [...(store.generated || []), ...(store.manual || [])].find(x => x.id === id)
      if (!c) return
      c.exec = { result: c.exec?.result === act ? null : act, notes: c.exec?.notes || '' }
      setTcStore(key, store)
      rerenderTcBody(key)
    })
  })
  document.querySelectorAll('[data-exec-notes]').forEach(ta => {
    ta.addEventListener('input', () => {
      const id = ta.dataset.execNotes
      const store = getTcStore(key); if (!store) return
      const c = [...(store.generated || []), ...(store.manual || [])].find(x => x.id === id)
      if (!c) return
      if (!c.exec) c.exec = { result: null, notes: '' }
      c.exec.notes = ta.value
      setTcStore(key, store)
    })
  })
}

async function logExecution(key, btn) {
  if (tcActionInFlight) return
  const cases = activeCases(key)
  if (!cases.some(c => c.exec?.result)) {
    toast('Run at least one case before logging', 'info')
    return
  }
  if (!confirm(`Post execution results for ${key} to Jira?`)) return
  tcActionInFlight = true
  const origText = btn.querySelector('span')?.textContent || 'Log Execution to Jira'
  btn.disabled = true
  if (btn.querySelector('span')) btn.querySelector('span').textContent = 'Posting…'
  try {
    await api(`/api/ticket/${encodeURIComponent(key)}/log-execution`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cases }),
    })
    toast(`${key}: execution log posted to Jira`, 'success')
  } catch (err) {
    toast(`Log failed: ${err.message}`, 'error')
  } finally {
    tcActionInFlight = false
    btn.disabled = false
    if (btn.querySelector('span')) btn.querySelector('span').textContent = origText
  }
}

// Submit: regenerate feedback-flagged cases (LLM) + drop removed cases; approvals persist.
async function submitReview(key, btn) {
  if (tcActionInFlight) return
  tcActionInFlight = true
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…' }
  try {
    const store = getTcStore(key) || {}
    const feedbackCases = allTcCases(key).filter(c => c.review === 'feedback' && String(c.feedback || '').trim())
    let revisedById = {}
    if (feedbackCases.length) {
      const r = await api(`/api/ticket/${encodeURIComponent(key)}/revise-tc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: feedbackCases.map(c => ({ id: c.id, title: c.title, steps: c.steps, expectedResults: c.expectedResults, linkedAcceptanceCriteriaIds: c.linkedAcceptanceCriteriaIds, feedback: c.feedback })) }),
      })
      for (const rc of (r.cases || [])) if (rc.id) revisedById[rc.id] = rc
    }
    const apply = (arr) => (arr || [])
      .filter(c => c.review !== 'removed')           // drop removed
      .map(c => revisedById[c.id]
        ? { ...revisedById[c.id], id: c.id, status: c.status, review: null, feedback: '' } // replace with revision, clear flag
        : c)
    store.generated = apply(store.generated)
    store.manual = apply(store.manual)
    setTcStore(key, store)
    openTcModal(key)
    const n = feedbackCases.length
    toast(`${key}: ${n ? `revised ${n} case${n === 1 ? '' : 's'}` : 'updated'}`, 'success')
  } catch (err) {
    toast(`Submit failed: ${err.message}`, 'error')
    renderTcActionRow(key)
  } finally {
    tcActionInFlight = false
  }
}

// Accept: lock the plan, post a structured comment to Jira, keep CSV export.
async function acceptPlan(key, btn) {
  if (tcActionInFlight) return
  if (!confirm(`Accept this test plan and post it to ${key} in Jira?`)) return
  tcActionInFlight = true
  if (btn) { btn.disabled = true; btn.textContent = 'Posting to Jira…' }
  try {
    const cases = activeCases(key)
    const { covered, acs } = (() => { const c = acCoverage(key); return { covered: c.covered, acs: c.acs } })()
    const r = await api(`/api/ticket/${encodeURIComponent(key)}/comment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cases, coverage: { total: acs.length, covered } }),
    })
    const store = getTcStore(key) || {}
    store.accepted = true
    store.acceptedBy = r.accepter || ''
    store.acceptedAt = new Date().toISOString().slice(0, 10)
    // Drop removed cases from the finalized set.
    store.generated = (store.generated || []).filter(c => c.review !== 'removed')
    store.manual = (store.manual || []).filter(c => c.review !== 'removed')
    setTcStore(key, store)
    openTcModal(key) // re-render locked
    toast(`${key}: accepted & posted to Jira`, 'success')
  } catch (err) {
    toast(`Accept failed: ${err.message}`, 'error')
    renderTcActionRow(key)
  } finally {
    tcActionInFlight = false
  }
}

function closeTcModal() {
  $('tcModal').classList.add('hidden')
  $('tcBackdrop').classList.add('hidden')
}

function renderTcAddForm(key) {
  const slot = $('tcAddSlot')
  slot.innerHTML = `
    <details class="tc-addbox">
      <summary>+ Add manual test case</summary>
      <div style="padding:0 14px 14px;display:grid;gap:10px">
        ${['title:Title', 'preconditions:Preconditions (one per line)', 'steps:Steps (one per line)', 'expectedResults:Expected result(s) (one per line)', 'priority:Priority (optional)', 'type:Type (optional)'].map(f => {
          const [name, label] = f.split(':')
          const multi = ['preconditions', 'steps', 'expectedResults'].includes(name)
          const control = multi
            ? `<textarea id="tc-${name}" rows="3" class="tc-input"></textarea>`
            : `<input id="tc-${name}" class="tc-input" />`
          return `<label style="display:block"><span style="font-size:12px;color:#5d6673">${label}</span>${control}</label>`
        }).join('')}
        <p id="tc-add-error" style="color:#c93c37;font-size:13px;margin:0"></p>
        <button id="tc-add-submit" class="btn-primary rounded-lg px-4 py-2 text-sm font-semibold" style="justify-self:start">Add test case</button>
      </div>
    </details>`

  $('tc-add-submit').addEventListener('click', () => {
    const lines = (id) => $(`tc-${id}`).value.split('\n').map(s => s.trim()).filter(Boolean)
    const title = $('tc-title').value.trim()
    const preconditions = lines('preconditions')
    const stepLines = lines('steps')
    const expectedResults = lines('expectedResults')
    const errEl = $('tc-add-error')
    const errors = []
    if (!title) errors.push('title')
    if (!preconditions.length) errors.push('preconditions')
    if (!stepLines.length) errors.push('steps')
    if (!expectedResults.length) errors.push('expected result')
    if (errors.length) { errEl.textContent = `Required: ${errors.join(', ')}`; return }

    const manualCase = {
      title,
      section: '',
      automationType: 'Manual',
      estimate: '',
      preconditions,
      testData: '-',
      priority: $('tc-priority').value.trim() || 'Medium',
      type: $('tc-type').value.trim() || 'Functional',
      coverage: 'positive',
      steps: stepLines.map(action => ({ action, expectedResult: '' })),
      expectedResults,
      linkedAcceptanceCriteriaIds: [],
      status: 'manual',
    }
    const store = getTcStore(key) || { generated: [], manual: [] }
    store.manual = [...(store.manual || []), manualCase]
    setTcStore(key, store)
    openTcModal(key) // re-render with the new case
  })
}

// Build a TestRail-ready CSV (RFC-4180) and trigger a client-side download.
function downloadTcCsv(key) {
  const cases = activeCases(key) // exclude removed cases from the export
  const columns = ['S.no', 'Title', 'Section', 'Automation Type', 'Estimate', 'Preconditions', 'Test Data', 'Priority', 'Steps (Text)', 'Expected Result', 'Type', 'Result']
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const rows = cases.map((c, i) => [
    i + 1,
    c.title,
    c.section || `${key.split('-')[0]} > ${c.title}`.slice(0, 80),
    c.automationType || 'Manual',
    c.estimate || '',
    (c.preconditions || []).join('\n'),
    c.testData || '-',
    c.priority || 'Medium',
    (c.steps || []).map((s, n) => `${n + 1}. ${s.action}`).join('\n'),
    ((c.steps || []).map(s => s.expectedResult).filter(Boolean).concat(c.expectedResults || [])).join('\n'),
    c.type || 'Functional',
    tc.exec?.result ? tc.exec.result.charAt(0).toUpperCase() + tc.exec.result.slice(1) : '',
  ].map(q).join(','))
  const csv = [columns.map(q).join(','), ...rows].join('\r\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${key}-TC-v1.0.csv`
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function moveToTesting(key, btn) {
  setMenuItemBusy(btn, true)
  try {
    const res = await api(`/api/ticket/${encodeURIComponent(key)}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStatus: 'Testing' }),
    })
    // Update cached status so the card moves columns, then re-render.
    const ticket = state.allTickets.find(t => t.key === key)
    if (ticket) ticket.status = 'Testing'
    closeCardMenu()
    renderDrawer()
    renderTickets(state.showAll ? state.allTickets : state.tickets)
    if (res.alreadyThere) toast(`${key} is already in Testing`, 'info')
    else toast(`${key} moved to Testing`, 'success')
  } catch (err) {
    setMenuItemBusy(btn, false)
    closeCardMenu()
    toast(`Failed: ${err.message}`, 'error')
  }
}
function closeCardMenu() { $('cardMenu').classList.add('hidden') }

function bindCardMenu() {
  // Single click does nothing; double click opens the Jira ticket.
  $('drawerColumns').addEventListener('click', (e) => {
    if (e.target.closest('[data-card]')) e.preventDefault()
  })
  $('drawerColumns').addEventListener('dblclick', (e) => {
    const card = e.target.closest('[data-card]')
    if (!card) return
    e.preventDefault()
    window.open(jiraIssueUrl(card.dataset.key), '_blank')
  })
  // Right-click on a card → custom menu
  $('drawerColumns').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-card]')
    if (!card) return
    e.preventDefault()
    openCardMenu(e.clientX, e.clientY, card.dataset.key, card.dataset.col)
  })
  // Dismiss on outside click / scroll / escape / drawer close
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#cardMenu')) closeCardMenu()
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCardMenu() })
  window.addEventListener('scroll', closeCardMenu, true)
}

function bindDrawer() {
  $('drawerToggle').addEventListener('click', () => {
    isDrawerOpen() ? closeDrawer() : openDrawer()
  })
  $('drawerClose').addEventListener('click', closeDrawer)
  $('drawerRefresh').addEventListener('click', async () => {
    await loadTickets()      // re-pull current scope (spins both refresh icons via setBusy)
    renderDrawer()           // re-render columns with fresh data
  })
  $('drawerBackdrop').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer() })

  // Shift+scroll anywhere on the page → open (down) / close (up)
  let lastShiftScroll = 0
  window.addEventListener('wheel', (e) => {
    if (!e.shiftKey) return
    const now = Date.now()
    if (now - lastShiftScroll < 300) return // throttle so one gesture = one toggle
    lastShiftScroll = now
    if (e.deltaY > 0 || e.deltaX > 0) openDrawer()
    else closeDrawer()
  }, { passive: true })
}

async function hydrateFromServer() {
  try {
    const store = await api('/api/store')
    for (const [k, v] of Object.entries(store.readiness || {})) {
      try { sessionStorage.setItem(readinessKey(k), JSON.stringify(v)) } catch {}
    }
    for (const [k, v] of Object.entries(store.tc || {})) {
      try { sessionStorage.setItem(tcKey(k), JSON.stringify(v)) } catch {}
    }

  } catch { /* server may not be running yet; silent fail is fine */ }
}

async function init() {

  // Load config + hydrate persisted state (readiness verdicts + TC plans) from server.
  const [cfg] = await Promise.all([api('/api/config'), hydrateFromServer()])
  state.projects = cfg.projects
  _jiraBase = cfg.jiraBase || ''
  const sel = $('projectSelect')
  sel.innerHTML = state.projects.map(p => `<option value="${p.key}">${escapeHtml(p.name)}</option>`).join('')
  sel.addEventListener('change', () => {
    state.project = sel.value
    state.dueDates = []
    state.selectedDueDates.clear()
    if (state.mode === 'sprint') {
      loadSprints()
    } else {
      loadSprints({ fetchTickets: false }) // prime pills for bulk-add only
      loadDueDates()
    }
  })

  $('refreshBtn').addEventListener('click', refreshAll)
  $('lastSprintPill').addEventListener('click', () => selectSprint('last'))
  $('currentSprintPill').addEventListener('click', () => selectSprint('current'))
  $('nextSprintPill').addEventListener('click', () => selectSprint('next'))
  $('modeSprintBtn').addEventListener('click', () => setMode('sprint'))
  $('modeDueDateBtn').addEventListener('click', () => setMode('duedate'))
  $('yearSelect').addEventListener('change', onYearChange)
  document.querySelector('thead').addEventListener('click', onHeaderClick)
  bindDrawer()
  bindCardMenu()
  $('readinessBackdrop').addEventListener('click', closeReadinessModal)
  $('tcBackdrop').addEventListener('click', closeTcModal)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeReadinessModal(); closeTcModal() }
  })
  $('showAllToggle').addEventListener('change', (e) => {
    state.showAll = e.target.checked
    renderTickets(state.showAll ? state.allTickets : state.tickets)
    updateBulkBtn()
  })
  $('bulkAddBtn').addEventListener('click', bulkAdd)
  $('selectAll').addEventListener('change', (e) => {
    document.querySelectorAll('.row-check').forEach(cb => { cb.checked = e.target.checked })
    updateBulkBtn()
  })

  if (!cfg.hasJira) {
    $('statusLine').textContent = '⚠️  Jira credentials missing. Copy .env.example to .env and fill it in, then restart the server.'
    return
  }
  if (state.projects.length) {
    state.project = state.projects[0].key
    sel.value = state.project
    // Ensure DOM (which view is visible, which button is active) matches state.mode.
    // setMode also kicks off the appropriate data load.
    if (state.mode === 'duedate') loadSprints({ fetchTickets: false }).catch(() => {}) // prime pills only
    setMode(state.mode)
  }
}

init().catch(err => { $('statusLine').textContent = `Init error: ${err.message}` })

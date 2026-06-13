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
    const { dates } = await api(`/api/duedates?project=${encodeURIComponent(state.project)}`)
    state.dueDates = dates
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
  if (!inYear.length) {
    wrap.innerHTML = '<span class="text-sm text-slate-500">No due dates for this year.</span>'
    return
  }
  wrap.innerHTML = inYear.map(d => {
    const active = state.selectedDueDates.has(d.date)
    return `<button data-date="${d.date}" class="dd-chip rounded-full px-4 py-2 text-sm font-medium ${
      active ? 'pill-active' : 'pill-idle'
    }">${d.date} <span class="opacity-70">(${d.count})</span></button>`
  }).join('')
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
  // Drop selections that are no longer in the visible year so the table matches the chips.
  for (const d of [...state.selectedDueDates]) {
    if (!d.startsWith(state.selectedYear)) state.selectedDueDates.delete(d)
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
  testing: [{ id: 'prepare-tc', label: 'Prepare TC' }, { id: 'review-tc', label: 'Review TC' }, { id: 'check-rtr', label: 'Check Ready to Release' }],
  release: [{ id: 'check-mr', label: 'Check MR' }, { id: 'check-zync', label: 'Check Zync Pre Flight score' }],
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
              <span class="font-mono">${t.key}</span>
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

function openCardMenu(x, y, ticketKey, colId) {
  const actions = CARD_MENU_ACTIONS[colId] || []
  if (!actions.length) return
  const menu = $('cardMenu')
  menu.innerHTML = `
    <div class="px-3 py-1.5 text-xs text-slate-400 border-b border-slate-800 font-mono">${ticketKey}</div>
    ${actions.map(a => `
      <button data-action="${a.id}" data-key="${ticketKey}" data-col="${colId}"
              class="card-menu-item w-full text-left px-3 py-2 text-slate-100 hover:bg-slate-800">
        ${a.label}
      </button>`).join('')}
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
    default:
      closeCardMenu()
      toast(`${key}: ${action} (not wired yet)`)
  }
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

async function init() {

  // Load config
  const cfg = await api('/api/config')
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

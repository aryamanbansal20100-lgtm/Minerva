/* ==========================================================================
   calendar.js — the month, with everything on it.

   Three things already exist separately and never met: the timetable (which
   periods, which days), tasks with due dates, and ManageBac deadlines. A
   student does not think in three lists — they think "what is this week".

   So: a month grid, every day carrying its lessons and its deadlines, and a
   day panel underneath. No library — a month is arithmetic.
   ========================================================================== */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

let CAL = { year: 0, month: 0, picked: '' };

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
  String(d.getDate()).padStart(2, '0')}`;

function viewCalendar() {
  if (!CAL.year) {
    const now = new Date();
    CAL.year = now.getFullYear();
    CAL.month = now.getMonth();
    CAL.picked = iso(now);
  }
  renderCalendar();
}

/* Everything happening on a given date, from all three sources. */
function dayEntries(dateIso) {
  const out = [];
  const d = new Date(dateIso + 'T12:00:00');
  const weekday = DAY_NAMES[(d.getDay() + 6) % 7];

  // Lessons from the timetable — the same day name every week.
  for (const p of (S.state.profile.timetable || [])) {
    const day = String(p.day || '').slice(0, 3);
    if (day.toLowerCase() !== weekday.toLowerCase()) continue;
    out.push({ kind: 'lesson', at: p.start || '', title: p.subject || 'Lesson',
               detail: [p.start, p.end].filter(Boolean).join('–') +
                       (p.room ? ` · ${p.room}` : '') });
  }

  // Anything due that day.
  for (const t of (S.state.tasks || [])) {
    if ((t.due || '').slice(0, 10) !== dateIso) continue;
    out.push({ kind: t.done ? 'done' : 'due', at: '', title: t.title,
               detail: t.subject || '', id: t.id, done: t.done });
  }

  out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return out;
}

function renderCalendar() {
  const first = new Date(CAL.year, CAL.month, 1);
  const lead = (first.getDay() + 6) % 7;               // Monday-first grid
  const days = new Date(CAL.year, CAL.month + 1, 0).getDate();
  const today = iso(new Date());

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let n = 1; n <= days; n++) cells.push(iso(new Date(CAL.year, CAL.month, n)));
  while (cells.length % 7) cells.push(null);

  $('#view').innerHTML = `
    <div class="topbar">
      <div class="grow"><h2>${MONTHS[CAL.month]} ${CAL.year}</h2>
        <div class="sub">lessons, homework and deadlines together</div></div>
      <button class="btn ghost sm" id="cal-prev" aria-label="Previous month">‹</button>
      <button class="btn ghost sm" id="cal-today">Today</button>
      <button class="btn ghost sm" id="cal-next" aria-label="Next month">›</button>
    </div>
    <div class="wrap wide">
      <div class="cal-grid" role="grid">
        ${DAY_NAMES.map(d => `<div class="cal-dow">${d}</div>`).join('')}
        ${cells.map(c => cell(c, today)).join('')}
      </div>
      <div id="cal-day"></div>
    </div>`;

  $('#cal-prev').onclick = () => { step(-1); };
  $('#cal-next').onclick = () => { step(1); };
  $('#cal-today').onclick = () => {
    const now = new Date();
    CAL.year = now.getFullYear(); CAL.month = now.getMonth(); CAL.picked = iso(now);
    renderCalendar();
  };
  $$('#view [data-day]').forEach(el => el.onclick = () => {
    CAL.picked = el.dataset.day;
    renderCalendar();
  });
  renderDayPanel();
}

function step(by) {
  const d = new Date(CAL.year, CAL.month + by, 1);
  CAL.year = d.getFullYear();
  CAL.month = d.getMonth();
  renderCalendar();
}

function cell(dateIso, today) {
  if (!dateIso) return '<div class="cal-cell empty"></div>';
  const items = dayEntries(dateIso);
  const due = items.filter(i => i.kind === 'due');
  const lessons = items.filter(i => i.kind === 'lesson');
  const n = Number(dateIso.slice(8, 10));
  const classes = ['cal-cell'];
  if (dateIso === today) classes.push('today');
  if (dateIso === CAL.picked) classes.push('picked');
  if (dateIso < today && due.length) classes.push('overdue');
  return `<button class="${classes.join(' ')}" data-day="${dateIso}"
      aria-label="${dateIso}, ${due.length} due, ${lessons.length} lessons">
      <span class="n">${n}</span>
      ${due.length ? `<span class="dot due" title="${due.length} due"></span>` : ''}
      ${lessons.length ? `<span class="lessons">${lessons.length}</span>` : ''}
      ${due.slice(0, 2).map(i =>
        `<span class="mini">${esc(String(i.title).slice(0, 22))}</span>`).join('')}
      ${due.length > 2 ? `<span class="mini more">+${due.length - 2} more</span>` : ''}
    </button>`;
}

function renderDayPanel() {
  const host = $('#cal-day');
  if (!host || !CAL.picked) return;
  const items = dayEntries(CAL.picked);
  const d = new Date(CAL.picked + 'T12:00:00');
  const label = d.toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long' });

  host.innerHTML = `
    <div class="tier-head" style="margin-top:24px">
      <span class="t">${esc(label)}</span>
      <span class="chip">${items.length}</span></div>
    ${items.length ? `<ul class="itemlist">${items.map(i => `
      <li class="item ${i.kind === 'due' && CAL.picked < iso(new Date()) ? 'hot' : ''}">
        <span class="bar" aria-hidden="true"></span>
        <span class="main">
          <span class="t" style="${i.done ? 'text-decoration:line-through;opacity:.6' : ''}">${
            esc(i.title)}</span>
          <span class="m">${i.kind === 'lesson' ? 'Lesson' :
            i.done ? 'Done' : 'Due'}${i.detail ? ' · ' + esc(i.detail) : ''}</span>
        </span>
      </li>`).join('')}</ul>`
      : '<p class="muted" style="margin-top:14px">Nothing on this day.</p>'}`;
}

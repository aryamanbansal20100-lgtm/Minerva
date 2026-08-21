/* ==========================================================================
   timetable.js — your week, and the reminder that you have a lesson in 5.

   Reminders live in the browser because notifications belong to the browser.
   The server decides *what* is next — one definition of "next period" — and
   the page decides how to tell you. Every reminder carries a key of
   date|day|time|subject, so polling twice a minute can never fire the same
   one twice.
   ========================================================================== */

const SUBJECT_HUES = {};

/* A stable colour per subject. Urgency still owns red/amber; this is a
   different job — making the week scannable — so it uses hue, not alarm. */
function hueFor(subject) {
  if (!subject) return 'var(--ink-4)';
  if (SUBJECT_HUES[subject]) return SUBJECT_HUES[subject];
  let h = 0;
  for (let i = 0; i < subject.length; i++) h = (h * 31 + subject.charCodeAt(i)) % 360;
  return (SUBJECT_HUES[subject] = `hsl(${h} 52% 45%)`);
}

const firedReminders = new Set();
let ttTimer = 0;

async function viewTimetable() {
  let d;
  try { d = await api.get('/api/timetable'); }
  catch (e) { $('#view').innerHTML = `<div class="wrap"><p class="muted">${esc(e.message)}</p></div>`; return; }

  const up = d.upcoming || {};
  const days = (d.days || []).filter(x => (d.by_day[x] || []).length);

  $('#view').innerHTML = `
    <div class="topbar"><div class="grow"><h2>Timetable</h2>
      <div class="sub">${d.periods.length
        ? d.periods.length + ' periods · reminders 5 minutes before each one'
        : 'not set up yet'}</div></div>
      <button class="btn" id="tt-notify">Enable reminders</button>
      ${d.periods.length ? '<button class="btn ghost" id="tt-clear">Clear</button>' : ''}
    </div>
    <div class="wrap wide">
      <div class="stat-row">
        <div class="stat-card"><div class="k">Now</div>
          <div class="v">${up.current ? esc(up.current.subject.slice(0, 11)) : '—'}</div>
          <div class="s">${up.current
            ? esc(up.current.start + (up.current.end ? '–' + up.current.end : ''))
            : 'no period running'}</div></div>
        <div class="stat-card"><div class="k">Next</div>
          <div class="v">${up.next ? esc(up.next.start) : '—'}</div>
          <div class="s">${up.next ? esc(up.next.subject) : 'nothing left today'}</div></div>
        <div class="stat-card"><div class="k">Left today</div>
          <div class="v">${up.remaining ?? 0}</div><div class="s">periods</div></div>
        <div class="stat-card"><div class="k">This week</div>
          <div class="v">${d.periods.length}</div><div class="s">periods total</div></div>
      </div>

      <div style="margin-top:22px">
        <div class="drop" id="tt-drop" tabindex="0" role="button"
             aria-label="Upload or paste a photo of your timetable">
          <b>Drop a photo of your timetable, or paste it with Ctrl+V</b>
          A screenshot or a straight-on photo both work. I read it and build your week.
        </div>
        <input type="file" id="tt-file" accept="image/*" class="sr">
        <p class="muted" style="font-size:12.5px;margin-top:8px">
          ${d.vision.vision ? 'Image reading is on.' : esc(d.vision.reason)}
        </p>
      </div>

      <div class="tt-grid">
        ${days.map(day => `
          <div class="tt-day ${day === up.day ? 'today' : ''}">
            <header>${esc(day)}${day === up.day ? ' · today' : ''}</header>
            ${(d.by_day[day] || []).map(p => `
              <div class="tt-p ${up.current && day === up.day
                  && up.current.start === p.start ? 'live' : ''}">
                <span class="tm">${esc(p.start)}</span>
                <span class="subject-dot" style="--sub:${hueFor(p.subject)}" aria-hidden="true"></span>
                <span style="flex:1;min-width:0">
                  <span class="sj">${esc(p.subject)}</span>
                  ${p.room || p.teacher
                    ? `<span class="rm">${esc([p.room, p.teacher].filter(Boolean).join(' · '))}</span>`
                    : ''}
                </span>
              </div>`).join('')}
          </div>`).join('')
        || '<p class="muted" style="margin-top:20px">Nothing yet. Drop a photo above and I will build it.</p>'}
      </div>
    </div>`;

  const drop = $('#tt-drop'), file = $('#tt-file');
  drop.onclick = () => file.click();
  drop.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); }
  };
  file.onchange = () => file.files[0] && readTimetableFile(file.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/'));
    if (f) readTimetableFile(f); else toast('That was not an image.', true);
  };
  $('#tt-notify').onclick = askNotify;
  const clr = $('#tt-clear');
  if (clr) clr.onclick = async () => {
    if (!confirm('Clear the whole timetable?')) return;
    await api.post('/api/timetable/save', { periods: [] });
    await refresh();
    route();
  };
}

function readTimetableFile(f) {
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) {
    return toast('That image is over 8 MB — take a smaller screenshot.', true);
  }
  const r = new FileReader();
  r.onload = () => sendTimetableImage(r.result);
  r.onerror = () => toast('Could not read that file.', true);
  r.readAsDataURL(f);
}

async function sendTimetableImage(dataUrl) {
  const drop = $('#tt-drop');
  if (drop) drop.innerHTML = '<b>Reading your timetable…</b>A few seconds.';
  try {
    const out = await api.post('/api/timetable/read', { image: dataUrl });
    if (!out.ok) { toast(out.error, true); return route(); }
    await api.post('/api/timetable/save', { periods: out.periods });
    toast(`Read ${out.periods.length} periods.`);
    await refresh();
    route();
  } catch (e) {
    toast(e.message, true);
    route();
  }
}

async function askNotify() {
  if (!('Notification' in window)) return toast('This browser has no notifications.', true);
  const perm = await Notification.requestPermission();
  toast(perm === 'granted'
    ? 'Reminders on — 5 minutes before each period.'
    : 'Reminders blocked. Allow notifications from the address bar.', perm !== 'granted');
}

function watchTimetable() {
  clearInterval(ttTimer);
  ttTimer = setInterval(tickTimetable, 30000);   // setInterval, not RAF
  tickTimetable();
}

async function tickTimetable() {
  let up;
  try { up = (await api.get('/api/timetable')).upcoming; } catch { return; }
  const strip = $('#nowstrip');
  if (!strip) return;

  if (up.current || up.next) {
    strip.classList.remove('hide');
    strip.innerHTML = up.current
      ? `<b>${esc(up.current.subject)}</b>${up.current.end ? ' until ' + esc(up.current.end) : ''}${
          up.next ? ` <span class="nxt">· then ${esc(up.next.subject)} at ${esc(up.next.start)}</span>` : ''}`
      : `<span class="nxt">Next</span> <b>${esc(up.next.subject)}</b> at ${esc(up.next.start)}`;
  } else {
    strip.classList.add('hide');
  }

  const r = up.remind;
  if (r && !firedReminders.has(r.key)) {
    firedReminders.add(r.key);
    const line = `${r.subject} in ${r.in_minutes} min${r.room ? ' · ' + r.room : ''}`;
    toast(line);
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Next period', { body: line, tag: r.key });
    }
  }
}

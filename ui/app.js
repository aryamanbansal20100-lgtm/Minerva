/* ==========================================================================
   app.js — Evie.

   The recording model, because it is the heart of the app:

   Press record inside a note. Audio is cut into fixed slices and each slice is
   transcribed while the class is still running, so you see it working and a
   crash costs one slice rather than the hour. Press again and the slices are
   composed into the finished note — headings, definitions, formulas, worked
   examples, diagrams — and any homework mentioned becomes a task.

   MediaRecorder is stopped and restarted per slice on purpose: chunks after the
   first carry no container header and cannot be decoded on their own.
   ========================================================================== */

const CHUNK_MS = 4 * 60 * 1000;   // how often a slice is sent for transcribing
const FIRST_CHUNK_MS = 20 * 1000; // the first one comes fast, on purpose
const BITRATE = 64000;            // 64 kbps: 24 lost quiet voices at the back
const TICK_MS = 100;

/* Capture constraints, and why every one of these is off.
   These filters are designed for one person holding a phone to their face. In a
   classroom they are actively harmful: noiseSuppression treats a student
   talking six metres away as noise and removes them, and autoGainControl pumps
   the room hiss up between sentences then ducks the teacher when they start
   again. Raw far-field audio transcribes far better than "cleaned" audio. */
const CLASS_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 48000,
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = { state: null, note: null, saveTimer: 0, obStep: 0, obSubjects: [] };

const api = {
  async get(p) { const r = await fetch(p); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); },
  /* Writing a note takes 30-60 seconds. Anything that interrupts the
     connection in that window — the server restarting, wifi dropping as you
     walk out of class, the laptop sleeping — surfaced as the browser's raw
     "Failed to fetch", which tells a student nothing and loses the work.

     So: one silent retry, then a message that says what actually happened. */
  async post(p, b, tries = 2) {
    let last;
    for (let n = 0; n < tries; n++) {
      try {
        const r = await fetch(p, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(b || {}),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `${p} → ${r.status}`);
        return j;
      } catch (e) {
        last = e;
        // Only a dropped connection is worth retrying; a real error from the
        // server will fail again the same way.
        const dropped = e instanceof TypeError ||
                        /failed to fetch|network|load failed/i.test(e.message || '');
        if (!dropped || n === tries - 1) break;
        await new Promise(ok => setTimeout(ok, 1500));
      }
    }
    const dropped = last instanceof TypeError ||
                    /failed to fetch|network|load failed/i.test(last.message || '');
    throw new Error(dropped
      ? 'lost the connection to Evie. Nothing was lost — check it is still running, then try again.'
      : last.message);
  },
};

let toastTimer = 0;
let seenTimer = 0;
function toast(msg, bad = false, hold = 0) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  // Instructions worth following need longer than a confirmation does — a
  // four-line fix that vanishes in seven seconds may as well not be shown.
  toastTimer = setTimeout(() => { t.className = ''; },
                          hold || (bad ? 7000 : 3200));
}

/* ========================================================================= */
/* boot + onboarding                                                         */
/* ========================================================================= */
/* Show whose notes these are.

   The sidebar showed "Evie" — the app's own name, in the corner of its own
   window, which tells the student nothing. With two Google accounts in play it
   actively hid the thing that mattered: which account they were signed into.
   Show the student's photo, name and email instead. */
function showIdentity() {
  const u = window.Evie && window.Evie.auth && window.Evie.auth.user;
  const name = $('#who-name'), mail = $('#who');
  const img = $('#avatar'), initial = $('#initial');
  if (!name) return;
  if (!u) {
    name.textContent = 'Evie';
    if (mail) mail.textContent = '—';
    return;
  }
  const full = u.displayName || (u.email || '').split('@')[0] || 'You';
  name.textContent = full;
  if (mail) mail.textContent = u.email || '';
  if (u.photoURL && img) {
    img.src = u.photoURL;
    img.hidden = false;
    img.alt = full;
    if (initial) initial.hidden = true;
    // A broken photo URL should fall back to the initial, not an empty box.
    img.onerror = () => { img.hidden = true; if (initial) initial.hidden = false; };
  } else if (initial) {
    initial.textContent = full.trim().charAt(0).toUpperCase() || 'E';
    initial.hidden = false;
  }
}

async function boot() {
  showIdentity();
  bindGlobal();
  await refresh();
  watchTimetable();
  if (!S.state.profile.onboarded) return startOnboarding();
  $('#app').classList.remove('hide');
  route();
}

async function refresh() {
  S.state = await api.get('/api/state');
  const p = S.state.profile;
  $('#who').textContent = p.onboarded
    ? `${p.grade || ''}${p.grade && p.curriculum ? ' · ' : ''}${p.curriculum || ''}`
    : 'not set up';
  const mb = S.state.managebac || {};
  const due = (S.state.tasks || []).filter(t => !t.done);
  const overdue = due.filter(t => t.due && t.due < new Date().toISOString().slice(0, 10));
  const tt = S.state.timetable || {};
  const cTt = $('#c-tt');
  if (cTt) cTt.textContent = tt.next ? tt.next.start : (tt.remaining || '');
  $('#c-notes').textContent = (S.state.notes || []).length || '';
  const cDue = $('#c-due');
  cDue.textContent = due.length || '';
  cDue.className = 'count' + (overdue.length ? ' alert' : '');
  const cMb = $('#c-mb');
  cMb.textContent = mb.unseen ? `${mb.unseen} new` : '';
  cMb.className = 'count' + (mb.unseen ? ' alert' : '');
  $('#foot-state').textContent = S.state.ai.ok
    ? (S.state.stt.ok ? 'ready' : 'notes on · recording off')
    : 'no API key — add GROQ_API_KEY';
  renderNoteList();
}

function startOnboarding() {
  $('#onboard').classList.remove('hide');
  const p = S.state.profile;
  $('#ob-name').value = p.name || '';
  $('#ob-school').value = p.school || '';
  S.obSubjects = p.subjects || [];
  renderObSubjects();

  $$('#onboard [data-next]').forEach(b => b.onclick = () => {
    if (b.dataset.next === '1' && !$('#ob-name').value.trim())
      return toast('I need a name to write to.', true);
    showStep(Number(b.dataset.next));
  });
  $('#ob-subject-input').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = e.target.value.trim();
    if (v && !S.obSubjects.includes(v)) S.obSubjects.push(v);
    e.target.value = '';
    renderObSubjects();
  });
  $('#ob-finish').onclick = finishOnboarding;
  $('#ob-skip').onclick = e => { e.preventDefault(); finishOnboarding(); };
}

function showStep(n) {
  S.obStep = n;
  $$('#onboard [data-step]').forEach(d =>
    d.classList.toggle('hide', Number(d.dataset.step) !== n));
  $$('#onboard .steps i').forEach((i, idx) => i.classList.toggle('on', idx <= n));
  window.scrollTo(0, 0);
}

function renderObSubjects() {
  $('#ob-subjects').innerHTML = S.obSubjects.map((s, i) =>
    `<button class="chip-toggle on" data-rm="${i}">${esc(s)} ✕</button>`).join('');
  $$('#ob-subjects [data-rm]').forEach(b => b.onclick = () => {
    S.obSubjects.splice(Number(b.dataset.rm), 1);
    renderObSubjects();
  });
}

async function finishOnboarding() {
  const payload = {
    name: $('#ob-name').value.trim(),
    curriculum: $('#ob-curriculum').value,
    grade: $('#ob-grade').value.trim(),
    school: $('#ob-school').value.trim(),
    city: $('#ob-city').value.trim(),
    country: $('#ob-country').value.trim(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    subjects: S.obSubjects,
    managebac_ics: $('#ob-mb').value.trim(),
    onboarded: true,
  };
  await api.post('/api/profile', payload);
  for (const s of S.obSubjects) await api.post('/api/notebook', { title: s, subject: s });
  if (payload.managebac_ics) {
    const r = await api.post('/api/managebac/refresh', {});
    toast(r.ok ? `ManageBac linked — ${r.total} items.` : r.error, !r.ok);
  }
  $('#onboard').classList.add('hide');
  $('#app').classList.remove('hide');
  await refresh();
  location.hash = '#/notes';
  route();
}

/* ========================================================================= */
/* routing                                                                   */
/* ========================================================================= */
function currentRoute() { return (location.hash.replace(/^#/, '') || '/notes').split('?')[0]; }

async function route() {
  const r = currentRoute();
  $$('.nav a').forEach(a => a.classList.toggle('on', a.dataset.route === r.split('/note')[0]));
  if (r.startsWith('/note/')) return openNote(r.slice(6));
  if (r.startsWith('/book/')) return viewNotebook(decodeURIComponent(r.slice(6)));
  if (r === '/timetable') return viewTimetable();
  if (r === '/due') return viewDue();
  if (r === '/managebac') return viewManageBac();
  if (r === '/alerts') return viewNotifications();
  if (r === '/calendar') return viewCalendar();
  if (r === '/settings') return viewSettings();
  return viewNotes();
}

function renderNoteList() {
  const route = currentRoute();
  const books = S.state.notebooks || [];
  const tasks = (S.state.tasks || []).filter(t => !t.done);
  $('#note-list').innerHTML = books.map(b => {
    const due = tasks.filter(t => (t.subject || '').toLowerCase() === b.title.toLowerCase()).length;
    const on = route === '/book/' + encodeURIComponent(b.title);
    return `<a class="note-row ${on ? 'on' : ''}" role="listitem"
       href="#/book/${encodeURIComponent(b.title)}" ${on ? 'aria-current="page"' : ''}>
      <span class="t">${esc(b.title)}</span>
      <span class="m">${b.notes} note${b.notes === 1 ? '' : 's'}${
        due ? ` · <b style="color:var(--soon)">${due} due</b>` : ''}</span>
    </a>`;
  }).join('') || '<div class="empty">No subjects yet — add them in Settings.</div>';
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/* ========================================================================= */
/* notes list                                                                */
/* ========================================================================= */
/* The dashboard row from the Timetable page, reusable.

   That page is the only one the student liked, and the reason is that it opens
   with hard numbers in cards rather than a list of rows. Same treatment here,
   so the app reads as one thing instead of one good page and five plain ones. */
function statRow(cards) {
  return `<div class="stat-row">${cards.map(c => `
    <div class="stat-card${c.alert ? ' alert' : ''}">
      <div class="k">${esc(c.k)}</div>
      <div class="v">${esc(String(c.v))}</div>
      <div class="s">${esc(c.s || '')}</div>
    </div>`).join('')}</div>`;
}

function viewNotes() {
  const notes = S.state.notes || [];
  $('#view').innerHTML = `
    <div class="topbar"><div class="grow"><h2>Notes</h2>
      <div class="sub">${notes.length} note${notes.length === 1 ? '' : 's'}</div></div>
      <button class="btn primary" id="v-new">New note</button></div>
    <div class="wrap">
      ${statRow([
        { k: 'Notes', v: notes.length, s: 'written' },
        { k: 'Due', v: (S.state.tasks || []).filter(x => !x.done).length,
          s: 'open', alert: (S.state.tasks || []).some(x => !x.done && x.due &&
              x.due < new Date().toISOString().slice(0, 10)) },
        { k: 'Subjects', v: (S.state.notebooks || []).length, s: 'notebooks' },
        { k: 'Next', v: S.state.nextLabel || '—', s: S.state.nextSub || 'no lesson' },
      ])}
      ${!notes.length && (S.state.elsewhere || []).length ? `
        <div class="cal warning">
          <div class="cal-h">Your notes are under your other Google account</div>
          <div class="cal-b">
            <p>This account has no notes yet. Another Google account signed in on
              this device has
              <b>${S.state.elsewhere[0].notes} note${S.state.elsewhere[0].notes === 1 ? '' : 's'}</b>
              and ${S.state.elsewhere[0].documents} document${S.state.elsewhere[0].documents === 1 ? '' : 's'}.</p>
            <p>Nothing has been deleted. Go to <b>Settings → Account → Sign out</b>,
              then sign back in with your other Google account and they will all
              be there.</p>
          </div>
        </div>` : ''}
      ${notes.length ? notes.map(n => `
        <div class="item" data-open="${n.id}" style="cursor:pointer;border-top:1px solid var(--line)">
          <div class="main">
            <div class="t">${esc(n.title || 'Untitled')}</div>
            <div class="m">${esc(n.subject || 'No subject')} · ${when(n.updated_at)}
              ${n.size > 40 ? '' : '<span class="pill">empty</span>'}</div>
          </div>
        </div>`).join('')
      : `<p class="muted">Nothing yet. Make a note, then press record when class
         starts — or just type and press <b>Write it up</b>.</p>`}
    </div>`;
  $('#v-new').onclick = newNote;
  offerResume();
}

/* If the last lesson in a subject ended mid-topic, offer to carry on with that
   note instead of starting a second half-note on the same thing. */
async function offerResume() {
  const subjects = (S.state.profile.subjects || []);
  for (const subject of subjects) {
    let r;
    try { r = await api.get('/api/resumable?subject=' + encodeURIComponent(subject)); }
    catch { continue; }
    if (!r.note) continue;
    const host = $('#view .wrap');
    if (!host) return;
    const div = document.createElement('div');
    div.className = 'urgent-strip';
    div.style.cssText = 'border-color:var(--accent);background:var(--accent-soft);margin-bottom:16px';
    div.innerHTML = `<b style="color:var(--accent)">${esc(subject)} was left mid-topic</b>
      <p style="margin:6px 0 10px;font-size:13.5px">“${esc(r.note.title)}” ended before the
      topic finished. Record the next lesson straight into it and I will merge them.</p>
      <a class="btn primary sm" href="#/note/${esc(r.note.id)}">Continue that note</a>`;
    host.prepend(div);
    return;
  }
}

async function newNote() {
  const note = await api.post('/api/note/new', { title: '' });
  await refresh();
  location.hash = '#/note/' + note.id;
}

/* ========================================================================= */
/* the note editor                                                           */
/* ========================================================================= */
async function openNote(id) {
  let note;
  try { note = await api.get('/api/note?id=' + encodeURIComponent(id)); }
  catch { return toast('That note is gone.', true); }
  S.note = note;
  renderNoteList();

  $('#view').innerHTML = `
    <div class="topbar">
      <div class="grow"><h2>${esc(note.title || 'Untitled')}</h2>
        <div class="sub">${esc(note.subject || 'No subject')} · saved ${when(note.updated_at)}</div></div>
      <input type="file" id="n-file" class="sr" multiple
             accept=".pdf,.docx,.pptx,.xlsx,.txt,.md,.csv,.rtf,.png,.jpg,.jpeg,.webp,.gif,.heic,image/*">
      <button class="btn ghost" id="n-add">Add file</button>
      <button class="btn ghost" id="n-obs" title="Copy as Obsidian markdown">⧉ Obsidian</button>
      <button class="btn" id="n-tidy">Write it up</button>
      <button class="btn ghost" id="n-del">Delete</button>
    </div>
    <div class="wrap">
      <input id="title-input" placeholder="Untitled" value="${esc(note.title === 'Untitled' ? '' : note.title)}">
      <div class="note-meta">
        <input id="subj-input" placeholder="Subject" value="${esc(note.subject)}">
        <input id="topic-input" placeholder="Topic" value="${esc(note.topic)}">
        <span class="pill" id="save-state">saved</span>
      </div>
      <textarea id="body-input" placeholder="Type here, or press record and just listen.">${esc(note.body)}</textarea>
      <div class="blocks" id="blocks"></div>
      ${note.transcript ? `<details style="margin-top:28px">
        <summary class="lbl" style="cursor:pointer">Transcript</summary>
        <p class="muted" style="white-space:pre-wrap;font-size:13.5px;margin-top:10px">${esc(note.transcript)}</p>
      </details>` : ''}
      <div id="recbar">
        <div id="rec-coach" class="coach hide" role="status" aria-live="polite"></div>
        <div class="recpanel">
          <div id="bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <div class="grow"><div id="livecap">Press record when the lesson starts.</div></div>
          <div class="recstat"><b id="rec-clock">00:00</b>elapsed</div>
          <div class="recstat"><b id="rec-chunks">0</b>slices</div>
          <button class="btn primary" id="rec-btn">● Record</button>
        </div>
      </div>
    </div>`;

  renderBlocks(note.blocks || []);
  if (note.continues) {
    const hint = document.createElement('div');
    hint.className = 'urgent-strip';
    hint.style.cssText = 'border-color:var(--accent);background:var(--accent-soft);margin:0 0 18px';
    hint.innerHTML = '<b style="color:var(--accent)">Left mid-topic</b>' +
      '<p style="margin:5px 0 0;font-size:13.5px">Press record here next lesson — ' +
      'I will merge the two into one note rather than starting a second half.</p>';
    $('#blocks').before(hint);
  }
  $('#ask-scope').textContent = 'this note';

  ['title-input', 'subj-input', 'topic-input', 'body-input'].forEach(idd =>
    $('#' + idd).addEventListener('input', queueSave));
  $('#n-tidy').onclick = tidyNote;
  $('#n-add').onclick = () => $('#n-file').click();
  $('#n-obs').onclick = copyObsidian;
  $('#n-file').onchange = () => attachToNote([...$('#n-file').files]);
  $('#n-del').onclick = async () => {
    if (!confirm('Delete this note?')) return;
    await api.post('/api/note/delete', { id: note.id });
    await refresh();
    location.hash = '#/notes';
  };
  $('#rec-btn').onclick = toggleRecord;
  paintRec();
}

function queueSave() {
  $('#save-state').textContent = 'saving…';
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNote, 700);
}

async function saveNote() {
  if (!S.note) return;
  const patch = {
    id: S.note.id,
    title: $('#title-input').value.trim() || 'Untitled',
    body: $('#body-input').value,
    subject: $('#subj-input').value.trim(),
    topic: $('#topic-input').value.trim(),
  };
  try {
    S.note = await api.post('/api/note/save', patch);
    $('#save-state').textContent = 'saved';
    S.state.notes = (await api.get('/api/notes')).notes;
    renderNoteList();
  } catch (e) { $('#save-state').textContent = 'not saved'; toast(e.message, true); }
}

/* Read files INTO the note being written.

   Uploading to the Documents tab only ever made a file searchable. What was
   asked for is the opposite direction: a photo of the whiteboard, the teacher's
   slides or a worksheet should end up inside the note, so that "Write it up"
   writes one set of notes covering the lesson AND the handout. So the extracted
   text is appended to the note body, marked with where it came from, and the
   normal note writer takes it from there. */
async function attachToNote(files) {
  if (!files.length || !S.note) return;
  const box = $('#body-input');
  const btn = $('#n-add');
  btn.disabled = true;
  let added = 0, failed = [];
  for (const f of files) {
    btn.textContent = `Reading ${f.name}…`;
    try {
      const data = await new Promise((ok, no) => {
        const fr = new FileReader();
        fr.onload = () => ok(fr.result);
        fr.onerror = () => no(new Error('could not read that file'));
        fr.readAsDataURL(f);
      });
      const out = await api.post('/api/document/upload',
        { subject: S.note.subject || '', name: f.name, data });
      if (out.readable && out.words > 3) {
        box.value += `

--- from ${f.name} (${out.how}) ---
${out.text || ''}`;
        added++;
      } else {
        failed.push(`${f.name}: ${out.how || 'nothing readable in it'}`);
      }
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  btn.disabled = false; btn.textContent = 'Add file';
  await saveNote();
  if (added) {
    toast(`Added ${added} file(s). Press "Write it up" to fold them in.`);
  }
  if (failed.length) toast(failed[0], true);
}

async function tidyNote() {
  if (!S.note) return;
  await saveNote();
  if (!$('#body-input').value.trim()) return toast('Write something first.', true);
  const btn = $('#n-tidy');
  btn.disabled = true; btn.textContent = 'Thinking…';
  try {
    const out = await api.post('/api/note/tidy', { id: S.note.id });
    S.note = out.note;
    renderBlocks(S.note.blocks || []);
    toast(out.tasks.length ? `Done — ${out.tasks.length} task(s) found.` : 'Done.');
    await refresh();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Write it up'; }
}

/* ------------------------------------------------------------ block render */
/* Inline markdown inside a note item.

   The model writes **bold**, `code`, "> quotes" and "## headings" inside list
   items, because that is how anyone writes notes. Escaping and dumping them
   raw is why a genuinely good note read as "How** the comic communicates" with
   stray asterisks everywhere. */
/* LaTeX, made readable.

   Models write maths in LaTeX whatever you ask for — it is what textbooks and
   training data are full of. Printed raw it reads as computer code:

     "$\% \Delta Q_s$ / $\% \Delta P$"   instead of   "%ΔQs / %ΔP"
     "$P_{old}$"                          instead of   "Pold"

   A real Economics note came back accurate and unreadable for exactly this
   reason. There is no maths engine here and there does not need to be — school
   notation is symbols plus sub/superscripts, and that is plain HTML.

   Runs BEFORE escaping, and returns escaped HTML, so callers must not escape
   its output again. */
const GREEK = {
  Delta: 'Δ', delta: 'δ', alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ',
  lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', omega: 'ω',
  Omega: 'Ω', Sigma: 'Σ', epsilon: 'ε', phi: 'φ', tau: 'τ',
};
const OPS = {
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', leq: '≤', le: '≤',
  geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡',
  infty: '∞', rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒',
  propto: '∝', sum: 'Σ', int: '∫', sqrt: '√', therefore: '∴', because: '∵',
  ldots: '…', dots: '…', percent: '%',
};

function mathText(raw) {
  let s = String(raw == null ? '' : raw);

  // Strip the delimiters; the content is handled the same either way.
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, '$1').replace(/\$([^$]+?)\$/g, '$1');
  s = s.replace(/\\[()[\]]/g, '');

  // \frac{a}{b} -> a/b, innermost first so nesting resolves.
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
  s = s.replace(/\\text\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\mathrm\s*\{([^{}]*)\}/g, '$1');

  // \% and \{ are escapes, not commands — do these before command lookup.
  s = s.replace(/\\([%&_#{}$])/g, '$1');

  s = s.replace(/\\([A-Za-z]+)/g, (m, name) =>
    GREEK[name] || OPS[name] || OPS[name.toLowerCase()] || m.slice(1));

  // Escape now: everything after this point emits real tags.
  s = esc(s);

  // Sub/superscripts: X_{old} and X_old, X^{2} and X^2.
  s = s.replace(/_\{([^{}]{1,18})\}/g, (m, t) => '<sub>' + t + '</sub>')
       .replace(/\^\{([^{}]{1,18})\}/g, (m, t) => '<sup>' + t + '</sup>')
       .replace(/_([A-Za-z0-9]{1,6})\b/g, '<sub>$1</sub>')
       .replace(/\^([A-Za-z0-9]{1,4})/g, '<sup>$1</sup>');

  // Any leftover braces were LaTeX grouping, not content.
  s = s.replace(/[{}]/g, '');
  // LaTeX puts a space after every command, so "\% \Delta Q_s" arrives as
  // "% Δ Q" — close those up, the way it would be written on paper.
  s = s.replace(/([%Δ∆])\s+(?=[ΔA-Za-z(])/g, '$1')
       .replace(/\s+(?=<sub>|<sup>)/g, '');
  return s;
}

function inlineMd(s) {
  // mathText escapes for us — do not escape again or the tags it emits show up
  // as literal <sub> in the note.
  return mathText(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*/g, '')            // any unmatched marker left over
    .replace(/(^|\s)__(.+?)__(?=\s|$)/g, '$1<b>$2</b>');
}

/* Turn a flat list of items into proper structure: headings become headings,
   "> …" becomes a pull quote, "1. …" becomes an ordered list. */
/* Callout kinds. No icons: the coloured left rule and the label carry the
   meaning, and a row of emoji was the single most amateur thing on the page. */
const CALLOUTS = {
  tip:     { label: 'Tip' },
  warning: { label: 'Watch out' },
  example: { label: 'Example' },
  quote:   { label: "In the teacher's words" },
  info:    { label: 'Note' },
  note:    { label: 'Note' },
  todo:    { label: 'To do' },
};

/* Turn a flat list of items into real structure.

   Handles four things the model writes that a flat <ul> destroys: indentation
   (nested bullets), "> [!tip] …" callouts, "## …" sub-headings, and "1. …"
   ordered lists. Indentation matters most — a note whose sub-points sit at the
   same level as their parents reads as a wall of text, which is exactly the
   difference between these notes and a hand-made Obsidian one. */
function renderItems(items) {
  let html = '', mode = '', buffer = [], call = null;

  const flush = () => {
    if (!buffer.length) return;
    const tag = mode === 'ol' ? 'ol' : 'ul';
    // Rebuild the indent tree: each item carries the depth it was written at.
    let out = '', open = 0;
    for (const item of buffer) {
      while (open < item.depth) { out += '<' + tag + ' class="sub">'; open++; }
      while (open > item.depth) { out += '</' + tag + '>'; open--; }
      out += '<li>' + inlineMd(item.text) + '</li>';
    }
    while (open-- > 0) out += '</' + tag + '>';
    html += '<' + tag + '>' + out + '</' + tag + '>';
    buffer = [];
  };

  const closeCallout = () => {
    if (!call) return;
    const c = CALLOUTS[call.kind] || CALLOUTS.note;
    html += '<div class="cal ' + esc(call.kind) + '"><div class="cal-h">' +
      inlineMd(call.title || c.label) + '</div>' +
      (call.lines.length
        ? '<div class="cal-b">' +
          call.lines.map(l => '<p>' + inlineMd(l) + '</p>').join('') + '</div>'
        : '') + '</div>';
    call = null;
  };

  for (const raw of items || []) {
    // An item can arrive as one string holding several lines.
    for (const line of String(raw == null ? '' : raw).split('\n')) {
      if (!line.trim()) continue;
      const lead = (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ');
      // A callout is often written as a bullet: "- > [!warning] …". Strip the
      // bullet marker before testing, or it renders as an ordinary list item
      // with a stray ">" sitting in the text.
      const s = line.trim().replace(/^[-*•]\s+(?=>)/, '');

      const opener = s.match(/^>\s*\[!(\w+)\]\s*(.*)$/);
      if (opener) {
        flush(); closeCallout(); mode = '';
        call = { kind: opener[1].toLowerCase(), title: opener[2].trim(), lines: [] };
        continue;
      }
      const cont = s.match(/^>\s?(.*)$/);
      if (cont) {
        flush(); mode = '';
        if (call) { if (cont[1].trim()) call.lines.push(cont[1].trim()); continue; }
        // A bare "> …" with no marker is model wording from the teacher.
        call = { kind: 'quote', title: '', lines: [cont[1].trim()] };
        closeCallout();
        continue;
      }
      // An indented line straight after a callout opener belongs to it, even
      // without its own ">" — models write the body that way about half the
      // time, and dropping it loses the actual content of the warning.
      if (call && lead.length >= 2 && !/^[-*•\d#]/.test(s)) { call.lines.push(s); continue; }
      closeCallout();

      const heading = s.match(/^#{1,4}\s+(.*)$/);
      if (heading) { flush(); mode = ''; html += '<h4>' + inlineMd(heading[1]) + '</h4>'; continue; }

      const task = s.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
      if (task) {
        flush(); mode = '';
        html += '<div class="task-line">' + (task[1] === ' ' ? '☐' : '☑') +
                ' ' + inlineMd(task[2]) + '</div>';
        continue;
      }

      const numbered = s.match(/^\d+[.)]\s+(.*)$/);
      const bulleted = s.match(/^[-*•]\s+(.*)$/);
      const text = numbered ? numbered[1] : bulleted ? bulleted[1] : s;
      const want = numbered ? 'ol' : 'ul';
      if (mode && mode !== want) flush();
      mode = want;
      // Two spaces per level, capped so a stray indent cannot run away.
      buffer.push({ depth: Math.min(3, Math.floor(lead.length / 2)), text });
    }
  }
  flush(); closeCallout();
  return html;
}

/* ------------------------------------------------------------- Obsidian
   Export the note as real Obsidian markdown.

   The rendered note is HTML; Obsidian wants markdown. Pasting the page gives
   mangled formatting, which is why the old workflow ended in hand-tidying.
   This writes properties frontmatter, #tags, > [!callouts] and nested bullets —
   Obsidian's own syntax, so it lands in the vault already formatted.

   Diagrams cannot be pasted, so they leave a mermaid block behind instead of a
   gap: Obsidian renders mermaid natively. */

function mdTag(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function mdItems(items, out) {
  for (const raw of items || []) {
    for (const line of String(raw == null ? '' : raw).split('\n')) {
      if (!line.trim()) continue;
      const lead = (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ');
      const s = line.trim();
      // Callouts and headings are already Obsidian syntax — pass them through.
      if (/^>/.test(s) || /^#{1,4}\s/.test(s)) { out.push(s); continue; }
      if (/^\d+[.)]\s/.test(s)) { out.push(s); continue; }
      const text = s.replace(/^[-*•]\s+/, '');
      out.push('  '.repeat(Math.min(3, Math.floor(lead.length / 2))) + '- ' + text);
    }
  }
}

function mdDiagram(spec) {
  const s = spec || {};
  const nodes = s.nodes || s.steps || s.items || [];
  if (!nodes.length) return '';
  const name = n => String(n && n.label != null ? n.label : n).replace(/"/g, "'");
  const lines = ['```mermaid', 'flowchart TD'];
  nodes.forEach((n, i) => lines.push(`  n${i}["${name(n)}"]`));
  if (s.edges && s.edges.length) {
    for (const e of s.edges) {
      const a = Number(e.from), b = Number(e.to);
      if (Number.isInteger(a) && Number.isInteger(b)) {
        lines.push(`  n${a} --> n${b}` + (e.label ? `|${String(e.label)}|` : ''));
      }
    }
  } else {
    nodes.forEach((_, i) => { if (i) lines.push(`  n${i - 1} --> n${i}`); });
  }
  lines.push('```');
  return lines.join('\n');
}

function toObsidian(note) {
  const n = note || {};
  const out = [];
  const date = (n.created_at || '').slice(0, 10);

  // Obsidian properties. These drive Dataview queries and the graph view, which
  // is the whole reason to keep notes in a vault rather than in a folder.
  out.push('---');
  out.push('title: ' + JSON.stringify(String(n.title || 'Untitled')));
  if (n.subject) out.push('subject: ' + JSON.stringify(String(n.subject)));
  if (n.topic) out.push('topic: ' + JSON.stringify(String(n.topic)));
  if (date) out.push('date: ' + date);
  out.push('source: evie');
  const tags = ['note'];
  if (n.subject) tags.push(mdTag(n.subject));
  if (n.topic) tags.push(mdTag(n.topic));
  out.push('tags: [' + tags.filter(Boolean).join(', ') + ']');
  out.push('---');
  out.push('');
  out.push('# ' + String(n.title || 'Untitled'));
  out.push('');

  if (n.summary) { out.push('> [!info] In one line'); out.push('> ' + n.summary); out.push(''); }

  for (const b of n.blocks || []) {
    if (b.type === 'summary') { out.push(String(b.text || '')); out.push(''); }
    else if (b.type === 'points') {
      out.push('## ' + String(b.heading || 'Key points'));
      mdItems(b.items, out); out.push('');
    } else if (b.type === 'definitions') {
      out.push('## Definitions');
      for (const d of b.items || []) out.push(`- **${d.term}** — ${d.meaning}`);
      out.push('');
    } else if (b.type === 'formula') {
      out.push('## Formula');
      out.push('> [!tip] ' + String(b.formula || ''));
      if (b.means) out.push('> ' + b.means);
      if (b.when) out.push('> Use it when: ' + b.when);
      out.push('');
    } else if (b.type === 'example') {
      out.push('## Worked example');
      out.push('> [!example] ' + String(b.title || ''));
      (b.steps || []).forEach((s, i) => out.push(`> ${i + 1}. ${s}`));
      out.push('');
    } else if (b.type === 'assessed') {
      out.push('## Comes up in assessment');
      out.push('> [!warning] Worth marks');
      for (const i of b.items || []) out.push('> - ' + String(i).replace(/^[-*]\s*/, ''));
      out.push('');
    } else if (b.type === 'gaps') {
      out.push('## Ask about next lesson');
      for (const i of b.items || []) out.push('- [ ] ' + String(i).replace(/^[-*]\s*/, ''));
      out.push('');
    } else if (b.type === 'diagram') {
      const m = mdDiagram(b.spec);
      if (m) { out.push('## Diagram'); out.push(m); out.push(''); }
    }
  }

  const tasks = (n.tasks || []).filter(t => t && t.title);
  if (tasks.length) {
    out.push('## Homework');
    for (const t of tasks) {
      out.push('- [ ] ' + t.title + (t.due ? '  ' + t.due : ''));
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function copyObsidian() {
  if (!S.note) return;
  const md = toObsidian(S.note);
  try {
    await navigator.clipboard.writeText(md);
    toast('Copied as Obsidian markdown — paste into your vault.');
  } catch (e) {
    // Clipboard needs a secure context and permission; falling back to a
    // selectable box beats failing silently.
    const box = document.createElement('textarea');
    box.className = 'copy-fallback';
    box.value = md;
    document.body.appendChild(box);
    box.select();
    toast('Press Ctrl+C to copy, then click anywhere.', true);
    const close = () => { box.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 300);
  }
}

function renderBlocks(blocks) {
  const host = $('#blocks');
  if (!host) return;
  host.innerHTML = '';
  for (const b of blocks) {
    const div = document.createElement('div');
    div.className = 'block ' + (b.type || '');
    if (b.type === 'summary') {
      div.innerHTML = `<p>${inlineMd(b.text)}</p>`;
    } else if (b.type === 'points') {
      div.innerHTML = `<h3>${esc(b.heading || 'Key points')}</h3>` +
        renderItems(b.items);
    } else if (b.type === 'definitions') {
      div.innerHTML = `<h3>Definitions</h3><div class="deflist">` +
        (b.items || []).map(d => `<div><b>${inlineMd(d.term)}</b><span>${
          inlineMd(d.meaning)}</span></div>`).join('') + '</div>';
    } else if (b.type === 'formula') {
      div.innerHTML = `<h3>Formula</h3><div class="formula">
        <div class="f">${esc(b.formula)}</div><div class="m">${esc(b.means || '')}</div>
        ${b.when ? `<div class="w">Use it when: ${esc(b.when)}</div>` : ''}</div>`;
    } else if (b.type === 'example') {
      div.innerHTML = `<h3>Worked example</h3><div class="example">
        <div class="t">${inlineMd(b.title || '')}</div><ol>` +
        (b.steps || []).map(s => `<li>${inlineMd(s)}</li>`).join('') + '</ol></div>';
    } else if (b.type === 'assessed') {
      div.innerHTML = `<h3>Comes up in assessment</h3><div class="callout assessed">` +
        renderItems(b.items) + '</div>';
    } else if (b.type === 'gaps') {
      div.innerHTML = `<h3>Ask about next lesson</h3><div class="callout gaps">` +
        renderItems(b.items) + '</div>';
    } else if (b.type === 'diagram') {
      const node = Diagram.render(b.spec);
      if (!node) continue;
      // No generic "Diagram" heading: each one carries its own caption, and
      // five identical headings above five graphs is noise.
      div.innerHTML = '';
      div.appendChild(node);
    } else { continue; }
    host.appendChild(div);
  }
}

/* ========================================================================= */
/* recording                                                                 */
/* ========================================================================= */
const R = { id: null, rec: null, stream: null, ctx: null, an: null, buf: null,
            header: null, pending: [], idx: 0, busy: 0, t0: 0, roll: 0,
            tick: 0, mime: '' };

const recording = () => !!R.id;


/* Why the microphone would not open, in words that lead somewhere.

   The old message said "Allow it in the address bar" for every failure. That
   is right for exactly one of these and actively misleading for the rest —
   NotReadableError in particular is not a permission problem at all, it means
   another program is holding the microphone, and on this laptop that is most
   likely WisprFlow, Teams or Zoom sitting in the tray. */
function micReason(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was refused. Click the icon at the left of ' +
           'the address bar, set Microphone to Allow, then reload.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Another program is holding the microphone — WisprFlow, Teams, Zoom, ' +
           'Discord or a recorder. Close it (check the tray by the clock) and ' +
           'press record again. If nothing is open, check Windows Settings → ' +
           'Privacy & security → Microphone → "Let desktop apps access your ' +
           'microphone" is on.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found. Plug one in, or check it is enabled in ' +
           'Windows sound settings.';
  }
  if (name === 'OverconstrainedError') {
    return 'This microphone will not accept the classroom settings. It should ' +
           'have fallen back automatically — tell me if you keep seeing this.';
  }
  return `The microphone would not open (${name || err}).`;
}

/* One device failing does not mean they all will. A laptop typically has the
   built-in array, a headset and whatever is plugged into HDMI; the default can
   be the exact one another app has locked. Try each in turn before giving up
   on the lesson. */
async function tryEveryMic() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); }
  catch (e) { return null; }
  const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId);
  for (const m of mics) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...CLASS_AUDIO, deviceId: { exact: m.deviceId } },
      });
    } catch (e) { /* try the next one */ }
  }
  return null;
}

async function toggleRecord() {
  if (recording()) return stopRecord();
  if (!S.state.stt.ok) return toast(S.state.stt.reason, true);
  try {
    R.stream = await navigator.mediaDevices.getUserMedia({ audio: CLASS_AUDIO });
  } catch (e) {
    // Some devices reject exact constraints; retry with plain audio rather
    // than failing the whole lesson.
    try { R.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e2) {
      const got = await tryEveryMic();
      if (got) R.stream = got;
      else return toast(micReason(e2), true, 12000);
    }
  }
  await saveNote();
  try {
    const out = await api.post('/api/record/start', { note_id: S.note.id });
    R.id = out.id;
  } catch (e) {
    R.stream.getTracks().forEach(t => t.stop());
    return toast(e.message, true);
  }
  R.idx = 0; R.busy = 0; R.t0 = Date.now();
  R.ctx = new (window.AudioContext || window.webkitAudioContext)();
  R.an = R.ctx.createAnalyser(); R.an.fftSize = 1024;
  R.ctx.createMediaStreamSource(R.stream).connect(R.an);
  R.buf = new Uint8Array(R.an.fftSize);
  spin();
  // Cut the first slice after 20 seconds, not 4 minutes. Waiting the full
  // slice before anything appears makes a working recorder look broken — you
  // stare at "0 slices" and give up. After the first one, settle into the long
  // slices that keep the request count and the token cost down.
  R.roll = setTimeout(() => {
    cut(false);
    R.roll = setInterval(() => cut(false), CHUNK_MS);
  }, FIRST_CHUNK_MS);
  R.tick = setInterval(paintRec, TICK_MS);          // setInterval, not RAF
  paintRec();
  $('#livecap').textContent = 'Listening… first words appear in about 20 seconds.';
  toast('Recording. Press again when the lesson ends.');
}

function spin() {
  R.mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
  R.parts = [];
  R.rec = new MediaRecorder(R.stream,
    { ...(R.mime ? { mimeType: R.mime } : {}), audioBitsPerSecond: BITRATE });
  R.rec.ondataavailable = e => e.data.size && R.parts.push(e.data);
  R.rec.onstop = () => {
    const blob = new Blob(R.parts, { type: R.mime || 'audio/webm' });
    R.parts = [];
    if (blob.size > 1200) send(blob, R.idx++);
    if (recording()) spin();
  };
  R.rec.start();
}

function cut(final) {
  if (R.rec && R.rec.state !== 'inactive') R.rec.stop();
  if (final) R.rec = null;
}

async function send(blob, idx) {
  R.busy++; paintRec();
  try {
    const r = await fetch('/api/record/chunk', {
      method: 'POST', body: blob,
      headers: { 'Content-Type': blob.type || 'audio/webm',
                 'X-Recording': R.id, 'X-Chunk': String(idx),
                 'X-Note': (S.note && S.note.id) || '',
                 'X-Filename': (R.mime || '').includes('mp4') ? 'c.mp4' : 'c.webm' },
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'slice failed');
    if (out.text) $('#livecap').textContent = out.text.slice(-160);
    else $('#livecap').textContent =
      'Heard nothing in that slice — check the mic is picking up the room.';
  } catch (e) {
    // Loud, and on screen rather than only in a toast that vanishes.
    $('#livecap').innerHTML = `<span style="color:var(--late)">Slice ${idx + 1} failed — ${esc(e.message)}</span>`;
    toast(`Slice ${idx + 1}: ${e.message}`, true);
  }
  finally { R.busy--; paintRec(); }
}

async function stopRecord() {
  const id = R.id, seconds = Math.round((Date.now() - R.t0) / 1000);
  R.id = null;
  // R.roll is a timeout until the first slice, an interval after it.
  clearTimeout(R.roll); clearInterval(R.roll); clearInterval(R.tick);
  cut(true);
  R.stream && R.stream.getTracks().forEach(t => t.stop());
  R.ctx && R.ctx.close().catch(() => {});
  R.stream = null; R.ctx = null; R.an = null;
  paintRec();
  $('#livecap').textContent = 'Writing your notes…';
  $('#rec-btn').disabled = true;

  for (let i = 0; i < 180 && R.busy > 0; i++) await new Promise(r => setTimeout(r, 500));

  try {
    const out = await api.post('/api/record/finish', { id, seconds });
    if (out.empty) { toast(out.message, true); }
    else {
      S.note = out.note;
      renderBlocks(S.note.blocks || []);
      $('#title-input').value = S.note.title === 'Untitled' ? '' : S.note.title;
      toast(`${Math.round(seconds / 60)} min · ${out.words} words` +
            (out.tasks.length ? ` · ${out.tasks.length} task(s) added` : ''));
      await refresh();
    }
  } catch (e) { toast(e.message, true); }
  finally {
    $('#rec-btn').disabled = false;
    $('#livecap').textContent = 'Press record when the lesson starts.';
    paintRec();
  }
}

/* Live coaching while recording.

   The point is that you never have to stop, look, and restart to find out
   whether it is working. It watches the real mic level and says what to do in
   plain words — and says nothing at all when everything is fine, because a
   panel that always shouts is a panel you stop reading. */
const COACH = {
  silent:  ['No sound reaching the mic', 'Something is muting it — check the mic icon in the address bar.', 'late'],
  quiet:   ['Very quiet', 'Move the laptop closer to the teacher, or lift the lid a bit.', 'soon'],
  loud:    ['Too loud — it may clip', 'Move it slightly away or turn the lid down.', 'soon'],
  good:    ['Picking up the room', 'Leave it be. Notes are written when you press stop.', 'ok'],
  waiting: ['Listening', 'First words appear in about 20 seconds.', 'ok'],
  working: ['Transcribing', 'Keep it running — this happens in the background.', 'ok'],
};

let coachState = '', quietFor = 0, loudFor = 0;

function coach(level) {
  const el = $('#rec-coach');
  if (!el) return;
  let key;
  if (R.busy) key = 'working';
  else if (!R.idx && (Date.now() - R.t0) < FIRST_CHUNK_MS) key = 'waiting';
  else if (level < 0.004) { quietFor += TICK_MS; key = quietFor > 4000 ? 'silent' : 'good'; }
  else if (level < 0.02) { quietFor = 0; loudFor = 0; key = 'quiet'; }
  else if (level > 0.85) { loudFor += TICK_MS; key = loudFor > 1500 ? 'loud' : 'good'; }
  else { quietFor = 0; loudFor = 0; key = 'good'; }
  if (level >= 0.004) quietFor = 0;

  if (key === coachState) return;
  coachState = key;
  const [title, advice, tone] = COACH[key];
  el.className = 'coach ' + tone;
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(advice)}</span>`;
}

function paintRec() {
  const btn = $('#rec-btn'); if (!btn) return;
  const on = recording();
  btn.className = 'btn ' + (on ? 'rec' : 'primary');
  btn.innerHTML = on ? '<span class="dot" aria-hidden="true"></span>Stop recording'
                     : '<span aria-hidden="true">●</span> Record';
  btn.setAttribute('aria-pressed', String(on));
  const secs = on ? Math.floor((Date.now() - R.t0) / 1000) : 0;
  $('#rec-clock').textContent =
    `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  $('#rec-chunks').textContent = R.idx + (R.busy ? `+${R.busy}` : '');
  $('#bars').classList.toggle('live', on);
  if (on && R.an) {
    R.an.getByteTimeDomainData(R.buf);
    let sum = 0;
    for (let i = 0; i < R.buf.length; i++) { const v = (R.buf[i] - 128) / 128; sum += v * v; }
    const level = Math.min(1, Math.sqrt(sum / R.buf.length) * 4);
    [...$('#bars').children].forEach((b, i) => {
      const c = 1 - Math.abs(i - 3) / 7;
      b.style.height = Math.max(3, level * 22 * (0.5 + c)) + 'px';
    });
  } else {
    [...$('#bars').children].forEach(b => b.style.height = '3px');
    coachState = '';
    const el = $('#rec-coach');
    if (el) { el.className = 'coach hide'; el.innerHTML = ''; }
  }
}

/* ========================================================================= */
/* due + managebac                                                           */
/* ========================================================================= */
const TODAY = () => new Date().toISOString().slice(0, 10);

function bandOf(due, timetabled) {
  if (!due) return { k: '', label: 'no date' };
  if (timetabled) {
    const d0 = due.slice(0, 10);
    if (d0 < TODAY()) return { k: '', label: 'past lesson' };
  }
  const d = due.slice(0, 10), t = TODAY();
  const days = Math.round((new Date(d) - new Date(t)) / 86400000);
  if (days < 0) return { k: 'late', label: `${-days}d overdue` };
  if (days === 0) return { k: 'late', label: 'today' };
  if (days === 1) return { k: 'soon', label: 'tomorrow' };
  if (days <= 7) return { k: 'soon', label: `in ${days}d` };
  return { k: '', label: `in ${days}d` };
}

/* One row builder for both surfaces. `open` is either a ManageBac deep link or
   an in-app note link; either way the whole title is a real anchor, so it is
   keyboard reachable, announced as a link, and middle-click/ctrl-click work. */
function itemRow(o) {
  const b = bandOf(o.due, o.timetabled);
  const href = o.url || (o.note_id ? `#/note/${o.note_id}` : '');
  const external = !!o.url;
  const label = `${o.title}${o.subject ? ', ' + o.subject : ''}, ${b.label}`;
  const title = href
    ? `<a class="t" href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}
         aria-label="${esc(label)}${external ? ', opens ManageBac in a new tab' : ''}">${esc(o.title)}${
         external ? '<span class="ext" aria-hidden="true">↗</span>' : ''}</a>`
    : `<span class="t">${esc(o.title)}</span>`;

  return `<li class="item ${b.k}">
    <span class="bar" aria-hidden="true"></span>
    <span class="main">
      ${title}
      <span class="m">
        ${o.subject ? `<span>${esc(o.subject)}</span>` : ''}
        <span class="pill ${b.k}">${b.label}</span>
        ${o.kind ? `<span class="pill">${esc(o.kind)}</span>` : ''}
        ${o.source === 'managebac' ? '<span class="pill calm">ManageBac</span>' : ''}
        ${o.seen === 0 ? '<span class="pill new">new</span>' : ''}
      </span>
    </span>
    ${o.id ? `<span class="act">
        ${o.kind ? `<select class="subj-pick" data-subj="${esc(o.id)}"
            aria-label="Subject for ${esc(o.title)}">
            <option value=""${o.subject ? '' : ' selected'}>Unfiled</option>
            ${((S.state && S.state.profile.subjects) || []).map(s =>
              `<option${s === o.subject ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>` : ''}
        <button class="btn ghost sm" data-done="${esc(o.id)}"
          aria-label="Mark done: ${esc(o.title)}">Done</button></span>` : ''}
  </li>`;
}

const taskRow = t => itemRow(t);

function viewDue() {
  const tasks = (S.state.tasks || []).filter(t => !t.done);
  const late = tasks.filter(t => t.due && t.due.slice(0, 10) < TODAY());
  const groups = [
    ['Overdue', late],
    ['Today & tomorrow', tasks.filter(t => { const b = bandOf(t.due); return !late.includes(t) && (b.label === 'today' || b.label === 'tomorrow'); })],
    ['This week', tasks.filter(t => { const b = bandOf(t.due); return b.k === 'soon' && b.label.startsWith('in'); })],
    ['Later & undated', tasks.filter(t => !t.due || bandOf(t.due).k === '')],
  ];
  $('#view').innerHTML = `
    <div class="topbar"><div class="grow"><h2>Due</h2>
      <div class="sub">${tasks.length} open</div></div></div>
    <div class="wrap">
      ${late.length ? `<div class="urgent-strip"><b>${late.length} overdue</b>
        <ul>${late.slice(0, 4).map(t => `<li>${esc(t.title)}</li>`).join('')}</ul></div>` : ''}
      ${groups.filter(g => g[1].length).map(([name, rows]) => `
        <div class="stream" style="margin-bottom:16px">
          <header><b>${name}</b><span class="n">${rows.length}</span></header>
          <ul class="itemlist">${rows.map(taskRow).join('')}</ul>
        </div>`).join('') || '<p class="muted">Nothing due. Genuinely nothing.</p>'}
    </div>`;
}

function viewManageBac() {
  const mb = S.state.managebac || {};
  const S_ = mb.streams || {};
  const names = { assignment: 'Assignments', exam: 'Exams & tests',
                  event: 'Events', admin: 'Admin & forms' };
  const row = it => itemRow({ ...it, due: it.due || it.starts, id: '', kind: '' });
  $('#view').innerHTML = `
    <div class="topbar"><div class="grow"><h2>ManageBac</h2>
      <div class="sub">${mb.configured ? 'linked, read-only' : 'not linked'}${
        mb.unseen ? ` · ${mb.unseen} new` : ''}</div></div>
      <button class="btn" id="mb-refresh">Refresh</button>
      ${mb.unseen ? '<button class="btn ghost" id="mb-seen">Mark all seen</button>' : ''}
    </div>
    <div class="wrap wide">
      ${!mb.configured ? `<p class="muted">Not linked yet. Add the calendar link in
        <a href="#/settings">Settings</a> — ManageBac → My Workspace →
        Subscribe to Calendar.</p>` : ''}
      ${(mb.urgent || []).length ? `<div class="urgent-strip">
        <b>Needs you now</b>
        <ul>${mb.urgent.slice(0, 5).map(i =>
          `<li>${esc(i.title)} — ${bandOf(i.due || i.starts).label}</li>`).join('')}</ul>
        </div>` : ''}
      <div class="streamgrid">
        ${Object.keys(names).map(k => {
          const rows = S_[k] || [];
          return `<div class="stream">
            <header><b>${names[k]}</b><span class="n">${rows.length}</span></header>
            ${rows.length ? `<ul class="itemlist">${rows.slice(0, 25).map(row).join('')}</ul>`
                          : '<div class="empty">Nothing here.</div>'}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  const rf = $('#mb-refresh');
  if (rf) rf.onclick = async () => {
    rf.disabled = true; rf.textContent = 'Refreshing…';
    const r = await api.post('/api/managebac/refresh', {});
    toast(r.ok ? `${r.total} items, ${r.new} new.` : r.error, !r.ok);
    await refresh(); route();
  };
  const ms = $('#mb-seen');
  if (ms) ms.onclick = async () => {
    const uids = (mb.new_items || []).map(i => i.uid);
    await api.post('/api/managebac/seen', { uids });
    await refresh(); route();
  };

  /* Mark what is on screen as seen, automatically.

     "New" was only ever cleared by a button most students never found, so
     every assignment stayed flagged as new for ever — the list looked
     identical on every visit and the badge never went down, which is exactly
     the ManageBac behaviour this was meant to fix.

     Reading a list is what makes it read. Give it a moment so a glance on the
     way past does not silently clear a genuinely new deadline, then mark only
     the items actually rendered. */
  const fresh = (mb.new_items || []).map(i => i.uid);
  if (fresh.length) {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(async () => {
      if (currentRoute() !== '/managebac') return;   // they navigated away
      try {
        await api.post('/api/managebac/seen', { uids: fresh });
        await refresh();
        // Repaint the badge without yanking the list out from under them.
        const badge = $('#c-mb');
        if (badge) badge.textContent = '';
      } catch (e) { /* leaving them unread is the safe failure */ }
    }, 2500);
  }
}

/* ========================================================================= */
/* settings                                                                  */
/* ========================================================================= */
/* Show whether school mail is connected, and to which address. Asks the server
   rather than trusting the token in this tab — a token can be present but
   expired, and "connected" that silently shows nothing is the worst of both. */
async function refreshMailState() {
  const el = $('#s-mail-state');
  if (!el) return;
  const off = $('#s-mail-forget');
  const has = window.Evie && window.Evie.mail && window.Evie.mail.token();
  if (!has) {
    el.className = 'mail-state';
    el.textContent = 'Not connected.';
    if (off) off.hidden = true;
    return;
  }
  el.textContent = 'Checking…';
  try {
    const d = await api.get('/api/notifications?days=1');
    if (d.email.connected) {
      el.className = 'mail-state on';
      el.textContent = 'Connected — reading ' + d.email.address + ' (read-only)';
      if (off) off.hidden = false;
    } else {
      el.className = 'mail-state bad';
      el.textContent = d.email.error || 'Not connected.';
      if (off) off.hidden = false;
    }
  } catch (e) {
    el.className = 'mail-state bad';
    el.textContent = e.message;
  }
}


function viewSettings() {
  const p = S.state.profile;
  $('#view').innerHTML = `
    <div class="topbar"><div class="grow"><h2>Settings</h2></div></div>
    <div class="wrap">
      <div class="field">
        <label>Account</label>
        <div class="acct">
          <span class="who" id="s-who">—</span>
          <button class="btn sm" id="s-signout">Sign out</button>
        </div>
        <div class="help">Your notes are stored against this Google account and
          follow you to any device you sign in on.</div>
      </div>

      <div class="field"><label>Name</label><input id="s-name" value="${esc(p.name)}"></div>
      <div class="field"><label>Curriculum</label><input id="s-cur" value="${esc(p.curriculum)}"></div>
      <div class="field"><label>Grade</label><input id="s-grade" value="${esc(p.grade)}"></div>
      <div class="field"><label>School</label><input id="s-school" value="${esc(p.school)}"></div>
      <div class="field"><label>City</label><input id="s-city" value="${esc(p.city)}"></div>
      <div class="field">
        <label>School email</label>
        <div id="s-mail-state" class="mail-state">Checking…</div>
        <div class="help">
          Evie can show school mail beside your ManageBac work — assignments,
          replies and anything urgent, kept in separate lists.
          <br><b>No password is stored, ever.</b> You sign in with Google and it
          grants read-only access, which you can take back at any time from your
          Google account. Evie cannot send, reply to or delete anything.
        </div>
        <div style="display:flex;gap:8px;margin-top:9px;align-items:center">
          <button class="btn sm" id="s-mail-connect">Connect school email</button>
          <button class="btn ghost sm" id="s-mail-forget" hidden>Disconnect</button>
        </div>
      </div>

      <div class="field">
        <label>ManageBac calendar link</label>
        <input id="s-mb" value="${esc(p.managebac_ics)}"
               placeholder="webcal://… or https://…ics">
        <div class="help">
          <b>In ManageBac:</b> My Workspace → <b>Subscribe to Calendar</b>.
          A small box appears with a long link in it — that link is what I need.
          Select it, copy it, paste it here. If the box shows a
          <i>Subscribe</i> button instead of text, right-click that button and
          choose <b>Copy link address</b>.
          <br>Read-only: I can never change anything in ManageBac.
        </div>
        <div style="display:flex;gap:8px;margin-top:9px;align-items:center">
          <button class="btn sm" id="s-mb-test">Test this link</button>
          <span id="s-mb-result" class="muted" style="font-size:12.5px"></span>
        </div>
      </div>
      <button class="btn primary" id="s-save">Save</button>
      <div style="margin-top:30px">
        <div class="lbl">Status</div>
        <p class="muted" style="font-size:13.5px">
          Brain: ${S.state.ai.ok ? 'connected · ' + esc(S.state.ai.model)
                                 : '<b>' + esc(S.state.ai.reason) + '</b>'}<br>
          Recording: ${S.state.stt.ok ? 'ready · ' + esc(S.state.stt.engine)
                                      : '<b>' + esc(S.state.stt.reason) + '</b>'}<br>
          ${S.state.tls.relaxed_strict_x509
            ? 'TLS: inspection detected on this network; certificates still verified.' : ''}
        </p>
      </div>
    </div>`;
  /* School email, wired here as well as in Notifications — Settings is where
     anyone looks for "connect an account", and a feature nobody can find is a
     feature that does not exist. */
  /* Sign out. window.Evie.auth.signOut has existed since auth was added but
     was never wired to anything, so there was no way out of the account. */
  const who = $('#s-who');
  const user = window.Evie && window.Evie.auth && window.Evie.auth.user;
  if (who) who.textContent = user ? (user.email || user.displayName || 'Signed in')
                                  : 'Not signed in';
  $('#s-signout').onclick = async () => {
    if (!confirm('Sign out of Evie on this device?')) return;
    // Drop the school-mail token too — leaving it behind would hand the next
    // person at this laptop a live read handle on the inbox.
    if (window.Evie.mail) window.Evie.mail.forget();
    try { await window.Evie.auth.signOut(); }
    catch (e) { toast(e.message, true); }
  };

  refreshMailState();
  $('#s-mail-connect').onclick = async () => {
    const btn = $('#s-mail-connect');
    if (!window.Evie || !window.Evie.mail) {
      return toast('Sign in with Google first.', true);
    }
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'Waiting for Google…';
    try {
      const out = await window.Evie.mail.connect();
      if (out.cancelled) return;
      if (!out.ok) return toast(out.error || 'could not connect', true);
      toast('School email connected — read-only.');
      await refreshMailState();
    } finally { btn.disabled = false; btn.textContent = was; }
  };
  $('#s-mail-forget').onclick = () => {
    window.Evie.mail.forget();
    toast('Disconnected. Nothing was kept.');
    refreshMailState();
  };

  $('#s-mb-test').onclick = async () => {
    const url = $('#s-mb').value.trim();
    const out = $('#s-mb-result');
    if (!url) { out.textContent = 'Paste the link first.'; return; }
    out.textContent = 'Checking…';
    try {
      const r = await api.post('/api/managebac/test', { url });
      if (!r.ok) {
        out.innerHTML = `<span style="color:var(--late)">${esc(r.error)}</span>`;
        return;
      }
      const c = Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(', ');
      out.innerHTML = `<span style="color:var(--accent)">Works — ${r.total} items
        (${esc(c)}).</span> e.g. ${esc(r.sample[0] || '')}`;
    } catch (e) {
      out.innerHTML = `<span style="color:var(--late)">${esc(e.message)}</span>`;
    }
  };

  $('#s-save').onclick = async () => {
    await api.post('/api/profile', {
      name: $('#s-name').value.trim(), curriculum: $('#s-cur').value.trim(),
      grade: $('#s-grade').value.trim(), school: $('#s-school').value.trim(),
      city: $('#s-city').value.trim(), managebac_ics: $('#s-mb').value.trim(),
    });
    toast('Saved.');
    await refresh();
  };
}

/* ========================================================================= */
/* ask                                                                       */
/* ========================================================================= */
async function ask(question) {
  const log = $('#asklog');
  const item = document.createElement('div');
  item.className = 'qa';
  item.innerHTML = `<div class="q">${esc(question)}</div><div class="a muted">Thinking…</div>`;
  log.appendChild(item);
  log.scrollTop = 1e9;
  try {
    const out = await api.post('/api/ask', {
      question, note_id: currentRoute().startsWith('/note/') ? S.note?.id : '',
    });
    item.querySelector('.a').className = 'a';
    item.querySelector('.a').innerHTML = md(out.answer);
    const src = document.createElement('div');
    src.className = 'src';
    src.innerHTML = (out.sources || []).map(s =>
      `<span class="pill ${s.label === 'WEB' ? 'calm' : ''}">${esc(s.label)}${
        s.title ? ' · ' + esc(s.title.slice(0, 26)) : ''}</span>`).join('') +
      (out.used_web ? '' : '');
    item.appendChild(src);
  } catch (e) {
    item.querySelector('.a').innerHTML = `<span style="color:var(--late)">${esc(e.message)}</span>`;
  }
  log.scrollTop = 1e9;
}

/* Small markdown subset — bold, italic, code, headings, lists, paragraphs. */
function md(text) {
  const lines = String(text || '').split('\n');
  let html = '', inList = false;
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, '$1<i>$2</i>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (!line) continue;
    if (/^#{1,4}\s/.test(line)) html += `<p><b>${inline(line.replace(/^#+\s/, ''))}</b></p>`;
    else html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html || '<p class="muted">(empty)</p>';
}

/* ========================================================================= */
/* global wiring                                                             */
/* ========================================================================= */
let setAsk = () => {};

function bindGlobal() {
  window.addEventListener('hashchange', route);
  $('#new-note').onclick = newNote;
  setAsk = open => {
    $('#askdock').classList.toggle('open', open);
    $('#askfab').setAttribute('aria-expanded', String(open));
    if (open) $('#askinput').focus(); else $('#askfab').focus();
  };
  $('#askfab').onclick = () => setAsk(!$('#askdock').classList.contains('open'));
  $('#ask-close').onclick = () => setAsk(false);
  $('#askform').onsubmit = e => {
    e.preventDefault();
    const q = $('#askinput').value.trim();
    if (!q) return;
    $('#askinput').value = '';
    ask(q);
  };
  document.body.addEventListener('click', async e => {
    const open = e.target.closest('[data-open]');
    if (open) { location.hash = '#/note/' + open.dataset.open; return; }
    // Anchors handle their own navigation; nothing to intercept for links.
    const pick = e.target.closest('[data-subj]');
    if (pick) return;                       // handled on change, not click

    const done = e.target.closest('[data-done]');
    if (done) {
      await api.post('/api/task/done', { id: done.dataset.done, done: true });
      await refresh(); route();
    }
  });
  // Re-filing an assignment: the student always overrules the AI's guess.
  document.body.addEventListener('change', async e => {
    const pick = e.target.closest('[data-subj]');
    if (!pick) return;
    try {
      await api.post('/api/task/subject',
                     { id: pick.dataset.subj, subject: pick.value });
      toast(pick.value ? `Moved to ${pick.value}.` : 'Unfiled.');
      await refresh();
      route();
    } catch (err) { toast(err.message, true); }
  });

  document.addEventListener('keydown', e => {
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (e.ctrlKey && e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      if (currentRoute().startsWith('/note/')) toggleRecord();
      else newNote();
    }
    if (e.key === 'Escape' && $('#askdock').classList.contains('open')) setAsk(false);
    if (e.key === '/' && !typing) { e.preventDefault(); setAsk(true); }
  });
  // Paste a screenshot straight onto the timetable page.
  window.addEventListener('paste', e => {
    if (currentRoute() !== '/timetable') return;
    const item = [...(e.clipboardData?.items || [])]
      .find(i => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    readTimetableFile(item.getAsFile());
  });

  window.addEventListener('beforeunload', e => {
    if (recording()) { e.preventDefault(); e.returnValue = ''; }
  });
}

// boot() is called by auth.js once Google sign-in succeeds.
if (!window.Evie || !window.Evie.auth) boot();

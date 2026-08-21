/* ==========================================================================
   notifications.js — one place for everything that wants your attention.

   The complaint about ManageBac was never that it lacks notifications. It is
   that an assignment due tomorrow, a graded discussion comment and a school
   newsletter all land in the same clamped pile, so the one that matters looks
   exactly like the two that do not. So here they are kept apart:

     Needs you now   anything overdue, due today or marked urgent — from either
                     source, lifted out of its own stream
     Assignments     work to hand in
     Discussions     replies, comments, questions
     School admin    circulars, trips, timetable changes, fees
     Everything else

   School email is read-only and password-free: see server/mail.py for why
   there is no password field anywhere in this app.
   ========================================================================== */

const STREAMS = [
  { key: 'urgent',     title: 'Needs you now',   tone: 'urgent' },
  { key: 'assignment', title: 'Assignments',     tone: '' },
  { key: 'discussion', title: 'Discussions',     tone: '' },
  { key: 'admin',      title: 'School admin',    tone: '' },
  { key: 'other',      title: 'Everything else', tone: 'muted' },
];

let NOTIF = { data: null, open: '' };

async function viewNotifications() {
  $('#view').innerHTML = `
    <div class="topbar">
      <div class="grow"><h2>Notifications</h2>
        <div class="sub">ManageBac and school email, kept apart</div></div>
      <button class="btn ghost" id="nf-refresh">Refresh</button>
    </div>
    <div class="wrap wide"><div id="nf-body">
      <p class="muted" style="margin-top:20px">Loading…</p></div></div>`;
  $('#nf-refresh').onclick = () => loadNotifications(true);
  loadNotifications(false);
}

async function loadNotifications(force) {
  const body = $('#nf-body');
  if (force) body.innerHTML = '<p class="muted" style="margin-top:20px">Checking…</p>';
  try {
    NOTIF.data = await api.get('/api/notifications');
  } catch (e) {
    body.innerHTML = `<p class="muted" style="margin-top:20px">${esc(e.message)}</p>`;
    return;
  }
  renderNotifications();
}

function renderNotifications() {
  const d = NOTIF.data;
  const body = $('#nf-body');
  if (!body || !d) return;

  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);

  body.innerHTML = `
    ${emailBanner(d.email)}
    ${!d.managebac.configured ? `<div class="cal info" style="margin-top:14px">
      <div class="cal-h">ManageBac is not connected</div>
      <div class="cal-b"><p>Add your ManageBac calendar link in Settings and
        assignments will appear here.</p></div></div>` : ''}
    ${total ? STREAMS.map(s => streamBlock(s, d.streams[s.key] || [])).join('')
            : `<p class="muted" style="margin-top:20px">Nothing waiting.
               ${d.email.connected ? '' : 'Connect your school email to see mail here too.'}</p>`}`;

  const btn = $('#nf-connect');
  if (btn) btn.onclick = connectSchoolEmail;
  const off = $('#nf-disconnect');
  if (off) off.onclick = () => {
    window.Minerva.mail.forget();
    toast('School email disconnected. Nothing was kept.');
    loadNotifications(true);
  };
}

function emailBanner(email) {
  if (email.connected) {
    return `<div class="cal tip" style="margin-top:14px">
      <div class="cal-h">Reading ${esc(email.address)}</div>
      <div class="cal-b"><p>Read-only. Minerva cannot send, reply to or delete
        anything. <button class="btn ghost sm" id="nf-disconnect">Disconnect</button></p>
      </div></div>`;
  }
  return `<div class="cal ${email.error ? 'warning' : 'info'}" style="margin-top:14px">
    <div class="cal-h">${
      email.error ? 'School email needs reconnecting' : 'Add your school email'}</div>
    <div class="cal-b">
      ${email.error ? `<p>${esc(email.error)}</p>` : `<p>Sign in with your school
        Google account and Minerva can show school mail here alongside ManageBac.
        <b>No password is stored</b> — Google grants read-only access which you
        can revoke any time from your Google account.</p>`}
      <p><button class="btn primary" id="nf-connect">Connect school email</button></p>
    </div></div>`;
}

function streamBlock(stream, items) {
  if (!items.length) return '';
  return `<div class="tier-head" style="margin-top:22px">
      <span class="t">${esc(stream.title)}</span>
      <span class="chip">${items.length}</span></div>
    <ul class="itemlist">${items.map(i => notifRow(i, stream.tone)).join('')}</ul>`;
}

function notifRow(i, tone) {
  const badge = i.source === 'email'
    ? '<span class="pill">email</span>'
    : '<span class="pill">ManageBac</span>';
  const band = i.band && i.band !== 'past'
    ? `<span class="pill ${esc(i.band)}">${esc(i.band)}</span>` : '';
  const link = i.url
    ? `<a class="t" href="${esc(i.url)}" target="_blank" rel="noopener">${
        esc(i.subject || '(no subject)')}<span class="ext" aria-hidden="true">↗</span></a>`
    : `<span class="t">${esc(i.subject || '(no subject)')}</span>`;
  return `<li class="item ${tone === 'urgent' ? 'hot' : ''}"
              style="${tone === 'muted' ? 'opacity:.7' : ''}">
      <span class="bar" aria-hidden="true"></span>
      <span class="main">
        ${link}
        <span class="m">${esc(i.from || '')} ${badge} ${band}
          ${i.unread ? '<span class="pill new">new</span>' : ''}</span>
        ${i.snippet ? `<span class="m">${esc(String(i.snippet).slice(0, 180))}</span>` : ''}
      </span>
    </li>`;
}

async function connectSchoolEmail() {
  const btn = $('#nf-connect');
  if (!window.Minerva || !window.Minerva.mail) {
    return toast('Sign in with Google first.', true);
  }
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Waiting for Google…';
  try {
    const out = await window.Minerva.mail.connect();
    if (out.cancelled) return;
    if (!out.ok) return toast(out.error || 'could not connect', true);
    toast('School email connected — read-only.');
    await loadNotifications(true);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

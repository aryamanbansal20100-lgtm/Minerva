/* ==========================================================================
   notebook.js — one subject, three tabs.

   Notes       every lesson recorded or written for this subject
   Documents   files you put here — worksheets, briefs, past papers
   Assignments what is due in this subject, from ManageBac and from lessons

   Documents are uploads, not ManageBac pulls. The ManageBac calendar feed
   carries SUMMARY, DTSTART, DTEND, UID and sometimes DESCRIPTION — there is no
   attachment field in it at all. Files sit behind the ManageBac API, which
   needs a school-admin token a student cannot mint. So this is drag-and-drop,
   and PDFs get their text extracted so Ask can read them.
   ========================================================================== */

let NB = { subject: '', tab: 'notes', data: null };

async function viewNotebook(subject) {
  NB.subject = subject;
  let d;
  try { d = await api.get('/api/notebook?subject=' + encodeURIComponent(subject)); }
  catch (e) { $('#view').innerHTML = `<div class="wrap"><p class="muted">${esc(e.message)}</p></div>`; return; }
  NB.data = d;
  renderNotebook();
}

function renderNotebook() {
  const d = NB.data;
  const open = d.assignments.filter(a => !a.done);
  const counts = { notes: d.notes.length, documents: d.documents.length,
                   assignments: open.length };

  $('#view').innerHTML = `
    <div class="topbar">
      <div class="grow"><h2>${esc(d.subject)}</h2>
        <div class="sub">${counts.notes} notes · ${counts.documents} documents ·
          ${counts.assignments} open</div></div>
      <button class="btn ghost" id="nb-rename">Rename</button>
      <button class="btn ghost" id="nb-del">Delete</button>
      <button class="btn primary" id="nb-new">New note</button>
    </div>
    <div class="wrap wide">
      <div class="tabs" role="tablist">
        ${['notes', 'documents', 'assignments'].map(k => `
          <button role="tab" class="tab ${NB.tab === k ? 'on' : ''}" data-tab="${k}"
                  aria-selected="${NB.tab === k}">
            ${k[0].toUpperCase() + k.slice(1)}
            <span class="tab-n">${counts[k]}</span>
          </button>`).join('')}
      </div>
      <div id="nb-body"></div>
    </div>`;

  $('#nb-new').onclick = async () => {
    const note = await api.post('/api/note/new', { title: '', subject: NB.subject });
    await refresh();
    location.hash = '#/note/' + note.id;
  };
  $('#nb-rename').onclick = async () => {
    const name = prompt('Rename this notebook to:', NB.subject);
    if (name === null) return;
    const wanted = name.trim();
    if (!wanted || wanted === NB.subject) return;
    try {
      const out = await api.post('/api/notebook/rename',
                                 { old: NB.subject, new: wanted });
      const m = out.moved || {};
      const carried = [[m.notes, 'note'], [m.documents, 'document'],
                       [m.tasks, 'task']]
        .filter(x => x[0]).map(x => `${x[0]} ${x[1]}${x[0] === 1 ? '' : 's'}`);
      toast(`Renamed to ${out.title}` +
            (carried.length ? ` — ${carried.join(', ')} moved with it.` : '.'));
      await refresh();
      location.hash = '#/book/' + encodeURIComponent(out.title);
    } catch (e) { toast(e.message, true, 9000); }
  };

  $('#nb-del').onclick = async () => {
    if (!confirm(`Delete the notebook "${NB.subject}"?`)) return;
    try {
      await api.post('/api/notebook/delete', { title: NB.subject });
      toast('Notebook deleted.');
      await refresh();
      location.hash = '#/notes';
    } catch (e) { toast(e.message, true, 9000); }
  };

  $$('#view [data-tab]').forEach(b => b.onclick = () => {
    NB.tab = b.dataset.tab;
    renderNotebook();
  });
  ({ notes: nbNotes, documents: nbDocuments, assignments: nbAssignments })[NB.tab]();
}

function nbNotes() {
  const d = NB.data;
  $('#nb-body').innerHTML = d.notes.length ? `
    <ul class="itemlist">${d.notes.map(n => `
      <li class="item">
        <span class="bar" aria-hidden="true"></span>
        <span class="main">
          <a class="t" href="#/note/${esc(n.id)}">${esc(n.title || 'Untitled')}</a>
          <span class="m">${esc(n.topic || 'no topic')} · ${when(n.updated_at)}
            ${n.continues ? '<span class="pill soon">left mid-topic</span>' : ''}</span>
        </span>
      </li>`).join('')}</ul>`
    : `<p class="muted" style="margin-top:20px">No notes in ${esc(d.subject)} yet.
       Make one and press record when the lesson starts.</p>`;
}

function nbAssignments() {
  const d = NB.data;
  const open = d.assignments.filter(a => !a.done);
  const done = d.assignments.filter(a => a.done);
  $('#nb-body').innerHTML = (open.length || done.length) ? `
    ${open.length ? `<ul class="itemlist">${open.map(taskRow).join('')}</ul>`
                  : '<p class="muted" style="margin-top:20px">Nothing open.</p>'}
    ${done.length ? `<div class="tier-head" style="margin-top:20px">
        <span class="t">Done</span><span class="chip">${done.length}</span></div>
      <ul class="itemlist">${done.map(t => `
        <li class="item" style="opacity:.55">
          <span class="bar" aria-hidden="true"></span>
          <span class="main"><span class="t" style="text-decoration:line-through">${esc(t.title)}</span></span>
        </li>`).join('')}</ul>` : ''}`
    : `<p class="muted" style="margin-top:20px">Nothing due in ${esc(d.subject)}.
       Assignments arrive from ManageBac and from lessons you record.</p>`;
}

function nbDocuments() {
  const d = NB.data;
  $('#nb-body').innerHTML = `
    <div class="drop" id="doc-drop" tabindex="0" role="button"
         aria-label="Upload documents for this subject">
      <b>Drop worksheets, briefs or past papers here</b>
      PDFs get read so you can ask questions about them. Up to 20 MB each.
    </div>
    <input type="file" id="doc-file" class="sr" multiple
           accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp,.doc,.docx,.ppt,.pptx">
    ${d.documents.length ? `<button class="btn primary" id="doc-notes"
          style="margin-top:14px">Make notes from these files</button>` : ''}
    ${d.documents.length ? `<ul class="itemlist" style="margin-top:18px">
      ${d.documents.map(f => `
        <li class="item">
          <span class="bar" aria-hidden="true"></span>
          <span class="main">
            <a class="t" href="#" data-doc-open="${esc(f.id)}"
               >${esc(f.name)}<span class="ext" aria-hidden="true">↗</span></a>
            <span class="m">${(f.size / 1024).toFixed(0)} KB · ${when(f.created_at)}
              ${f.chars > 40 ? '<span class="pill new">readable</span>'
                             : '<span class="pill">not searchable</span>'}</span>
          </span>
          <span class="act"><button class="btn ghost sm" data-doc-del="${esc(f.id)}"
            aria-label="Delete ${esc(f.name)}">Delete</button></span>
        </li>`).join('')}</ul>`
      : '<p class="muted" style="margin-top:18px">No documents yet.</p>'}
    <div class="grab-box">
      <div class="grab-copy">
        <b>Get files straight from ManageBac</b>
        <span>Drag this button to your bookmarks bar once. Then on any ManageBac
        page, click it and the files land here.</span>
      </div>
      <a class="btn primary grab-btn" id="grab-link" href="#"
         draggable="true">Save to ${esc(NB.subject)}</a>
      <button class="btn sm" id="grab-copy-btn">Copy instead</button>
    </div>`;

  buildGrabLink();
  const drop = $('#doc-drop'), file = $('#doc-file');
  drop.onclick = () => file.click();
  drop.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); }
  };
  file.onchange = () => uploadDocs([...file.files]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => {
    e.preventDefault(); drop.classList.remove('over');
    uploadDocs([...e.dataTransfer.files]);
  };
  const mk = $('#doc-notes');
  if (mk) mk.onclick = async () => {
    mk.disabled = true;
    const was = mk.textContent;
    mk.textContent = 'Reading the files and writing notes…';
    try {
      const out = await api.post('/api/notes/from-documents',
                                 { subject: NB.subject });
      if (out.warning) toast(out.warning, true);
      else toast(`Notes written from ${out.used.length} file(s)` +
                 (out.tasks && out.tasks.length
                    ? ` — ${out.tasks.length} task(s) found.` : '.'));
      if (out.skipped && out.skipped.length) {
        toast(`Skipped (no readable text): ${out.skipped.slice(0, 3).join(', ')}`, true);
      }
      location.hash = '#/note/' + out.note.id;
    } catch (e) { toast(e.message, true); }
    finally { mk.disabled = false; mk.textContent = was; }
  };

  $$('#nb-body [data-doc-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this document?')) return;
    await api.post('/api/document/delete', { id: b.dataset.docDel });
    viewNotebook(NB.subject);
  });

  /* Open a stored file.

     This used to be a plain <a href="/api/document?id=…">. A plain navigation
     does not go through the patched fetch(), so it carried no Firebase token,
     the auth gate answered 401, and the browser saved that JSON error body
     under the file's name. That is the whole reason files "did not even open" —
     the stored bytes were fine, the download was not.

     So fetch it properly, with the token, and hand the browser real bytes. */
  $$('#nb-body [data-doc-open]').forEach(a => a.onclick = async e => {
    e.preventDefault();
    const id = a.dataset.docOpen;
    const was = a.textContent;
    a.textContent = 'Opening…';
    try {
      const res = await fetch('/api/document?id=' + encodeURIComponent(id));
      if (!res.ok) {
        let why = res.status === 401 ? 'you are signed out — sign in again'
                                    : 'the app returned ' + res.status;
        try { const j = await res.json(); if (j.error) why = j.error; } catch (_) {}
        throw new Error(why);
      }
      const blob = await res.blob();
      if (!blob.size) throw new Error('that file is empty on disk');
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      if (!win) {
        // Popup blocked: fall back to a click on a real download link.
        const dl = document.createElement('a');
        dl.href = url;
        dl.download = was.replace(/↗$/, '').trim() || 'file';
        document.body.appendChild(dl);
        dl.click();
        dl.remove();
      }
      // Revoke late; revoking immediately can kill the tab that just opened.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast(err.message, true);
    } finally {
      a.textContent = was;
    }
  });
}

async function buildGrabLink() {
  const link = $('#grab-link');
  if (!link || typeof bookmarkletSource !== 'function') return;
  try {
    const { key, uid } = await api.get('/api/capture-key');
    link.href = bookmarkletSource(key, NB.subject, uid);
    link.onclick = e => {
      e.preventDefault();
      toast('Drag this button up to your bookmarks bar (Ctrl+Shift+B shows it), ' +
            'then click it on a ManageBac page.');
    };
    // Dragging is fiddly on some setups; copying the URL and pasting it into a
    // new bookmark by hand always works.
    const copy = $('#grab-copy-btn');
    if (copy) copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(link.href);
        toast('Copied. Make a new bookmark and paste this as its URL.');
      } catch { toast('Could not copy — drag the button instead.', true); }
    };
  } catch {
    link.outerHTML = '<span class="muted">Sign in to set this up.</span>';
  }
}


async function uploadDocs(files) {
  if (!files.length) return;
  const drop = $('#doc-drop');
  let done = 0;
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { toast(`${f.name} is over 20 MB.`, true); continue; }
    if (drop) drop.innerHTML = `<b>Uploading ${esc(f.name)}…</b>${done}/${files.length} done`;
    try {
      const data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error('could not read the file'));
        r.readAsDataURL(f);
      });
      await api.post('/api/document/upload',
                     { subject: NB.subject, name: f.name, data });
      done++;
    } catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
  if (done) toast(`${done} document${done === 1 ? '' : 's'} added.`);
  viewNotebook(NB.subject);
}

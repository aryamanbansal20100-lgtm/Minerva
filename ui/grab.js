/* ==========================================================================
   grab.js — builds the "Save to <subject>" bookmarklet.

   Why a bookmarklet: ManageBac's API needs a school-admin token, and its
   calendar feed has no attachment field. But your browser is already signed in
   to ManageBac, so it can read the files on a page you are looking at. This
   runs there and posts them to Minerva. Your ManageBac password never comes near
   this app.

   The body is written as a NORMAL function and serialised with toString().
   Writing it as a string instead means every backslash needs escaping twice,
   and an earlier version silently produced the invalid regex `(?|$)` — which
   threw the moment you clicked the bookmark, so nothing happened at all and
   there was nothing to see. A real function cannot have that bug: the regex
   below is checked by the JS parser when this file loads.
   ========================================================================== */

/* eslint-disable */
function evieGrabBody(KEY, SUBJECT, MINERVA, UID) {
  (async () => {
    const show = (msg, bad) => {
      let n = document.getElementById('minerva-note');
      if (!n) {
        n = document.createElement('div');
        n.id = 'minerva-note';
        n.style.cssText =
          'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;' +
          'padding:14px 18px;border-radius:12px;font:14px/1.45 system-ui,sans-serif;' +
          'box-shadow:0 10px 40px rgba(0,0,0,.35);white-space:pre-line';
        document.body.appendChild(n);
      }
      n.style.background = bad ? '#b4342a' : '#1c1b19';
      n.style.color = '#fff';
      n.textContent = msg;
      return n;
    };

    /* Deciding what is a file.

       Attempt one matched any href containing "/files/" — but the ManageBac
       Files page itself lives at /files, so pagination buttons and category
       filters were saved as documents.

       Attempt two demanded a file extension in the link text or the href. That
       kept the junk out but threw away most real files, because ManageBac shows
       a file as its title ("Las Nacionalidades") with the type in a separate
       column, and its href is an opaque id. That is why only three of your
       files ever arrived.

       So: guess generously here, then let the SERVER decide. A real attachment
       answers with Content-Disposition, or with a document Content-Type. A
       navigation link answers with HTML. The response headers are authoritative
       in a way that URL-guessing never is. */
    const EXT = /\.(pdf|docx?|pptx?|xlsx?|csv|txt|rtf|odt|png|jpe?g|gif|webp|heic|zip)(\?|#|$)/i;
    const DOWNLOAD = /(\/download|[?&]download|attachment|\/assets?\/|\/files?\/\d|\/resources?\/\d)/i;
    // Things that are definitely the page's own furniture, not content.
    const SKIP = /(\/login|\/logout|\/sign_?out|\/settings|\/profile|\/messages|\/notifications|\/calendar|\/help|mailto:|tel:|\/page\/|[?&]page=|[?&]sort=|[?&]filter=)/i;
    const DOCTYPE = /(pdf|word|powerpoint|presentation|excel|spreadsheet|officedocument|opendocument|image\/|zip|rtf|csv|octet-stream)/i;

    const seen = new Set();
    const strong = [], maybe = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!href || !/^https?:/i.test(href)) continue;
      if (seen.has(href)) continue;
      const label = (a.textContent || '').trim();
      if (SKIP.test(href)) continue;
      // Pagination and filter chips are short and numeric or one word.
      if (/^\d+$/.test(label)) continue;
      seen.add(href);
      if (EXT.test(label) || EXT.test(href) || DOWNLOAD.test(href)) strong.push(a);
      else if (label.length >= 3) maybe.push(a);
    }

    // Probe the strong candidates first, then the rest, up to a sane budget.
    const queue = strong.concat(maybe).slice(0, 60);
    if (!queue.length) {
      return show(
        'Minerva: no links to check on this page.\n\n' +
        'Open a ManageBac page that lists attachments — a class Files tab, or ' +
        'an assignment with a worksheet on it.', true);
    }

    show('Minerva: checking ' + queue.length + ' link(s) on this page…');

    const files = [];
    let pages = 0, problems = [], tooBig = 0;
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i];
      if (i % 5 === 0) {
        show('Minerva: checking link ' + (i + 1) + ' of ' + queue.length +
             '…\nfound ' + files.length + ' file(s) so far');
      }
      try {
        const res = await fetch(a.href, { credentials: 'include' });
        if (!res.ok) { problems.push(res.status + ' ' + a.href.slice(-36)); continue; }

        const type = (res.headers.get('content-type') || '').toLowerCase();
        const cd = res.headers.get('content-disposition') || '';
        const attached = /attachment|filename/i.test(cd);

        // A page is a page, whatever its URL looked like.
        if (type.includes('text/html') && !attached) { pages++; continue; }
        // Accept only things that look like documents, or that the server
        // explicitly offered as a download.
        if (!attached && !DOCTYPE.test(type)) { pages++; continue; }

        const blob = await res.blob();
        if (!blob.size) { problems.push('empty: ' + a.href.slice(-30)); continue; }
        if (blob.size > 20 * 1024 * 1024) { tooBig++; continue; }

        /* Name it. Best source first: the server's Content-Disposition, then
           the visible link text, then the URL tail. If none of those carry an
           extension, derive one from the MIME type — that is what rescues a
           real PDF whose link text is just its title. */
        let name = '';
        const match = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
        if (match) { try { name = decodeURIComponent(match[1]); } catch (e) { name = match[1]; } }
        name = (name || '').trim();
        const label = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90);
        if (!EXT.test(name)) {
          const tail = decodeURIComponent((a.href.split('?')[0].split('/').pop() || ''));
          if (EXT.test(tail)) name = tail;
        }
        if (!EXT.test(name)) {
          const from = {
            'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
            'image/webp': 'webp', 'image/gif': 'gif', 'text/plain': 'txt',
            'text/csv': 'csv', 'application/zip': 'zip', 'application/rtf': 'rtf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
            'application/msword': 'doc', 'application/vnd.ms-powerpoint': 'ppt',
            'application/vnd.ms-excel': 'xls',
          }[type.split(';')[0].trim()];
          const base = (name || label || 'file').replace(/[\\/:*?"<>|]/g, '-');
          // The label may already end in the right extension — appending one
          // from the MIME type then produces "notes.pdf.pdf".
          if (EXT.test(base)) name = base;
          else if (from) name = base + '.' + from;
          else if (!name) name = base;
        }
        if (!name) continue;

        const data = await new Promise((ok, no) => {
          const fr = new FileReader();
          fr.onload = () => ok(fr.result);
          fr.onerror = () => no(new Error('read failed'));
          fr.readAsDataURL(blob);
        });
        files.push({ name: name, data: data });
      } catch (err) {
        problems.push(String(err.message || err).slice(0, 40));
      }
    }

    // Tell the student if the list is paginated — otherwise "only some came"
    // looks like a bug when the rest are simply on page 2.
    let more = '';
    for (const a of document.querySelectorAll('a[href]')) {
      if (/next|›|»/i.test((a.textContent || '').trim()) || /[?&]page=[2-9]/.test(a.href)) {
        more = '\nThis list has more pages — run this again on each page.';
        break;
      }
    }

    if (!files.length) {
      return show(
        'Minerva: checked ' + queue.length + ' link(s) and found no files.\n\n' +
        pages + ' were web pages, not attachments.' +
        (tooBig ? '\n' + tooBig + ' were over 20 MB.' : '') +
        (problems.length ? '\n' + problems.slice(0, 2).join('\n') : '') + more, true);
    }

    show('Minerva: sending ' + files.length + ' file(s)…');

    try {
      const res = await fetch(MINERVA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Capture-Key': KEY,
                   'X-Capture-Uid': UID },
        body: JSON.stringify({ subject: SUBJECT, files: files }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) return show('Minerva: ' + (out.error || res.status), true);
      const bad = out.failed || [];
      show('Minerva: saved ' + (out.saved || []).length + ' file(s) to ' + SUBJECT + '.' +
           (bad.length ? '\n\nRejected ' + bad.length + ':\n' +
                         bad.slice(0, 3).join('\n') : '') +
           more, false);
    } catch (err) {
      show('Minerva: could not reach the app.\n\n' +
           'Is it still running at ' + MINERVA.replace('/api/capture', '') + ' ?', true);
    }
  })();
}
/* eslint-enable */

/** A javascript: URL that runs the body above with this student's key. */
function bookmarkletSource(key, subject, uid, origin) {
  const endpoint = (origin || window.location.origin) + '/api/capture';
  const call = '(' + evieGrabBody.toString() + ')('
    + JSON.stringify(String(key)) + ','
    + JSON.stringify(String(subject)) + ','
    + JSON.stringify(endpoint) + ','
    + JSON.stringify(String(uid || '')) + ');';
  return 'javascript:' + encodeURIComponent(call);
}

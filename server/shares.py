"""shares.py — a note, shared by a link.

The whole feature in one place, stdlib only. A student presses Share on a note
and gets a link. What happens when someone opens that link depends on who they
are:

    they have Minerva      the link drops them into the app, reading the note
                           with a one-tap "Add to my notes" button.
    they do not            a clean web page shows the note and offers it as a
                           Word (.docx) file they can open in anything.

The clever half is that one link does both, decided in the browser: if this
browser has ever signed in to Minerva it forwards into the app, otherwise it
stays on the web page. See open_js().

What is shared is a SNAPSHOT, frozen at the moment of sharing — never a live
window into the owner's account. A share therefore exposes exactly the one note
its owner chose and nothing else: not their other notes, not their database,
not a token. The snapshot lives in a small global on-disk store keyed by an
unguessable token, so a visitor needs no account to read it and the server needs
no per-user routing to serve it. It is mirrored into the owner's own cloud space
too (see sync.push_share), so a share survives the free host wiping its disk, the
same way the owner's notes do.

The .docx is written by hand: a Word file is a ZIP of XML parts, and the
standard library has both zipfile and everything needed to emit the XML. No
python-docx, no pip install — which is the whole spirit of this build.
"""

from __future__ import annotations

import hashlib
import html as _html
import io
import json
import re
import secrets
import threading
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARES_DIR = ROOT / "data" / "shares"
OWNERS_DIR = SHARES_DIR / "owners"

_lock = threading.Lock()

# A token is short, URL-safe and unguessable. token_urlsafe(9) is 12 characters
# from a 72-bit space, so the links are tidy and still impossible to walk.
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _dirs() -> None:
    SHARES_DIR.mkdir(parents=True, exist_ok=True)
    OWNERS_DIR.mkdir(parents=True, exist_ok=True)


def valid_token(token: str) -> bool:
    """A token that is safe to turn into a filename. Rejects anything with a
    slash or a dot, so a crafted `/s/../../etc` can never escape the store."""
    return bool(token and _TOKEN_RE.match(token))


def _path(token: str) -> Path | None:
    if not valid_token(token):
        return None
    return SHARES_DIR / f"{token}.json"


def _owner_tag(owner_uid: str) -> str:
    """A short, non-reversible tag for the owner, prefixed onto every token.

    It routes nothing and reveals nothing (a Firebase uid is not secret), but it
    BINDS a token to the account that minted it. The durable share store is a
    single global directory keyed by token, and shares are rehydrated from each
    owner's own cloud space; without this tag, a signed-in user could write
    users/<them>/shares/<someone-else's-token> and, on their next pull, overwrite
    that global file — hijacking a link they were merely sent. Refusing to
    rehydrate a token that does not carry the pulling user's tag closes that. """
    return hashlib.sha256((owner_uid or "").encode("utf-8")).hexdigest()[:8]


def new_token(owner_uid: str) -> str:
    return _owner_tag(owner_uid) + secrets.token_urlsafe(9)


def owner_owns_token(owner_uid: str, token: str) -> bool:
    return bool(token) and token.startswith(_owner_tag(owner_uid))


# ---------------------------------------------------------------------------
# The store: one JSON file per share, plus a per-owner index for listing.
# ---------------------------------------------------------------------------
def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write(path: Path, record: dict) -> None:
    _dirs()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _owner_index_path(owner_uid: str) -> Path:
    safe = "".join(ch for ch in (owner_uid or "") if ch.isalnum() or ch in "-_")[:64]
    return OWNERS_DIR / f"{safe or 'local'}.json"


def _owner_index(owner_uid: str) -> dict:
    return _read(_owner_index_path(owner_uid)) or {}


def _save_owner_index(owner_uid: str, index: dict) -> None:
    _write(_owner_index_path(owner_uid), index)


def load(token: str) -> dict | None:
    path = _path(token)
    if not path or not path.exists():
        return None
    return _read(path)


def create(owner_uid: str, owner_name: str, snapshot: dict) -> dict:
    """Make (or refresh) the share for one note, and return its record.

    Re-sharing the same note reuses its existing token and simply refreshes the
    snapshot, so pressing Share twice never scatters half a dozen dead links —
    the one link a student already sent stays valid and now shows the latest
    version of the note.
    """
    with _lock:
        _dirs()
        note_id = str(snapshot.get("note_id") or "")
        index = _owner_index(owner_uid)
        token = ""
        # Reuse the live token for this note, if there is one.
        for tok, meta in index.items():
            if meta.get("note_id") == note_id and not meta.get("revoked"):
                token = tok
                break
        record = None
        if token:
            record = load(token)
        if not record:
            token = new_token(owner_uid)
            record = {"views": 0, "created_at": _now()}
        record.update({
            "token": token,
            "owner_uid": owner_uid,
            "owner_name": (owner_name or "").strip()[:80],
            "snapshot": snapshot,
            "revoked": False,
            "updated_at": _now(),
        })
        path = _path(token)
        if path:
            _write(path, record)
        index[token] = {
            "note_id": note_id,
            "title": str(snapshot.get("title") or "Untitled")[:200],
            "subject": str(snapshot.get("subject") or "")[:80],
            "created_at": record["created_at"],
            "revoked": False,
        }
        _save_owner_index(owner_uid, index)
        return record


def list_for_owner(owner_uid: str) -> list[dict]:
    """The owner's shares, newest first, each with its live view count."""
    index = _owner_index(owner_uid)
    out = []
    for token, meta in index.items():
        record = load(token)
        if not record:
            continue
        out.append({
            "token": token,
            "title": meta.get("title") or "Untitled",
            "subject": meta.get("subject") or "",
            "note_id": meta.get("note_id") or "",
            "created_at": record.get("created_at") or meta.get("created_at") or "",
            "views": int(record.get("views") or 0),
            "revoked": bool(record.get("revoked")),
        })
    out.sort(key=lambda s: s.get("created_at") or "", reverse=True)
    return out


def revoke(token: str, owner_uid: str) -> bool:
    """Stop sharing. Only the owner can, and it is one-way: the link goes dead
    at once, on every device, because there is only ever the one server copy."""
    with _lock:
        record = load(token)
        if not record or record.get("owner_uid") != owner_uid:
            return False
        record["revoked"] = True
        record["updated_at"] = _now()
        path = _path(token)
        if path:
            _write(path, record)
        index = _owner_index(owner_uid)
        if token in index:
            index[token]["revoked"] = True
            _save_owner_index(owner_uid, index)
        return True


def bump_views(token: str) -> None:
    """One more open. Best-effort — a lost increment never matters."""
    with _lock:
        record = load(token)
        if not record or record.get("revoked"):
            return
        record["views"] = int(record.get("views") or 0) + 1
        path = _path(token)
        if path:
            _write(path, record)


def public_view(record: dict) -> dict:
    """The safe subset handed to a viewer: the note itself and who shared it —
    never the owner's uid, never anything about their account."""
    snap = record.get("snapshot") or {}
    return {
        "token": record.get("token", ""),
        "title": snap.get("title") or "Untitled",
        "subject": snap.get("subject") or "",
        "topic": snap.get("topic") or "",
        "summary": snap.get("summary") or "",
        "blocks": snap.get("blocks") or [],
        "body": snap.get("body") or "",
        "owner_name": record.get("owner_name") or "",
        "created_at": record.get("created_at") or "",
        "views": int(record.get("views") or 0),
    }


# ---------------------------------------------------------------------------
# Cloud mirror — so a share is as durable as the notes it comes from.
# Stored under the OWNER's own space (Firestore rules lock it to their uid); the
# snapshot travels as one JSON string, which sidesteps Firestore's limits on
# nested arrays and its rules about field names in a diagram spec.
# ---------------------------------------------------------------------------
def to_cloud_row(record: dict) -> dict:
    return {
        "token": record.get("token", ""),
        "owner_name": record.get("owner_name", ""),
        "snapshot_json": json.dumps(record.get("snapshot") or {}, ensure_ascii=False),
        "views": int(record.get("views") or 0),
        "revoked": bool(record.get("revoked")),
        "created_at": record.get("created_at", ""),
        "updated_at": record.get("updated_at", ""),
    }


def restore_from_cloud(owner_uid: str, row: dict) -> None:
    """Re-materialise one share pulled from the cloud onto local disk."""
    token = str(row.get("token") or row.get("id") or "")
    if not valid_token(token):
        return
    # A rehydrate may only ever re-create a token this very account minted. This
    # is the check that stops one user's cloud space from claiming another's
    # global share file — see _owner_tag.
    if not owner_owns_token(owner_uid, token):
        return
    try:
        snapshot = json.loads(row.get("snapshot_json") or "{}")
    except ValueError:
        snapshot = {}
    with _lock:
        record = {
            "token": token,
            "owner_uid": owner_uid,
            "owner_name": row.get("owner_name", ""),
            "snapshot": snapshot,
            "views": int(row.get("views") or 0),
            "revoked": bool(row.get("revoked")),
            "created_at": row.get("created_at", "") or _now(),
            "updated_at": row.get("updated_at", "") or _now(),
        }
        existing = load(token)
        if existing:
            # A killed link stays killed, and a view counted since the backup is
            # not lost.
            if existing.get("revoked"):
                record["revoked"] = True
            record["views"] = max(record["views"], int(existing.get("views") or 0))
            # A locally-newer copy wins outright — the owner may have re-shared
            # (refreshing the snapshot) while the mirror of that was still in
            # flight, and a stale cloud row must not roll it back.
            if (existing.get("updated_at") or "") > (record["updated_at"] or ""):
                record["snapshot"] = existing.get("snapshot") or record["snapshot"]
                record["owner_name"] = existing.get("owner_name") or record["owner_name"]
                record["updated_at"] = existing.get("updated_at") or record["updated_at"]
        path = _path(token)
        if path:
            _write(path, record)
        index = _owner_index(owner_uid)
        index[token] = {
            "note_id": str(snapshot.get("note_id") or ""),
            "title": str(snapshot.get("title") or "Untitled")[:200],
            "subject": str(snapshot.get("subject") or "")[:80],
            "created_at": record["created_at"],
            "revoked": record["revoked"],
        }
        _save_owner_index(owner_uid, index)


# ===========================================================================
# Rendering. One note, three ways out: a web page, a Word file, Markdown.
# A single item parser feeds all three so they never drift apart.
# ===========================================================================

# --- text hygiene ----------------------------------------------------------
# XML 1.0 forbids the C0 control characters outright (tab, LF and CR excepted) —
# they are illegal even as numeric escapes. PDF text extraction routinely leaves
# a form-feed (0x0C) between pages, and that text can become a note's body, so
# this is a real input, not a hypothetical: one stray control byte would make
# word/document.xml not-well-formed and Word would call the whole .docx corrupt.
# Strip them centrally, once, in front of both the XML and the HTML escapers.
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _no_ctrl(s) -> str:
    return _CTRL.sub("", str(s if s is not None else ""))


def _esc(s) -> str:
    """HTML-escape, control-characters removed first."""
    return _html.escape(_no_ctrl(s))


# --- inline markdown, the little of it a note uses -------------------------
def _strip_math(text) -> str:
    """Make LaTeX readable outside the app. The web page and the Word file have
    no maths typesetter, so drop the delimiters and keep the symbols; a formula
    reads as plain text rather than a row of dollar signs. Coerces its input, so
    a null or numeric formula field can never raise here."""
    text = _no_ctrl(text)
    text = re.sub(r"\\[()\[\]]", "", text)
    return text.replace("$", "")


_INLINE = re.compile(r"(\*\*.+?\*\*)|(`.+?`)|(\*.+?\*)")


def _inline_runs(text: str) -> list[tuple[str, bool, bool, bool]]:
    """(text, bold, italic, code) runs. Deliberately small: **bold**, *italic*
    and `code`, which is the whole inline vocabulary the note writer emits."""
    text = _strip_math(str(text or ""))
    runs: list[tuple[str, bool, bool, bool]] = []
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            runs.append((text[pos:m.start()], False, False, False))
        tok = m.group(0)
        if tok.startswith("**"):
            runs.append((tok[2:-2], True, False, False))
        elif tok.startswith("`"):
            runs.append((tok[1:-1], False, False, True))
        else:
            runs.append((tok[1:-1], False, True, False))
        pos = m.end()
    if pos < len(text):
        runs.append((text[pos:], False, False, False))
    return runs or [("", False, False, False)]


def _inline_html(text: str) -> str:
    """Inline markdown to safe HTML. Every run's text is escaped BEFORE our own
    tags go on, so a note that contains `<script>` becomes visible text, never
    live markup — the one real injection surface on the public page."""
    out = []
    for t, b, i, code in _inline_runs(text):
        esc = _esc(t)
        if code:
            out.append(f"<code>{esc}</code>")
        elif b:
            out.append(f"<strong>{esc}</strong>")
        elif i:
            out.append(f"<em>{esc}</em>")
        else:
            out.append(esc)
    return "".join(out)


def _inline_plain(text: str) -> str:
    """Just the words, markers removed — for Markdown-ish contexts and titles."""
    return "".join(t for t, _, _, _ in _inline_runs(text))


# --- the item parser (a small echo of the app's BlockRenderer) -------------
_CALLOUT_LABELS = {
    "tip": "Tip", "warning": "Watch out", "example": "Example",
    "quote": "In the teacher's words", "info": "Note", "note": "Note",
    "todo": "To do",
}


def _parse_items(items) -> list[dict]:
    """A flat list of strings (each of which may hold several lines) becomes a
    list of pieces: headings, tasks, bullet/number items with a depth, and
    callouts. The same shapes the on-screen renderer understands."""
    pieces: list[dict] = []
    call: dict | None = None

    def close_call():
        nonlocal call
        if call is not None:
            pieces.append(call)
            call = None

    for raw in items or []:
        for line in str(raw or "").split("\n"):
            if not line.strip():
                continue
            lead = re.match(r"^[ \t]*", line).group(0).replace("\t", "  ")
            s = re.sub(r"^[-*\u2022]\s+(?=>)", "", line.strip())

            opener = re.match(r"^>\s*\[!(\w+)\]\s*(.*)$", s)
            if opener:
                close_call()
                call = {"k": "callout", "kind": opener.group(1).lower(),
                        "title": opener.group(2).strip(), "lines": []}
                continue

            cont = re.match(r"^>\s?(.*)$", s)
            if cont:
                if call is not None:
                    if cont.group(1).strip():
                        call["lines"].append(cont.group(1).strip())
                    continue
                call = {"k": "callout", "kind": "quote", "title": "",
                        "lines": [cont.group(1).strip()]}
                close_call()
                continue

            if call is not None and len(lead) >= 2 and not re.match(r"^[-*\u2022\d#]", s):
                call["lines"].append(s)
                continue
            close_call()

            heading = re.match(r"^#{1,4}\s+(.*)$", s)
            if heading:
                pieces.append({"k": "heading", "text": heading.group(1)})
                continue

            task = re.match(r"^[-*]\s+\[([ xX])\]\s+(.*)$", s)
            if task:
                pieces.append({"k": "task", "done": task.group(1) != " ",
                               "text": task.group(2)})
                continue

            numbered = re.match(r"^\d+[.)]\s+(.*)$", s)
            bulleted = re.match(r"^[-*\u2022]\s+(.*)$", s)
            text = numbered.group(1) if numbered else (
                bulleted.group(1) if bulleted else s)
            pieces.append({"k": "item", "ordered": bool(numbered),
                           "depth": min(3, len(lead) // 2), "text": text})
    close_call()
    return pieces


# --- HTML ------------------------------------------------------------------
_CALLOUT_HTML_COLOUR = {
    "tip": "#2e9e6b", "warning": "#d9822b", "example": "#3b6fb0",
    "info": "#3b6fb0", "note": "#3b6fb0", "todo": "#3b6fb0",
    "quote": "#9aa0aa",
}


def _items_html(items) -> str:
    pieces = _parse_items(items)
    out: list[str] = []
    i = 0
    while i < len(pieces):
        p = pieces[i]
        if p["k"] == "item":
            ordered = p["ordered"]
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>")
            while i < len(pieces) and pieces[i]["k"] == "item" and pieces[i]["ordered"] == ordered:
                pad = pieces[i]["depth"] * 18
                out.append(f'<li style="margin-left:{pad}px">'
                           f'{_inline_html(pieces[i]["text"])}</li>')
                i += 1
            out.append(f"</{tag}>")
            continue
        if p["k"] == "heading":
            out.append(f'<h4>{_inline_html(p["text"])}</h4>')
        elif p["k"] == "task":
            box = "\u2611" if p["done"] else "\u2610"
            out.append(f'<p class="task">{box} {_inline_html(p["text"])}</p>')
        elif p["k"] == "callout":
            colour = _CALLOUT_HTML_COLOUR.get(p["kind"], "#3b6fb0")
            label = _esc(p["title"] or _CALLOUT_LABELS.get(p["kind"], "Note"))
            body = "".join(f"<p>{_inline_html(l)}</p>" for l in p["lines"])
            out.append(f'<div class="callout" style="border-color:{colour}">'
                       f'<div class="callout-label">{label}</div>{body}</div>')
        i += 1
    return "".join(out)


def _blocks_html(view: dict) -> str:
    out: list[str] = []
    for b in view.get("blocks") or []:
        if not isinstance(b, dict):
            continue
        kind = b.get("type")
        if kind == "summary":
            out.append(f'<div class="card"><div class="label">In one line</div>'
                       f'<p class="summary">{_inline_html(b.get("text", ""))}</p></div>')
        elif kind == "points":
            head = _esc(b.get("heading") or "Key points")
            out.append(f'<div class="card"><div class="label">{head}</div>'
                       f'{_items_html(b.get("items"))}</div>')
        elif kind == "definitions":
            rows = ""
            for d in b.get("items") or []:
                if not isinstance(d, dict):
                    continue
                rows += (f'<div class="def"><dt>{_inline_html(d.get("term", ""))}</dt>'
                         f'<dd>{_inline_html(d.get("meaning", ""))}</dd></div>')
            out.append(f'<div class="card"><div class="label">Definitions</div>'
                       f'<dl>{rows}</dl></div>')
        elif kind == "formula":
            extra = ""
            if b.get("means"):
                extra += f'<p class="means">{_inline_html(b.get("means"))}</p>'
            if b.get("when"):
                extra += (f'<p class="when"><span>Use it when</span> '
                          f'{_inline_html(b.get("when"))}</p>')
            out.append(f'<div class="card"><div class="label">Formula</div>'
                       f'<p class="formula">{_esc(_strip_math(b.get("formula", "")))}</p>'
                       f'{extra}</div>')
        elif kind == "example":
            title = (f'<p class="ex-title">{_inline_html(b.get("title"))}</p>'
                     if b.get("title") else "")
            steps = "".join(f"<li>{_inline_html(s)}</li>" for s in b.get("steps") or [])
            out.append(f'<div class="card"><div class="label">Worked example</div>'
                       f'{title}<ol>{steps}</ol></div>')
        elif kind in ("assessed", "gaps"):
            label = "Comes up in assessment" if kind == "assessed" else "Ask about next lesson"
            out.append(f'<div class="card"><div class="label">{label}</div>'
                       f'{_items_html(b.get("items"))}</div>')
        elif kind == "diagram":
            title = _esc((b.get("spec") or {}).get("title") or "Diagram")
            out.append(f'<div class="card diagram"><div class="label">{title}</div>'
                       f'<p class="muted">A diagram is here — open it in Minerva to see it drawn.</p></div>')
    if not out and view.get("body"):
        out.append(f'<div class="card"><p class="summary">'
                   f'{_inline_html(view.get("body"))}</p></div>')
    return "".join(out)


def landing_html(record: dict) -> str:
    """The page a visitor without the app sees: the note, and two ways forward —
    open it in Minerva, or take it away as a Word file."""
    view = public_view(record)
    token = view["token"]
    title = _esc(view["title"])
    owner = _esc(view["owner_name"] or "a Minerva student")
    subject = _esc(view["subject"])
    topic = _esc(view["topic"])
    chips = ""
    if subject:
        chips += f'<span class="chip">{subject}</span>'
    if topic:
        chips += f'<span class="chip subtle">{topic}</span>'
    body = _blocks_html(view)
    return _PAGE.replace("{{TITLE}}", title).replace("{{OWNER}}", owner) \
        .replace("{{CHIPS}}", chips).replace("{{BODY}}", body) \
        .replace("{{TOKEN}}", _esc(token))


def not_found_html() -> str:
    return _NOT_FOUND


def open_js() -> str:
    """Served at /share-open.js so it runs under the strict CSP (no inline
    script). It is the whole "one link, two destinations" trick: a browser that
    has signed in to Minerva before carries a flag, and this forwards it into the
    app; a browser that has not stays on the web page it is already showing."""
    return (
        "(function(){try{"
        "var s=document.currentScript;var t=s&&s.getAttribute('data-token');"
        "if(t&&localStorage.getItem('minerva.seen')==='1'){"
        "location.replace('/#/shared/'+encodeURIComponent(t));}"
        "}catch(e){}})();"
    )


# --- Markdown --------------------------------------------------------------
def _items_md(items, indent="") -> str:
    lines = []
    for p in _parse_items(items):
        if p["k"] == "heading":
            lines.append(f"\n**{_inline_plain(p['text'])}**")
        elif p["k"] == "task":
            box = "[x]" if p["done"] else "[ ]"
            lines.append(f"- {box} {_inline_plain(p['text'])}")
        elif p["k"] == "callout":
            label = p["title"] or _CALLOUT_LABELS.get(p["kind"], "Note")
            lines.append(f"> **{label}**")
            for l in p["lines"]:
                lines.append(f"> {_inline_plain(l)}")
        else:
            pad = "  " * p["depth"]
            marker = "1." if p["ordered"] else "-"
            lines.append(f"{pad}{marker} {_inline_plain(p['text'])}")
    return "\n".join(lines)


def markdown_text(record: dict) -> str:
    view = public_view(record)
    out = [f"# {_inline_plain(view['title'])}", ""]
    meta = " · ".join(x for x in (view["subject"], view["topic"]) if x)
    if meta:
        out.append(f"_{meta}_")
    if view["owner_name"]:
        out.append(f"Shared by {view['owner_name']} via Minerva")
    out.append("")
    for b in view.get("blocks") or []:
        if not isinstance(b, dict):
            continue
        kind = b.get("type")
        if kind == "summary":
            out += [f"> {_inline_plain(b.get('text',''))}", ""]
        elif kind == "points":
            out += [f"## {b.get('heading') or 'Key points'}", _items_md(b.get("items")), ""]
        elif kind == "definitions":
            out.append("## Definitions")
            for d in b.get("items") or []:
                if not isinstance(d, dict):
                    continue
                out.append(f"- **{_inline_plain(d.get('term',''))}** — "
                           f"{_inline_plain(d.get('meaning',''))}")
            out.append("")
        elif kind == "formula":
            out += ["## Formula", "```", _strip_math(b.get("formula", "")), "```"]
            if b.get("means"):
                out.append(_inline_plain(b.get("means")))
            out.append("")
        elif kind == "example":
            out.append("## Worked example")
            if b.get("title"):
                out.append(_inline_plain(b.get("title")))
            for i, s in enumerate(b.get("steps") or [], 1):
                out.append(f"{i}. {_inline_plain(s)}")
            out.append("")
        elif kind in ("assessed", "gaps"):
            out += [f"## {'Comes up in assessment' if kind=='assessed' else 'Ask about next lesson'}",
                    _items_md(b.get("items")), ""]
        elif kind == "diagram":
            out += [f"## {(b.get('spec') or {}).get('title') or 'Diagram'}",
                    "_(a diagram — open in Minerva to see it drawn)_", ""]
    out += ["", "— shared from Minerva"]
    return "\n".join(out)


# ===========================================================================
# .docx — a Word file, written by hand as a ZIP of XML parts.
# ===========================================================================
def _xml(text: str) -> str:
    text = _no_ctrl(text)
    return (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _runs_xml(text: str, *, size=22, bold=False, colour="", italic=False) -> str:
    """The <w:r> runs for one string, honouring its inline **bold**/*italic*/
    `code` on top of the paragraph's own defaults."""
    out = []
    for t, b, i, code in _inline_runs(text):
        if t == "":
            continue
        props = []
        if bold or b:
            props.append("<w:b/>")
        if italic or i:
            props.append("<w:i/>")
        if code:
            props.append('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
        props.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
        if colour:
            props.append(f'<w:color w:val="{colour}"/>')
        out.append(f'<w:r><w:rPr>{"".join(props)}</w:rPr>'
                   f'<w:t xml:space="preserve">{_xml(t)}</w:t></w:r>')
    return "".join(out) or '<w:r><w:t xml:space="preserve"></w:t></w:r>'


def _para(text="", *, size=22, bold=False, colour="", italic=False,
          before=0, after=120, indent=0, align="", bullet="", border="") -> str:
    """One paragraph. Bullets and numbers are drawn as literal prefixes with a
    hanging indent rather than a real numbering part — visually identical and it
    keeps the file to four parts instead of seven."""
    p = ["<w:pPr>"]
    spacing = f'<w:spacing w:before="{before}" w:after="{after}"/>'
    p.append(spacing)
    if indent:
        p.append(f'<w:ind w:left="{indent}"/>')
    if align:
        p.append(f'<w:jc w:val="{align}"/>')
    if border:
        p.append('<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" '
                 f'w:color="{border}"/></w:pBdr>')
    p.append("</w:pPr>")
    prefix = f"{bullet} " if bullet else ""
    runs = ""
    if prefix:
        runs += _runs_xml(prefix, size=size, bold=bold, colour=colour)
    runs += _runs_xml(text, size=size, bold=bold, colour=colour, italic=italic)
    return f"<w:p>{''.join(p)}{runs}</w:p>"


_CALLOUT_DOCX_COLOUR = {
    "tip": "2E9E6B", "warning": "D9822B", "example": "3B6FB0",
    "info": "3B6FB0", "note": "3B6FB0", "todo": "3B6FB0", "quote": "9AA0AA",
}


def _items_docx(items) -> list[str]:
    out = []
    for p in _parse_items(items):
        if p["k"] == "heading":
            out.append(_para(p["text"], size=24, bold=True, before=120, after=60))
        elif p["k"] == "task":
            box = "\u2611" if p["done"] else "\u2610"
            out.append(_para(p["text"], indent=360, bullet=box, after=60))
        elif p["k"] == "callout":
            colour = _CALLOUT_DOCX_COLOUR.get(p["kind"], "3B6FB0")
            label = p["title"] or _CALLOUT_LABELS.get(p["kind"], "Note")
            out.append(_para(label, size=19, bold=True, colour=colour,
                             indent=240, border=colour, before=100, after=20))
            for l in p["lines"]:
                out.append(_para(l, size=21, colour="444444", indent=240,
                                 border=colour, after=20))
        else:
            marker = "\u2022" if not p["ordered"] else "\u2013"
            out.append(_para(p["text"], indent=360 + p["depth"] * 360,
                             bullet=marker, after=60))
    return out


def _blocks_docx(view: dict) -> list[str]:
    out = []
    for b in view.get("blocks") or []:
        if not isinstance(b, dict):
            continue
        kind = b.get("type")
        if kind == "summary":
            out.append(_para("In one line", size=17, bold=True, colour="7A7F87",
                             before=160, after=20))
            out.append(_para(b.get("text", ""), size=24, italic=True,
                             indent=240, border="C9CCD2", after=120))
        elif kind == "points":
            out.append(_para(b.get("heading") or "Key points", size=26, bold=True,
                             before=200, after=60))
            out += _items_docx(b.get("items"))
        elif kind == "definitions":
            out.append(_para("Definitions", size=26, bold=True, before=200, after=60))
            for d in b.get("items") or []:
                if not isinstance(d, dict):
                    continue
                out.append(_para(d.get("term", ""), size=22, bold=True, after=0))
                out.append(_para(d.get("meaning", ""), size=22, colour="444444",
                                 indent=240, after=100))
        elif kind == "formula":
            out.append(_para("Formula", size=26, bold=True, before=200, after=60))
            fx = _strip_math(b.get("formula", ""))
            out.append(f'<w:p><w:pPr><w:spacing w:after="60"/></w:pPr>'
                       f'<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'
                       f'<w:sz w:val="26"/></w:rPr>'
                       f'<w:t xml:space="preserve">{_xml(fx)}</w:t></w:r></w:p>')
            if b.get("means"):
                out.append(_para(b.get("means"), size=21, colour="444444", after=40))
            if b.get("when"):
                out.append(_para("Use it when " + str(b.get("when")), size=20,
                                 colour="7A7F87", after=120))
        elif kind == "example":
            out.append(_para("Worked example", size=26, bold=True, before=200, after=60))
            if b.get("title"):
                out.append(_para(b.get("title"), size=22, bold=True, after=40))
            for i, s in enumerate(b.get("steps") or [], 1):
                out.append(_para(s, indent=360, bullet=f"{i}.", after=60))
        elif kind in ("assessed", "gaps"):
            label = "Comes up in assessment" if kind == "assessed" else "Ask about next lesson"
            out.append(_para(label, size=26, bold=True, colour="B26A1B" if kind == "assessed" else "3B6FB0",
                             before=200, after=60))
            out += _items_docx(b.get("items"))
        elif kind == "diagram":
            title = (b.get("spec") or {}).get("title") or "Diagram"
            out.append(_para(title, size=26, bold=True, before=200, after=20))
            out.append(_para("A diagram is here — open the note in Minerva to see it drawn.",
                             size=20, italic=True, colour="7A7F87", after=120))
    if not out and view.get("body"):
        out.append(_para(view.get("body"), size=22, after=120))
    return out


def docx_bytes(record: dict) -> bytes:
    view = public_view(record)
    parts = []
    # Masthead.
    parts.append(_para(view["title"], size=44, bold=True, after=40))
    meta = " · ".join(x for x in (view["subject"], view["topic"]) if x)
    sub = meta or ""
    if view["owner_name"]:
        sub = (sub + "   ·   " if sub else "") + f"Shared by {view['owner_name']} via Minerva"
    if sub:
        parts.append(_para(sub, size=20, colour="7A7F87", after=200))
    parts += _blocks_docx(view)
    parts.append(_para("— shared from Minerva", size=18, colour="9AA0AA",
                       before=240, after=0, align="center"))

    body = "".join(parts)
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body>{body}'
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
        'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
        '</w:body></w:document>'
    )

    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ")
    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties '
        'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f'<dc:title>{_xml(view["title"])}</dc:title>'
        f'<dc:creator>{_xml(view["owner_name"] or "Minerva")}</dc:creator>'
        f'<cp:lastModifiedBy>Minerva</cp:lastModifiedBy>'
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>'
        '</cp:coreProperties>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/docProps/core.xml" '
        'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
        'Target="docProps/core.xml"/>'
        '</Relationships>'
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
        z.writestr("docProps/core.xml", core)
    return buf.getvalue()


def docx_filename(record: dict) -> str:
    """A safe download name from the note's title. No slashes, no quotes, no
    line breaks, so it cannot break the Content-Disposition header."""
    title = (record.get("snapshot") or {}).get("title") or "note"
    safe = re.sub(r"[^A-Za-z0-9 _.-]+", "", str(title)).strip() or "note"
    return safe[:60] + ".docx"


# ---------------------------------------------------------------------------
# Page templates. Inline CSS, theme-aware, self-contained. The only script is
# the external /share-open.js, so the strict Content-Security-Policy holds.
# ---------------------------------------------------------------------------
_STYLE = """
:root{--bg:#f7f7f5;--card:#fff;--ink:#1a1c1e;--dim:#6b7078;--line:#e6e7ea;
--brand:#6d5ef0;--brand-ink:#fff;--soft:#efedfb;}
@media (prefers-color-scheme:dark){:root{--bg:#131417;--card:#1c1e22;--ink:#e9eaec;
--dim:#9aa0aa;--line:#2a2d33;--brand:#8b7ef5;--soft:#23202f;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 80px}
.top{display:flex;align-items:center;gap:10px;margin-bottom:26px}
.logo{width:26px;height:26px}
.brandname{font-weight:700;font-size:16px;letter-spacing:-.01em}
.shared-by{font-size:13px;color:var(--dim);margin-left:auto}
h1{font-size:29px;line-height:1.2;letter-spacing:-.02em;margin:0 0 10px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
.chip{background:var(--soft);color:var(--brand);font-size:12px;font-weight:600;
padding:4px 10px;border-radius:999px}
.chip.subtle{background:transparent;border:1px solid var(--line);color:var(--dim)}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 30px;
position:sticky;top:0;background:var(--bg);padding:12px 0;z-index:5}
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:11px;
font-size:14px;font-weight:600;text-decoration:none;border:1px solid var(--line);
color:var(--ink);background:var(--card);transition:transform .05s ease}
.btn:active{transform:translateY(1px)}
.btn.primary{background:var(--brand);color:var(--brand-ink);border-color:var(--brand)}
.btn.ghost{background:transparent}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
padding:16px 18px;margin:0 0 14px}
.label{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
color:var(--dim);margin-bottom:10px}
.summary{font-size:18px;line-height:1.6;margin:0;padding-left:14px;
border-left:2px solid var(--line);color:var(--ink)}
.card p{margin:.4em 0}
.card ul,.card ol{margin:.3em 0;padding-left:22px}
.card li{margin:.28em 0}
.card h4{font-size:14px;margin:.7em 0 .3em}
.def{display:grid;grid-template-columns:180px 1fr;gap:14px;padding:9px 0;
border-top:1px solid var(--line)}
.def:first-child{border-top:0}
.def dt{font-weight:600;font-size:14px;margin:0}
.def dd{margin:0;color:var(--dim);font-size:15px}
.formula{font-family:Consolas,ui-monospace,monospace;font-size:19px;margin:0}
.means{color:var(--dim);font-size:15px}
.when{font-size:13px;color:var(--dim)}.when span{text-transform:uppercase;
font-size:11px;font-weight:700;letter-spacing:.05em}
.callout{border-left:3px solid var(--brand);padding:2px 0 2px 14px;margin:12px 0}
.callout-label{font-size:11px;font-weight:700;text-transform:uppercase;
letter-spacing:.06em;color:var(--dim);margin-bottom:4px}
.task{margin:.3em 0}
.muted{color:var(--dim);font-size:14px;font-style:italic}
code{font-family:Consolas,ui-monospace,monospace;font-size:.9em;
background:var(--soft);padding:1px 5px;border-radius:5px}
.foot{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);
color:var(--dim);font-size:13px}
.foot a{color:var(--brand);text-decoration:none;font-weight:600}
@media (max-width:520px){.def{grid-template-columns:1fr;gap:2px}h1{font-size:24px}}
"""

_LOGO_SVG = (
    '<svg class="logo" viewBox="0 0 32 32" fill="none" '
    'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    '<path d="M5 25V8.5L16 19L27 8.5V25" stroke="var(--brand)" stroke-width="2.4" '
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'
)

_PAGE = (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    "<title>{{TITLE}} · Minerva</title><style>" + _STYLE + "</style></head><body>"
    "<div class=\"wrap\">"
    "<div class=\"top\">" + _LOGO_SVG + "<span class=\"brandname\">Minerva</span>"
    "<span class=\"shared-by\">Shared by {{OWNER}}</span></div>"
    "<h1>{{TITLE}}</h1><div class=\"chips\">{{CHIPS}}</div>"
    "<div class=\"actions\">"
    "<a class=\"btn primary\" href=\"/#/shared/{{TOKEN}}\">Open in Minerva</a>"
    "<a class=\"btn\" href=\"/s/{{TOKEN}}/word\">Download as Word</a>"
    "<a class=\"btn ghost\" href=\"/s/{{TOKEN}}/markdown\">Get Markdown</a>"
    "</div>"
    "{{BODY}}"
    "<div class=\"foot\">These are study notes shared from "
    "<a href=\"/\">Minerva</a>, a free note-taker for IB students. "
    "Open in Minerva to add them to your own notes.</div>"
    "</div>"
    "<script src=\"/share-open.js\" data-token=\"{{TOKEN}}\"></script>"
    "</body></html>"
)

_NOT_FOUND = (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    "<title>Link not available · Minerva</title><style>" + _STYLE + "</style></head><body>"
    "<div class=\"wrap\"><div class=\"top\">" + _LOGO_SVG +
    "<span class=\"brandname\">Minerva</span></div>"
    "<h1>This shared note isn't available</h1>"
    "<p class=\"muted\">The link may have been turned off by the person who "
    "shared it, or it was mistyped.</p>"
    "<div class=\"actions\"><a class=\"btn primary\" href=\"/\">Go to Minerva</a></div>"
    "</div></body></html>"
)

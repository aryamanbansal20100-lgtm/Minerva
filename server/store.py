"""store.py — SQLite. Everything the app knows lives here.

One file, stdlib only, no ORM. The schema is small on purpose:

    profile        one row: who the student is, curriculum, grade, school
    notebooks      subjects, basically
    notes          a note, its markdown body, and its generated blocks
    recordings     one per transcription session, attached to a note
    chunks         audio slices, transcribed as the lesson runs
    tasks          assignments, from ManageBac or from a lesson
    feed_items     raw ManageBac calendar items, categorised
    reads          what the student has already seen (drives the badge counts)
"""

from __future__ import annotations

import json
import pathlib
import sqlite3
import uuid
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "minerva.db"

# Whose data the current request is touching. Set per request from the verified
# Google account; every read and write is scoped to it, so two students on the
# same machine never see each other's notes.
import threading
_ctx = threading.local()


def set_user(user_id: str) -> None:
    """Point every following query at this account's own database file.

    One file per user rather than an `owner` column on every table: it needs no
    query changes (so no table can be forgotten and leak), a student's whole
    account is one file to back up or delete, and there is no way to write a
    join that accidentally crosses accounts.
    """
    previous = getattr(_ctx, "uid", None)
    _ctx.uid = user_id or "local"
    if previous != _ctx.uid:
        _ctx.ready = False


def uid() -> str:
    return getattr(_ctx, "uid", "local")


def db_path() -> Path:
    who = uid()
    if who == "local":
        return DB_PATH
    safe = "".join(ch for ch in who if ch.isalnum() or ch in "-_")[:64]
    return ROOT / "data" / "users" / f"{safe}.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT DEFAULT '', curriculum TEXT DEFAULT '', grade TEXT DEFAULT '',
    school TEXT DEFAULT '', city TEXT DEFAULT '', country TEXT DEFAULT '',
    timezone TEXT DEFAULT '', subjects TEXT DEFAULT '[]',
    managebac_ics TEXT DEFAULT '', goals TEXT DEFAULT '',
    timetable TEXT DEFAULT '[]',
    groq_key TEXT DEFAULT '',
    tuition_subjects TEXT DEFAULT '[]',
    lock_pin TEXT DEFAULT '',
    onboarded INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, subject TEXT DEFAULT '',
    colour TEXT DEFAULT '', created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, notebook_id TEXT, title TEXT NOT NULL DEFAULT 'Untitled',
    body TEXT NOT NULL DEFAULT '', blocks TEXT NOT NULL DEFAULT '[]',
    transcript TEXT NOT NULL DEFAULT '', subject TEXT DEFAULT '',
    topic TEXT DEFAULT '', starred INTEGER DEFAULT 0,
    continues INTEGER DEFAULT 0, thread TEXT DEFAULT '',
    context TEXT DEFAULT 'school',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL, started TEXT NOT NULL,
    finished TEXT, seconds INTEGER DEFAULT 0, words INTEGER DEFAULT 0,
    state TEXT DEFAULT 'running');

CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, idx INTEGER NOT NULL,
    text TEXT DEFAULT '', condensed TEXT DEFAULT '{}', created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT DEFAULT '',
    subject TEXT DEFAULT '', kind TEXT DEFAULT 'assignment',
    due TEXT, source TEXT DEFAULT 'note', source_ref TEXT DEFAULT '',
    done INTEGER DEFAULT 0, note_id TEXT, url TEXT DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS feed_items (
    uid TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
    subject TEXT DEFAULT '', detail TEXT DEFAULT '', due TEXT,
    starts TEXT, url TEXT DEFAULT '', raw TEXT DEFAULT '',
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, seen INTEGER DEFAULT 0,
    timetabled INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, subject TEXT DEFAULT '', name TEXT NOT NULL,
    mime TEXT DEFAULT '', size INTEGER DEFAULT 0, path TEXT NOT NULL,
    text TEXT DEFAULT '', source TEXT DEFAULT 'upload',
    created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS important_senders (
    key TEXT PRIMARY KEY,          -- an email address, or a bare @domain
    added_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_docs_subject ON documents(subject, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(notebook_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(done, due);
CREATE INDEX IF NOT EXISTS idx_feed_kind ON feed_items(kind, due);
CREATE INDEX IF NOT EXISTS idx_chunks_rec ON chunks(recording_id, idx);
"""

_ready = False


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init() -> None:
    if getattr(_ctx, "ready", False):
        return
    with connect() as c:
        c.executescript(SCHEMA)
        # Tiny forward migration: databases made before `timetabled` existed
        # would otherwise mark every finished lesson "overdue" forever.
        cols = {r["name"] for r in c.execute("PRAGMA table_info(feed_items)")}
        if "timetabled" not in cols:
            c.execute("ALTER TABLE feed_items ADD COLUMN timetabled INTEGER DEFAULT 0")
        pcols = {r["name"] for r in c.execute("PRAGMA table_info(profile)")}
        if "timetable" not in pcols:
            c.execute("ALTER TABLE profile ADD COLUMN timetable TEXT DEFAULT '[]'")
        if "groq_key" not in pcols:
            # A student's own free Groq key, so their recording runs against
            # their own quota instead of a shared one.
            c.execute("ALTER TABLE profile ADD COLUMN groq_key TEXT DEFAULT ''")
        if "tuition_subjects" not in pcols:
            # Subjects the student also attends tuition for -- so tuition notes
            # can live in their own tab, only for those subjects.
            c.execute("ALTER TABLE profile ADD COLUMN tuition_subjects TEXT DEFAULT '[]'")
        if "lock_pin" not in pcols:
            # The account-level app-lock PIN (sha-256 hash). Synced, so the lock
            # follows the student to any device they sign in on.
            c.execute("ALTER TABLE profile ADD COLUMN lock_pin TEXT DEFAULT ''")
        ncols = {r["name"] for r in c.execute("PRAGMA table_info(notes)")}
        if "continues" not in ncols:
            c.execute("ALTER TABLE notes ADD COLUMN continues INTEGER DEFAULT 0")
        if "thread" not in ncols:
            c.execute("ALTER TABLE notes ADD COLUMN thread TEXT DEFAULT ''")
        if "context" not in ncols:
            # A note belongs to school or to tuition, so the two can be kept
            # in separate tabs. Everything existing is school.
            c.execute("ALTER TABLE notes ADD COLUMN context TEXT DEFAULT 'school'")
        tcols = {r["name"] for r in c.execute("PRAGMA table_info(tasks)")}
        if "url" not in tcols:
            c.execute("ALTER TABLE tasks ADD COLUMN url TEXT DEFAULT ''")
        row = c.execute("SELECT id FROM profile WHERE id=1").fetchone()
        if not row:
            c.execute("INSERT INTO profile (id, created_at, updated_at) VALUES (1,?,?)",
                      (now(), now()))
    _ctx.ready = True


def rid() -> str:
    return uuid.uuid4().hex[:12]


# ---------------------------------------------------------------- profile
def get_profile() -> dict:
    init()
    with connect() as c:
        row = c.execute("SELECT * FROM profile WHERE id=1").fetchone()
    p = dict(row)
    p["subjects"] = json.loads(p["subjects"] or "[]")
    try:
        p["timetable"] = json.loads(p.get("timetable") or "[]")
    except ValueError:
        p["timetable"] = []
    try:
        p["tuition_subjects"] = json.loads(p.get("tuition_subjects") or "[]")
    except ValueError:
        p["tuition_subjects"] = []
    p["onboarded"] = bool(p["onboarded"])
    # The student's own Groq key never leaves this machine. The browser is told
    # only whether one is set and its last four characters, enough to recognise
    # which key it is without being able to use it. Same rule the server key has
    # always followed -- a secret that reaches the browser is a public secret.
    raw = (p.pop("groq_key", "") or "").strip()
    p["groq_key_set"] = bool(raw)
    p["groq_key_hint"] = ("…" + raw[-4:]) if len(raw) > 4 else ""
    # The PIN hash never reaches the browser -- only whether one exists, so the
    # UI knows the account has a lock. The check is done server-side.
    lock = (p.pop("lock_pin", "") or "").strip()
    p["lock_set"] = bool(lock)
    return p


def _hash_pin(pin: str) -> str:
    import hashlib
    # Salted with the account id so the same PIN on two accounts differs, and a
    # stolen hash cannot be matched against a rainbow table of 4-digit codes.
    salt = uid()
    return hashlib.sha256((salt + ":" + (pin or "").strip()).encode()).hexdigest()


def set_lock_pin(pin: str) -> None:
    """Store the account app-lock PIN as a salted hash."""
    init()
    with connect() as c:
        c.execute("UPDATE profile SET lock_pin=?, updated_at=? WHERE id=1",
                  (_hash_pin(pin), now()))


def clear_lock() -> None:
    init()
    with connect() as c:
        c.execute("UPDATE profile SET lock_pin='', updated_at=? WHERE id=1", (now(),))


def get_profile_raw_lock() -> str:
    """The raw stored PIN hash, for the sync layer to mirror. Not for the browser."""
    init()
    with connect() as c:
        row = c.execute("SELECT lock_pin FROM profile WHERE id=1").fetchone()
    return (dict(row).get("lock_pin") if row else "") or ""


def lock_required() -> bool:
    init()
    with connect() as c:
        row = c.execute("SELECT lock_pin FROM profile WHERE id=1").fetchone()
    return bool(row and (dict(row).get("lock_pin") or "").strip())


def check_lock_pin(pin: str) -> bool:
    init()
    with connect() as c:
        row = c.execute("SELECT lock_pin FROM profile WHERE id=1").fetchone()
    stored = (dict(row).get("lock_pin") if row else "") or ""
    return bool(stored) and _hash_pin(pin) == stored


def groq_key() -> str:
    """This student's own Groq key, if they have added one.

    Read straight from their row rather than through get_profile, which strips
    it on purpose. Empty string when unset, so callers fall back to the shared
    server key.
    """
    init()
    with connect() as c:
        row = c.execute("SELECT groq_key FROM profile WHERE id=1").fetchone()
    return ((dict(row).get("groq_key") if row else "") or "").strip()


def save_profile(patch: dict) -> dict:
    init()
    allowed = ("name", "curriculum", "grade", "school", "city", "country",
               "timezone", "subjects", "managebac_ics", "goals", "onboarded",
               "timetable", "groq_key", "tuition_subjects", "lock_pin")
    fields, values = [], []
    for k in allowed:
        if k not in patch:
            continue
        v = patch[k]
        if k in ("subjects", "timetable", "tuition_subjects"):
            v = json.dumps(v if isinstance(v, list) else [])
        if k == "onboarded":
            v = int(bool(v))
        fields.append(f"{k}=?")
        values.append(v)
    if fields:
        values.append(now())
        with connect() as c:
            c.execute(f"UPDATE profile SET {', '.join(fields)}, updated_at=? WHERE id=1",
                      values)
    return get_profile()


# ---------------------------------------------------------------- notebooks
def notebooks() -> list[dict]:
    init()
    with connect() as c:
        books = [dict(r) for r in c.execute(
            "SELECT * FROM notebooks ORDER BY title")]
        counts = {r["notebook_id"]: r["n"] for r in c.execute(
            "SELECT notebook_id, COUNT(*) n FROM notes GROUP BY notebook_id")}
    for b in books:
        b["notes"] = counts.get(b["id"], 0)
    return books


def create_notebook(title: str, subject: str = "", colour: str = "") -> dict:
    """One notebook per title. Calling this twice with the same subject returns
    the existing one rather than making a duplicate — setup runs more than once
    and a second 'Physics HL' notebook helps nobody."""
    init()
    name = title.strip() or "Untitled"
    with connect() as c:
        row = c.execute("SELECT * FROM notebooks WHERE lower(title)=lower(?)",
                        (name,)).fetchone()
    if row:
        return dict(row) | {"notes": 0}
    nb = {"id": rid(), "title": name,
          "subject": subject, "colour": colour, "created_at": now()}
    with connect() as c:
        c.execute("INSERT INTO notebooks VALUES (:id,:title,:subject,:colour,:created_at)", nb)
    nb["notes"] = 0
    return nb


def ensure_notebook(subject: str) -> str:
    """One notebook per subject, made on demand."""
    init()
    subject = (subject or "General").strip()
    with connect() as c:
        row = c.execute("SELECT id FROM notebooks WHERE lower(title)=lower(?)",
                        (subject,)).fetchone()
    return row["id"] if row else create_notebook(subject, subject)["id"]


# ---------------------------------------------------------------- notes
def notes(notebook_id: str = "", limit: int = 200, context: str = "") -> list[dict]:
    init()
    sql = "SELECT id,notebook_id,title,subject,topic,starred,context," \
          "created_at,updated_at," \
          "substr(body,1,240) AS preview, length(body) AS size FROM notes"
    where, args = [], []
    if notebook_id:
        where.append("notebook_id=?")
        args.append(notebook_id)
    if context:
        # An older note has NULL context; treat that as 'school' so the filter
        # for school notes still finds everything that predates the column.
        if context == "school":
            where.append("(context='school' OR context IS NULL)")
        else:
            where.append("context=?")
            args.append(context)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY updated_at DESC LIMIT ?"
    with connect() as c:
        return [dict(r) for r in c.execute(sql, tuple(args) + (limit,))]


def get_note(note_id: str) -> dict | None:
    init()
    with connect() as c:
        row = c.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if not row:
        return None
    n = dict(row)
    n["blocks"] = json.loads(n["blocks"] or "[]")
    n["starred"] = bool(n["starred"])
    n["continues"] = bool(n.get("continues"))
    return n


def create_note(title: str = "Untitled", notebook_id: str = "",
                subject: str = "", topic: str = "", body: str = "",
                context: str = "school") -> dict:
    init()
    stamp = now()
    note = {"id": rid(), "notebook_id": notebook_id or ensure_notebook(subject),
            "title": title or "Untitled", "body": body, "blocks": "[]",
            "transcript": "", "subject": subject, "topic": topic, "starred": 0,
            "continues": 0, "thread": "",
            "context": context if context in ("school", "tuition") else "school",
            "created_at": stamp, "updated_at": stamp}
    with connect() as c:
        c.execute(
            "INSERT INTO notes (id,notebook_id,title,body,blocks,transcript,"
            "subject,topic,starred,continues,thread,context,created_at,updated_at)"
            " VALUES (:id,:notebook_id,:title,:body,:blocks,:transcript,:subject,"
            ":topic,:starred,:continues,:thread,:context,:created_at,:updated_at)",
            note)
    return get_note(note["id"])


def update_note(note_id: str, **patch) -> dict | None:
    init()
    allowed = ("title", "body", "blocks", "transcript", "subject", "topic",
               "starred", "notebook_id", "continues", "thread", "context")
    fields, values = [], []
    for k in allowed:
        if k not in patch:
            continue
        v = patch[k]
        if k == "blocks":
            v = json.dumps(v)
        if k in ("starred", "continues"):
            v = int(bool(v))
        fields.append(f"{k}=?")
        values.append(v)
    if not fields:
        return get_note(note_id)
    values += [now(), note_id]
    with connect() as c:
        c.execute(f"UPDATE notes SET {', '.join(fields)}, updated_at=? WHERE id=?",
                  values)
    return get_note(note_id)


def delete_note(note_id: str) -> bool:
    init()
    with connect() as c:
        cur = c.execute("DELETE FROM notes WHERE id=?", (note_id,))
    return cur.rowcount > 0


def note_by_thread(thread: str) -> str | None:
    """The id of a note carrying this thread tag, if any. Used to tell whether a
    shared note has already been added, so 'Add to my notes' twice reopens the
    one copy instead of piling up duplicates."""
    if not thread:
        return None
    init()
    with connect() as c:
        row = c.execute("SELECT id FROM notes WHERE thread=? LIMIT 1",
                        (thread,)).fetchone()
    return row["id"] if row else None


def resumable(subject: str, days: int = 21) -> dict | None:
    """The most recent lesson in this subject that ended mid-topic.

    A period ends when the bell goes, not when the teacher finishes. The next
    lesson picks the topic straight back up, and two half-notes on the same
    topic are worse than one whole one — so the next recording can be appended
    to this note instead of starting a stranger.
    """
    init()
    from datetime import timedelta
    cutoff = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
    with connect() as c:
        row = c.execute(
            "SELECT * FROM notes WHERE continues=1 AND lower(subject)=lower(?)"
            " AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1",
            (subject or "", cutoff)).fetchone()
    if not row:
        return None
    n = dict(row)
    n["blocks"] = json.loads(n["blocks"] or "[]")
    n["continues"] = True
    return n


def restore_note(row: dict) -> None:
    """Write a note pulled from the cloud straight in, keeping its id."""
    init()
    if not row.get("id"):
        return
    stamp = row.get("updated_at") or now()
    with connect() as c:
        ctx = row.get("context") if row.get("context") in ("school", "tuition") else "school"
        c.execute(
            "INSERT OR REPLACE INTO notes (id,notebook_id,title,body,blocks,"
            "transcript,subject,topic,starred,continues,thread,context,"
            "created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["id"], ensure_notebook(row.get("subject", "")),
             row.get("title", "Untitled"), row.get("body", ""),
             json.dumps(row.get("blocks") or []), row.get("transcript", ""),
             row.get("subject", ""), row.get("topic", ""), 0,
             int(bool(row.get("continues"))), row.get("thread") or "", ctx,
             row.get("created_at") or stamp, stamp))


def restore_task(row: dict) -> None:
    init()
    if not row.get("id"):
        return
    stamp = row.get("updated_at") or now()
    with connect() as c:
        c.execute(
            "INSERT OR REPLACE INTO tasks (id,title,detail,subject,kind,due,"
            "source,source_ref,done,note_id,url,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["id"], row.get("title", ""), row.get("detail", ""),
             row.get("subject", ""), row.get("kind", "assignment"),
             row.get("due") or None, row.get("source", "cloud"),
             row.get("source_ref", ""), int(bool(row.get("done"))),
             row.get("note_id") or "", row.get("url", ""), stamp, stamp))


def capture_key() -> str:
    """A per-account key the ManageBac bookmarklet carries.

    Not a password — it only permits adding documents, never reading anything.
    Kept out of the Firebase token flow because a bookmarklet on managebac.com
    has no way to obtain one.
    """
    init()
    with connect() as c:
        row = c.execute("SELECT goals FROM profile WHERE id=1").fetchone()
    existing = (row["goals"] or "") if row else ""
    if existing.startswith("cap:"):
        return existing[4:]
    key = uuid.uuid4().hex
    with connect() as c:
        c.execute("UPDATE profile SET goals=? WHERE id=1", ("cap:" + key,))
    return key


# ---------------------------------------------------------------- documents
def docs_dir() -> Path:
    d = ROOT / "data" / "documents" / (uid() or "local")
    d.mkdir(parents=True, exist_ok=True)
    return d


def add_document(subject: str, name: str, mime: str, blob: bytes,
                 text: str = "", source: str = "upload") -> dict:
    init()
    # Re-uploading a file replaces it rather than sitting beside itself. Without
    # this the same document accumulates a row per upload -- and the cloud merge
    # adds one more each time it runs, so a list quietly fills with copies of
    # things the student only ever added once. Matched on subject, name and
    # size, which is enough to mean "this same file again" without treating a
    # genuinely edited worksheet as a duplicate.
    if name:
        with connect() as c:
            for old_row in c.execute(
                    "SELECT id, path FROM documents WHERE name=? AND subject=? "
                    "AND size=?", (name, subject or "", len(blob))).fetchall():
                try:
                    pathlib.Path(dict(old_row)["path"]).unlink(missing_ok=True)
                except Exception:
                    pass                    # the row matters more than the file
                c.execute("DELETE FROM documents WHERE id=?", (dict(old_row)["id"],))

    doc_id = rid()
    safe = "".join(ch for ch in name if ch.isalnum() or ch in " ._-")[:80] or "file"
    path = docs_dir() / f"{doc_id}-{safe}"
    path.write_bytes(blob)
    row = {"id": doc_id, "subject": subject or "", "name": name or safe,
           "mime": mime or "application/octet-stream", "size": len(blob),
           "path": str(path), "text": (text or "")[:200000], "source": source,
           "created_at": now()}
    with connect() as c:
        c.execute("INSERT INTO documents VALUES (:id,:subject,:name,:mime,:size,"
                  ":path,:text,:source,:created_at)", row)
    return {k: v for k, v in row.items() if k != "path"}


def important_senders() -> set[str]:
    """The addresses and @domains this student has flagged as important."""
    init()
    with connect() as c:
        return {r["key"] for r in c.execute("SELECT key FROM important_senders")}


def _sender_keys(address: str) -> list[str]:
    """The two keys an address matches on: the address itself, and its @domain.
    Marking one sender important therefore also lifts anyone else at the same
    school domain -- which is what "similar emails" means for school mail."""
    addr = (address or "").strip().lower()
    if "@" not in addr:
        return [addr] if addr else []
    return [addr, "@" + addr.split("@", 1)[1]]


# Marking a personal contact important should not flag everyone at gmail.com.
# Marking a teacher important SHOULD flag the rest of the school. So the domain
# is lifted only when it is not one of the big consumer mail hosts.
_CONSUMER = {"gmail.com", "googlemail.com", "outlook.com", "hotmail.com",
             "yahoo.com", "yahoo.co.in", "icloud.com", "proton.me", "protonmail.com",
             "live.com", "aol.com", "rediffmail.com"}


def mark_sender_important(address: str, on: bool = True) -> None:
    init()
    addr = (address or "").strip().lower()
    if not addr or "@" not in addr:
        return
    domain = addr.split("@", 1)[1]
    with connect() as c:
        if on:
            c.execute("INSERT OR REPLACE INTO important_senders (key, added_at) "
                      "VALUES (?, ?)", (addr, now()))
            # "similar emails" = the same school domain. Not for consumer hosts,
            # or one starred friend would flag all of gmail.
            if domain not in _CONSUMER:
                c.execute("INSERT OR REPLACE INTO important_senders (key, added_at)"
                          " VALUES (?, ?)", ("@" + domain, now()))
        else:
            c.execute("DELETE FROM important_senders WHERE key=? OR key=?",
                      (addr, "@" + domain))


def is_important(address: str, marked: set[str] | None = None) -> bool:
    """True if this address, or another address at a domain the student has
    marked important, is flagged. So marking one teacher important auto-marks
    later mail from the same school domain."""
    marked = important_senders() if marked is None else marked
    if not marked:
        return False
    return any(k in marked for k in _sender_keys(address))


def documents(subject: str = "") -> list[dict]:
    init()
    sql = ("SELECT id,subject,name,mime,size,source,created_at,"
           "length(text) AS chars FROM documents")
    args: tuple = ()
    if subject:
        sql += " WHERE lower(subject)=lower(?)"
        args = (subject,)
    sql += " ORDER BY created_at DESC"
    with connect() as c:
        return [dict(r) for r in c.execute(sql, args)]


def get_document(doc_id: str) -> dict | None:
    init()
    with connect() as c:
        row = c.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    return dict(row) if row else None


def delete_document(doc_id: str) -> bool:
    init()
    row = get_document(doc_id)
    if not row:
        return False
    try:
        Path(row["path"]).unlink(missing_ok=True)
    except OSError:
        pass
    with connect() as c:
        c.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    return True


def notebook_view(subject: str) -> dict:
    """Everything for one subject: its notes, its files, its assignments."""
    init()
    with connect() as c:
        notes = [dict(r) for r in c.execute(
            "SELECT id,title,subject,topic,continues,created_at,updated_at,"
            "substr(body,1,200) AS preview FROM notes WHERE lower(subject)=lower(?)"
            " ORDER BY updated_at DESC", (subject,))]
        tasks = [dict(r) for r in c.execute(
            "SELECT * FROM tasks WHERE lower(subject)=lower(?)"
            " ORDER BY done, (due IS NULL), due", (subject,))]
    for n in notes:
        n["continues"] = bool(n.get("continues"))
    return {"subject": subject, "notes": notes,
            "documents": documents(subject), "assignments": tasks}


def all_notes_for_search() -> list[dict]:
    init()
    with connect() as c:
        return [dict(r) for r in c.execute(
            "SELECT id,title,subject,topic,body,transcript,updated_at FROM notes")]


# ---------------------------------------------------------------- recordings
def start_recording(note_id: str) -> dict:
    init()
    rec = {"id": rid(), "note_id": note_id, "started": now(),
           "finished": None, "seconds": 0, "words": 0, "state": "running"}
    with connect() as c:
        c.execute("INSERT INTO recordings VALUES (:id,:note_id,:started,:finished,"
                  ":seconds,:words,:state)", rec)
    return rec


def get_recording(rec_id: str) -> dict | None:
    init()
    with connect() as c:
        row = c.execute("SELECT * FROM recordings WHERE id=?", (rec_id,)).fetchone()
    return dict(row) if row else None


def adopt_recording(new_id: str, wanted_id: str) -> None:
    """Re-key a rebuilt recording to the id the browser is still using.

    The page cannot be told "your recording moved" mid-lesson, so the server
    takes the browser's id instead. Keeps every later slice landing in the
    same session.
    """
    if not wanted_id or new_id == wanted_id:
        return
    init()
    with connect() as c:
        exists = c.execute("SELECT id FROM recordings WHERE id=?",
                           (wanted_id,)).fetchone()
        if exists:
            return
        c.execute("UPDATE recordings SET id=? WHERE id=?", (wanted_id, new_id))
        c.execute("UPDATE chunks SET recording_id=? WHERE recording_id=?",
                  (wanted_id, new_id))


def add_chunk(rec_id: str, idx: int, text: str, condensed: dict) -> None:
    init()
    with connect() as c:
        c.execute("INSERT INTO chunks VALUES (?,?,?,?,?,?)",
                  (rid(), rec_id, idx, text, json.dumps(condensed), now()))


def chunks(rec_id: str) -> list[dict]:
    init()
    with connect() as c:
        rows = c.execute("SELECT * FROM chunks WHERE recording_id=? ORDER BY idx",
                         (rec_id,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["condensed"] = json.loads(d["condensed"] or "{}")
        except ValueError:
            d["condensed"] = {}
        out.append(d)
    return out


def finish_recording(rec_id: str, seconds: int, words: int) -> None:
    init()
    with connect() as c:
        c.execute("UPDATE recordings SET finished=?, seconds=?, words=?, state='done'"
                  " WHERE id=?", (now(), seconds, words, rec_id))


# ---------------------------------------------------------------- tasks
def add_task(title: str, due: str | None = None, subject: str = "",
             kind: str = "assignment", detail: str = "", source: str = "note",
             source_ref: str = "", note_id: str = "", url: str = "") -> dict:
    init()
    stamp = now()
    task = {"id": rid(), "title": title.strip(), "detail": detail,
            "subject": subject, "kind": kind, "due": due, "source": source,
            "source_ref": source_ref, "done": 0, "note_id": note_id,
            "url": url, "created_at": stamp, "updated_at": stamp}
    with connect() as c:
        existing = c.execute(
            "SELECT id FROM tasks WHERE source=? AND source_ref=? AND source_ref<>''",
            (source, source_ref)).fetchone()
        if existing:
            return dict(c.execute("SELECT * FROM tasks WHERE id=?",
                                  (existing["id"],)).fetchone())
        c.execute("INSERT INTO tasks VALUES (:id,:title,:detail,:subject,:kind,:due,"
                  ":source,:source_ref,:done,:note_id,:url,:created_at,:updated_at)",
                  task)
    return task


def set_task_subject(task_id: str, subject: str) -> dict | None:
    """Move a task to a different subject.

    The feed carries no subject, so the AI has to infer one — and it will
    sometimes be wrong. You know which class it is; one click should fix it,
    and the fix should stick through the next ManageBac refresh.
    """
    init()
    with connect() as c:
        c.execute("UPDATE tasks SET subject=?, updated_at=? WHERE id=?",
                  (subject or "", now(), task_id))
        row = c.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row and row["source"] == "managebac" and row["source_ref"]:
            # Pin it on the feed item too, so a refresh does not re-guess.
            c.execute("UPDATE feed_items SET subject=? WHERE uid=?",
                      (subject or "", row["source_ref"]))
    return dict(row) if row else None


def pinned_subjects() -> dict:
    """Subjects the student set by hand, keyed by feed uid. These win."""
    init()
    with connect() as c:
        return {r["uid"]: r["subject"] for r in c.execute(
            "SELECT uid, subject FROM feed_items WHERE subject <> ''")}


def tasks(open_only: bool = True) -> list[dict]:
    init()
    sql = "SELECT * FROM tasks"
    if open_only:
        sql += " WHERE done=0"
    sql += " ORDER BY (due IS NULL), due, created_at"
    with connect() as c:
        return [dict(r) for r in c.execute(sql)]


def set_task_done(task_id: str, done: bool = True) -> bool:
    init()
    with connect() as c:
        cur = c.execute("UPDATE tasks SET done=?, updated_at=? WHERE id=?",
                        (int(done), now(), task_id))
    return cur.rowcount > 0


# ---------------------------------------------------------------- feed
def upsert_feed(items: list[dict]) -> dict:
    """Insert new ManageBac items, keep `seen` on ones already there."""
    init()
    added = 0
    stamp = now()
    with connect() as c:
        for it in items:
            row = c.execute("SELECT uid FROM feed_items WHERE uid=?",
                            (it["uid"],)).fetchone()
            timetabled = int(bool(it.get("timetabled")))
            if row:
                c.execute("UPDATE feed_items SET title=?,kind=?,subject=?,detail=?,"
                          "due=?,starts=?,url=?,last_seen=?,timetabled=? WHERE uid=?",
                          (it["title"], it["kind"], it["subject"], it["detail"],
                           it["due"], it["starts"], it["url"], stamp, timetabled,
                           it["uid"]))
            else:
                # Something already in the past is not news. Importing a whole
                # term of history used to light up every old item as "new" and
                # the badge never went down. Mark past items seen on arrival so
                # "new" means what it says.
                when = (it.get("due") or it.get("starts") or "")[:10]
                already = 1 if (when and when < datetime.now().strftime("%Y-%m-%d")) else 0
                c.execute("INSERT INTO feed_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (it["uid"], it["kind"], it["title"], it["subject"],
                           it["detail"], it["due"], it["starts"], it["url"],
                           it.get("raw", ""), stamp, stamp, already, timetabled))
                if not already:
                    added += 1
    return {"added": added, "total": len(items)}


def feed(kind: str = "", unseen_only: bool = False,
         days_back: int = 21, include_past: bool = False) -> list[dict]:
    """ManageBac items worth showing.

    Without a date floor this returned EVERY item ever imported, so a term of
    finished lessons piled up at the top of the page for ever — the exact
    "it keeps showing past things" complaint. Anything whose date is more than
    `days_back` old is dropped unless the caller explicitly wants history.
    Undated items are always kept: no date means nothing has passed.
    """
    init()
    sql, args = "SELECT * FROM feed_items WHERE 1=1", []
    if kind:
        sql += " AND kind=?"
        args.append(kind)
    if unseen_only:
        sql += " AND seen=0"
    if not include_past and days_back >= 0:
        floor = (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")
        sql += (" AND (COALESCE(due, starts) IS NULL"
                "      OR substr(COALESCE(due, starts), 1, 10) >= ?)")
        args.append(floor)
    sql += " ORDER BY (due IS NULL), due, starts"
    with connect() as c:
        return [dict(r) for r in c.execute(sql, args)]


def mark_seen(uids: list[str]) -> int:
    init()
    if not uids:
        return 0
    with connect() as c:
        cur = c.executemany("UPDATE feed_items SET seen=1 WHERE uid=?",
                            [(u,) for u in uids])
    return cur.rowcount


def other_accounts() -> list[dict]:
    """Other Google accounts with data on this device.

    Signing in with a second Google account gives a second, empty database, and
    the app simply looks wiped — which is exactly how it looked when a whole
    lesson's notes appeared to vanish. Nothing was lost; the notes were under
    the other account. Rather than let that read as data loss, report what else
    is here so the app can say so.

    Read-only, and only counts — no content is read across accounts.
    """
    import sqlite3

    here = db_path()
    out = []
    folder = ROOT / "data" / "users"
    if not folder.exists():
        return out
    for f in sorted(folder.glob("*.db")):
        if f.resolve() == here.resolve():
            continue
        try:
            c = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
            notes = c.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
            docs = c.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            row = c.execute("SELECT name FROM profile LIMIT 1").fetchone()
            c.close()
        except Exception:
            continue
        if notes or docs:
            out.append({"notes": notes, "documents": docs,
                        "name": (row[0] if row else "") or "",
                        "hint": f.stem[:6]})
    return out


def rename_notebook(old: str, new: str) -> dict:
    """Rename a notebook and everything filed under it.

    `subject` is a free-text string copied onto every note, document and task,
    so renaming only the notebooks row would leave all of them pointing at a
    name that no longer exists — the notebook would look empty and the work
    would look lost. Rename all four tables in one transaction, or none.
    """
    init()
    old = (old or "").strip()
    new = (new or "").strip()
    if not new:
        raise ValueError("a notebook needs a name")
    if len(new) > 60:
        raise ValueError("that name is too long")
    if old.lower() == new.lower():
        # Same name in different case is still worth applying.
        pass

    with connect() as c:
        row = c.execute("SELECT * FROM notebooks WHERE lower(title)=lower(?)",
                        (old,)).fetchone()
        if not row:
            raise ValueError(f"there is no notebook called {old!r}")
        clash = c.execute(
            "SELECT id FROM notebooks WHERE lower(title)=lower(?) AND id<>?",
            (new, row["id"])).fetchone()
        if clash:
            raise ValueError(
                f"you already have a notebook called {new!r}. "
                "Rename that one first, or pick a different name.")

        c.execute("UPDATE notebooks SET title=?, subject=? WHERE id=?",
                  (new, new, row["id"]))
        moved = {}
        for table in ("notes", "documents", "tasks"):
            cur = c.execute(
                f"UPDATE {table} SET subject=? WHERE lower(subject)=lower(?)",
                (new, old))
            moved[table] = cur.rowcount

        # The student's subject list drives the notebook sidebar and the
        # timetable matcher; leaving the old spelling there recreates the
        # notebook under its previous name on the next sync.
        prof = c.execute("SELECT subjects FROM profile LIMIT 1").fetchone()
        if prof and prof["subjects"]:
            try:
                subs = json.loads(prof["subjects"])
                if isinstance(subs, list):
                    subs = [new if str(s).strip().lower() == old.lower() else s
                            for s in subs]
                    c.execute("UPDATE profile SET subjects=?",
                              (json.dumps(subs),))
            except (ValueError, TypeError):
                pass

    return {"title": new, "moved": moved}


def delete_notebook(title: str) -> dict:
    """Remove an empty notebook.

    Deliberately refuses while anything is filed under it. A one-click delete
    that silently takes a term of notes with it is not a feature.
    """
    init()
    title = (title or "").strip()
    with connect() as c:
        row = c.execute("SELECT * FROM notebooks WHERE lower(title)=lower(?)",
                        (title,)).fetchone()
        if not row:
            raise ValueError("no such notebook")
        held = {}
        for table in ("notes", "documents", "tasks"):
            held[table] = c.execute(
                f"SELECT COUNT(*) FROM {table} WHERE lower(subject)=lower(?)",
                (title,)).fetchone()[0]
        if any(held.values()):
            parts = [f"{n} {name}" for name, n in held.items() if n]
            raise ValueError("that notebook still holds " + ", ".join(parts)
                             + ". Move or delete those first.")
        c.execute("DELETE FROM notebooks WHERE id=?", (row["id"],))
    return {"deleted": title}


def assessments(days_ahead: int = 60) -> list[dict]:
    """Upcoming FAs, SAs, tests and exams — the things you revise for.

    Kept apart from homework on purpose. An essay you hand in and a formative
    you sit are different kinds of pressure: one is a deadline, the other needs
    days of revision before it. Mixing them in one list is why a test creeps up
    on you.
    """
    init()
    today = datetime.now().strftime("%Y-%m-%d")
    horizon = (datetime.now() + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
    with connect() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM feed_items WHERE kind='exam' "
            "AND COALESCE(due, starts) IS NOT NULL "
            "AND substr(COALESCE(due, starts), 1, 10) >= ? "
            "AND substr(COALESCE(due, starts), 1, 10) <= ? "
            "ORDER BY COALESCE(due, starts)", (today, horizon))]
    return rows


def past_assessments(days_back: int = 60, limit: int = 12) -> list[dict]:
    """Assessments that have already happened, newest first.

    Worth showing rather than hiding. A term's formatives are the best possible
    revision material for the next one, and a page that goes blank the day after
    a test looks broken — which is exactly what happened: four real FAs sat in
    the database and the screen said "connect ManageBac".
    """
    init()
    today = datetime.now().strftime("%Y-%m-%d")
    floor = (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")
    with connect() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM feed_items WHERE kind='exam' "
            "AND COALESCE(due, starts) IS NOT NULL "
            "AND substr(COALESCE(due, starts), 1, 10) < ? "
            "AND substr(COALESCE(due, starts), 1, 10) >= ? "
            "ORDER BY COALESCE(due, starts) DESC LIMIT ?",
            (today, floor, limit))]


def add_assessment(title: str, subject: str = "", when: str = "",
                   detail: str = "", kind: str = "exam") -> dict:
    """Record an FA or test the student was told about in class.

    ManageBac's calendar feed carries assignments and events. It does NOT carry
    the class Discussions tab, which is where many teachers actually announce
    the week's formative — so those assessments are invisible to any calendar
    import, however well it works. This is the way in for them.

    Stored in the same table as the imported ones so it sorts, bands and
    practises identically; only the uid prefix marks it as hand-entered.
    """
    init()
    title = (title or "").strip()
    if not title:
        raise ValueError("give the assessment a name")
    if not (when or "").strip():
        raise ValueError("give the date it is on")
    uid = "manual-" + rid()
    stamp = now()
    with connect() as c:
        c.execute("INSERT INTO feed_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (uid, kind, title, (subject or "").strip(),
                   (detail or "").strip(), when, when, "", "manual",
                   stamp, stamp, 1, 0))
    return {"uid": uid, "title": title, "subject": subject, "when": when,
            "kind": kind}


def delete_assessment(uid: str) -> bool:
    """Remove an assessment. Hand-entered ones only — an imported one would
    simply come back on the next ManageBac refresh, so deleting it would look
    broken rather than helpful."""
    init()
    if not str(uid).startswith("manual-"):
        raise ValueError("that one comes from ManageBac — it cannot be deleted here")
    with connect() as c:
        cur = c.execute("DELETE FROM feed_items WHERE uid=?", (uid,))
    return cur.rowcount > 0

"""sync.py — keep the local copy and Firestore in step.

Two directions, both deliberately simple:

  push()   after a local write, mirror that row up
  pull()   on a device that has never seen this account, bring everything down

Local stays the working copy. If the wifi dies mid-lesson the app keeps working
and the mirror catches up on the next write — which is the right trade in a
school, where the network is the least reliable component.
"""

from __future__ import annotations

import pathlib
import threading

from . import cloud, shares, store

_pulled: set[str] = set()
_lock = threading.Lock()


def _fire(fn, *args) -> None:
    """Sync in the background. A slow network must never make the app wait."""
    if not cloud.enabled() or not cloud.token():
        return
    token, uid = cloud.token(), store.uid()

    def run():
        cloud.set_token(token)
        try:
            fn(uid, *args)
        except Exception:
            pass                       # mirroring is best-effort by design

    threading.Thread(target=run, daemon=True).start()


def push_note(note: dict) -> None:
    """Mirror one note. REFUSES to mirror a partial row.

    This function destroyed a term of work once and must never be able to again.
    store.notes() returns a LIST PROJECTION -- id, title, subject, a 240-char
    preview -- with no body, blocks or transcript. Handed one of those, the code
    below happily defaulted all three to empty, and cloud.put builds its
    updateMask from exactly the keys it is given, so Firestore was PATCHed to
    body="", blocks=[], transcript="". The local copy was untouched, so nothing
    looked wrong until the host wiped its disk and restored the emptiness.

    So a projection row is now detected (it carries "preview"/"size" and lacks
    "blocks") and the note re-read in full. And as a last line of defence, a note
    that would mirror as completely empty is checked against the database first:
    if the stored note actually HAS content, the write is dropped rather than
    allowed to blank a good backup.
    """
    if not note or not note.get("id"):
        return
    if "preview" in note or "size" in note or "blocks" not in note or "body" not in note:
        full = store.get_note(note["id"])
        if not full:
            return
        note = full
    # Never let an empty note overwrite a backup that has something in it.
    if not (note.get("body") or note.get("blocks") or note.get("transcript")):
        stored = store.get_note(note["id"])
        if stored and (stored.get("body") or stored.get("blocks")
                       or stored.get("transcript")):
            return
    _fire(lambda uid, n: cloud.put(uid, "notes", n["id"], {
        "id": n["id"], "title": n.get("title", ""), "body": n.get("body", ""),
        "blocks": n.get("blocks", []), "transcript": n.get("transcript", ""),
        "subject": n.get("subject", ""), "topic": n.get("topic", ""),
        "continues": bool(n.get("continues")),
        "context": n.get("context", "school"),
        # Carried so 'Add to my notes' dedupe (the 'share:<token>' marker) still
        # holds after a note round-trips through the cloud to another device.
        "thread": n.get("thread", ""),
        "created_at": n.get("created_at", ""), "updated_at": n.get("updated_at", ""),
    }), note)


def push_task(task: dict) -> None:
    if not task:
        return
    _fire(lambda uid, t: cloud.put(uid, "tasks", t["id"], {
        "id": t["id"], "title": t.get("title", ""), "subject": t.get("subject", ""),
        "kind": t.get("kind", ""), "due": t.get("due") or "",
        "done": bool(t.get("done")), "source": t.get("source", ""),
        "url": t.get("url", ""), "note_id": t.get("note_id") or "",
        "updated_at": t.get("updated_at", ""),
    }), task)


def push_profile(profile: dict) -> None:
    if not profile:
        return
    # Read the raw key HERE, on the request thread, not inside the closure.
    # store.uid() is thread-local and _fire runs the upload on a fresh thread
    # that never calls set_user, so a read in there would silently open the
    # "local" database and mirror the wrong account's key.
    #
    # It is synced on purpose. The alternative is losing it on every redeploy,
    # because the free host's disk is wiped each time. It is the student's own
    # free-tier key with no card behind it, it lands in a Firestore document the
    # rules lock to their uid, and it is strictly less sensitive than the term of
    # notes already sitting beside it. It still never goes to the browser.
    try:
        raw_key = store.groq_key()
    except Exception:
        raw_key = ""
    try:
        lock_hash = store.get_profile_raw_lock() if hasattr(store, "get_profile_raw_lock") else ""
    except Exception:
        lock_hash = ""
    _fire(lambda uid, p: cloud.put_profile(uid, {
        "groq_key": raw_key,
        "lock_pin": lock_hash,
        "name": p.get("name", ""), "curriculum": p.get("curriculum", ""),
        "grade": p.get("grade", ""), "school": p.get("school", ""),
        "city": p.get("city", ""), "country": p.get("country", ""),
        "subjects": p.get("subjects", []), "timetable": p.get("timetable", []),
        "tuition_subjects": p.get("tuition_subjects", []),
        "managebac_ics": p.get("managebac_ics", ""),
        "onboarded": bool(p.get("onboarded")),
    }), profile)


def push_share(record: dict) -> None:
    """Mirror a share into the owner's own cloud space, so a shared link is as
    durable as the notes behind it and survives the free host wiping its disk.
    The snapshot rides as one JSON string — see shares.to_cloud_row."""
    if not record:
        return
    row = shares.to_cloud_row(record)
    _fire(lambda uid, r: cloud.put(uid, "shares", r["token"], r), row)


def push_share_now(record: dict) -> bool:
    """Mirror a share synchronously and report whether it landed. Used for a
    revoke, where a silently-lost write could later resurrect a killed link."""
    if not record or not cloud.enabled() or not cloud.token():
        return False
    row = shares.to_cloud_row(record)
    try:
        return cloud.put(store.uid(), "shares", row["token"], row)
    except Exception:
        return False


def push_document(doc: dict, blob: bytes) -> None:
    """Metadata to Firestore, bytes to Storage. Both in the background."""
    if not doc:
        return

    def go(uid, d, data):
        stored = cloud.upload_file(uid, d["id"], d["name"], d["mime"], data)
        # The extracted text always syncs even when the bytes are too big:
        # that is what makes a document answerable by Ask on another device.
        cloud.put(uid, "documents", d["id"], {
            "id": d["id"], "subject": d.get("subject", ""), "name": d["name"],
            "mime": d.get("mime", ""), "size": d.get("size", 0),
            "storage_path": stored, "text": (d.get("text") or "")[:20000],
            "created_at": d.get("created_at", ""),
        })

    _fire(go, doc, blob)


def delete_document(doc_id: str) -> None:
    _fire(lambda uid, i: cloud.delete(uid, "documents", i), doc_id)


def delete_note(note_id: str) -> None:
    _fire(lambda uid, nid: cloud.delete(uid, "notes", nid), note_id)


def pull_if_new() -> dict:
    """First time this machine sees the account, bring the cloud copy down.

    Guarded on the local profile being empty, so it can never overwrite work
    done on this device — it only fills a genuinely blank slate.
    """
    uid = store.uid()
    if uid in ("local", "nobody") or not cloud.enabled() or not cloud.token():
        return {"pulled": False}
    with _lock:
        if uid in _pulled:
            return {"pulled": False}
        _pulled.add(uid)

    local = store.get_profile()
    if local.get("onboarded") or store.notes(limit=1):
        # The device has something of its own, so the wholesale restore below
        # would be wrong — but doing nothing is what stranded a term of notes
        # in Firestore after a redeploy wiped the disk and one new note was
        # written. Merge instead, in the background: the first request must not
        # wait on downloading every document, and anything that comes down
        # appears on the next poll a second later.
        token, uid_ = cloud.token(), uid

        def merge():
            cloud.set_token(token)
            try:
                store.set_user(uid_)
                pull_all()
            except Exception:
                pass               # best-effort, exactly like the pushes

        threading.Thread(target=merge, daemon=True).start()
        return {"pulled": False, "reason": "device already has data; merging"}

    remote = cloud.get_profile(uid)
    # Restore the profile when it is there, but do NOT bail if it isn't: a
    # transient hiccup fetching the profile must not also abandon the notes,
    # tasks and settings sitting in the cloud right beside it.
    if remote:
        store.save_profile({k: remote.get(k) for k in (
            "name", "curriculum", "grade", "school", "city", "country",
            "subjects", "timetable", "managebac_ics", "onboarded",
            "groq_key", "tuition_subjects", "lock_pin") if k in remote})

    notes = cloud.fetch(uid, "notes")
    for n in notes:
        store.restore_note(n)
    tasks = cloud.fetch(uid, "tasks")
    for t in tasks:
        store.restore_task(t)

    # Documents come back with their bytes, so a new device gets the actual
    # files and not just a list of names it cannot open.
    docs = cloud.fetch(uid, "documents")
    restored = 0
    for d in docs:
        blob = cloud.download_file(uid, d.get("id", ""))
        if not blob:
            # Bytes were too large to mirror, but the text came down — the
            # document is still searchable, just not openable here.
            blob = b""
        store.add_document(d.get("subject", ""), d.get("name", "file"),
                           d.get("mime", ""), blob, d.get("text", ""), "cloud")
        restored += 1

    for row in cloud.fetch(uid, "shares"):
        shares.restore_from_cloud(uid, row)
    return {"pulled": True, "notes": len(notes), "tasks": len(tasks),
            "documents": restored}


def pull_all() -> dict:
    """Bring down everything the cloud has that this device is missing or has
    an older copy of. A merge, not a restore.

    pull_if_new() deliberately refuses to run on a device that already has any
    data, so it can never clobber work. That is the right guard for a first
    sign-in and useless for the case that actually bites: a free host with an
    ephemeral disk. One redeploy wipes the SQLite file, the student writes a
    single note on the fresh instance, and from that moment pull_if_new sees
    "device already has data" and a whole term of notes stays invisible in
    Firestore for ever.

    So this compares row by row and takes the cloud copy only when the local one
    is absent or older. A local edit made while offline still wins, because its
    updated_at is later. Nothing is deleted either way — a row missing locally
    is treated as missing, never as deleted, since this cannot tell the two
    apart and losing a note is far worse than keeping a stale one.
    """
    uid = store.uid()
    if uid in ("local", "nobody"):
        return {"ok": False, "message": "Sign in with Google first."}
    if not cloud.enabled() or not cloud.token():
        return {"ok": False, "message": "Cloud backup is not switched on."}

    added = {"notes": 0, "tasks": 0, "documents": 0}
    skipped = 0

    for row in cloud.fetch(uid, "notes"):
        nid = row.get("id")
        if not nid:
            continue
        mine = store.get_note(nid)
        if mine and (mine.get("updated_at") or "") >= (row.get("updated_at") or ""):
            skipped += 1
            continue
        store.restore_note(row)
        added["notes"] += 1

    have_tasks = {t.get("id") for t in store.tasks(open_only=False)}
    for row in cloud.fetch(uid, "tasks"):
        if not row.get("id") or row["id"] in have_tasks:
            skipped += 1
            continue
        store.restore_task(row)
        added["tasks"] += 1

    # Documents are matched on name, because their ids are minted per device.
    have_docs = {(d.get("name") or "").lower() for d in store.documents()}
    for row in cloud.fetch(uid, "documents"):
        name = (row.get("name") or "").lower()
        if not name or name in have_docs:
            skipped += 1
            continue
        blob = cloud.download_file(uid, row.get("id", "")) or b""
        store.add_document(row.get("subject", ""), row.get("name", "file"),
                           row.get("mime", ""), blob, row.get("text", ""), "cloud")
        added["documents"] += 1

    for row in cloud.fetch(uid, "shares"):
        shares.restore_from_cloud(uid, row)

    # Settings self-heal: bring back anything the cloud has that this device is
    # missing — the API key, tuition subjects, the lock PIN, the timetable — not
    # just on a blank device but any time a field is empty here. This is what
    # stops the free host's disk wipe from resetting settings while the notes
    # survive. It only ever FILLS a gap, never overwrites a local value, so a
    # change made on this device always wins.
    profile = cloud.get_profile(uid)
    if profile:
        local = store.get_profile()
        patch: dict = {}
        for k in ("name", "curriculum", "grade", "school", "city", "country",
                  "managebac_ics"):
            if profile.get(k) and not (local.get(k) or "").strip():
                patch[k] = profile[k]
        for k in ("subjects", "timetable", "tuition_subjects"):
            if profile.get(k) and not local.get(k):
                patch[k] = profile[k]
        # Secrets are stripped from get_profile, so read them with their own
        # getters to decide whether this device is missing them.
        if profile.get("groq_key") and not store.groq_key():
            patch["groq_key"] = profile["groq_key"]
        if profile.get("lock_pin") and not store.get_profile_raw_lock():
            patch["lock_pin"] = profile["lock_pin"]
        if profile.get("onboarded") and not local.get("onboarded"):
            patch["onboarded"] = True
        if patch:
            store.save_profile(patch)

    total = sum(added.values())
    return {"ok": True, **added, "already_had": skipped,
            "message": (f"Brought down {total} item{'' if total == 1 else 's'} "
                        f"from the cloud." if total else
                        "This device is already up to date with the cloud.")}


def push_all() -> dict:
    """Upload everything on this device, synchronously, reporting failures.

    The ordinary pushes are fire-and-forget: they happen in a thread when a note
    is saved, and a failure is swallowed so a sync problem can never lose a
    local write. That is right for the steady state and useless for recovery —
    when Firestore was rejecting writes (the rules ship denying everything until
    they are published), every push failed silently and the cloud stayed empty.
    Publishing the rules afterwards does not go back and upload a term of notes.

    So: a deliberate, blocking, one-off upload of everything, which counts what
    it managed and says what went wrong. This is what makes a laptop's worth of
    work appear on another device.
    """
    uid = store.uid()
    if uid in ("local", "nobody"):
        return {"ok": False, "message": "Sign in with Google first."}
    if not cloud.enabled():
        return {"ok": False, "message": "Cloud backup is switched off."}
    if not cloud.token():
        return {"ok": False, "message": "Sign in with Google first."}

    done = {"profile": 0, "notes": 0, "tasks": 0, "documents": 0, "shares": 0}
    failed = []

    if cloud.put_profile(uid, store.get_profile()):
        done["profile"] = 1
    else:
        failed.append("profile")

    for n in store.notes(limit=1000):
        full = store.get_note(n["id"]) or n
        row = {
            "id": full["id"], "title": full.get("title", ""),
            "body": full.get("body", ""), "blocks": full.get("blocks", []),
            "transcript": full.get("transcript", ""),
            "subject": full.get("subject", ""), "topic": full.get("topic", ""),
            "continues": bool(full.get("continues")),
            "context": full.get("context", "school"),
            "thread": full.get("thread", ""),
            "created_at": full.get("created_at", ""),
            "updated_at": full.get("updated_at", ""),
        }
        if cloud.put(uid, "notes", full["id"], row):
            done["notes"] += 1
        else:
            failed.append("note:" + (full.get("title") or full["id"])[:30])

    for task in store.tasks(open_only=False):
        trow = {
            "id": task["id"], "title": task.get("title", ""),
            "subject": task.get("subject", ""), "kind": task.get("kind", ""),
            "due": task.get("due") or "", "done": bool(task.get("done")),
            "source": task.get("source", ""), "url": task.get("url", ""),
            "note_id": task.get("note_id") or "",
            "updated_at": task.get("updated_at", ""),
        }
        if cloud.put(uid, "tasks", task["id"], trow):
            done["tasks"] += 1
        else:
            failed.append("task:" + (task.get("title") or task["id"])[:30])

    for d in store.documents():
        row = store.get_document(d["id"]) or d
        blob = b""
        try:
            path = row.get("path")
            if path:
                blob = pathlib.Path(path).read_bytes()
        except OSError:
            blob = b""
        meta = {k: v for k, v in row.items() if k != "path"}
        if cloud.put(uid, "documents", row["id"], meta):
            done["documents"] += 1
            if blob:
                cloud.upload_file(uid, row["id"], row.get("name", "file"),
                                  row.get("mime", ""), blob)
        else:
            failed.append("doc:" + (row.get("name") or row["id"])[:30])

    for s in shares.list_for_owner(uid):
        rec = shares.load(s["token"])
        if rec and cloud.put(uid, "shares", rec["token"], shares.to_cloud_row(rec)):
            done["shares"] += 1

    ok = not failed
    total = done["notes"] + done["tasks"] + done["documents"]
    if ok:
        message = (f"Backed up {done['notes']} notes, {done['tasks']} tasks and "
                   f"{done['documents']} documents. Sign in anywhere and they "
                   "will be there.")
    elif total:
        message = (f"Backed up {total} things, but {len(failed)} failed. "
                   + (cloud.status().get("last_error") or ""))
    else:
        message = ("Nothing could be saved. "
                   + (cloud.status().get("last_error")
                      or "Firestore refused every write. If the error mentions "
                         "401/UNAUTHENTICATED, sign out and back in; if it "
                         "mentions 403/PERMISSION_DENIED, publish the rules."))
    return {"ok": ok, "done": done, "failed": failed[:8], "message": message}

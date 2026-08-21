"""sync.py — keep the local copy and Firestore in step.

Two directions, both deliberately simple:

  push()   after a local write, mirror that row up
  pull()   on a device that has never seen this account, bring everything down

Local stays the working copy. If the wifi dies mid-lesson the app keeps working
and the mirror catches up on the next write — which is the right trade in a
school, where the network is the least reliable component.
"""

from __future__ import annotations

import threading

from . import cloud, store

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
    if not note:
        return
    _fire(lambda uid, n: cloud.put(uid, "notes", n["id"], {
        "id": n["id"], "title": n.get("title", ""), "body": n.get("body", ""),
        "blocks": n.get("blocks", []), "transcript": n.get("transcript", ""),
        "subject": n.get("subject", ""), "topic": n.get("topic", ""),
        "continues": bool(n.get("continues")),
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
    _fire(lambda uid, p: cloud.put_profile(uid, {
        "name": p.get("name", ""), "curriculum": p.get("curriculum", ""),
        "grade": p.get("grade", ""), "school": p.get("school", ""),
        "city": p.get("city", ""), "country": p.get("country", ""),
        "subjects": p.get("subjects", []), "timetable": p.get("timetable", []),
        "managebac_ics": p.get("managebac_ics", ""),
        "onboarded": bool(p.get("onboarded")),
    }), profile)


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
        return {"pulled": False, "reason": "device already has data"}

    remote = cloud.get_profile(uid)
    if not remote:
        return {"pulled": False, "reason": "nothing in the cloud yet"}

    store.save_profile({k: remote.get(k) for k in (
        "name", "curriculum", "grade", "school", "city", "country",
        "subjects", "timetable", "managebac_ics", "onboarded") if k in remote})

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
    return {"pulled": True, "notes": len(notes), "tasks": len(tasks),
            "documents": restored}

"""main.py — HTTP server and API. Stdlib http.server, nothing else.

The API key never reaches the browser. The page posts audio and text here; this
process holds the key and talks to Groq.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import (ai, auth, cloud, config, mail, managebac, net, pdftext, readfile,
               search,
               store, sync, timetable, transcribe)

ROOT = Path(__file__).resolve().parent.parent
UI_DIR = ROOT / "ui"
DIST = ROOT / "web" / "dist"

# One app, one command, one URL. If the React app has been built, serve THAT —
# so the student runs `python run.py`, opens one address, and there is no second
# npm server and no proxy to "establish a connection" to. If it has not been
# built, fall back to the vanilla UI. Either way this process is the whole app.
WEB_ROOT = DIST if (DIST / "index.html").exists() else UI_DIR
IS_BUILT_APP = WEB_ROOT == DIST
MAX_BODY = 30 * 1024 * 1024


# ---------------------------------------------------------------------------
# Notes: turning a recording, or typed text, into blocks
# ---------------------------------------------------------------------------
_MONTHS = ("january february march april may june july august september "
           "october november december").split()

_DATE_FORMS = ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y",
               "%d %B %Y", "%B %d %Y", "%d %b %Y", "%b %d %Y")


def _fix_year(due) -> str | None:
    """Parse whatever the model gave back, then repair the year.

    Two failures to survive. First, models return dates in whatever shape they
    feel like — "17 August 2026", "17/08/2026", "2026-08-17T00:00" — and a
    strict parser silently drops the deadline, which is how homework ends up
    with no date. Second, a teacher says "due Monday the 17th" and never says
    the year, so the model supplies its training year and the task lands two
    years in the past. Roll it forward.
    """
    if not due:
        return None
    raw = str(due).strip()
    today = datetime.now().date()
    parsed = None

    for form in _DATE_FORMS:
        try:
            parsed = datetime.strptime(raw[:len("2026-08-17") if form == "%Y-%m-%d"
                                            else len(raw)], form).date()
            break
        except ValueError:
            continue

    # Teachers speak in weekdays: "due Thursday", "hand it in on Monday". The
    # model passes that straight through, and an unparsed date meant no reminder
    # ever fired for it. Resolve to the next occurrence of that weekday.
    if parsed is None:
        words = raw.lower()
        if "tomorrow" in words:
            parsed = today + timedelta(days=1)
        elif "today" in words or "tonight" in words:
            parsed = today
        else:
            for i, day in enumerate(("monday", "tuesday", "wednesday", "thursday",
                                     "friday", "saturday", "sunday")):
                if day in words or day[:3] in words.split():
                    ahead = (i - today.weekday()) % 7
                    # "due Thursday" said on a Thursday means the next one.
                    parsed = today + timedelta(days=ahead or 7)
                    # "next Friday" means the Friday of next week — but "next
                    # Monday" said on a Monday already resolved to next week's
                    # Monday above, so adding another week would overshoot.
                    if "next" in words and ahead:
                        parsed += timedelta(days=7)
                    break

    if parsed is None:                       # "17 August" with no year at all
        m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})", raw)
        if m:
            month = next((i + 1 for i, name in enumerate(_MONTHS)
                          if name.startswith(m.group(2).lower()[:3])), None)
            if month:
                try:
                    parsed = datetime(today.year, month, int(m.group(1))).date()
                except ValueError:
                    parsed = None
    if parsed is None:
        return None

    if (today - parsed).days <= 7:
        return parsed.isoformat()
    for year in (today.year, today.year + 1):
        try:
            candidate = parsed.replace(year=year)
        except ValueError:
            continue
        if (today - candidate).days <= 7:
            return candidate.isoformat()
    return None


def _note_text(note: dict) -> str:
    """Everything readable in a note: its written blocks, body and transcript.

    Practice has to come from what the lesson actually covered, so the blocks
    (the finished notes) lead, with the raw transcript behind them for detail.
    """
    parts = []
    for b in note.get("blocks") or []:
        kind = b.get("type")
        if kind == "summary":
            parts.append(str(b.get("text") or ""))
        elif kind in ("points", "assessed", "gaps"):
            head = b.get("heading") or ""
            if head:
                parts.append("## " + str(head))
            parts += [str(i) for i in (b.get("items") or [])]
        elif kind == "definitions":
            for d in b.get("items") or []:
                parts.append(f"{d.get('term','')}: {d.get('meaning','')}")
        elif kind == "formula":
            parts.append(f"{b.get('formula','')} — {b.get('means','')}")
        elif kind == "example":
            parts.append(str(b.get("title") or ""))
            parts += [str(s) for s in (b.get("steps") or [])]
    text = "\n".join(p for p in parts if p.strip())
    if len(text.split()) < 60:
        text += "\n\n" + (note.get("body") or "") + "\n\n" + (note.get("transcript") or "")
    return text.strip()[:60000]


def _plain_reason(detail: str) -> str:
    """Say what went wrong in words a student can act on."""
    d = (detail or "").lower()
    if "503" in d or "high demand" in d or "overloaded" in d:
        return "the free AI service is busy."
    if "429" in d or "quota" in d or "rate" in d:
        return "today's free AI quota is used up."
    if "413" in d or "too large" in d or "tokens per minute" in d:
        return "the lesson is longer than the free tier allows in one minute."
    if "key" in d or "401" in d or "403" in d:
        return "the AI key was rejected — check it in Settings."
    if "unreachable" in d or "urlopen" in d or "timed out" in d:
        return "the AI service could not be reached."
    return "the AI service did not answer."


def _apply_composition(note: dict, composed: dict, transcript: str = "") -> dict:
    blocks = composed.get("blocks") or []
    if composed.get("summary"):
        blocks = [{"type": "summary", "text": composed["summary"]}] + blocks

    tasks = []
    for t in composed.get("tasks") or []:
        # Sometimes the model returns tasks as plain strings rather than
        # objects. Assuming a dict crashed the whole request, which lost the
        # note as well as the homework.
        if isinstance(t, str):
            t = {"what": t}
        elif not isinstance(t, dict):
            continue
        # Same near-miss problem as the note blocks: the model is asked for
        # "what" and frequently writes "description", "task" or "title"
        # instead. Reading only "what" meant every piece of homework in a note
        # was silently dropped — the one feature that has to be reliable.
        what = ""
        for key in ("what", "description", "task", "title", "name", "text",
                    "item", "todo"):
            what = str(t.get(key) or "").strip()
            if what:
                break
        if not what:
            continue
        # "Complete all questions before Friday" arrives with no due field at
        # all. The deadline is sitting in the text — read it from there rather
        # than filing homework with no date.
        due = _fix_year(t.get("due")) or _fix_year(
            (re.search(r"\b(?:by|before|due|for|on)\s+([A-Za-z]{3,9}day|tomorrow"
                       r"|next\s+[A-Za-z]{3,9}day|\d{1,2}\s+[A-Za-z]{3,9})",
                       what, re.I) or [None, ""])[1])
        row = store.add_task(
            title=what, due=due, subject=note.get("subject", ""),
            kind=t.get("kind", "homework"), source="note",
            source_ref=f"{note['id']}:{what[:40]}", note_id=note["id"])
        tasks.append(row)

    patch = {"blocks": blocks, "continues": bool(composed.get("continues"))}
    if composed.get("title") and note.get("title") in ("", "Untitled", None):
        patch["title"] = composed["title"]
    if transcript:
        patch["transcript"] = ((note.get("transcript") or "") + "\n\n"
                               + transcript).strip()
    updated = store.update_note(note["id"], **patch)
    sync.push_note(updated)
    for row in tasks:
        sync.push_task(row)
    return {"note": updated, "tasks": tasks}


# ---------------------------------------------------------------------------
# ManageBac
# ---------------------------------------------------------------------------
def refresh_managebac() -> dict:
    profile = store.get_profile()
    url = profile.get("managebac_ics") or ""
    if not url:
        return {"ok": False, "error": "no ManageBac calendar URL saved",
                "hint": "ManageBac -> My Workspace -> Subscribe to Calendar"}
    try:
        items = managebac.refresh(url, profile.get("subjects") or [])
    except managebac.FeedError as exc:
        return {"ok": False, "error": str(exc)}
    # The feed carries no subject, so titles like "Drag Forces" arrive
    # unfiled and every notebook looks empty. Sort them once, here.
    pinned = store.pinned_subjects()
    for it in items:
        if pinned.get(it["uid"]):
            it["subject"] = pinned[it["uid"]]

    unfiled = [i["title"] for i in items
               if not i["subject"] and i["kind"] in ("assignment", "exam")]
    if unfiled:
        guessed = ai.classify_subjects(unfiled, profile.get("subjects") or [])
        for it in items:
            if not it["subject"]:
                it["subject"] = guessed.get(it["title"], "")

    result = store.upsert_feed(items)

    # EVERY assignment and exam becomes a task, whatever its date.
    #
    # An earlier version skipped anything dated in the past, on the reasoning
    # that a finished lesson needs nothing. That was wrong: a worksheet set on
    # the 11th is still outstanding on the 17th if you have not done it.
    # ManageBac lists those as incomplete and so must we — the student decides
    # what is done by ticking it, not the calendar.
    made = 0
    for it in items:
        if it["kind"] not in ("assignment", "exam"):
            continue
        due = (it.get("due") or it.get("starts") or "")[:10] or None
        store.add_task(title=it["title"], due=due, subject=it["subject"],
                       kind=it["kind"], detail=it["detail"][:400],
                       source="managebac", source_ref=it["uid"],
                       url=it.get("url", ""))
        made += 1
    return {"ok": True, "new": result["added"], "total": result["total"],
            "tasks": made}


def managebac_view() -> dict:
    rows = store.feed()
    org = managebac.organise(rows)
    org["configured"] = bool(store.get_profile().get("managebac_ics"))
    org["unseen"] = sum(1 for r in rows if not r["seen"])
    org["new_items"] = [
        dict(r) | {"band": managebac.band_for(
            r["due"] or r["starts"], timetabled=bool(r.get("timetabled")))}
        for r in rows if not r["seen"]][:40]
    return org


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    server_version = "Minerva/2.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            print(f"  {self.command} {self.path}")

    def _cors(self):
        """Cross-origin access, allow-listed — never a blanket "*".

        Two callers legitimately arrive from another origin:

        1. managebac.com, for the file-capture bookmarklet.
        2. The hosted front end, when the static app is served from somewhere
           else (Netlify, say) while this Python process runs on its own host.
           Set EVIE_ALLOWED_ORIGINS to a comma-separated list for that, e.g.
           EVIE_ALLOWED_ORIGINS=https://minerva.netlify.app,https://minerva.app

        Everything is still Firebase-gated per request, so CORS only decides who
        may ask — never who may read another student's data.
        """
        origin = self.headers.get("Origin", "")
        if not origin:
            return
        allowed = [o.strip().rstrip("/") for o
                   in config.env("EVIE_ALLOWED_ORIGINS", "").split(",") if o.strip()]
        is_managebac = "managebac.com" in origin
        is_allowed = origin.rstrip("/") in allowed
        if is_managebac or is_allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers",
                             "Content-Type, Authorization, X-Capture-Key, "
                             "X-Capture-Uid, X-Mail-Token, X-Recording, "
                             "X-Chunk, X-Note, X-Filename")
            self.send_header("Access-Control-Allow-Methods",
                             "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
            # Chrome's Private Network Access: a request from an HTTPS page on
            # the public internet to a private address like localhost is
            # blocked outright unless the local server opts in here. Without
            # this the bookmarklet reports "could not reach the app" even
            # though the app is running perfectly.
            if self.headers.get("Access-Control-Request-Private-Network"):
                self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def end_headers(self):
        # Never cache the UI. Without this the browser keeps serving an old
        # app.js after a restart, and you debug a bug that is no longer in the
        # source — which is exactly what happened while building this.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        else:
            # The preflight alone is not enough: the ACTUAL response must carry
            # the header too, or the browser discards a perfectly good reply.
            # Only fires for an allow-listed Origin — see _cors.
            self._cors()
        super().end_headers()

    _ASSET = re.compile(r'(src|href)="(?!https?:|data:|#)([^"?]+\.(?:js|css))"')

    def _index(self):
        """Serve index.html with every asset URL stamped by its modification time.

        `Cache-Control: no-store` only helps browsers that have not already
        cached the file. A tab that loaded app.js before the header existed will
        keep running the old code, and you end up debugging a bug that is no
        longer in the source — which happened twice while building this.
        Stamping the URL means a changed file is a different URL, and a stale
        copy becomes impossible rather than merely discouraged.
        """
        if IS_BUILT_APP:
            body = (WEB_ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        page = (UI_DIR / "index.html").read_text(encoding="utf-8")

        def stamp(m):
            attr, name = m.group(1), m.group(2)
            asset = UI_DIR / name
            try:
                version = int(asset.stat().st_mtime)
            except OSError:
                return m.group(0)
            return f'{attr}="{name}?v={version}"'

        body = self._ASSET.sub(stamp, page).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorise(self) -> bool:
        """Bind this request to a verified Google account, or refuse it.

        Runs before any handler touches the database, so an unauthenticated
        request cannot read or write a single row.
        """
        if not auth.required():
            store.set_user("local")
            return True
        try:
            user = auth.verify(self.headers.get("Authorization", ""))
        except auth.AuthError as exc:
            store.set_user("nobody")
            self._json({"error": str(exc), "signin": True}, 401)
            return False
        store.set_user(user["uid"])
        cloud.set_token(self.headers.get("Authorization", "").replace("Bearer ", "").strip())
        sync.pull_if_new()
        self._user = user
        return True

    def _json(self, payload, code: int = 200):
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if 0 < n <= MAX_BODY else b""

    def _q(self) -> dict:
        return {k: v[0] for k, v in urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query).items()}

    # -- GET -------------------------------------------------------------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            if path == "/" or "." not in Path(path).name:
                return self._index()
            return super().do_GET()
        if not self._authorise():
            return
        try:
            self._get(path)
        except Exception as exc:
            traceback.print_exc()
            self._json({"error": str(exc)}, 500)

    def _get(self, path: str):
        q = self._q()
        if path == "/api/state":
            profile = store.get_profile()
            return self._json({
                "profile": profile,
                "ai": ai.status(),
                "stt": transcribe.status(),
                "tls": net.status(),
                "notebooks": store.notebooks(),
                "notes": store.notes(limit=60),
                "tasks": store.tasks(open_only=True),
                "managebac": managebac_view(),
                "timetable": timetable.upcoming(profile.get("timetable") or []),
                "vision": timetable.status(),
                "auth": auth.status() | {"user": getattr(self, "_user", None)},
                "cloud": cloud.status(),
                # Only worth reporting when this account looks empty — that is
                # the case that reads as "my notes are gone" when in fact they
                # are under the student's other Google account.
                "elsewhere": (store.other_accounts()
                              if not store.notes(limit=1) else []),
            })
        if path == "/api/resumable":
            return self._json({"note": store.resumable(q.get("subject", ""))})
        if path == "/api/notebook":
            return self._json(store.notebook_view(q.get("subject", "")))
        if path == "/api/capture-key":
            return self._json({"key": store.capture_key(),
                               "uid": store.uid()})
        if path == "/api/documents":
            return self._json({"documents": store.documents(q.get("subject", ""))})
        if path == "/api/document":
            return self._document(q.get("id", ""))
        if path == "/api/notes":
            return self._json({"notes": store.notes(q.get("notebook", ""))})
        if path == "/api/note":
            note = store.get_note(q.get("id", ""))
            return self._json(note or {"error": "no such note"},
                              200 if note else 404)
        if path == "/api/tasks":
            return self._json({"tasks": store.tasks(q.get("all") != "1")})
        if path == "/api/notifications":
            return self._json(self._notifications(
                self.headers.get("X-Mail-Token", ""),
                q.get("days", "14")))

        if path == "/api/backup":
            # A plain answer to "are my notes safe if this machine dies?".
            # It was previously unanswerable: sync failures were swallowed, so
            # a broken backup and a perfect one looked identical from here.
            st = cloud.status()
            local = {
                "notes": len(store.notes(limit=1000)),
                "documents": len(store.documents()),
                "tasks": len(store.tasks(open_only=False)),
            }
            if not st["enabled"]:
                verdict = "off"
                say = ("Cloud backup is switched off. Your notes live only on "
                       "this device.")
            elif not st["connected"]:
                verdict = "signed-out"
                say = "Sign in with Google to back your notes up."
            elif st["failed"] and not st["saved"]:
                verdict = "failing"
                say = ("Nothing is reaching the cloud. Firestore is rejecting "
                       "every write — publish the rules in firestore.rules. "
                       "Your notes are still safe on this device.")
            elif st["failed"]:
                verdict = "partial"
                say = ("Some things saved and some failed. Check the rules in "
                       "firestore.rules.")
            elif st["saved"]:
                verdict = "ok"
                say = "Your notes are backed up and will follow you to any device."
            else:
                verdict = "idle"
                say = ("Nothing has needed saving yet. Make or open a note and "
                       "check again.")
            return self._json({"verdict": verdict, "message": say,
                               "cloud": st, "local": local})

        if path == "/api/assessments":
            return self._json(self._assessments())

        if path == "/api/managebac":
            return self._json(managebac_view())
        if path == "/api/timetable":
            periods = store.get_profile().get("timetable") or []
            return self._json({
                "periods": periods,
                "by_day": timetable.by_day(periods),
                "upcoming": timetable.upcoming(periods),
                "vision": timetable.status(),
                "days": timetable.DAYS,
            })
        if path == "/api/subjects":
            return self._json({"subjects": timetable.subjects_for(q.get("curriculum", "")),
                               "curricula": list(timetable.CURRICULUM_SUBJECTS)})
        if path == "/api/search":
            return self._json({"results": search.find(q.get("q", ""), 8)})
        return self._json({"error": "unknown endpoint"}, 404)

    # -- POST ------------------------------------------------------------
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/capture":
            # The bookmarklet cannot hold a Firebase token, so it carries the
            # account id instead and proves itself with the capture key. An
            # earlier version looked the key up under "local" while the key was
            # issued to the signed-in Google account — same app, different
            # database, so it never matched.
            store.set_user(self.headers.get("X-Capture-Uid", "").strip()
                           or config.env("EVIE_CAPTURE_UID", "local"))
            try:
                return self._capture()
            except Exception as exc:
                traceback.print_exc()
                return self._json({"error": str(exc)}, 500)
        if not self._authorise():
            return
        # Held open for the length of the request so a code change cannot
        # restart the server out from under a note that is being written.
        busy(1)
        try:
            self._post(path)
        except Exception as exc:
            traceback.print_exc()
            self._json({"error": str(exc)}, 500)
        finally:
            busy(-1)

    def _post(self, path: str):
        # Raw audio, handled before the JSON parse.
        if path == "/api/record/chunk":
            return self._chunk()

        payload = json.loads(self._body() or b"{}")

        if path == "/api/profile":
            saved = store.save_profile(payload)
            sync.push_profile(saved)
            return self._json(saved)

        if path == "/api/notebook":
            return self._json(store.create_notebook(
                payload.get("title", ""), payload.get("subject", ""),
                payload.get("colour", "")))

        if path == "/api/document/upload":
            return self._upload(payload)

        if path == "/api/document/delete":
            sync.delete_document(payload.get("id", ""))
            return self._json({"ok": store.delete_document(payload.get("id", ""))})

        if path == "/api/backup/now":
            # A deliberate, blocking upload of everything on this device.
            # The ordinary pushes are fire-and-forget and were failing silently
            # while Firestore denied writes, so publishing the rules afterwards
            # left a term of notes still only on the laptop. This is the button
            # that actually gets them to the cloud.
            return self._json(sync.push_all())

        if path == "/api/backup/restore":
            # The other direction: pull down anything this device is missing.
            # Needed because a free host wipes its disk on every redeploy, and
            # the first-sign-in pull refuses to run once the device has any
            # data of its own — so after a wipe plus one new note, everything
            # else stayed stranded in Firestore.
            return self._json(sync.pull_all())

        if path == "/api/backup/test":
            """Write a probe document, read it back, delete it.

            The only honest way to answer "is the cloud working". Rules cannot
            be checked from outside — an unauthenticated probe is denied whether
            the rules are correct or still the locked default — so the test has
            to run as the signed-in student, from here, with their real token.
            """
            uid = store.uid()
            if not cloud.enabled():
                return self._json({"ok": False, "step": "config",
                                   "message": "Cloud backup is switched off."})
            if not cloud.token():
                return self._json({"ok": False, "step": "auth",
                                   "message": "Sign in with Google first."})
            probe = {"hello": "minerva", "at": datetime.now().isoformat(timespec="seconds")}
            wrote = cloud.put(uid, "diagnostics", "probe", probe)
            if not wrote:
                return self._json({
                    "ok": False, "step": "write",
                    "message": ("Firestore refused the write. If you published "
                                "rules, check they went to Firestore and not "
                                "Realtime Database."),
                    "error": cloud.status().get("last_error", ""),
                })
            back = cloud.fetch(uid, "diagnostics", limit=5)
            found = any(r.get("hello") == "minerva" for r in back)
            cloud.delete(uid, "diagnostics", "probe")
            if not found:
                return self._json({
                    "ok": False, "step": "read",
                    "message": "Saved, but could not read it back.",
                    "error": cloud.status().get("last_error", ""),
                })
            return self._json({
                "ok": True, "step": "done",
                "message": ("Cloud backup works. Your notes are saved to your "
                            "Google account and will follow you to any device."),
            })

        if path == "/api/assessment/add":
            try:
                row = store.add_assessment(
                    payload.get("title", ""), payload.get("subject", ""),
                    payload.get("when", ""), payload.get("detail", ""),
                    payload.get("kind", "exam") or "exam")
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            return self._json(row)

        if path == "/api/assessment/delete":
            try:
                gone = store.delete_assessment(payload.get("uid", ""))
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            return self._json({"deleted": gone})

        if path == "/api/notebook/rename":
            try:
                out = store.rename_notebook(payload.get("old", ""),
                                            payload.get("new", ""))
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            for note in store.notes(limit=500):
                sync.push_note(note)
            return self._json(out)

        if path == "/api/notebook/delete":
            try:
                return self._json(store.delete_notebook(payload.get("title", "")))
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)

        if path == "/api/note/new":
            made = store.create_note(
                title=payload.get("title", "Untitled"),
                notebook_id=payload.get("notebook_id", ""),
                subject=payload.get("subject", ""),
                topic=payload.get("topic", ""))
            sync.push_note(made)
            return self._json(made)

        if path == "/api/note/save":
            note = store.update_note(payload.get("id", ""),
                                     **{k: v for k, v in payload.items() if k != "id"})
            sync.push_note(note)
            return self._json(note or {"error": "no such note"},
                              200 if note else 404)

        if path == "/api/note/delete":
            sync.delete_note(payload.get("id", ""))
            return self._json({"ok": store.delete_note(payload.get("id", ""))})

        if path == "/api/notes/from-documents":
            return self._notes_from_documents(payload)

        if path == "/api/practice":
            return self._practice(payload)

        if path == "/api/explain":
            note = store.get_note(payload.get("note_id", "")) or {}
            context = _note_text(note) if note else ""
            out = ai.explain(payload.get("idea", ""), context,
                             store.get_profile())
            return self._json(out)

        if path == "/api/note/tidy":
            note = store.get_note(payload.get("id", ""))
            if not note:
                return self._json({"error": "no such note"}, 404)
            composed = ai.tidy(note["body"], store.get_profile(),
                               note["subject"], note["topic"])
            # When no model could write the note, ai.tidy hands back the raw
            # input chopped into bullets. Saving that overwrites whatever good
            # notes were already there and — worse — looks like Minerva tried and
            # produced rubbish. Refuse, keep the note untouched, and say why.
            if composed.get("_failed"):
                return self._json({
                    "error": "Could not write the notes just now — "
                             + _plain_reason(composed["_failed"])
                             + " Your text is saved; press it again in a minute.",
                    "detail": composed["_failed"][:300],
                }, 503)
            return self._json(_apply_composition(note, composed))

        if path == "/api/record/start":
            note_id = payload.get("note_id", "")
            if not note_id:
                note = store.create_note(
                    title=payload.get("title", "") or "Untitled",
                    subject=payload.get("subject", ""),
                    topic=payload.get("topic", ""))
                note_id = note["id"]
            if not store.get_note(note_id):
                return self._json({"error": "no such note"}, 404)
            rec = store.start_recording(note_id)
            return self._json(rec | {"note_id": note_id})

        if path == "/api/record/finish":
            return self._finish(payload)

        if path == "/api/managebac/test":
            # Validate a pasted link BEFORE saving it, and say exactly what was
            # found. "Paste it and hope" is how people give up on this step.
            url = (payload.get("url") or "").strip()
            try:
                items = managebac.refresh(
                    url, store.get_profile().get("subjects") or [])
            except managebac.FeedError as exc:
                return self._json({"ok": False, "error": str(exc)})
            counts: dict[str, int] = {}
            for it in items:
                counts[it["kind"]] = counts.get(it["kind"], 0) + 1
            sample = [f"{i['subject'] + ' · ' if i['subject'] else ''}{i['title']}"
                      for i in items[:5]]
            return self._json({"ok": True, "total": len(items), "counts": counts,
                               "sample": sample})

        if path == "/api/timetable/read":
            try:
                out = timetable.read_image(
                    payload.get("image", ""),
                    store.get_profile().get("subjects") or [])
            except timetable.TimetableError as exc:
                return self._json({"ok": False, "error": str(exc)}, 200)
            return self._json({"ok": True, **out})

        if path == "/api/timetable/save":
            periods = timetable.normalise(payload.get("periods") or [])
            store.save_profile({"timetable": periods})
            return self._json({"ok": True, "periods": periods,
                               "by_day": timetable.by_day(periods)})

        if path == "/api/managebac/refresh":
            return self._json(refresh_managebac())

        if path == "/api/managebac/seen":
            return self._json({"marked": store.mark_seen(payload.get("uids", []))})

        if path == "/api/task/subject":
            row = store.set_task_subject(payload.get("id", ""),
                                         payload.get("subject", ""))
            sync.push_task(row or {})
            return self._json(row or {"error": "no such task"},
                              200 if row else 404)

        if path == "/api/task/done":
            return self._json({"ok": store.set_task_done(
                payload.get("id", ""), payload.get("done", True))})

        if path == "/api/ask":
            return self._ask(payload)

        return self._json({"error": "unknown endpoint"}, 404)

    # -- handlers --------------------------------------------------------
    def _capture(self):
        """Files pushed in from a ManageBac page by the bookmarklet.

        The browser is already signed in to ManageBac, so IT can read the
        attachments; this endpoint just receives what the page already had
        access to. No scraping of anything the student cannot already open,
        and no ManageBac credentials ever come near this server.
        """
        payload = json.loads(self._body() or b"{}")
        key = self.headers.get("X-Capture-Key", "")
        expected = store.capture_key()
        if not expected or key != expected:
            self.send_response(403)
            self._cors()
            body = json.dumps({"error": "capture key does not match"}).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        import base64
        saved, failed = [], []
        for f in payload.get("files", [])[:40]:
            m = re.match(r"data:([^;]*);base64,(.+)$", f.get("data", ""), re.S)
            if not m:
                failed.append(f.get("name", "?"))
                continue
            try:
                blob = base64.b64decode(m.group(2), validate=True)
            except Exception:
                failed.append(f.get("name", "?"))
                continue
            name = f.get("name", "file")
            # Never save a file that will not open. A login page dressed up as
            # a download is worse than no file at all.
            ok, why = pdftext.looks_valid(name, blob)
            if not ok:
                failed.append(f"{name}: {why}")
                continue
            text, _how = readfile.read(name, m.group(1), blob)
            row = store.add_document(payload.get("subject", ""), name,
                                     m.group(1), blob, text, "managebac")
            sync.push_document(row, blob)
            saved.append(row["name"])

        self.send_response(200)
        self._cors()
        body = json.dumps({"saved": saved, "failed": failed}).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _notes_from_documents(self, payload):
        """Turn the files in a notebook into SEPARATE, properly written notes.

        The first version concatenated every document into one 120,000-character
        note and ran a single AI pass over it. That pass blew straight past the
        free-tier limit, failed, and dumped the raw text — the Yeats poem, a
        worksheet's table and a PDF's broken bullets all in one note, some files
        twice. Three faults, fixed here:

          1. De-duplicate. The same file uploaded twice made the same note twice.
          2. Let the AI GROUP the files — a poem with its worksheet, general
             technique notes on their own — so each note is one coherent topic.
          3. Write each group SEPARATELY and small enough that the note actually
             gets written instead of falling back to raw text.
        """
        subject = (payload.get("subject") or "").strip()
        wanted = set(payload.get("ids") or [])
        docs = [d for d in store.documents(subject)
                if not wanted or d["id"] in wanted]
        if not docs:
            return self._json({"error": "there are no documents here yet"}, 400)

        # 1) Collect readable text, de-duplicated by name + opening content.
        seen, unique, empty = set(), [], []
        for d in docs:
            row = store.get_document(d["id"])
            text = (row or {}).get("text") or ""
            if len(text.split()) < 12:
                empty.append(d["name"])
                continue
            key = (d["name"].strip().lower(), text[:300])
            if key in seen:
                continue
            seen.add(key)
            unique.append({"name": d["name"], "text": text})

        if not unique:
            return self._json({
                "error": ("none of these files have readable text. "
                          + (", ".join(empty[:3]) if empty else "")
                          + " — scanned PDFs and .doc/.ppt need re-saving as "
                            ".docx/.pptx, and images need a Gemini key."),
            }, 400)

        # 2) Ask the model how to split them into coherent notes.
        groups = ai.group_documents(
            [{"name": u["name"], "excerpt": u["text"][:700]} for u in unique])
        by_name = {u["name"]: u for u in unique}

        profile = store.get_profile()
        created, failed = [], []
        for g in groups:
            members = [by_name[m] for m in g["members"] if m in by_name]
            if not members:
                continue
            # Small per-group input — this is why the write now succeeds where
            # one giant note failed. Each source is labelled so the note can
            # attribute a point or a quote to the right file.
            combined = "\n\n".join(
                f"[{m['name']}]\n{m['text']}" for m in members)[:30000]
            note = store.create_note(title=g["title"], subject=subject,
                                     topic=g.get("focus", ""))
            composed = ai.tidy(combined, profile, subject, g["title"])
            if composed.get("_failed"):
                # Keep the source in the body so "Write it up" can retry this one
                # note, rather than losing it.
                store.update_note(note["id"], body=combined)
                failed.append(g["title"])
                created.append(store.get_note(note["id"]))
                continue
            # A clean body: the source list, not a wall of raw text. The raw
            # text lives in the transcript so Ask can still search it.
            store.update_note(
                note["id"],
                body="Notes from: " + ", ".join(m["name"] for m in members),
                transcript=combined)
            out = _apply_composition(note, composed)
            created.append(out["note"])

        if not created:
            return self._json({"error": "the notes could not be written — "
                               + _plain_reason(ai.last_error() if hasattr(ai, "last_error") else "")}, 502)

        return self._json({
            "notes": created,
            "count": len(created),
            "used": [u["name"] for u in unique],
            "skipped": empty,
            "warning": (("some notes need a retry: " + ", ".join(failed)
                         + '. Open them and press "Write it up".')
                        if failed else ""),
        })

    def _notifications(self, mail_token: str, days: str = "14") -> dict:
        """One inbox for everything that wants the student's attention.

        The complaint about ManageBac was never that it lacks notifications —
        it is that everything lands in one clamped pile, so a graded discussion
        comment and an assignment due tomorrow look identical. So these are kept
        in separate streams, and anything urgent is lifted out of its stream to
        the top regardless of where it came from.
        """
        streams = {"urgent": [], "assignment": [], "discussion": [],
                   "admin": [], "other": []}

        # --- ManageBac ------------------------------------------------------
        rows = store.feed()
        for r in rows:
            band = managebac.band_for(r["due"] or r["starts"],
                                      timetabled=bool(r.get("timetabled")))
            kind = (r.get("kind") or "").lower()
            stream = ("assignment" if kind in ("assignment", "exam")
                      else "discussion" if kind in ("discussion", "message")
                      else "admin")
            item = {
                "id": r["uid"], "source": "managebac",
                "from": r.get("subject") or "ManageBac",
                "subject": r.get("title") or "",
                "snippet": (r.get("detail") or "")[:400],
                "stream": stream, "band": band,
                "urgent": band in ("overdue", "today", "soon"),
                "at": r.get("due") or r.get("starts"),
                "unread": not r.get("seen"),
                "url": r.get("url") or "",
            }
            streams["urgent" if item["urgent"] else stream].append(item)

        # --- School email ---------------------------------------------------
        email_state = {"connected": False, "address": "", "error": ""}
        if mail_token:
            try:
                who = mail.profile(mail_token)
                email_state = {"connected": True, "address": who["address"],
                               "error": ""}
                for m in mail.fetch(mail_token, limit=25, days=int(days or 14)):
                    streams["urgent" if m["urgent"] else m["stream"]].append(m)
            except mail.MailError as exc:
                email_state = {"connected": False, "address": "",
                               "error": str(exc)}
            except (ValueError, TypeError) as exc:
                email_state = {"connected": False, "address": "",
                               "error": f"could not read the mailbox: {exc}"}

        # Newest or soonest first inside every stream.
        for key in streams:
            streams[key].sort(key=lambda x: str(x.get("at") or ""), reverse=True)

        return {
            "streams": streams,
            "counts": {k: len(v) for k, v in streams.items()},
            "unread": sum(1 for v in streams.values() for i in v if i.get("unread")),
            "email": email_state,
            "managebac": {"configured": bool(
                store.get_profile().get("managebac_ics"))},
        }

    def _assessments(self) -> dict:
        """Upcoming FAs, tests and exams, each with what to revise from.

        Deliberately its own section. Homework is a deadline; a formative needs
        several days of revision before it, and burying the two in one list is
        how a test creeps up on you.
        """
        profile = store.get_profile()
        rows = store.assessments()
        past_rows = store.past_assessments()

        def shape(r: dict, gone: bool) -> dict:
            when = r.get("due") or r.get("starts")
            subject = r.get("subject") or ""
            notes = [n for n in store.notes(limit=200)
                     if (n.get("subject") or "").lower() == subject.lower()][:6]
            return {
                "uid": r["uid"],
                "title": r.get("title") or "",
                "subject": subject,
                "detail": (r.get("detail") or "")[:400],
                "when": when,
                "days": managebac.days_until(when),
                "band": "past" if gone else managebac.band_for(
                    when, timetabled=bool(r.get("timetabled"))),
                "url": r.get("url") or "",
                "revise_from": [{"id": n["id"], "title": n.get("title") or "Untitled",
                                 "topic": n.get("topic") or ""} for n in notes],
                "can_practise": bool(notes),
            }

        out = []
        for r in rows:
            out.append(shape(r, gone=False))

        return {
            "assessments": out,
            "past": [shape(r, gone=True) for r in past_rows],
            "count": len(out),
            "next": out[0] if out else None,
            "subjects": profile.get("subjects") or [],
            # Whether ManageBac is connected is NOT the same question as whether
            # anything is coming up. Without this the page showed "connect
            # ManageBac" to a student whose feed was connected and full — the
            # term's assessments had simply all been sat already.
            "configured": bool(profile.get("managebac_ics")),
            "total_known": len(out) + len(past_rows),
        }

    def _practice(self, payload) -> None:
        """Exam-style practice questions generated from the student's own notes."""
        note_id = (payload.get("note_id") or "").strip()
        subject = (payload.get("subject") or "").strip()
        count = payload.get("count") or 5

        if note_id:
            note = store.get_note(note_id)
            if not note:
                return self._json({"error": "no such note"}, 404)
            text = _note_text(note)
            subject = subject or note.get("subject") or ""
            topic = note.get("topic") or note.get("title") or ""
        else:
            # Whole-subject revision: pool the notes for that subject.
            notes = [n for n in store.notes(limit=200)
                     if (n.get("subject") or "").lower() == subject.lower()]
            if not notes:
                return self._json(
                    {"error": f"there are no notes in {subject or 'that subject'} "
                              "to practise from yet"}, 400)
            chunks = []
            for n in notes[:6]:
                full = store.get_note(n["id"])
                if full:
                    chunks.append(_note_text(full))
            text = "\n\n".join(chunks)
            topic = subject

        out = ai.practice(text, store.get_profile(), subject, topic, count)
        if out.get("_failed"):
            return self._json({"error": out["_failed"]}, 502)
        return self._json(out)

    def _document(self, doc_id: str):
        """Serve a stored file back for viewing or download."""
        row = store.get_document(doc_id)
        if not row:
            return self._json({"error": "no such document"}, 404)
        try:
            blob = Path(row["path"]).read_bytes()
        except OSError as exc:
            return self._json({"error": f"file missing on disk: {exc}"}, 410)
        self.send_response(200)
        self.send_header("Content-Type", row["mime"] or "application/octet-stream")
        self.send_header("Content-Length", str(len(blob)))
        self.send_header("Content-Disposition",
                         f'inline; filename="{row["name"]}"')
        self.end_headers()
        self.wfile.write(blob)

    def _upload(self, payload):
        """Accept a base64 data URL. Keeps the whole upload path JSON, so there
        is no multipart parser to get wrong for a file the student picked."""
        import base64

        data_url = payload.get("data") or ""
        m = re.match(r"data:([^;]*);base64,(.+)$", data_url, re.S)
        if not m:
            return self._json({"error": "that file could not be read"}, 400)
        mime, b64 = m.group(1), m.group(2)
        try:
            blob = base64.b64decode(b64, validate=True)
        except Exception as exc:
            return self._json({"error": f"could not decode the file — {exc}"}, 400)
        if len(blob) > 20 * 1024 * 1024:
            return self._json({"error": "files over 20 MB are not accepted"}, 413)

        name = payload.get("name", "file")
        # Check the file is what it claims BEFORE spending a vision call on it.
        ok, why = pdftext.looks_valid(name, blob)
        if not ok:
            return self._json({"error": why}, 400)

        text, how = readfile.read(name, mime, blob)
        row = store.add_document(payload.get("subject", ""), name, mime, blob, text)
        sync.push_document(row, blob)
        # Hand the extracted text back as well: the note editor appends it to
        # the body so the file becomes part of the note, not just a search hit.
        return self._json(row | {"readable": bool(text.strip()), "how": how,
                                 "words": len(text.split()),
                                 "text": text[:200000]})

    def _chunk(self):
        rec_id = self.headers.get("X-Recording", "")
        note_id = self.headers.get("X-Note", "")
        idx = int(self.headers.get("X-Chunk", "0"))

        rec = store.get_recording(rec_id)
        if not rec:
            # The recording row is gone — server restarted, database replaced,
            # whatever. The audio in this request is the irreplaceable part; a
            # missing row is not. Rebuild the session and keep the lesson.
            note = store.get_note(note_id) if note_id else None
            if not note:
                note = store.create_note(title="Recovered lesson")
            rebuilt = store.start_recording(note["id"])
            store.adopt_recording(rebuilt["id"], rec_id)
            rec = store.get_recording(rec_id) or rebuilt
            rec_id = rec["id"]
        # Hand Whisper the tail of what was heard just before this slice. It
        # uses it to carry names, spellings and subject vocabulary across the
        # cut. Without it every slice starts cold, so a term the teacher used
        # all lesson gets re-guessed each time and a word split across the
        # boundary is simply lost.
        prior = store.chunks(rec_id)
        context = " ".join((c.get("text") or "") for c in prior[-2:]).strip()
        try:
            out = transcribe.transcribe(
                self._body(), self.headers.get("X-Filename", "chunk.webm"),
                context=context)
        except transcribe.TranscriptionUnavailable as exc:
            return self._json({"error": str(exc), "degraded": True}, 503)

        text = out["text"]
        profile = store.get_profile()
        condensed = ai.condense(text, profile, store.today()) if text else {}
        store.add_chunk(rec_id, idx, text, condensed)
        return self._json({"index": idx, "text": text, "engine": out["engine"],
                           "points": len(condensed.get("points", [])),
                           "tasks": len(condensed.get("tasks", []))})

    def _finish(self, payload):
        rec = store.get_recording(payload.get("id", ""))
        if not rec:
            return self._json({"error": "no such recording"}, 404)
        note = store.get_note(rec["note_id"])
        if not note:
            return self._json({"error": "note vanished"}, 404)

        rows = store.chunks(rec["id"])
        transcript = "\n\n".join(r["text"] for r in rows if r["text"].strip())
        pieces = [r["condensed"] for r in rows]
        seconds = int(payload.get("seconds") or 0)
        store.finish_recording(rec["id"], seconds, len(transcript.split()))

        if not transcript.strip():
            return self._json({"note": note, "tasks": [], "empty": True,
                               "message": "Nothing was transcribed — check the mic."})

        # If this note already has content, we are resuming a topic — hand the
        # existing note to the composer so it merges instead of duplicating.
        previous = note if note.get("blocks") else None
        composed = ai.compose(pieces, store.get_profile(),
                              note["subject"], note["topic"], store.today(),
                              previous=previous, transcript=transcript)
        result = _apply_composition(note, composed, transcript)
        result["seconds"] = seconds
        result["words"] = len(transcript.split())
        result["chunks"] = len(rows)
        return self._json(result)

    def _ask(self, payload):
        question = (payload.get("question") or "").strip()
        if not question:
            return self._json({"error": "empty question"}, 400)
        note_id = payload.get("note_id") or ""

        contexts = []
        if note_id:
            note = store.get_note(note_id)
            if note:
                contexts.append({
                    "label": "this note", "id": note["id"],
                    "title": note["title"],
                    "text": (note["body"] or "") + "\n" + (note["transcript"] or ""),
                })
        contexts += [c for c in search.find(question, 4)
                     if c["id"] != note_id]

        used_web = False
        if search.confidence(question) < 0.45 and payload.get("web", True):
            web = _web_search(question)
            if web:
                used_web = True
                contexts.append({"label": "WEB", "id": "", "title": "Web results",
                                 "text": web})

        text = ai.answer(question, contexts, store.get_profile())
        return self._json({
            "answer": text,
            "sources": [{"label": c["label"], "id": c["id"], "title": c["title"]}
                        for c in contexts],
            "used_web": used_web,
            "from_notes": any(c["label"] != "WEB" for c in contexts),
        })


def _web_search(query: str) -> str:
    """DuckDuckGo HTML. Free, no key. Returns '' if the network blocks it."""
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": ai.USER_AGENT})
    try:
        with net.urlopen(req, timeout=12) as resp:
            body = resp.read().decode("utf-8", "replace")
    except Exception:
        return ""
    import html as html_mod

    out = []
    pattern = re.compile(
        r'result__a"[^>]*>(?P<title>.*?)</a>.*?result__snippet"[^>]*>(?P<snip>.*?)</a>',
        re.S)
    for m in pattern.finditer(body):
        clean = lambda s: html_mod.unescape(re.sub(r"<[^>]+>", "", s)).strip()
        out.append(f"- {clean(m.group('title'))}: {clean(m.group('snip'))[:240]}")
        if len(out) >= 4:
            break
    return "\n".join(out)


BUSY = ROOT / "data" / ".busy"


def busy(delta: int) -> None:
    """Track in-flight requests so the reload watcher does not kill one.

    Writing a note takes the better part of a minute. Restarting the server in
    that window drops the request and the student sees "Failed to fetch" with
    the lesson apparently lost. The watcher waits while this count is above 0.
    """
    try:
        BUSY.parent.mkdir(parents=True, exist_ok=True)
        n = int(BUSY.read_text()) if BUSY.exists() else 0
        n = max(0, n + delta)
        BUSY.write_text(str(n))
    except (OSError, ValueError):
        pass


def serve() -> None:
    mimetypes.add_type("application/javascript", ".js")
    config.load_env()
    store.init()

    profile = store.get_profile()
    # Hosting platforms (Render, Railway, Fly) hand the process a $PORT and
    # expect it on 0.0.0.0. Locally neither is set, so it stays on
    # 127.0.0.1:7400 — private to this machine, which is the right default for
    # a laptop. One rule, no config file to edit when deploying.
    # A hosting platform hands the process a $PORT and routes to it from
    # outside the container, which only works if we listen on every interface.
    #
    # Read PORT from the real environment, never through config.env: that helper
    # also loads the .env file, and run.py writes a starter .env containing
    # EVIE_HOST=127.0.0.1 for local use. On the server that file did not exist
    # until the process itself created it — so the template's 127.0.0.1 won,
    # the app bound to localhost inside the container, and Render's router had
    # nothing to reach. The deploy looked healthy and the site never answered.
    hosted_port = os.environ.get("PORT", "").strip()
    if hosted_port:
        host = "0.0.0.0"                      # not negotiable when hosted
        port = int(hosted_port)
    else:
        host = config.env("EVIE_HOST", "127.0.0.1")
        port = int(config.env("EVIE_PORT", "7400") or 7400)

    print()
    print("  Minerva — notes for students")
    print(f"  student   {profile['name'] or '(not set up yet)'}"
          + (f" · {profile['grade']} · {profile['curriculum']}"
             if profile["onboarded"] else ""))
    a, s = ai.status(), transcribe.status()
    print(f"  brain     {'groq · ' + a['model'] if a['ok'] else '** ' + a['reason']}")
    print(f"  recording {'ready' if s['ok'] else '** off — ' + s['reason']}")
    print(f"  managebac {'linked' if profile['managebac_ics'] else 'not linked yet'}")
    if net.status()["relaxed_strict_x509"]:
        print("  tls       relaxed strict-X509 (TLS inspection on this network)")
    print()
    print(f"  http://{host}:{port}")
    print()
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    serve()

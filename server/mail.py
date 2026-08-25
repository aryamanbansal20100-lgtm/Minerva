"""School email, read-only, without ever holding a password.

Why there is no password field anywhere in this file:

  * School Google Workspace accounts almost always have IMAP and basic
    authentication switched off by the admin, and enforce single sign-on. A
    password typed into this app would simply be refused, so the feature would
    not work even if the password were stored.
  * Storing a school password in a local SQLite file is a real risk to the
    student for no gain.

So the student signs in with Google — which they already do — and grants one
extra read-only Gmail scope. Google hands the browser a short-lived access
token, the browser passes it to this process for the length of one request, and
nothing is kept. No password is seen, stored or transmitted, and access can be
revoked from the Google account page at any time.

The token is deliberately NOT persisted. It expires in about an hour and the
student reconnects; that is a fair trade for never holding a long-lived
credential to a school inbox.
"""
from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from . import net

API = "https://gmail.googleapis.com/gmail/v1/users/me"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


class MailError(Exception):
    """Something went wrong that the student needs told about plainly."""


def _get(path: str, token: str, **params) -> dict:
    url = f"{API}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "User-Agent": USER_AGENT,
    })
    try:
        with net.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300].decode("utf-8", "replace")
        if exc.code in (401, 403):
            if "insufficient" in detail.lower() or "scope" in detail.lower():
                raise MailError(
                    "Minerva is not allowed to read this inbox yet. Press "
                    "“Connect school email” again and tick the "
                    "permission Google asks for.") from exc
            low = detail.lower()
            # "disabled" appears in two completely different situations and
            # blaming the school for the other one sends the student to their
            # IT department over a setting only I control.
            if "has not been used in project" in low or "accessnotconfigured" in low:
                raise MailError(
                    "the Gmail API is not switched on for this app yet. In "
                    "Google Cloud Console for project note-ta, open "
                    "APIs & Services -> Library, search Gmail API and press "
                    "Enable. Then try again.") from exc
            if "consent" in low or "unverified" in low or "not been verified" in low:
                raise MailError(
                    "Google has not approved this app for reading mail yet. Add "
                    "your address as a Test user on the OAuth consent screen in "
                    "Google Cloud Console.") from exc
            if ("policy" in low or "admin" in low or "org_internal" in low
                    or "disabled" in low):
                raise MailError(
                    "your school has blocked outside apps from reading school "
                    "email. Only a school IT admin can allow it. "
                    f"(Google said: {detail[:110]})") from exc
            raise MailError(
                "the email permission has expired — press "
                "“Connect school email” again.") from exc
        if exc.code == 429:
            raise MailError("Google is rate-limiting the mailbox. "
                            "Try again in a minute.") from exc
        raise MailError(f"Gmail returned {exc.code}: {detail[:120]}") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise MailError(f"could not reach Gmail: {exc}") from exc


def _header(msg: dict, name: str) -> str:
    for h in (msg.get("payload") or {}).get("headers") or []:
        if h.get("name", "").lower() == name.lower():
            return h.get("value") or ""
    return ""


def _body_text(payload: dict, depth: int = 0) -> str:
    """Pull the plain-text body out of a MIME tree."""
    if depth > 6 or not isinstance(payload, dict):
        return ""
    mime = payload.get("mimeType") or ""
    data = ((payload.get("body") or {}).get("data")) or ""
    if data and mime.startswith("text/"):
        try:
            raw = base64.urlsafe_b64decode(data + "==").decode("utf-8", "replace")
        except Exception:
            return ""
        if mime == "text/html":
            raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw,
                         flags=re.S | re.I)
            raw = re.sub(r"<[^>]+>", " ", raw)
        return raw
    best = ""
    for part in payload.get("parts") or []:
        got = _body_text(part, depth + 1)
        # Prefer plain text over the HTML alternative.
        if got and ((part.get("mimeType") == "text/plain") or not best):
            best = got if part.get("mimeType") == "text/plain" else (best or got)
    return best


# Which stream a message belongs in. Rules first, deliberately: they are free,
# instant and predictable, and the free AI tier has a hard tokens-per-minute
# ceiling that classifying an inbox would blow straight through.
URGENT = re.compile(
    r"\b(urgent|immediately|today|asap|deadline|overdue|late|missing|detention|"
    r"reminder|final (?:notice|call)|action required|by end of day|eod)\b", re.I)
ASSIGNMENT = re.compile(
    r"\b(assignment|homework|hand ?in|submit|submission|due|coursework|"
    r"essay|worksheet|task|assessment|exam|test|quiz|revision|ia |internal "
    r"assessment|ee |extended essay|tok|deadline)\b", re.I)
DISCUSSION = re.compile(
    r"\b(discussion|reply|replied|comment|commented|thread|question|"
    r"clarification|feedback|responded|posted)\b", re.I)
ADMIN = re.compile(
    r"\b(newsletter|circular|holiday|timetable|trip|permission slip|fee|"
    r"payment|consent|photo|assembly|notice|bulletin|calendar)\b", re.I)

# Senders that are educational by their address: school domains, and the
# platforms schools actually use. .edu / .ac / .sch / .edu.<cc> cover most
# schools and universities worldwide.
EDU_SENDER = re.compile(
    r"(@[^@\s]*\.(edu|ac|sch)(\.|)|@[^@\s]*\.edu\.[a-z]{2}|"
    r"managebac\.com|classroom\.google\.com|@[^@\s]*school[^@\s]*|"
    r"khanacademy|turnitin|@[^@\s]*\.k12\.)", re.I)


def educational(sender: str, subject: str, snippet: str,
                student_domain: str = "") -> bool:
    """Is this school/study mail, as opposed to personal or promotional?

    True when the sender is a school or a study platform, when it comes from the
    student's OWN school domain, or when the words are unmistakably schoolwork
    (an assignment, a discussion, a test). This is what lets the inbox show
    "educational" apart from the rest.
    """
    s = (sender or "").lower()
    if EDU_SENDER.search(s):
        return True
    if student_domain and student_domain.lower() in s:
        return True
    blob = f"{subject} {snippet}"
    return bool(ASSIGNMENT.search(blob) or DISCUSSION.search(blob))


# Mail that is not school business at all.
NOISE = re.compile(
    r"(noreply@|no-reply@|newsletter@|marketing@|unsubscribe|promotions?@)", re.I)


def classify(subject: str, sender: str, snippet: str) -> tuple[str, bool]:
    """Return (stream, urgent). Streams: assignment, discussion, admin, other."""
    blob = f"{subject} {snippet}"
    urgent = bool(URGENT.search(blob))
    if ASSIGNMENT.search(blob):
        return "assignment", urgent
    if DISCUSSION.search(blob):
        return "discussion", urgent
    if ADMIN.search(blob):
        return "admin", urgent
    return "other", urgent


def fetch(token: str, limit: int = 25, days: int = 14,
          important: set[str] | None = None,
          student_domain: str = "") -> list[dict]:
    """Recent mail, newest first, split into streams.

    Read-only. Nothing is marked read, moved, replied to or deleted — the scope
    granted does not even permit it. `important` is the set of addresses/@domains
    the student has starred; anything matching is lifted to urgent so it sits at
    the very top, and every message is tagged educational-or-not.
    """
    if not token:
        raise MailError("no email permission yet — press "
                        "“Connect school email”.")
    important = important or set()
    limit = max(1, min(150, int(limit or 25)))
    query = f"in:inbox newer_than:{max(1, min(60, int(days or 14)))}d"
    listing = _get("messages", token, q=query, maxResults=limit)
    out = []
    for stub in (listing.get("messages") or [])[:limit]:
        try:
            msg = _get(f"messages/{stub['id']}", token, format="full")
        except MailError:
            continue
        subject = _header(msg, "Subject") or "(no subject)"
        sender = _header(msg, "From")
        snippet = (msg.get("snippet") or "").strip()
        if NOISE.search(sender) and not ASSIGNMENT.search(subject):
            continue
        stream, urgent = classify(subject, sender, snippet)
        body = _body_text(msg.get("payload") or {})
        name = re.sub(r"\s*<[^>]*>", "", sender).strip(' "') or sender
        address = (re.search(r"<([^>]+)>", sender) or [None, sender])[1]
        addr_l = (address or "").strip().lower()
        keys = [addr_l] + (["@" + addr_l.split("@", 1)[1]] if "@" in addr_l else [])
        starred = any(k in important for k in keys)
        out.append({
            "id": msg.get("id"),
            "source": "email",
            "from": name,
            "address": address,
            "subject": subject,
            "snippet": snippet[:400],
            "body": (body or snippet)[:6000],
            "stream": stream,
            # A starred sender is always urgent, so it leads the inbox.
            "urgent": urgent or starred,
            "important": starred,
            "educational": educational(sender, subject, snippet, student_domain),
            "at": _header(msg, "Date"),
            "unread": "UNREAD" in (msg.get("labelIds") or []),
            "url": f"https://mail.google.com/mail/u/0/#inbox/{msg.get('id')}",
        })
    return out


def profile(token: str) -> dict:
    """Which mailbox this token opens. Shown so the student can see it is the
    school account and not their personal one."""
    got = _get("profile", token)
    return {"address": got.get("emailAddress", ""),
            "total": got.get("messagesTotal", 0)}


# Which inbox a message belongs to. A student's mail is not one pile: school
# systems, teachers, and parents writing about them are different kinds of
# thing and want reading differently.
SCHOOL_HINTS = ("managebac", "school", "edu", "sns", "academic", "principal",
                "admin", "office", "teacher", "faculty", "library")
PARENT_WORDS = re.compile(
    r"\b(parent|guardian|mother|father|mum|mom|dad|family|ptm|"
    r"parent[- ]teacher|fees?|transport|bus)\b", re.I)


def mailbox(sender: str, address: str, subject: str, student_domain: str = "") -> str:
    """Sort one message into an inbox: school, parents, teachers or other."""
    addr = (address or "").lower()
    domain = addr.split("@")[-1] if "@" in addr else ""
    blob = f"{sender} {subject}"

    if PARENT_WORDS.search(blob):
        return "parents"
    if "managebac" in domain or "managebac" in blob.lower():
        return "school"
    # Mail from inside the student's own school domain is school mail.
    if student_domain and domain.endswith(student_domain):
        return "teachers" if "@" in addr and not any(
            h in addr.split("@")[0] for h in ("no-reply", "noreply", "admin",
                                              "office", "info")) else "school"
    if any(h in domain for h in SCHOOL_HINTS):
        return "school"
    return "other"

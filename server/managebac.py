"""managebac.py — reads your ManageBac calendar feed and organises it properly.

Why a feed and not the API: ManageBac's Public API tokens are minted by a
school administrator with chosen permissions. A student cannot create one. The
personal calendar subscription URL, though, is yours — My Workspace ->
Subscribe to Calendar. Assignments and deadlines land in it automatically.

What this module adds, which ManageBac itself does not:

  * **Separate streams.** Assignments, exams, events and admin are different
    kinds of thing and get different lists. ManageBac pours them into one.
  * **Real urgency.** Overdue / today / 48 hours / this week / later, computed
    from the deadline, not from a colour someone picked.
  * **New vs seen.** An item you have never looked at is genuinely new. That is
    what a notification should mean, and it is why `seen` lives in the database
    instead of being guessed.

The ICS parser is hand-rolled against RFC 5545: unfolding, escaped commas and
semicolons, and both DATE and DATE-TIME values including TZID and Z forms. No
third-party calendar library.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

from . import config, net

# Classification is keyword-driven and deliberately transparent — you can read
# exactly why something was filed where, which is more useful than a model
# guessing differently each refresh.
ASSIGNMENT_WORDS = re.compile(
    r"\b(assignment|homework|task|submission|submit|due|hand ?in|worksheet|"
    r"essay|report|portfolio|draft|ia\b|ee\b|tok\b|cas\b|lab|problem set|"
    r"assessment|coursework|project)\b", re.I)
# FA and SA are what IB schools actually write in ManageBac — "FA 2",
# "Formative Assessment", "Summative". Without them a formative landed in the
# generic pile (or worse, "event"), which is exactly the thing a student most
# needs warned about. Checked FIRST, before the assignment words, because
# "Formative Assessment" contains "assessment" and would otherwise be caught
# by the assignment rule.
EXAM_WORDS = re.compile(
    r"\b(exam|test|quiz|paper ?[123]|mock|midterm|final|assessment week|"
    r"viva|oral|presentation|fa ?\d+|sa ?\d+|formative|summative|"
    r"unit test|class test|mcq)\b", re.I)
EVENT_WORDS = re.compile(
    r"\b(trip|assembly|meeting|holiday|break|ceremony|sports|match|concert|"
    r"parents?[' ]?evening|orientation|workshop|club|practice|rehearsal)\b", re.I)
ADMIN_WORDS = re.compile(
    r"\b(deadline for|form|consent|payment|fee|register|sign ?up|survey|"
    r"reminder|notice|circular)\b", re.I)

# Only a bracketed prefix is unambiguously a subject. Real ManageBac feeds
# write things like "Literary Analysis - Poetry" and "Homework: Price
# Mechanism", where the left half is the ASSESSMENT TYPE, not the class. An
# earlier version split on the dash and confidently filed work under a subject
# called "Literary Analysis". Anything less certain than a bracket now has to
# match a subject the student actually told us they take.
BRACKET_SUBJECT = re.compile(r"^\s*\[([^\]]{2,40})\]\s*(.+)$")

# Assessment-type prefixes to strip from the title but never treat as subjects.
TYPE_PREFIX = re.compile(
    r"^\s*(homework|classwork|class assignment|assignment|quiz|test|exam|"
    r"summative|formative|task|worksheet|lab|practical|essay|project|"
    r"literary analysis|revision|presentation|oral)\s*[:–—-]\s*", re.I)


class FeedError(Exception):
    """Surfaced on screen. A broken feed never looks like an empty one."""


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------
def normalise_url(url: str) -> str:
    url = (url or "").strip()
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    return url


def fetch_ics(url: str, timeout: int = 25) -> str:
    url = normalise_url(url)
    if not url:
        raise FeedError("no ManageBac calendar URL saved yet")
    if not url.lower().startswith(("http://", "https://")):
        raise FeedError(f"that does not look like a calendar URL: {url[:60]}")
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; Evie/1.0; student notebook)",
        "Accept": "text/calendar, text/plain, */*",
    })
    try:
        with net.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise FeedError(
            f"ManageBac returned {exc.code}. If it is 401 or 403 the link has "
            "been regenerated — copy a fresh one from Subscribe to Calendar."
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FeedError(f"could not reach ManageBac — {exc}") from exc

    if "BEGIN:VCALENDAR" not in body:
        raise FeedError(
            "that URL did not return a calendar. Use the link from "
            "My Workspace -> Subscribe to Calendar, not the page address."
        )
    return body


# ---------------------------------------------------------------------------
# Parse — RFC 5545, by hand
# ---------------------------------------------------------------------------
def _unfold(text: str) -> list[str]:
    """Continuation lines start with a space or tab and belong to the line above."""
    out: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and out:
            out[-1] += raw[1:]
        else:
            out.append(raw)
    return out


def _unescape(value: str) -> str:
    return (value.replace("\\n", "\n").replace("\\N", "\n")
                 .replace("\\,", ",").replace("\\;", ";")
                 .replace("\\\\", "\\")).strip()


def _parse_dt(value: str) -> tuple[str | None, bool]:
    """Returns (ISO string, is_all_day). Naive local time; good enough for school."""
    value = value.strip()
    if not value:
        return None, False
    if re.fullmatch(r"\d{8}", value):                      # DATE
        try:
            d = datetime.strptime(value, "%Y%m%d")
            return d.date().isoformat(), True
        except ValueError:
            return None, False
    m = re.fullmatch(r"(\d{8})T(\d{6})(Z?)", value)        # DATE-TIME
    if m:
        try:
            dt = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
        except ValueError:
            return None, False
        if m.group(3) == "Z":
            # The feed marks UTC; convert to local so a 23:59 deadline reads as
            # 23:59 on your clock. Timezone-aware conversion, not a subtraction
            # of two clock readings — that drifts by the microseconds between
            # the two calls and turned 14:30 into 14:29:59.
            dt = dt.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
        return dt.isoformat(timespec="seconds"), False
    return None, False


def parse_events(ics: str) -> list[dict]:
    events, current = [], None
    for line in _unfold(ics):
        if line.startswith("BEGIN:VEVENT"):
            current = {}
            continue
        if line.startswith("END:VEVENT"):
            if current is not None:
                events.append(current)
            current = None
            continue
        if current is None or ":" not in line:
            continue
        head, _, value = line.partition(":")
        name = head.split(";")[0].upper()
        if name in ("SUMMARY", "DESCRIPTION", "LOCATION", "UID", "URL",
                    "CATEGORIES", "STATUS"):
            current[name] = _unescape(value)
        elif name in ("DTSTART", "DTEND", "DUE"):
            iso, all_day = _parse_dt(value)
            current[name] = iso
            if name == "DTSTART":
                current["ALLDAY"] = all_day
    return events


# ---------------------------------------------------------------------------
# Classify
# ---------------------------------------------------------------------------
def split_subject(summary: str, known: list[str] | None = None) -> tuple[str, str]:
    """Return (subject, title). Subject is '' unless we are actually sure.

    Guessing a subject is worse than leaving it blank: a wrong subject sends the
    work to the wrong notebook and quietly hides it.
    """
    m = BRACKET_SUBJECT.match(summary)
    if m:
        return m.group(1).strip(), m.group(2).strip()

    text = summary.strip()
    for name in sorted(known or [], key=len, reverse=True):
        if not name.strip():
            continue
        pattern = re.compile(r"^\s*" + re.escape(name.strip()) + r"\s*[:–—-]\s*(.+)$", re.I)
        hit = pattern.match(text)
        if hit:
            return name.strip(), hit.group(1).strip()
        if re.search(r"\b" + re.escape(name.strip()) + r"\b", text, re.I):
            return name.strip(), text

    return "", TYPE_PREFIX.sub("", text).strip() or text


def classify(summary: str, description: str, categories: str) -> str:
    hay = f"{summary} {description} {categories}"
    if EXAM_WORDS.search(hay):
        return "exam"
    if ASSIGNMENT_WORDS.search(hay):
        return "assignment"
    if ADMIN_WORDS.search(hay):
        return "admin"
    if EVENT_WORDS.search(hay):
        return "event"
    return "event"


def item_url(uid: str, feed_url: str) -> str:
    """A ManageBac link for one calendar entry — one that actually resolves.

    The feed carries no URL, so the link has to be reconstructed. An earlier
    version guessed `/student/events/<uid>` because that path answered 302 to
    the login page while other paths answered 404. That reasoning was wrong:
    ManageBac redirects *everything* under /student/ to login when you are
    signed out, so the 302 only proved the auth gate exists. Signed in, the
    same URL is a 404.

    Without an authenticated session there is no way to verify the real item
    path, so the default is the dashboard: it always resolves, and lands you
    signed in one click from the item. Set EVIE_MB_ITEM_URL to a pattern
    containing {uid} (copied from a real assignment page) to get true deep
    links.
    """
    host = urllib.parse.urlparse(normalise_url(feed_url)).netloc
    if not host:
        return ""
    pattern = config.env("EVIE_MB_ITEM_URL", "")
    if pattern and "{uid}" in pattern and str(uid).isdigit():
        return pattern.replace("{uid}", str(uid)).replace("{host}", host)
    return f"https://{host}/student"


def to_items(events: list[dict], known_subjects: list[str] | None = None,
             feed_url: str = "") -> list[dict]:
    items = []
    for ev in events:
        summary = ev.get("SUMMARY", "").strip()
        if not summary:
            continue
        subject, title = split_subject(summary, known_subjects)
        kind = classify(summary, ev.get("DESCRIPTION", ""), ev.get("CATEGORIES", ""))

        # A ManageBac entry with both a start and an end time is a timetabled
        # lesson slot, not a deadline — the assessment is simply attached to the
        # period it happened in. Treating those as due dates marked every past
        # lesson "overdue", which is noise of exactly the kind this app exists
        # to remove. Only an explicit DUE, or an all-day entry, is a deadline.
        explicit_due = ev.get("DUE")
        all_day = bool(ev.get("ALLDAY"))
        timetabled = bool(ev.get("DTSTART")) and bool(ev.get("DTEND")) and not all_day
        due = explicit_due or (None if timetabled else ev.get("DTSTART"))

        uid = ev.get("UID") or f"{summary}|{ev.get('DTSTART')}"
        items.append({
            "uid": uid,
            "kind": kind,
            "title": title,
            "subject": subject,
            "detail": ev.get("DESCRIPTION", "")[:1200],
            "due": due if kind in ("assignment", "exam", "admin") else None,
            "starts": ev.get("DTSTART"),
            "timetabled": timetabled,
            "url": ev.get("URL") or item_url(uid, feed_url),
            "raw": summary,
        })
    return items


# ---------------------------------------------------------------------------
# Urgency — computed, not colour-coded by a teacher
# ---------------------------------------------------------------------------
BANDS = ("overdue", "today", "tomorrow", "this_week", "later", "past", "undated")


def band_for(due: str | None, ref: datetime | None = None,
             timetabled: bool = False) -> str:
    """Which urgency band something falls in.

    `timetabled` separates "this lesson already happened" from "you have missed
    a deadline". Both are in the past; only one needs you to do anything.
    """
    if not due:
        return "undated"
    ref = ref or datetime.now()
    try:
        when = datetime.fromisoformat(due)
    except ValueError:
        try:
            when = datetime.combine(date.fromisoformat(due[:10]), datetime.min.time())
        except ValueError:
            return "undated"
    if when.date() < ref.date():
        return "past" if timetabled else "overdue"
    days = (when.date() - ref.date()).days
    if days == 0:
        return "today"
    if days == 1:
        return "tomorrow"
    if days <= 7:
        return "this_week"
    return "later"


def days_until(due: str | None, ref: datetime | None = None) -> int | None:
    if not due:
        return None
    ref = ref or datetime.now()
    try:
        when = datetime.fromisoformat(due).date()
    except ValueError:
        try:
            when = date.fromisoformat(due[:10])
        except ValueError:
            return None
    return (when - ref.date()).days


def organise(items: list[dict]) -> dict:
    """The whole point: separate streams, real urgency, honest counts."""
    streams: dict[str, list[dict]] = {"assignment": [], "exam": [],
                                      "event": [], "admin": []}
    for it in items:
        enriched = dict(it)
        when = it.get("due") or it.get("starts")
        enriched["band"] = band_for(when, timetabled=bool(it.get("timetabled")))
        enriched["days"] = days_until(when)
        streams.setdefault(it["kind"], []).append(enriched)

    order = {b: i for i, b in enumerate(BANDS)}
    for rows in streams.values():
        rows.sort(key=lambda r: (order.get(r["band"], 9), r.get("due") or "9999"))

    needs_action = [r for r in streams["assignment"] + streams["exam"] + streams["admin"]
                    if r["band"] in ("overdue", "today", "tomorrow", "this_week")]
    unseen = [r for r in items if not r.get("seen")]

    return {
        "streams": streams,
        "counts": {k: len(v) for k, v in streams.items()},
        "urgent": [r for r in needs_action if r["band"] in ("overdue", "today")],
        "needs_action": needs_action,
        "unseen": len(unseen),
        "bands": {b: sum(1 for r in needs_action if r["band"] == b) for b in BANDS},
    }


def refresh(url: str, known_subjects: list[str] | None = None) -> list[dict]:
    return to_items(parse_events(fetch_ics(url)), known_subjects, url)

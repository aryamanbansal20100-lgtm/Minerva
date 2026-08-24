"""timetable.py — your week, read from a photo or typed in by hand.

Reading the image needs a vision model, and Groq does not currently serve one
(their catalogue is text + Whisper only — checked against the live model list,
no llama-vision, no scout). Google's Gemini 2.0 Flash is multimodal and free
without a card, so that is what the image path uses.

There is always a manual path too. A feature that only works if you have a
second API key is a feature that does not work.

Reminders are computed here and polled by the page: the browser owns
notifications, the server owns the schedule.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from . import ai, config, net

GEMINI_URL = ("https://generativelanguage.googleapis.com/v1beta/models/"
              "{model}:generateContent?key={key}")

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
        "Saturday", "Sunday"]

# Subjects offered per curriculum. Used to prefill setup so the student picks
# from a list instead of typing six subject names correctly.
CURRICULUM_SUBJECTS = {
    "IB Diploma Programme": [
        "English A Language and Literature", "English A Literature",
        "Hindi B", "French B", "Spanish AB initio",
        "Economics", "Business Management", "History", "Psychology",
        "Geography", "Global Politics",
        "Biology", "Chemistry", "Physics", "Computer Science",
        "Design Technology", "Environmental Systems and Societies",
        "Mathematics AA", "Mathematics AI",
        "Visual Arts", "Theatre", "Music",
        "Theory of Knowledge", "Extended Essay", "CAS",
    ],
    "IB MYP": [
        "Language and Literature", "Language Acquisition", "Individuals and Societies",
        "Sciences", "Mathematics", "Arts", "Physical and Health Education",
        "Design", "Personal Project",
    ],
    "CBSE": [
        "English Core", "Hindi Core", "Mathematics", "Physics", "Chemistry",
        "Biology", "Computer Science", "Informatics Practices", "Accountancy",
        "Business Studies", "Economics", "History", "Political Science",
        "Geography", "Psychology", "Physical Education",
    ],
    "ICSE / ISC": [
        "English", "Hindi", "Mathematics", "Physics", "Chemistry", "Biology",
        "Computer Science", "Commerce", "Accounts", "Economics", "History",
        "Geography", "Physical Education",
    ],
    "Cambridge IGCSE": [
        "First Language English", "Mathematics", "Additional Mathematics",
        "Physics", "Chemistry", "Biology", "Computer Science", "Economics",
        "Business Studies", "History", "Geography", "Global Perspectives",
    ],
    "Cambridge A Level": [
        "Mathematics", "Further Mathematics", "Physics", "Chemistry", "Biology",
        "Computer Science", "Economics", "Business", "Psychology", "English Literature",
    ],
    "Edexcel / GCSE": [
        "English Language", "English Literature", "Mathematics", "Combined Science",
        "Physics", "Chemistry", "Biology", "Computer Science", "History",
        "Geography", "Business",
    ],
    "AP / US High School": [
        "AP Calculus AB", "AP Calculus BC", "AP Physics 1", "AP Physics C",
        "AP Chemistry", "AP Biology", "AP Computer Science A", "AP Statistics",
        "AP English Language", "AP English Literature", "AP US History",
        "AP World History", "AP Macroeconomics", "AP Microeconomics",
    ],
}


# Google retires model names without warning: `gemini-2.0-flash` did not exist
# on this key at all, and `gemini-2.5-flash` answered
# "no longer available to new users". Hardcoding one name means the feature
# breaks on a day Google chooses. Try the configured model first, then walk a
# preference list, and remember whichever answered.
MODEL_CANDIDATES = [
    "gemini-flash-latest",      # alias, tracks the current flash model
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
]

_working_model = ""


class TimetableError(Exception):
    """Shown on screen. Reading a timetable can fail in ways worth explaining."""


PERIOD_OBJ = re.compile(r"\{[^{}]*?\"day\"\s*:.*?\}", re.S)


def _periods_from(text: str) -> list[dict]:
    """Get the periods out, even when the JSON is truncated.

    A full week is a lot of objects and the model can hit its output ceiling
    mid-array, leaving `Expecting ',' delimiter`. Throwing the whole reply away
    at that point loses a timetable that was 90% correct, so: try strict JSON
    first, and if that fails, salvage every complete period object that did
    arrive. A partial timetable you can top up beats an error message.
    """
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(text[start:end + 1])
            rows = normalise(parsed.get("periods") or [])
            if rows:
                return rows
        except ValueError:
            pass

    salvaged = []
    for m in PERIOD_OBJ.finditer(text):
        try:
            salvaged.append(json.loads(m.group(0)))
        except ValueError:
            continue
    return normalise(salvaged)


def _call_gemini(payload: dict, key: str) -> dict:
    global _working_model
    tried, last, quota = [], "", False
    order = ([_working_model] if _working_model else []) \
        + ([config.env("GEMINI_MODEL")] if config.env("GEMINI_MODEL") else []) \
        + MODEL_CANDIDATES
    for model in dict.fromkeys(m for m in order if m):
        req = urllib.request.Request(
            GEMINI_URL.format(model=model, key=key),
            data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json", "User-Agent": ai.USER_AGENT})
        try:
            with net.urlopen(req, timeout=150) as resp:
                _working_model = model
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:200].decode("utf-8", "replace")
            tried.append(f"{model} ({exc.code})")
            last = detail
            # 429 is a per-model daily quota on the free tier, not an account
            # ban — the next model in the list usually still has budget. Raising
            # on the first one meant a single exhausted model killed timetable
            # reading and image reading for the rest of the day.
            if exc.code == 429:
                quota = True
                # Stop preferring this model: it is cached as "the one that
                # works", and an exhausted model retried first every time turns
                # one dead model into a dead feature.
                if _working_model == model:
                    _working_model = ""
                continue
            if exc.code == 503:                     # transient "high demand"
                continue
            if exc.code not in (404, 400, 403):     # a real failure, not a dead name
                raise TimetableError(f"Gemini {exc.code}: {detail}") from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise TimetableError(f"Gemini unreachable: {exc}") from exc
    if quota:
        raise TimetableError(
            "today's free Google AI quota is used up. It resets at midnight "
            "US Pacific time (about 12:30 pm India time). Notes still work — "
            "they fall back to the other AI — but reading timetable photos and "
            "images needs Google, so those wait until the reset.")
    raise TimetableError(
        f"No Gemini model accepted the request. Tried: {', '.join(tried)}. {last[:150]}")


def subjects_for(curriculum: str) -> list[str]:
    if not curriculum:
        return []
    for name, subs in CURRICULUM_SUBJECTS.items():
        if name.lower() == curriculum.lower():
            return subs
    return []


def vision_available() -> bool:
    return bool(config.env("GEMINI_API_KEY"))


def status() -> dict:
    return {
        "vision": vision_available(),
        "reason": "" if vision_available() else (
            "Reading a timetable photo needs a free Gemini key — Groq has no "
            "vision model. Get one at aistudio.google.com/apikey and put it in "
            ".env as GEMINI_API_KEY. You can always build the grid by hand instead."
        ),
    }


# ---------------------------------------------------------------------------
# Image -> structured timetable, via Gemini
# ---------------------------------------------------------------------------
READ_PROMPT = """Read this school timetable image and return JSON only.

{"periods":[{"day":"Monday","start":"08:20","end":"09:40","subject":str,"room":str,"teacher":str}],
 "notes":str}

Rules:
- 24-hour times, zero padded. "8.20" becomes "08:20".
- One object per period per day. If a subject runs on four days, emit four objects.
- "day" must be one of Monday..Sunday, spelled in full.
- Copy subject names exactly as printed, including HL/SL.
- Leave room and teacher as "" when the timetable does not show them.
- Skip breaks, lunch and free periods unless they are named subjects.
- If the image is unreadable or is not a timetable, return {"periods":[],"notes":"why"}.
- Never invent a period that is not visible in the image."""


def read_image(data_url: str, subjects: list[str] | None = None) -> dict:
    """Parse a pasted or uploaded timetable image into periods."""
    key = config.env("GEMINI_API_KEY")
    if not key:
        raise TimetableError(status()["reason"])

    m = re.match(r"data:(image/[a-zA-Z+]+);base64,(.+)$", (data_url or "").strip(), re.S)
    if not m:
        raise TimetableError("that did not look like an image")
    mime, b64 = m.group(1), m.group(2)
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception as exc:
        raise TimetableError(f"could not decode the image — {exc}") from exc
    if len(raw) > 8 * 1024 * 1024:
        raise TimetableError("image is over 8 MB — take a smaller screenshot")

    prompt = READ_PROMPT
    if subjects:
        prompt += ("\n\nThe student takes these subjects; prefer these exact "
                   "spellings when a cell clearly matches one: "
                   + ", ".join(subjects))

    payload = {
        "contents": [{"role": "user", "parts": [
            {"text": prompt},
            {"inline_data": {"mime_type": mime, "data": b64}},
        ]}],
        "generationConfig": net.no_thinking({
            "temperature": 0.1, "maxOutputTokens": 32768,
            "responseMimeType": "application/json"}),
    }
    out = _call_gemini(payload, key)

    try:
        text = net.gemini_text(out)
    except net.GeminiEmpty as exc:
        raise TimetableError(f"Google read the image but returned no text — "
                             f"{exc}. Try a clearer, straight-on photo.") from exc
    except (KeyError, IndexError):
        raise TimetableError("Gemini returned nothing readable")

    periods = _periods_from(text)
    if not periods:
        raise TimetableError(
            "no periods were found in that image. Try a clearer, straight-on "
            "shot with the whole grid visible.")
    return {"periods": periods, "notes": ""}


# ---------------------------------------------------------------------------
# Normalising and querying
# ---------------------------------------------------------------------------
def _clean_time(value: str) -> str | None:
    s = str(value or "").strip().replace(".", ":").replace(" ", "")
    m = re.match(r"^(\d{1,2}):?(\d{2})\s*(am|pm)?$", s, re.I)
    if not m:
        return None
    hour, minute, half = int(m.group(1)), int(m.group(2)), (m.group(3) or "").lower()
    if half == "pm" and hour < 12:
        hour += 12
    if half == "am" and hour == 12:
        hour = 0
    if not (0 <= hour < 24 and 0 <= minute < 60):
        return None
    return f"{hour:02d}:{minute:02d}"


def normalise(periods: list) -> list[dict]:
    out = []
    for p in periods or []:
        if not isinstance(p, dict):
            continue
        day = str(p.get("day", "")).strip().title()
        day = next((d for d in DAYS if d.lower().startswith(day.lower()[:3])), "") if day else ""
        start = _clean_time(p.get("start"))
        end = _clean_time(p.get("end"))
        subject = str(p.get("subject", "")).strip()
        if not (day and start and subject):
            continue
        out.append({"day": day, "start": start, "end": end or "",
                    "subject": subject, "room": str(p.get("room", "")).strip(),
                    "teacher": str(p.get("teacher", "")).strip()})
    out.sort(key=lambda r: (DAYS.index(r["day"]), r["start"]))
    return out


def by_day(periods: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {d: [] for d in DAYS}
    for p in periods:
        grouped.setdefault(p["day"], []).append(p)
    return {d: rows for d, rows in grouped.items() if rows}


def today_periods(periods: list[dict], ref: datetime | None = None) -> list[dict]:
    ref = ref or datetime.now()
    return [p for p in periods if p["day"] == DAYS[ref.weekday()]]


def upcoming(periods: list[dict], lead_minutes: int = 5,
             ref: datetime | None = None) -> dict:
    """What is on now, what is next, and whether a reminder is due.

    The page polls this and raises the notification, because notifications
    belong to the browser. The schedule maths lives here so there is one
    definition of "next period" rather than one per surface.
    """
    ref = ref or datetime.now()
    today = today_periods(periods, ref)
    now_min = ref.hour * 60 + ref.minute

    def mins(hhmm: str) -> int:
        try:
            h, m = hhmm.split(":")
            return int(h) * 60 + int(m)
        except (ValueError, AttributeError):
            return -1

    current = next((p for p in today
                    if mins(p["start"]) <= now_min
                    and (mins(p["end"]) if p["end"] else mins(p["start"]) + 60) > now_min),
                   None)
    later = [p for p in today if mins(p["start"]) > now_min]
    nxt = later[0] if later else None

    remind = None
    if nxt:
        gap = mins(nxt["start"]) - now_min
        if 0 < gap <= lead_minutes:
            remind = {**nxt, "in_minutes": gap,
                      "key": f"{ref:%Y-%m-%d}|{nxt['day']}|{nxt['start']}|{nxt['subject']}"}

    return {
        "day": DAYS[ref.weekday()],
        "now": ref.strftime("%H:%M"),
        "current": current,
        "next": nxt,
        "remaining": len(later),
        "remind": remind,
        "today": today,
    }

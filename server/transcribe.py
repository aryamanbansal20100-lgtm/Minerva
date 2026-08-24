"""transcribe.py — audio in, text out, via Groq Whisper.

The free tier allows 25 MB a file and 28,800 audio-seconds a day — eight hours,
more than a school day. Four-minute Opus slices at 24 kbps are about 700 KB, so
the size ceiling is never near, and a crash costs one slice rather than the
whole lesson.

Multipart/form-data is built by hand. Nothing to install.
"""

from __future__ import annotations

import re

import json
import mimetypes
import urllib.error
import urllib.request
import uuid

from . import ai, config, net, store

def collapse_loops(text: str) -> str:
    """Strip Whisper's repetition loops out of a transcript.

    Whisper, handed silence or room noise, sometimes latches onto the last thing
    it heard and emits it over and over. A real lesson recording came back with
    "Sikar." forty times in a row, "Dilation." scattered dozens of times, plus
    "Tshh." and "Yenam." -- in one stretch 87% of the sentences were this. It is
    not a cosmetic problem: that noise is most of what reaches the note writer,
    so it crowds real teaching out of the context window and the note comes back
    thin. It also invites the model to treat a hallucinated word as the topic.

    Two rules, both deliberately conservative, because deleting real speech is
    worse than keeping some noise:

      1. A run of the SAME sentence three or more times consecutively collapses
         to one. Nobody says the same sentence three times in a row verbatim.
      2. A short fragment that accounts for more than a tenth of the whole
         transcript is a loop however it is spread out, so only its first two
         occurrences are kept.

    Anything said twice, or any longer sentence, is left exactly as it was.
    """
    parts = [s for s in re.split(r"(?<=[.!?])\s+", text or "") if s.strip()]
    if len(parts) < 6:
        return text

    # 1. consecutive runs
    out: list[str] = []
    i = 0
    while i < len(parts):
        j = i
        while j + 1 < len(parts) and parts[j + 1].strip() == parts[i].strip():
            j += 1
        run = j - i + 1
        out.extend([parts[i]] if run >= 3 else parts[i:j + 1])
        i = j + 1

    # 2. short fragments that dominate the whole thing
    counts: dict[str, int] = {}
    for s in out:
        counts[s.strip()] = counts.get(s.strip(), 0) + 1
    floor = max(4, len(out) // 10)
    hogs = {k for k, n in counts.items() if n > floor and len(k) <= 30}
    if hogs:
        kept: dict[str, int] = {}
        trimmed = []
        for s in out:
            key = s.strip()
            if key in hogs:
                kept[key] = kept.get(key, 0) + 1
                if kept[key] > 2:
                    continue
            trimmed.append(s)
        out = trimmed

    return " ".join(out)


def groq_key() -> str:
    """The signed-in student's own Groq key, falling back to the server's.

    Groq's free tier gives every account 28,800 audio seconds a day -- eight
    hours, comfortably more than anyone records at school. That allowance is per
    ACCOUNT, so one shared key means all students draw from a single eight-hour
    pool and the third one to record that day gets nothing. A student who adds
    their own free key gets their own eight hours, and recording stays free no
    matter how many people use Minerva.

    Falls back to the server's key so nothing breaks for someone who has not
    added one.
    """
    try:
        own = store.groq_key()
    except Exception:
        own = ""                        # no signed-in user, e.g. a health check
    return own or config.env("GROQ_API_KEY")


URL = "https://api.groq.com/openai/v1/audio/transcriptions"


class TranscriptionUnavailable(Exception):
    """Raised, never swallowed. Silence and failure must look different."""


def configured() -> bool:
    return bool(groq_key())


def status() -> dict:
    return {
        "ok": configured(),
        "engine": "groq/" + config.env("GROQ_STT_MODEL", "whisper-large-v3"),
        "reason": "" if configured() else
                  "no GROQ_API_KEY — recording is off. Free key: console.groq.com/keys",
    }


def _multipart(fields: dict, filename: str, payload: bytes) -> tuple[bytes, str]:
    boundary = "----minerva" + uuid.uuid4().hex
    ctype = mimetypes.guess_type(filename)[0] or "audio/webm"
    parts = bytearray()
    for key, value in fields.items():
        parts += (f"--{boundary}\r\n"
                  f'Content-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'
                  ).encode()
    parts += (f"--{boundary}\r\n"
              f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
              f"Content-Type: {ctype}\r\n\r\n").encode()
    parts += payload
    parts += f"\r\n--{boundary}--\r\n".encode()
    return bytes(parts), f"multipart/form-data; boundary={boundary}"


def transcribe(audio: bytes, filename: str = "chunk.webm",
               language: str = "", context: str = "") -> dict:
    """Audio in, text out.

    `context` is the tail of what was heard just before this slice. Whisper
    accepts it as a prompt and uses it to carry spelling, names and terminology
    across a cut — without it, every slice starts cold and a word split across
    the boundary is simply lost. This is the single biggest quality difference
    between chopped-up audio and one continuous transcription.
    """
    if not audio:
        raise TranscriptionUnavailable("empty recording")
    key = groq_key()
    if not key:
        raise TranscriptionUnavailable(status()["reason"])
    if len(audio) > 24 * 1024 * 1024:
        raise TranscriptionUnavailable(
            "slice is over the 25 MB limit — shorten EVIE_CHUNK_MINUTES")

    fields = {"model": config.env("GROQ_STT_MODEL", "whisper-large-v3"),
              "response_format": "json"}
    # Deliberately NOT pinning a language. Teachers switch between Hindi and
    # English mid-sentence, and forcing `language=en` makes Whisper try to
    # render Hindi as English words, which is worse than letting it detect.
    # Set EVIE_STT_LANGUAGE only if a room is reliably monolingual.
    language = language or config.env("EVIE_STT_LANGUAGE", "")
    if language:
        fields["language"] = language
    # Whisper caps the prompt at 224 tokens; the last few hundred characters of
    # the previous slice is the useful part and stays well inside that.
    if context:
        fields["prompt"] = context.strip()[-800:]
    # Lower temperature keeps it transcribing rather than paraphrasing.
    fields["temperature"] = "0"
    body, ctype = _multipart(fields, filename, audio)

    # School wifi drops packets and DNS lookups fail intermittently — the
    # student hit "getaddrinfo failed" mid-lesson, which killed a whole slice of
    # audio. A dropped-network blip lasts a second or two, so retry a few times
    # with a short backoff before giving up. The audio in a slice is
    # irreplaceable; a momentary network failure must not lose it.
    import time

    last: Exception | None = None
    for attempt in range(4):
        if attempt:
            time.sleep([0, 1, 3, 6][attempt])
        req = urllib.request.Request(URL, data=body, method="POST", headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": ctype,
            "User-Agent": ai.USER_AGENT,
        })
        try:
            with net.urlopen(req, timeout=120) as resp:
                out = json.loads(resp.read().decode("utf-8", "replace"))
            return {"text": (out.get("text") or "").strip(),
                    "engine": status()["engine"]}
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:250].decode("utf-8", "replace")
            if exc.code == 429:
                raise TranscriptionUnavailable(
                    "Groq rate limit hit. The free tier allows 7,200 "
                    "audio-seconds an hour; wait a few minutes.") from exc
            # 502/503/504 come from the gateway in front of Groq, not from Groq
            # deciding anything about this request — the service is briefly
            # unreachable. Treating that as final threw away a slice of a real
            # lesson mid-recording. Retry it like any other blip.
            if exc.code in (500, 502, 503, 504):
                last = exc
                continue
            # A 4xx is a real answer about this request — do not retry it.
            raise TranscriptionUnavailable(f"Groq {exc.code}: {detail}") from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            last = exc                       # network blip — try again
            continue

    if isinstance(last, urllib.error.HTTPError):
        raise TranscriptionUnavailable(
            "Groq is down right now (it answered " + str(last.code) + " four "
            "times). Nothing is wrong with your recording — keep it running "
            "and this slice will be retried, or stop and press Write it up "
            "once Groq is back.")
    raise TranscriptionUnavailable(
        "the network dropped while sending this slice — check the wifi. "
        f"({last})")

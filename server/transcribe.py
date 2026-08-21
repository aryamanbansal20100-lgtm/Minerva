"""transcribe.py — audio in, text out, via Groq Whisper.

The free tier allows 25 MB a file and 28,800 audio-seconds a day — eight hours,
more than a school day. Four-minute Opus slices at 24 kbps are about 700 KB, so
the size ceiling is never near, and a crash costs one slice rather than the
whole lesson.

Multipart/form-data is built by hand. Nothing to install.
"""

from __future__ import annotations

import json
import mimetypes
import urllib.error
import urllib.request
import uuid

from . import ai, config, net

URL = "https://api.groq.com/openai/v1/audio/transcriptions"


class TranscriptionUnavailable(Exception):
    """Raised, never swallowed. Silence and failure must look different."""


def configured() -> bool:
    return bool(config.env("GROQ_API_KEY"))


def status() -> dict:
    return {
        "ok": configured(),
        "engine": "groq/" + config.env("GROQ_STT_MODEL", "whisper-large-v3-turbo"),
        "reason": "" if configured() else
                  "no GROQ_API_KEY — recording is off. Free key: console.groq.com/keys",
    }


def _multipart(fields: dict, filename: str, payload: bytes) -> tuple[bytes, str]:
    boundary = "----evie" + uuid.uuid4().hex
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
               language: str = "") -> dict:
    if not audio:
        raise TranscriptionUnavailable("empty recording")
    key = config.env("GROQ_API_KEY")
    if not key:
        raise TranscriptionUnavailable(status()["reason"])
    if len(audio) > 24 * 1024 * 1024:
        raise TranscriptionUnavailable(
            "slice is over the 25 MB limit — shorten EVIE_CHUNK_MINUTES")

    fields = {"model": config.env("GROQ_STT_MODEL", "whisper-large-v3-turbo"),
              "response_format": "json"}
    # Deliberately NOT pinning a language. Teachers switch between Hindi and
    # English mid-sentence, and forcing `language=en` makes Whisper try to
    # render Hindi as English words, which is worse than letting it detect.
    # Set EVIE_STT_LANGUAGE only if a room is reliably monolingual.
    language = language or config.env("EVIE_STT_LANGUAGE", "")
    if language:
        fields["language"] = language
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
            # An HTTP error is a real answer, not a blip — do not retry it.
            raise TranscriptionUnavailable(f"Groq {exc.code}: {detail}") from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            last = exc                       # network blip — try again
            continue

    raise TranscriptionUnavailable(
        "the network dropped while sending this slice — check the wifi. "
        f"({last})")

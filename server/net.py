"""net.py — one TLS context for every outbound call.

This machine sits behind a FortiGate firewall doing TLS inspection: it
terminates HTTPS and re-signs every certificate with its own CA
(`CN=FG2H0GT924905401`). Browsers accept that because the CA is installed in
the Windows trust store.

Python 3.13 turned on `VERIFY_X509_STRICT` by default, which enforces RFC 5280
to the letter — including that every CA certificate carry an Authority Key
Identifier. The FortiGate's certificate does not, so every HTTPS request from
Python fails with:

    CERTIFICATE_VERIFY_FAILED: Missing Authority Key Identifier

That looks exactly like a bad API key and is not. The fix is to clear that one
flag, which restores Python 3.12 behaviour.

What is deliberately NOT done here: certificates are still verified and
hostnames are still checked. `verify_mode` stays `CERT_REQUIRED` and
`check_hostname` stays True. This relaxes a pedantic extension check, not
security. Set EVIE_TLS_STRICT=1 to keep the strict behaviour and fail loudly
instead.
"""

from __future__ import annotations

import ssl
import urllib.request

from . import config as data

_context: ssl.SSLContext | None = None
_relaxed = False


def context() -> ssl.SSLContext:
    global _context, _relaxed
    if _context is not None:
        return _context
    ctx = ssl.create_default_context()
    if data.env("EVIE_TLS_STRICT", "0") != "1":
        if ctx.verify_flags & ssl.VERIFY_X509_STRICT:
            ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
            _relaxed = True
    _context = ctx
    return ctx


def opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=context()))


def urlopen(req, timeout: int = 30):
    return opener().open(req, timeout=timeout)


def status() -> dict:
    context()
    return {
        "verified": True,
        "hostname_checked": True,
        "relaxed_strict_x509": _relaxed,
        "note": ("TLS inspection detected on this network; RFC-5280 strict "
                 "extension checks relaxed. Certificates are still verified."
                 if _relaxed else ""),
    }


class GeminiEmpty(Exception):
    """Gemini replied, but with no usable text. Carries the reason why."""


def gemini_text(out: dict) -> str:
    """The visible text from a Gemini reply, or raise saying what went wrong.

    Newer Gemini models think before answering, and those thoughts come back as
    parts too. Reading parts[0]["text"] therefore returns a thought instead of
    the answer -- or raises KeyError when the whole budget went on thinking and
    `content` came back as an empty object.

    That is exactly what was happening to every image upload. The reply looked
    like this:

        {"content": {}, "finishReason": "MAX_TOKENS", "thoughtsTokenCount": 60}

    the KeyError was swallowed, and the file was reported as unreadable -- as
    though the model had looked and found nothing, rather than never having
    answered at all.

    So: skip thought parts, join the rest, and when there is nothing, say which
    of the several very different failures it was.
    """
    cand = (out.get("candidates") or [{}])[0]
    parts = ((cand.get("content") or {}).get("parts")) or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    if text.strip():
        return text.strip()

    reason = cand.get("finishReason") or "unknown"
    thoughts = (out.get("usageMetadata") or {}).get("thoughtsTokenCount", 0)
    if reason == "MAX_TOKENS":
        raise GeminiEmpty(
            f"the model spent its entire output budget thinking ({thoughts} "
            f"tokens) and never wrote an answer")
    if reason == "SAFETY":
        raise GeminiEmpty("the model declined to answer for this content")
    raise GeminiEmpty(f"the reply contained no text (finishReason: {reason})")


def no_thinking(config: dict) -> dict:
    """Turn thinking off for a task that does not need it.

    Reading text out of a picture or filling in a JSON shape is transcription,
    not reasoning; thinking there buys nothing and can consume the entire
    output budget before a single visible word is produced.
    """
    out = dict(config)
    out["thinkingConfig"] = {"thinkingBudget": 0}
    return out

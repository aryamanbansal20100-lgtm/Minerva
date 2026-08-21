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

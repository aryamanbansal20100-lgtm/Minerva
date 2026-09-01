"""auth.py — verify Google sign-in server-side.

The browser signs in with Firebase and sends the resulting ID token on every
request. This module checks that token is real before any data is touched.

Verification uses Google's Identity Toolkit REST endpoint rather than checking
the RS256 signature locally, because verifying that signature needs RSA and the
standard library has no public-key crypto. The REST call asks Google "is this
token yours, and whose is it?" and Google answers — same guarantee, no
dependency. Results are cached until the token expires so a lesson does not
make one call per audio slice.

No guest path. No anonymous fallback. If EVIE_REQUIRE_AUTH is 1 and there is no
valid token, the API returns 401 and the app shows the sign-in screen.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config, net

LOOKUP = "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={key}"

# token -> (expires_at, user dict)
_cache: dict[str, tuple[float, dict]] = {}
CACHE_SECONDS = 900


class AuthError(Exception):
    pass


def _expiry_of(token: str) -> float:
    """The `exp` claim of a JWT, as a unix time, or +inf if it cannot be read.

    Only used to SHORTEN a cache entry, never to grant access, so reading it
    without verifying the signature is safe: Google has already vouched for the
    token by the time this is called.
    """
    import base64
    import json as _json
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)          # restore base64 padding
        exp = _json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        # A minute of margin, so a token cannot be handed to Firestore just as
        # it dies in flight.
        return float(exp) - 60 if exp else float("inf")
    except Exception:
        return float("inf")


def required() -> bool:
    return config.env("EVIE_REQUIRE_AUTH", "1") == "1"


def api_key() -> str:
    return config.env("FIREBASE_API_KEY", config.DEFAULT_FIREBASE_API_KEY)


def status() -> dict:
    return {
        "required": required(),
        "configured": bool(api_key()),
        "project": config.env("FIREBASE_PROJECT", config.DEFAULT_FIREBASE_PROJECT),
        "reason": "" if api_key() else
                  "no FIREBASE_API_KEY in .env — sign-in cannot be verified",
    }


def verify(token: str) -> dict:
    """Return the signed-in user, or raise. Cached until the token ages out."""
    token = (token or "").strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if not token:
        raise AuthError("not signed in")

    hit = _cache.get(token)
    if hit and hit[0] > time.time():
        return hit[1]

    key = api_key()
    if not key:
        raise AuthError(status()["reason"])

    body = json.dumps({"idToken": token}).encode("utf-8")
    req = urllib.request.Request(
        LOOKUP.format(key=key), data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with net.urlopen(req, timeout=20) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:200].decode("utf-8", "replace")
        raise AuthError(f"Google rejected the sign-in ({exc.code}): {detail}") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise AuthError(f"could not reach Google to verify sign-in: {exc}") from exc

    users = out.get("users") or []
    if not users:
        raise AuthError("that sign-in is not valid any more — sign in again")

    u = users[0]
    providers = {p.get("providerId") for p in (u.get("providerUserInfo") or [])}
    if "google.com" not in providers:
        # Belt and braces: the UI only offers Google, but the API must not
        # accept anything else just because someone sent a different token.
        raise AuthError("only Google accounts are allowed")

    user = {
        "uid": u.get("localId", ""),
        "email": u.get("email", ""),
        "name": u.get("displayName", ""),
        "photo": u.get("photoUrl", ""),
    }
    if not user["uid"]:
        raise AuthError("Google returned no account id")

    # Never cache a token past its OWN expiry.
    #
    # Caching a fixed 900 seconds meant a token verified late in its life stayed
    # "valid" here after Google had stopped honouring it. Our own endpoints kept
    # working while every Firestore write came back 401 UNAUTHENTICATED -- so the
    # app looked fine and the cloud backup silently saved nothing. The expiry is
    # readable from the JWT payload without verifying it (we have just had Google
    # verify the token itself), so cap the cache at whichever comes first.
    _cache[token] = (min(time.time() + CACHE_SECONDS, _expiry_of(token)), user)
    if len(_cache) > 64:                       # tiny, single-user; keep it tidy
        for stale in [k for k, (exp, _) in _cache.items() if exp < time.time()]:
            _cache.pop(stale, None)
    return user

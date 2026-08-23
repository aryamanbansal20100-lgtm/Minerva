"""config.py — .env loading. Stdlib only, no python-dotenv."""

from __future__ import annotations

import os
from pathlib import Path

# The Firebase project id. Public by definition — it ships inside the browser
# bundle (web/src/lib/firebase.ts) because Firebase needs it client-side — so
# defaulting it here leaks nothing, and it removes an entire class of outage.
#
# It used to come only from the environment. A host where nobody had typed it in
# got an empty string, cloud.enabled() went False, and the server mirrored
# nothing to Firestore without ever raising: notes saved fine, then vanished on
# the next redeploy because the free tier's disk is ephemeral. Silent, and
# indistinguishable from a working backup until the day you needed it.
#
# Override with FIREBASE_PROJECT if the deployment ever points at another
# project; it must match projectId in web/src/lib/firebase.ts either way.
DEFAULT_FIREBASE_PROJECT = "note-ta"

# The Firebase Web API key, for the same reason and with the same caveat. This
# is NOT a credential: Google documents web API keys as public identifiers that
# belong in client code, and this exact string is already committed in
# web/src/lib/firebase.ts and shipped to every browser. What actually protects
# the data is the Firestore security rules plus the authorised-domain list —
# holding this key gets an attacker nothing a page visitor does not already
# have. The Groq and Gemini keys are real secrets and stay in the environment.
DEFAULT_FIREBASE_API_KEY = "AIzaSyAw8zOGiC3q5lFvGIrJDPlNrHTiUl4KbhQ"

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
_loaded = False


def load_env() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    if not ENV_PATH.exists():
        return
    for raw in ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")


def env(key: str, default: str = "") -> str:
    load_env()
    value = os.environ.get(key)
    return (value if value is not None else default).strip()

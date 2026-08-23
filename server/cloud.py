"""cloud.py — Firestore over REST, so notes follow the account.

No Firebase Admin SDK, no service-account key file. Requests carry the
student's own ID token, which means Firestore's security rules apply exactly as
written: a user can only ever touch `users/<their uid>/…`. A leaked server has
no more power than the student who signed in.

Firestore's REST API wants values wrapped by type — {"stringValue": "x"} rather
than "x" — so this module converts both ways. That is the bulk of the code and
all of the fiddliness.

Sync model: local SQLite stays the working copy and Firestore is the mirror.
Writes go to both; on a device that has never seen this account, the mirror is
pulled down first. Local-first keeps the app usable when the school wifi drops
mid-lesson, which matters more here than perfect real-time consistency.
"""

from __future__ import annotations

import json
from datetime import datetime
import threading
import urllib.error
import urllib.parse
import urllib.request

from . import config, net

BASE = ("https://firestore.googleapis.com/v1/projects/{project}"
        "/databases/(default)/documents")

_ctx = threading.local()
_last_error = ""
_ok = 0
_failed = 0
_last_ok_at = ""


def set_token(token: str) -> None:
    _ctx.token = token or ""


def token() -> str:
    return getattr(_ctx, "token", "")


def project() -> str:
    return config.env("FIREBASE_PROJECT", config.DEFAULT_FIREBASE_PROJECT)


def enabled() -> bool:
    return bool(project()) and config.env("EVIE_CLOUD", "1") == "1"


def status() -> dict:
    """Whether the cloud copy is actually working — not merely switched on.

    The counters matter as much as the flags. Every sync failure used to be
    swallowed silently, so a student whose writes were all being rejected saw
    exactly what a student with a perfect backup saw: nothing. Then they signed
    in on another machine and it was empty. Counting successes and failures
    turns that silence into something the app can show and act on.
    """
    healthy = _ok > 0 and _failed == 0
    return {
        "enabled": enabled(),
        "project": project(),
        "connected": bool(token()) and enabled(),
        "saved": _ok,
        "failed": _failed,
        "healthy": healthy,
        "last_error": _last_error,
        "last_saved_at": _last_ok_at,
    }


# ---------------------------------------------------------------------------
# Firestore's typed value format
# ---------------------------------------------------------------------------
def encode(value):
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, (list, tuple)):
        return {"arrayValue": {"values": [encode(v) for v in value]}}
    if isinstance(value, dict):
        return {"mapValue": {"fields": {k: encode(v) for k, v in value.items()}}}
    return {"stringValue": str(value)}


def decode(field):
    if not isinstance(field, dict):
        return None
    if "nullValue" in field:
        return None
    if "booleanValue" in field:
        return field["booleanValue"]
    if "integerValue" in field:
        try:
            return int(field["integerValue"])
        except (TypeError, ValueError):
            return 0
    if "doubleValue" in field:
        return field["doubleValue"]
    if "stringValue" in field:
        return field["stringValue"]
    if "arrayValue" in field:
        return [decode(v) for v in field["arrayValue"].get("values", [])]
    if "mapValue" in field:
        return {k: decode(v) for k, v in field["mapValue"].get("fields", {}).items()}
    return None


def to_doc(row: dict) -> dict:
    return {"fields": {k: encode(v) for k, v in row.items()}}


def from_doc(doc: dict) -> dict:
    return {k: decode(v) for k, v in (doc.get("fields") or {}).items()}


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------
def _call(method: str, path: str, payload: dict | None = None,
          params: str = "") -> dict | None:
    global _last_error
    if not enabled() or not token():
        return None
    url = BASE.format(project=project()) + path + (("?" + params) if params else "")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + token(),
        "Content-Type": "application/json",
    })
    try:
        with net.urlopen(req, timeout=25) as resp:
            body = resp.read().decode("utf-8")
        global _ok, _last_ok_at
        _last_error = ""
        _ok += 1
        _last_ok_at = datetime.now().isoformat(timespec="seconds")
        return json.loads(body) if body.strip() else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:200].decode("utf-8", "replace")
        if exc.code == 404 and method == "GET":
            return None                       # simply not there yet
        global _failed
        _failed += 1
        _last_error = f"HTTP {exc.code} {detail}"
        return None
    except (urllib.error.URLError, OSError, ValueError) as exc:
        _failed += 1
        _last_error = f"{type(exc).__name__}: {exc}"
        return None


def put(uid: str, collection: str, doc_id: str, row: dict) -> bool:
    """Create or overwrite one document. Never raises — a sync failure must
    not lose the local write that already succeeded."""
    if not uid or not doc_id:
        return False
    # updateMask makes this a full overwrite of the fields we send, which is
    # what we want: the local row is the complete truth for that document.
    mask = "&".join(f"updateMask.fieldPaths={urllib.parse.quote(k)}" for k in row)
    out = _call("PATCH", f"/users/{uid}/{collection}/{doc_id}", to_doc(row), mask)
    return out is not None


def delete(uid: str, collection: str, doc_id: str) -> bool:
    return _call("DELETE", f"/users/{uid}/{collection}/{doc_id}", None) is not None


def fetch(uid: str, collection: str, limit: int = 300) -> list[dict]:
    out = _call("GET", f"/users/{uid}/{collection}", None, f"pageSize={limit}")
    if not out:
        return []
    rows = []
    for doc in out.get("documents", []):
        row = from_doc(doc)
        row.setdefault("id", (doc.get("name") or "").rsplit("/", 1)[-1])
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# File bytes, in Firestore itself
#
# Firebase Cloud Storage now requires the paid Blaze plan on new projects, so
# it is not an option here. Firestore's free tier gives 1 GiB, and a document
# can hold just under 1 MiB — so a file is base64'd and split across chunk
# documents. Wasteful next to real object storage, and completely free, which
# for school worksheets is the right trade.
# ---------------------------------------------------------------------------
CHUNK_BYTES = 700_000          # base64 chars per chunk; safely under the 1 MiB cap
MAX_SYNC_BYTES = 6 * 1024 * 1024


def upload_file(uid: str, doc_id: str, name: str, mime: str, blob: bytes) -> str:
    """Split the file across Firestore chunk documents. Returns "" if skipped."""
    global _last_error
    if not enabled() or not token() or not uid or not blob:
        return ""
    if len(blob) > MAX_SYNC_BYTES:
        _last_error = f"{name} is over 6 MB, kept on this device only"
        return ""

    import base64

    b64 = base64.b64encode(blob).decode("ascii")
    parts = [b64[i:i + CHUNK_BYTES] for i in range(0, len(b64), CHUNK_BYTES)]
    for i, part in enumerate(parts):
        ok = put(uid, f"documents/{doc_id}/chunks", str(i),
                 {"i": i, "data": part})
        if not ok:
            return ""
    return f"firestore:{len(parts)}"


def download_file(uid: str, doc_id: str) -> bytes:
    """Reassemble a file from its chunk documents."""
    if not enabled() or not token() or not uid or not doc_id:
        return b""
    rows = fetch(uid, f"documents/{doc_id}/chunks", limit=64)
    if not rows:
        return b""
    import base64

    rows.sort(key=lambda r: r.get("i", 0))
    try:
        return base64.b64decode("".join(r.get("data", "") for r in rows))
    except Exception:
        return b""


def put_profile(uid: str, profile: dict) -> bool:
    row = {k: v for k, v in profile.items() if k != "id"}
    return _call("PATCH", f"/users/{uid}/meta/profile", to_doc(row),
                 "&".join(f"updateMask.fieldPaths={urllib.parse.quote(k)}"
                          for k in row)) is not None


def get_profile(uid: str) -> dict | None:
    out = _call("GET", f"/users/{uid}/meta/profile")
    return from_doc(out) if out else None

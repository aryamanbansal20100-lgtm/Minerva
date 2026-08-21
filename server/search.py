"""search.py — find the right bits of the student's own notes.

TF-IDF with a coverage bonus, over note titles, bodies and transcripts. No
embeddings API, no vector database, nothing to pay for. For a personal
notebook — hundreds of notes, not millions — term matching with sensible
weighting beats an embedding call that costs money and adds latency.

The coverage bonus matters: a note mentioning every word of the question beats
one that mentions the loudest word a lot. Without it, "resistivity formula"
returns the note with "resistivity" in the title over the note that actually
contains the formula.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict

from . import store

WORD = re.compile(r"[a-z0-9][a-z0-9'µ°/-]*")
STOP = {
    "the", "and", "for", "with", "that", "this", "from", "was", "are", "you",
    "your", "have", "has", "not", "will", "can", "all", "any", "out", "its",
    "were", "been", "they", "them", "their", "what", "when", "who", "how",
    "why", "into", "about", "there", "here", "than", "then", "these", "those",
    "would", "could", "should", "also", "more", "some", "such", "only", "very",
    "just", "one", "two", "per", "via", "does", "did", "each", "our", "his",
    "her", "but", "get", "got", "use", "used", "using", "explain", "tell", "me",
}


def tokens(text: str) -> list[str]:
    return [w for w in WORD.findall((text or "").lower())
            if w not in STOP and len(w) > 1]


def _corpus() -> list[dict]:
    rows = store.all_notes_for_search()
    for r in rows:
        r["_text"] = f"{r['title']} {r['title']} {r['subject']} {r['topic']} " \
                     f"{r['body']} {r['transcript']}"
        r["_terms"] = Counter(tokens(r["_text"]))
    return rows


def find(query: str, limit: int = 5) -> list[dict]:
    terms = tokens(query)
    if not terms:
        return []
    rows = _corpus()
    if not rows:
        return []

    postings: dict[str, dict[str, int]] = defaultdict(dict)
    for r in rows:
        for term, count in r["_terms"].items():
            postings[term][r["id"]] = count

    total = len(rows)
    scores: dict[str, float] = defaultdict(float)
    covered: dict[str, set] = defaultdict(set)
    unique = set(terms)

    for term in terms:
        hits = postings.get(term)
        if not hits:                                   # cheap prefix match
            hits = {}
            for known, docs in postings.items():
                if known.startswith(term) or term.startswith(known):
                    for nid, c in docs.items():
                        hits[nid] = max(hits.get(nid, 0), c)
            if not hits:
                continue
        idf = math.log(1 + total / (1 + len(hits)))
        for nid, count in hits.items():
            scores[nid] += (1 + math.log(count)) * idf
            covered[nid].add(term)

    for nid in scores:
        scores[nid] *= 1 + 0.9 * (len(covered[nid]) / len(unique))

    by_id = {r["id"]: r for r in rows}
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])[:limit]
    out = []
    for i, (nid, score) in enumerate(ranked, 1):
        r = by_id[nid]
        out.append({
            "label": f"note {i}",
            "id": nid,
            "title": r["title"] or "Untitled",
            "subject": r["subject"],
            "score": round(score, 2),
            "text": _excerpt(r["body"] or r["transcript"], query),
            "updated_at": r["updated_at"],
        })
    return out


def _excerpt(text: str, query: str, width: int = 1400) -> str:
    flat = " ".join((text or "").split())
    if len(flat) <= width:
        return flat
    low = flat.lower()
    first = len(flat)
    for w in tokens(query):
        i = low.find(w)
        if i != -1:
            first = min(first, i)
    if first == len(flat):
        first = 0
    start = max(0, first - 200)
    return ("…" if start else "") + flat[start:start + width] + "…"


def confidence(query: str) -> float:
    """0..1 — how well the notes actually cover this. Drives web fallback."""
    hits = find(query, limit=1)
    return max(0.0, min(1.0, hits[0]["score"] / 9.0)) if hits else 0.0

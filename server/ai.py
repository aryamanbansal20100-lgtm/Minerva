"""ai.py — Groq over urllib. Notes, diagrams, and answering doubts.

Three jobs:

1. **Condense** each 4-minute slice while the lesson is still running. Small,
   cheap model. This exists because a 70-minute transcript is roughly 14,000
   tokens and the free tier allows 12,000 per minute — summarising the lot in
   one call fails outright.

2. **Compose** the finished note from those condensed slices. Big model, once.
   Output is a list of typed blocks, not a wall of markdown, so the app can
   render definitions, formulas, worked examples and diagrams differently.

3. **Answer** a question using the student's own notes first and the web only
   when the notes fall short — always saying which it used.

Diagrams are emitted as a small JSON spec and drawn by our own renderer. No
Mermaid, no D3, nothing to install: the spec is deliberately simple enough to
lay out by hand, and that keeps the diagrams legible instead of generic.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from . import config, net

CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"

# Groq sits behind Cloudflare, which 403s urllib's default User-Agent with the
# body "error code: 1010" — which looks exactly like a bad API key and is not.
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# Groq retires model names without warning. `llama-3.3-70b-versatile` and
# `llama-3.1-8b-instant` were both live earlier in this project and are now 404
# — and because every failure fell back silently, the app kept "working" while
# producing raw transcript lines instead of notes. So: preference lists, probed
# once against the live catalogue, and a loud error if nothing answers.
BIG_CHOICES = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "groq/compound",
               "openai/gpt-oss-20b", "llama-3.3-70b-versatile"]
SMALL_CHOICES = ["openai/gpt-oss-20b", "qwen/qwen3.6-27b", "groq/compound-mini",
                 "openai/gpt-oss-120b", "llama-3.1-8b-instant"]

BIG = BIG_CHOICES[0]
SMALL = SMALL_CHOICES[0]

_available: set[str] = set()
_last_error = ""


def catalogue() -> set:
    """What this key can actually call, asked once."""
    global _available
    if _available:
        return _available
    key = config.env("GROQ_API_KEY")
    if not key:
        return set()
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/models",
        headers={"Authorization": "Bearer " + key, "User-Agent": USER_AGENT})
    try:
        with net.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        _available = {m["id"] for m in data.get("data", [])}
    except Exception:
        _available = set()
    return _available


def pick(choices: list) -> str:
    have = catalogue()
    if not have:
        return choices[0]
    for name in choices:
        if name in have:
            return name
    # Nothing preferred survived; take any chat-capable model rather than 404.
    for name in sorted(have):
        if not any(x in name for x in ("whisper", "guard", "orpheus", "tts")):
            return name
    return choices[0]


def big() -> str:
    return config.env("GROQ_MODEL") or pick(BIG_CHOICES)


def small() -> str:
    return config.env("GROQ_SMALL_MODEL") or pick(SMALL_CHOICES)


class AIUnavailable(Exception):
    pass


def configured() -> bool:
    return bool(config.env("GROQ_API_KEY"))


def status() -> dict:
    return {"ok": configured(), "model": big(),
            "last_error": _last_error,
            "reason": "" if configured() else
                      "no GROQ_API_KEY in .env — get a free one at console.groq.com/keys"}


def chat(system: str, user: str, model: str = "", temperature: float = 0.4,
         max_tokens: int = 1600, want_json: bool = False) -> str:
    global _last_error
    key = config.env("GROQ_API_KEY")
    if not key:
        raise AIUnavailable(status()["reason"])
    payload = {
        "model": model or big(),
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if want_json:
        payload["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(
        CHAT_URL, data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT,
                 "Authorization": f"Bearer {key}"})
    try:
        with net.urlopen(req, timeout=90) as resp:
            out = json.loads(resp.read().decode("utf-8"))
        _last_error = ""
        return out["choices"][0]["message"]["content"].strip()
    except urllib.error.HTTPError as exc:
        body = exc.read()[:200].decode("utf-8", "replace")
        _last_error = f"HTTP {exc.code} {body}"
        raise AIUnavailable(_last_error) from exc
    except (urllib.error.URLError, OSError, KeyError, ValueError) as exc:
        _last_error = f"{type(exc).__name__}: {exc}"
        raise AIUnavailable(_last_error) from exc


GEMINI_URL = ("https://generativelanguage.googleapis.com/v1beta/models/"
              "{model}:generateContent?key={key}")
GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.5-flash",
                 "gemini-3-flash-preview", "gemini-flash-lite-latest"]
_gemini_model = ""


def gemini_ready() -> bool:
    return bool(config.env("GEMINI_API_KEY"))


def gemini_json(system: str, user: str, max_tokens: int = 16384) -> dict | None:
    """Write with Gemini instead of Groq.

    Groq's free tier allows 8,000 tokens PER MINUTE across prompt and
    completion. A lesson transcript plus a full set of notes is two to four
    times that, so a complete note is arithmetically impossible there — every
    attempt came back HTTP 413 and fell through to the fallback, which is why
    the notes were a fifth the length they should be. Gemini's free tier is
    large enough to take the whole transcript in one pass, which is exactly
    what makes a rich note possible.
    """
    global _gemini_model, _last_error
    key = config.env("GEMINI_API_KEY")
    if not key:
        return None
    payload = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens,
                             "responseMimeType": "application/json"},
    }
    # 503 "high demand" is transient and common on the free tier. One attempt
    # per model meant a busy minute produced no note at all, and the caller fell
    # back to dumping raw transcript lines. Try each model more than once, with
    # a pause, before giving up on it.
    import time

    order = ([_gemini_model] if _gemini_model else []) + GEMINI_MODELS
    plan = [(m, attempt) for attempt in range(4)
            for m in dict.fromkeys(x for x in order if x)]
    for name, attempt in plan:
        # A busy spike lasts seconds, not milliseconds. Waiting 3s, then 8s,
        # then 15s costs the student nothing — they are watching a spinner —
        # and it is the difference between a real note and no note.
        if attempt:
            time.sleep([0, 3, 8, 15][min(attempt, 3)])
        req = urllib.request.Request(
            GEMINI_URL.format(model=name, key=key),
            data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
        try:
            with net.urlopen(req, timeout=180) as resp:
                out = json.loads(resp.read().decode("utf-8"))
            text = out["candidates"][0]["content"]["parts"][0]["text"]
            start, end = text.find("{"), text.rfind("}")
            parsed = json.loads(text[start:end + 1])
            _gemini_model = name
            return parsed if isinstance(parsed, dict) else None
        except urllib.error.HTTPError as exc:
            _last_error = (f"gemini {name} {exc.code}: "
                           + exc.read()[:150].decode("utf-8", "replace"))
            if exc.code in (400, 404):
                order = [m for m in order if m != name]   # dead name, drop it
            if exc.code == 429:
                # Daily quota on this model. Drop it for this call and stop
                # preferring it, so the remaining models get a turn.
                order = [m for m in order if m != name]
                if _gemini_model == name:
                    _gemini_model = ""
            continue
        except Exception as exc:
            _last_error = f"gemini {name}: {type(exc).__name__} {exc}"[:200]
            continue
    return None


def json_call(system: str, user: str, fallback: dict, model: str = "",
              max_tokens: int = 1800) -> dict:
    """Returns the parsed object, or the fallback with `_failed` set.

    The caller MUST be able to tell the difference. Silently returning the
    fallback is how this app spent a whole afternoon emitting raw transcript
    lines while reporting success.
    """
    try:
        text = chat(system, user, model=model, temperature=0.15,
                    max_tokens=max_tokens, want_json=True)
    except AIUnavailable as exc:
        out = dict(fallback)
        out["_failed"] = str(exc)[:300]
        return out
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return fallback
    try:
        parsed = json.loads(text[start:end + 1])
        return parsed if isinstance(parsed, dict) else fallback
    except ValueError:
        return fallback


# ===========================================================================
# 1. Condense one slice, live
# ===========================================================================
CONDENSE = """You capture EVERYTHING taught in one slice of a lesson, for a {curriculum} student in {grade}.

JSON only:
{{"points":[str],"terms":[{{"term":str,"meaning":str}}],"examples":[str],
  "formulas":[{{"formula":str,"means":str}}],
  "tasks":[{{"what":str,"due":str|null,"kind":"homework"|"assignment"|"exam"|"admin"}}],
  "assessed":[str],"confusing":[str]}}

Rules:
- CAPTURE, do not summarise. This is not a summary step. If the teacher spent
  four minutes on one idea, that idea needs several points, not one.
- Aim for one point per distinct thing said. A four-minute slice of real
  teaching normally yields 10-25 points. Returning three is a failure.
- Keep sub-points as separate items, including asides, examples the teacher
  gave verbally, wording they told you to use, and things they told you NOT to
  write. Those are exactly what students lose.
- Keep the teacher's numbers, names and wording exactly. Do not round or rephrase figures.
- Where the teacher gave model phrasing or a sentence to copy, keep it verbatim
  and prefix it with "> " so it survives as a quote.
- "tasks" only when something was actually set. TODAY IS {today}. Teachers say
  "due Monday the 17th" with no year — resolve against today and never return a past date.
- CAPTURE THE QUESTION ITSELF, WORD FOR WORD. When a teacher sets an essay or a
  structured question, the wording IS the task and paraphrasing loses the marks:
  record it as it was said, including the mark allocation.
      "Using real-world examples, discuss the effectiveness of imposing a price
       ceiling on essential goods (15 marks)"
  not "economics essay". A task carrying a mark count in brackets — (15m),
  [10 marks], "out of 8" — is always worth capturing, even when no due date is
  given: an undated task is still a task, so return it with "due": null rather
  than dropping it.
- Phrases that mean work was set, and must produce a task: "for homework",
  "your task is", "I want you to", "write me", "attempt", "hand this in",
  "do this for next class", "practise these", "complete", "submit".
- "assessed" for anything flagged as exam-relevant or coursework-relevant.
- "confusing" for places the recording is garbled or the explanation was cut off.
- Speech-to-text is imperfect. If a slice is inaudible or off-topic, return empty arrays.
- Never invent content that was not said.
- Teachers in India often switch between Hindi and English mid-sentence, so the
  transcript may be mixed or transliterated. Understand both, but ALWAYS write
  the notes in English. Keep technical terms and any Hindi literary or subject
  term the teacher used in its original form, with a short gloss in brackets."""


def condense(text: str, profile: dict, today: str) -> dict:
    empty = {"points": [], "terms": [], "examples": [], "formulas": [],
             "tasks": [], "assessed": [], "confusing": []}
    if len(text.split()) < 12:
        return empty
    system = CONDENSE.format(
        curriculum=profile.get("curriculum") or "school",
        grade=profile.get("grade") or "secondary school", today=today)
    out = json_call(system, text[:9000], fallback=empty, model=small(),
                    max_tokens=4000)
    for k in empty:
        if not isinstance(out.get(k), list):
            out[k] = []
    return out


# ===========================================================================
# 2. Compose the note
# ===========================================================================
COMPOSE = """You write the finished lesson note for {name}, a {grade} student
following {curriculum} at {school}. Subject: {subject}. Topic: {topic}.

Return JSON only:
{{"title":str,
  "summary":str,
  "blocks":[ ...see below... ],
  "diagram":{{...spec...}} | null,
  "quotes":[str],
  "continues":bool,
  "tasks":[{{"what":str,"due":"YYYY-MM-DD"|null,"kind":str}}]}}

"quotes" is REQUIRED, even if empty. Put in it, WORD FOR WORD, every sentence
the teacher dictated, told the class to write down, gave as model phrasing, or
said not to write. These are worth marks and are the first thing students lose.
Do not paraphrase them.

"continues" is REQUIRED. Set it true when the lesson ended in the middle of the
topic — the teacher was mid-explanation, said "we will finish this next class",
ran out of time, or left a worked example incomplete. Set it false when the
topic was properly wrapped up. A school period ends on a bell, not on a
conclusion, so true is common.

"diagram" is REQUIRED as a top-level key. Give the single diagram that best
shows the shape of this lesson. Only use null if the lesson genuinely has no
process, comparison, hierarchy, cycle or sequence in it at all — that is rare.
TODAY IS {today}; every date in "tasks" must be YYYY-MM-DD and in the future.

Each block is one of:
  {{"type":"points","heading":str,"items":[str]}}
  {{"type":"definitions","items":[{{"term":str,"meaning":str}}]}}
  {{"type":"formula","formula":str,"means":str,"when":str}}
  {{"type":"example","title":str,"steps":[str]}}
  {{"type":"diagram","spec":{{...}}}}
  {{"type":"assessed","items":[str]}}
  {{"type":"gaps","items":[str]}}

Diagram spec — pick the shape that fits what was actually taught:
  {{"kind":"flow","title":str,"nodes":[{{"id":str,"label":str}}],"edges":[{{"from":str,"to":str,"label":str}}]}}
  {{"kind":"mindmap","title":str,"centre":str,"branches":[{{"label":str,"children":[str]}}]}}
  {{"kind":"cycle","title":str,"steps":[str]}}
  {{"kind":"timeline","title":str,"points":[{{"when":str,"what":str}}]}}
  {{"kind":"compare","title":str,"columns":[str,str],"rows":[{{"aspect":str,"left":str,"right":str}}]}}
  {{"kind":"hierarchy","title":str,"root":str,"children":[{{"label":str,"children":[str]}}]}}
  {{"kind":"graph","title":str,"x":str,"y":str,"note":str,
   "lines":[{{"label":str,"dashed":bool,"points":[[x,y],[x,y]]}}]}}

USE "graph" WHENEVER THE LESSON IS ABOUT THE SHAPE OF A CURVE OR A
RELATIONSHIP — supply and demand, elasticity, cost curves, velocity-time,
displacement-time, rates of reaction, any y-against-x. Points are [x,y] on a
0-100 scale in both directions, so 0 is the origin and 100 is the far end of
each axis; you never need pixels. A vertical line is [[50,0],[50,100]]. A
horizontal line is [[0,50],[100,50]]. A line through the origin is
[[0,0],[100,100]]. A line cutting the y-axis is [[0,30],[100,100]]; a line
cutting the x-axis is [[30,0],[100,90]]. Name both axes.

A lesson that defines several distinct cases needs ONE GRAPH PER CASE, not one
overall — five categories of elasticity means five graphs, each placed in the
section that explains it.

Rules that matter:
- COMPLETENESS IS THE POINT. A student must be able to revise from this note
  alone, without replaying the lesson. Keep every idea, example, definition,
  piece of model phrasing and instruction that was captured. Do not merge two
  distinct ideas into one line to be concise.
- Expect a real lesson to produce 25-60 points spread across several headed
  sections, not a tidy list of eight. Under-writing is the failure mode here,
  not over-writing.
- Use several "points" blocks with real headings that follow the lesson's own
  structure, rather than one block called "Key points".
- Where the teacher dictated wording or a model sentence, keep it verbatim as
  its own item prefixed with "> ".
- No filler, no "in conclusion", no restating the topic in the first line. Dense
  is not the same as short.
- Keep every number, formula, date and name exactly as recorded.
- Include ONE or TWO diagrams, and only where a diagram genuinely helps —
  a process, a comparison, a hierarchy, a cycle. Never diagram a list.
- "gaps" is what to ask the TEACHER next lesson — real questions about the
  subject, the kind a good student writes in the margin. For example: "does
  this formula still hold when the collision is inelastic?", "which of these
  two methods is expected in Paper 1?".
  NEVER ask about the transcript itself. A misheard word is a microphone
  problem, not a doubt: do not write "clarify the meaning of 'Scarra Svati'",
  do not ask to confirm a name or figure that simply came through garbled, and
  do not ask the student to check the wording of the recording. If a passage is
  unintelligible, leave it out silently — the student cannot ask their teacher
  what your speech model failed to hear.
  If there is no genuine subject question worth asking, return an empty list.
- Everything must come from the input — never invent material. But do not
  discard input either: if it was said, it belongs in the note.
- The recording may mix Hindi and English. Write the finished note in English,
  keeping any Hindi term the teacher used alongside its meaning."""


DIAGRAM_KINDS = ("flow", "cycle", "mindmap", "hierarchy", "timeline",
                 "compare", "graph")

# Every field any diagram shape uses, for pulling a spec off a flat block.
DIAGRAM_FIELDS = ("kind", "title", "nodes", "edges", "steps", "items",
                  "rows", "columns", "branches", "centre", "center",
                  "points", "children", "root", "lines", "x", "y",
                  "note", "left", "right", "labels")


# Models reach for Mermaid whatever the schema says — it is what they have seen
# a million times. A real Economics lesson came back with a perfectly good
# "graph TD PES[...] --> PI[...]" in a "content" field, and the normaliser threw
# it away because it carried no "nodes" key. Rather than fight that habit,
# translate it: Mermaid flowcharts map cleanly onto the flow shape.
_MM_NODE = re.compile(r"([A-Za-z_][\w]*)\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?")
_MM_EDGE = re.compile(
    r"([A-Za-z_][\w]*)\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*"
    r"-{1,2}[->.]*>?\s*(?:\|([^|]*)\|)?\s*"
    r"([A-Za-z_][\w]*)\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?")


def mermaid_to_spec(text: str) -> dict | None:
    """Turn a Mermaid flowchart into a flow spec. Returns None if it is not one."""
    if not isinstance(text, str):
        return None
    body = text.strip()
    if body.startswith("```"):
        body = re.sub(r"^```[a-zA-Z]*\n?|```$", "", body).strip()
    first = body.split("\n", 1)[0].strip().lower()
    if not first.startswith(("graph ", "flowchart ", "graph\t", "stateDiagram")):
        return None

    labels: dict[str, str] = {}
    edges = []
    for line in body.split("\n")[1:]:
        line = line.strip().rstrip(";")
        if not line or line.startswith(("%%", "class", "style", "subgraph", "end")):
            continue
        m = _MM_EDGE.search(line)
        if m:
            a, note, b = m.group(1), (m.group(2) or "").strip(), m.group(3)
            la = next((x for x in m.groups()[0:1] if x), None)
            # Capture the bracket text on each side if it was given here.
            side_a = re.match(r"[A-Za-z_][\w]*\s*\[([^\]]*)\]", line)
            if side_a:
                labels.setdefault(a, side_a.group(1).strip())
            lb = m.group(4) or m.group(5) or m.group(6)
            if lb:
                labels.setdefault(b, lb.strip())
            labels.setdefault(a, a)
            labels.setdefault(b, b)
            edges.append({"from": a, "to": b, "label": note})
            continue
        # A standalone node declaration, e.g. "PI[Perfectly Inelastic]".
        solo = re.fullmatch(r"([A-Za-z_][\w]*)\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})", line)
        if solo:
            name = solo.group(2) or solo.group(3) or solo.group(4) or solo.group(1)
            labels.setdefault(solo.group(1), name.strip())

    if not edges:
        return None
    nodes = [{"id": k, "label": (v or k).strip(' "')} for k, v in labels.items()]
    return {"kind": "flow", "nodes": nodes, "edges": edges}


def normalise_blocks(blocks) -> list:
    """Coerce whatever the model returned into the shape the UI renders.

    Models use near-miss key names — "title" or "name" instead of "heading",
    "content"/"bullets" instead of "items", a diagram nested under "diagram"
    rather than "spec". The renderer used to skip anything that did not match
    exactly, so a perfectly good section or diagram vanished without a word.
    Accept the near-misses instead of discarding the work.
    """
    out = []
    for b in blocks or []:
        if not isinstance(b, dict):
            continue
        kind = str(b.get("type") or b.get("block") or "").lower().strip()
        items = b.get("items") or b.get("content") or b.get("bullets") or b.get("points")
        heading = (b.get("heading") or b.get("title") or b.get("name")
                   or b.get("section") or "")

        if kind in ("diagram", "chart", "figure", "flowchart", "graphic"):
            spec = b.get("spec") or b.get("diagram") or b.get("data") or {}
            # Some answers put the diagram fields straight on the block instead
            # of nesting them under "spec". Requiring "spec" threw those away —
            # which is most of the reason notes came back with no diagram.
            if not isinstance(spec, dict) or not spec:
                spec = {k: v for k, v in b.items() if k in DIAGRAM_FIELDS}
            # Every shape carries its content under a different key: flow has
            # nodes, compare has rows, mindmap has branches, timeline has
            # points, hierarchy has children, graph has lines. The old test
            # accepted only nodes/steps/items, so four of the seven shapes were
            # thrown away without a word — which is why notes so often came back
            # with no diagram at all.
            # Mermaid arrives as text under content/mermaid/code/text.
            if not any(spec.get(k) for k in ("nodes", "rows", "branches",
                                             "points", "children", "lines",
                                             "steps", "items")):
                for key in ("content", "mermaid", "code", "text", "diagram",
                            "definition", "chart"):
                    got = mermaid_to_spec(b.get(key) or spec.get(key) or "")
                    if got:
                        got["title"] = str(b.get("title") or spec.get("title") or "")
                        spec = got
                        break

            payload = ("nodes", "steps", "items", "rows", "branches", "points",
                       "children", "lines")
            if isinstance(spec, dict) and any(spec.get(k) for k in payload):
                if not spec.get("kind") and b.get("kind") not in (None, "diagram"):
                    spec["kind"] = str(b.get("kind"))
                if str(spec.get("kind") or "") not in DIAGRAM_KINDS:
                    # Guess from the shape of the data rather than defaulting
                    # everything to "flow", which drew nonsense for a graph.
                    spec["kind"] = ("graph" if spec.get("lines") else
                                    "compare" if spec.get("rows") else
                                    "mindmap" if spec.get("branches") else
                                    "timeline" if spec.get("points") else
                                    "hierarchy" if spec.get("children") else
                                    "cycle" if spec.get("steps") else "flow")
                out.append({"type": "diagram", "spec": spec})
            continue
        if kind == "definitions":
            rows = []
            for d in (items or []):
                if isinstance(d, dict):
                    term = d.get("term") or d.get("word") or d.get("name") or ""
                    mean = d.get("meaning") or d.get("definition") or d.get("value") or ""
                    if term:
                        rows.append({"term": str(term), "meaning": str(mean)})
                elif isinstance(d, str) and " - " in d:
                    a, _, bb = d.partition(" - ")
                    rows.append({"term": a.strip(), "meaning": bb.strip()})
            if rows:
                out.append({"type": "definitions", "items": rows})
            continue
        if kind == "formula":
            f = b.get("formula") or b.get("expression") or ""
            if f:
                out.append({"type": "formula", "formula": str(f),
                            "means": str(b.get("means") or b.get("explanation") or ""),
                            "when": str(b.get("when") or b.get("use") or "")})
            continue
        if kind == "example":
            steps = b.get("steps") or items or []
            if steps:
                out.append({"type": "example", "title": str(heading or "Worked example"),
                            "steps": [str(s) for s in steps if str(s).strip()]})
            continue
        if kind == "summary":
            text = b.get("text") or b.get("summary") or ""
            if text:
                out.append({"type": "summary", "text": str(text)})
            continue

        # Prose shape. Gemini writes the best notes as alternating
        # {"type":"heading"} / {"type":"text"} blocks, where the text is
        # markdown carrying nested bullets, > [!callouts] and verbatim quotes —
        # exactly the Obsidian structure we asked for. Neither type was
        # recognised, so all of it was silently binned and the note fell back to
        # raw transcript lines. Fold them into the points blocks the UI renders.
        if kind in ("heading", "header", "section", "subheading"):
            title = str(b.get("text") or heading or "").strip()
            if title:
                out.append({"type": "points", "heading": title, "items": []})
            continue
        if kind in ("text", "paragraph", "prose", "body", "markdown", "md"):
            body = str(b.get("text") or b.get("content") or b.get("body") or "")
            lines = [l.rstrip() for l in body.splitlines() if l.strip()]
            if not lines:
                continue
            # Attach to the heading immediately above, so a section keeps its
            # own name instead of everything landing in one bucket.
            if out and out[-1].get("type") == "points":
                out[-1]["items"].extend(lines)
            else:
                out.append({"type": "points", "heading": str(heading) or "Notes",
                            "items": lines})
            continue

        if isinstance(items, list):
            flat = [str(i).strip() for i in items if str(i).strip()]
        elif items:
            flat = [str(items)]
        else:
            flat = []
        # Models very often put the section body in "text" as a markdown string
        # rather than in an "items" list — including for blocks they themselves
        # labelled "points". Splitting it into lines keeps the nesting, the
        # callouts and the verbatim quotes; ignoring it threw the entire note
        # away and left the raw transcript showing in its place.
        if not flat:
            body = b.get("text") or b.get("body") or b.get("markdown") or ""
            flat = [l.rstrip() for l in str(body).splitlines() if l.strip()]
        if not flat:
            continue
        if kind in ("assessed", "assessment", "exam"):
            out.append({"type": "assessed", "items": flat})
        elif kind in ("gaps", "questions", "ask"):
            out.append({"type": "gaps", "items": flat})
        else:
            out.append({"type": "points",
                        "heading": str(heading) or "Notes", "items": flat})
    # A heading whose text block never arrived would render as an empty section.
    kept = [b for b in out if b.get("type") != "points" or b.get("items")]

    # A run of sections that all came back unnamed renders as "Notes", "Notes",
    # "Notes" — five identical headings read worse than one. Fold consecutive
    # unnamed point blocks together.
    folded = []
    for b in kept:
        anon = (b.get("type") == "points"
                and str(b.get("heading") or "").strip().lower()
                in ("", "notes", "key points", "points"))
        if anon and folded and folded[-1].pop("_anon", False):
            folded[-1]["items"] = list(folded[-1].get("items") or [])                 + list(b.get("items") or [])
            folded[-1]["_anon"] = True
            continue
        if anon:
            b = dict(b, heading=b.get("heading") or "Notes", _anon=True)
        folded.append(b)
    for b in folded:
        b.pop("_anon", None)
    return folded


def _merge_quotes(out: dict) -> dict:
    """Give the teacher's exact words their own place in the note.

    Relying on a "> " prefix inside a bullet meant the wording the teacher
    dictated silently blended into ordinary points and lost its status. A named
    field survives; a formatting convention does not.
    """
    quotes = [str(q).strip() for q in (out.get("quotes") or []) if str(q).strip()]
    out.pop("quotes", None)
    if not quotes:
        return out
    blocks = out.get("blocks") or []
    blocks.insert(0, {"type": "points",
                      "heading": "In the teacher's own words",
                      "items": ["> " + q.lstrip("> ") for q in quotes]})
    out["blocks"] = blocks
    return out


def _merge_diagrams(out: dict) -> dict:
    """Place a required top-level "diagrams" list into the block list.

    A named top-level key is the only reliable way to get diagrams out of these
    models: asked for one inside `blocks` they simply do not produce it, as a
    real Economics lesson proved — perfect notes, five categories of supply
    curve described in words, and not a single diagram. Each spec carries
    "after", the heading it illustrates, so it lands in the right section
    instead of all of them piling up at the end.
    """
    specs = out.get("diagrams")
    out.pop("diagrams", None)
    if not isinstance(specs, list) or not specs:
        return out
    blocks = out.get("blocks") or []
    seen = {json.dumps(b.get("spec"), sort_keys=True, default=str)
            for b in blocks if b.get("type") == "diagram"}

    for spec in specs:
        if not isinstance(spec, dict):
            continue
        after = str(spec.pop("after", "") or "").strip().lower()
        if str(spec.get("kind", "")).lower() not in DIAGRAM_KINDS:
            continue
        key = json.dumps(spec, sort_keys=True, default=str)
        if key in seen:
            continue
        seen.add(key)
        block = {"type": "diagram", "spec": spec}
        # Straight after the section it explains, if that section exists.
        at = len(blocks)
        if after:
            for i, b in enumerate(blocks):
                head = str(b.get("heading") or "").strip().lower()
                if head and (after in head or head in after):
                    at = i + 1
                    break
        blocks.insert(at, block)
    out["blocks"] = blocks
    return out


def _merge_diagram(out: dict) -> dict:
    """Lift the required top-level `diagram` into the block list.

    Asking for the diagram as its own key rather than hoping one appears
    somewhere inside `blocks` is the difference between getting one most of the
    time and getting one nearly always — the model treats a named key as
    mandatory and a list item as optional.
    """
    spec = out.get("diagram")
    blocks = out.get("blocks") or []
    # A lesson can need several diagrams — five categories of elasticity means
    # five graphs. Any the model already put in `blocks` stay; this only rescues
    # the top-level one, and only when it is not a duplicate of those.
    drawn = [json.dumps(b.get("spec"), sort_keys=True, default=str)
             for b in blocks if b.get("type") == "diagram"]
    if isinstance(spec, dict) and str(spec.get("kind", "")).lower() in DIAGRAM_KINDS:
        if json.dumps(spec, sort_keys=True, default=str) not in drawn:
            # After the points, before the closing callouts, is where a diagram
            # actually helps when you are revising.
            at = next((i for i, b in enumerate(blocks)
                       if b.get("type") in ("assessed", "gaps")), len(blocks))
            blocks.insert(at, {"type": "diagram", "spec": spec})
    out["blocks"] = blocks
    out.pop("diagram", None)
    return out


CONTINUATION = """
THIS LESSON CONTINUES AN EARLIER ONE. Below is the note so far. Produce the
MERGED note covering both lessons, not a note about today only:
- Fold today's material into the existing sections rather than repeating them.
- If today corrected or completed something from last time, use the corrected
  version and do not leave the half-finished one behind.
- Keep the existing title unless the topic genuinely moved on.
- Carry forward anything from the old note that is still unresolved.

EXISTING NOTE:
{previous}
"""


def compose(pieces: list[dict], profile: dict, subject: str, topic: str,
            today: str = "", previous: dict | None = None,
            transcript: str = "") -> dict:
    merged = {
        "points": [p for c in pieces for p in c.get("points", [])],
        "terms": [t for c in pieces for t in c.get("terms", [])],
        "examples": [e for c in pieces for e in c.get("examples", [])],
        "formulas": [f for c in pieces for f in c.get("formulas", [])],
        "tasks": [t for c in pieces for t in c.get("tasks", [])],
        "assessed": [a for c in pieces for a in c.get("assessed", [])],
        "confusing": [x for c in pieces for x in c.get("confusing", [])],
    }
    fallback = {
        "title": topic or subject or "Lesson",
        "summary": "",
        "blocks": ([{"type": "points", "heading": "Key points",
                     "items": merged["points"]}] if merged["points"] else [])
                  + ([{"type": "definitions", "items": merged["terms"]}]
                     if merged["terms"] else []),
        "tasks": merged["tasks"],
    }
    if not any(merged.values()):
        return fallback

    system = COMPOSE.format(
        name=profile.get("name") or "the student",
        grade=profile.get("grade") or "secondary",
        curriculum=profile.get("curriculum") or "their curriculum",
        school=profile.get("school") or "school",
        subject=subject or "General", topic=topic or "(not given)",
        today=today or "today")
    if previous and previous.get("blocks"):
        system += CONTINUATION.format(
            previous=json.dumps({"title": previous.get("title", ""),
                                 "blocks": previous.get("blocks", [])},
                                ensure_ascii=False)[:9000])
    # Gemini first: it can hold the whole transcript, Groq cannot.
    payload = {"captured": merged}
    # Hand over the transcript as well, not just the condensed pass. The
    # condensed pass is lossy by construction; with the real words available the
    # note can carry the detail a student would otherwise have to re-listen for.
    if transcript:
        payload["transcript"] = transcript[:24000]
    body = json.dumps(payload, ensure_ascii=False)[:120000]
    out = gemini_json(system, body) if gemini_ready() else None
    if not out and transcript:
        out = _sectioned_tidy(system, transcript)
    if not out:
        out = dict(fallback)
        out["_failed"] = _last_error or "no model could write the note"
    out["blocks"] = normalise_blocks(out.get("blocks")) or fallback["blocks"]
    if not isinstance(out.get("tasks"), list) or not out["tasks"]:
        # Never lose a homework the map step heard just because the compose
        # step forgot to copy it forward.
        out["tasks"] = merged["tasks"]
    out.setdefault("title", fallback["title"])
    out.setdefault("summary", "")
    return _merge_diagrams(_merge_diagram(_merge_quotes(out)))


# ===========================================================================
# Sorting ManageBac items into subjects
# ===========================================================================
CLASSIFY = """You file school assignments under the right subject.

The student takes exactly these subjects:
{subjects}

You get a list of assignment titles. Reply with JSON only:
{{"assignments":[{{"title":str,"subject":str}}]}}

Rules:
- "subject" must be copied EXACTLY from the list above, or be "" if you cannot tell.
- Judge by topic. "Drag Forces" is physics; "Demand and Supply" is economics;
  "Poetry" is English; "Functions Quiz" is maths.
- A generic title like "Class Assignment A1" with nothing to go on gets "".
- Use subject knowledge: PPC means production possibility curve (economics);
  "Paper 1/2/3" is an IB exam paper, so judge by the topic beside it;
  "Functions" is maths; "Kinematics" and "Drag" are physics.
- Never invent a subject that is not in the list. Guessing wrong hides the work
  in the wrong notebook, which is worse than leaving it unfiled."""


def classify_subjects(titles: list[str], subjects: list[str]) -> dict:
    """title -> subject. Empty dict if there is nothing to work with."""
    if not titles or not subjects:
        return {}
    system = CLASSIFY.format(subjects=chr(10).join("- " + s for s in subjects))
    # The big model, deliberately. This runs once per ManageBac refresh, not
    # per audio slice, so the cost is trivial — and the small model filed
    # "Functions Quiz" and "PPC - Paper 1 style" as unknown, which leaves real
    # work invisible in the wrong notebook.
    out = json_call(system, json.dumps({"titles": titles[:60]}),
                    fallback={}, model=big(), max_tokens=1500)
    mapping = {}
    allowed = {s.lower(): s for s in subjects}
    for row in out.get("assignments") or []:
        title = (row.get("title") or "").strip()
        subject = (row.get("subject") or "").strip()
        if title and subject.lower() in allowed:
            mapping[title] = allowed[subject.lower()]
    return mapping



# ===========================================================================
# Group uploaded documents into separate, coherent notes
# ===========================================================================
GROUP_DOCS = """You organise a student's uploaded study files into SEPARATE notes.

You are given a list of documents, each with a name and an excerpt. Decide how
to split them so each note is one coherent topic — the way a student keeps
separate pages in a binder.

Rules for grouping:
- A primary text (a poem, story, comic, article, source) and the worksheets or
  notes ABOUT that text belong in the SAME note.
- Two unrelated topics belong in DIFFERENT notes.
- General technique or skills notes (e.g. "how to analyse cartoons") are their
  own note, separate from the specific text being analysed.
- Prefer a few coherent notes over one giant note or many tiny ones.
- Every document goes in exactly one note.

Return JSON, nothing else:
{{"notes":[{{"title":str,"members":[str],"focus":str}}]}}
- "title": what to call the note. Specific — "A Prayer for my Daughter (Yeats)",
  not "Poem". Name the actual text or topic.
- "members": the EXACT document names (copied verbatim) that belong in this note.
- "focus": one sentence on what the finished note should cover — for a primary
  text, that means analysis and annotation, not a plot summary."""


def group_documents(docs: list[dict]) -> list[dict]:
    """Split [{name, excerpt}] into note groups. Falls back to one note per
    document if the model is unavailable, which is still far better than one
    giant note."""
    if not docs:
        return []
    listing = [{"name": d["name"], "excerpt": (d.get("excerpt") or "")[:700]}
               for d in docs]
    out = json_call(GROUP_DOCS, json.dumps({"documents": listing}),
                    fallback={}, model=big(), max_tokens=2000)
    groups = []
    names = {d["name"] for d in docs}
    claimed = set()
    for g in out.get("notes") or []:
        members = [m for m in (g.get("members") or [])
                   if m in names and m not in claimed]
        if not members:
            continue
        claimed.update(members)
        groups.append({"title": (g.get("title") or members[0]).strip(),
                       "members": members,
                       "focus": (g.get("focus") or "").strip()})
    # Any document the model forgot becomes its own note, so nothing is lost.
    for d in docs:
        if d["name"] not in claimed:
            groups.append({"title": d["name"].rsplit(".", 1)[0],
                           "members": [d["name"]], "focus": ""})
    return groups



# ===========================================================================
# Practice — the "learn it properly" half of the app
# ===========================================================================

# How each board actually writes its papers.
#
# Not decoration. "Exam-style" without a style is just questions, and a student
# who has only ever practised generic questions meets the real command terms and
# the real mark allocations for the first time in the exam hall. These are the
# published structures, so the practice looks like the paper.
BOARD_STYLES = {
    "ib": """- IB tiers its command terms by objective: level 1 knowledge (State,
  Define, List, Identify), level 2 application (Describe, Outline, Explain,
  Calculate, Distinguish), level 3 synthesis and evaluation (Evaluate, Discuss,
  Justify, Examine, "To what extent"). Use the real term, and answer to the
  level it demands.
- Marks signal depth, not sentence count: 1-2 marks is a precise statement or
  definition, 3-4 marks an explanation with a reason, 6-8 marks a developed
  argument, 10-15 marks a structured multi-perspective response with a
  judgement. Paper 2 style extended response ends in an evaluation, not a
  summary.
- Where the subject uses them, include a diagram instruction in the stem
  ("using a diagram, explain...") and say in the working what the diagram must
  show and label.""",
    "cbse": """- CBSE Class 12 papers run 3 hours for 80 theory marks, and are now
  roughly half competency-based. Mirror that mix across the set:
  about 20% multiple choice or Assertion-Reason, about 50% competency-based
  (case-study, source-based, data-based or visual-based, where a passage, table
  or figure is given and several parts hang off it), and about 30% short and
  long constructed answers.
- Use CBSE's own mark steps: 1 mark objective, 2 marks very short answer,
  3 marks short answer, 5 marks long answer.
- For Assertion-Reason, give Assertion (A) and Reason (R) and ask which of the
  standard four options holds — including the case where both are true but R
  does not explain A, which is where marks are actually lost.""",
    "cambridge": """- Cambridge stems build in parts: (a) define or state, (b) explain
  or calculate, (c) analyse, (d) discuss or evaluate — each part worth more than
  the last, off one shared context. Write them that way.
  - Mark allocations run 1-2 for recall, 4-6 for explanation with development,
  8-12 for evaluation carrying a conclusion.
  - Where the paper is data-response, give the data (a short extract, table or
  figure) inside the question rather than assuming it.""",
    "icse": """- ICSE papers reward detail and precise terminology, with questions
  split into short compulsory parts and longer structured questions carrying
  internal choice. Use full sentences in the mark scheme and expect named
  examples.""",
    "": """- Use the ordinary command terms of the subject (Define, Explain,
  Calculate, Analyse, Evaluate), mark allocations proportional to the depth
  asked for, and a mark scheme detailed enough to self-mark against.""",
}


def board_style(curriculum: str) -> str:
    """Match the student's stated curriculum to a paper style, loosely.

    Students type this themselves, so it arrives as "IB", "IBDP", "IB Diploma",
    "cbse board", "Cambridge IGCSE" and everything in between. Substring
    matching on a lowered string beats an exact lookup that silently falls
    through to generic for anyone who typed it a little differently.
    """
    c = (curriculum or "").lower()
    if "ib" in c.split() or "ibdp" in c or "diploma programme" in c or c.startswith("ib"):
        return BOARD_STYLES["ib"]
    if "cbse" in c or "ncert" in c:
        return BOARD_STYLES["cbse"]
    if "igcse" in c or "cambridge" in c or "a level" in c or "a-level" in c or "cie" in c:
        return BOARD_STYLES["cambridge"]
    if "icse" in c or "isc" in c:
        return BOARD_STYLES["icse"]
    return BOARD_STYLES[""]


PRACTICE = """You write exam practice for a {curriculum} student in {grade},
studying {subject}.

You are given the student's OWN notes on a topic. Write practice questions that
test exactly that material, in the style and command terms their course uses.
This is not a quiz for fun — it is revision that has to earn its time.

Return JSON only:
{{"topic":str,
  "questions":[
    {{"q":str,
      "marks":int,
      "command":str,
      "kind":"recall"|"apply"|"analyse"|"calculate",
      "answer":str,
      "working":[str],
      "why":str,
      "trap":str}}
  ]}}

Write them the way {curriculum} writes them. Past papers have a house style —
the command terms, the mark allocations, the way a stem is set up, the order a
multi-part question builds in — and a student who practises in that style walks
into the exam recognising the paper. Match it:

{board}

Rules:
- {count} questions, ordered easiest to hardest.
- Where the paper uses multi-part questions (a), (b), (c) building on one stem,
  write them that way rather than as unrelated singles.
- "command" is the course's own command term — Define, Explain, Calculate,
  Analyse, Evaluate, Compare, Justify, Outline.
- "marks" is realistic for that command term (Define 2, Explain 3-4,
  Evaluate 6-8) and the answer must contain enough distinct points to earn them.
- "answer" is the full mark-scheme answer, not a hint.
- "working" is the step-by-step route to it. For a calculation show every line
  with units. For an essay-style question list the points a marker looks for.
  Write maths as it is written on paper (%ΔQs, x², √16, ≤, ∞) — never LaTeX,
  no backslash commands, no dollar signs.
- "why" explains the underlying idea in one or two plain sentences, so a
  student who got it wrong understands rather than memorises.
- "trap" is the specific mistake students actually make here. If there is no
  real trap, use "".
- Base every question ONLY on the notes given. Do not invent syllabus content
  that is not there."""


def practice(notes_text: str, profile: dict, subject: str, topic: str,
             count: int = 5) -> dict:
    """Exam-style practice questions with full worked answers, from the
    student's own notes."""
    fallback = {"topic": topic or subject, "questions": [], "_failed": ""}
    if len((notes_text or "").split()) < 30:
        out = dict(fallback)
        out["_failed"] = "there is not enough in these notes yet to practise from"
        return out

    try:
        want = int(count or 5)
    except (TypeError, ValueError):
        want = 5
    # 20 is the real ceiling now, not 10. A full past-paper-length set is the
    # point of asking for 20, and the old clamp silently handed back 10 —
    # the request looked honoured and was not.
    want = max(3, min(20, want))

    curriculum = profile.get("curriculum") or "their curriculum"
    system = PRACTICE.format(
        curriculum=curriculum,
        grade=profile.get("grade") or "secondary",
        subject=subject or "this subject",
        board=board_style(curriculum),
        count=want)

    # Roughly 700 tokens per question with its full mark scheme and working,
    # with headroom. Left at a flat 8000 a 20-question set was cut off
    # mid-JSON and parsed to nothing.
    budget = min(32000, 2000 + 700 * want)
    out = gemini_json(system, notes_text[:60000], max_tokens=budget) if gemini_ready() else None
    if not out:
        out = json_call(system, notes_text[:9000], fallback={}, model=big(),
                        max_tokens=min(8000, 1200 + 500 * want))
        if out.get("_failed"):
            bad = dict(fallback)
            bad["_failed"] = out["_failed"]
            return bad

    questions = []
    for q in out.get("questions") or []:
        if not isinstance(q, dict):
            continue
        text = str(q.get("q") or q.get("question") or "").strip()
        answer = str(q.get("answer") or q.get("a") or "").strip()
        if not text or not answer:
            continue
        working = q.get("working") or q.get("steps") or []
        if isinstance(working, str):
            working = [working]
        try:
            marks = int(q.get("marks") or 0)
        except (TypeError, ValueError):
            marks = 0
        questions.append({
            "q": text,
            "marks": max(0, min(20, marks)),
            "command": str(q.get("command") or "").strip(),
            "kind": str(q.get("kind") or "apply").strip().lower(),
            "answer": answer,
            "working": [str(w) for w in working if str(w).strip()],
            "why": str(q.get("why") or "").strip(),
            "trap": str(q.get("trap") or "").strip(),
        })

    return {"topic": str(out.get("topic") or topic or subject),
            "questions": questions,
            "_failed": "" if questions else "no usable questions came back"}


EXPLAIN = """You explain one idea to a {curriculum} student in {grade} who has
just got it wrong, or has not met it before.

Return JSON only:
{{"title":str,"short":str,"steps":[str],"example":str,"misconception":str,
  "check":str}}

- "short": the idea in two sentences, in plain words. No jargon that is not
  then defined.
- "steps": how to think about it or apply it, 3-6 steps, in order.
- "example": one concrete worked example with real numbers or a real case.
- "misconception": the thing students most often get wrong about this.
- "check": one short question they can answer to prove they now understand.
- Maths as written on paper, never LaTeX.
- Teach at {grade} level for {curriculum}, using its command terms."""


def explain(idea: str, context: str, profile: dict) -> dict:
    """A teach-me-this-properly explainer for one concept."""
    system = EXPLAIN.format(
        curriculum=profile.get("curriculum") or "their curriculum",
        grade=profile.get("grade") or "secondary")
    body = f"IDEA TO EXPLAIN:\n{idea}\n\nFROM THE STUDENT'S NOTES:\n{context[:12000]}"
    out = gemini_json(system, body, max_tokens=3000) if gemini_ready() else None
    if not out:
        out = json_call(system, body[:8000], fallback={}, model=big(),
                        max_tokens=2000)
    steps = out.get("steps") or []
    if isinstance(steps, str):
        steps = [steps]
    return {
        "title": str(out.get("title") or idea)[:120],
        "short": str(out.get("short") or "").strip(),
        "steps": [str(s) for s in steps if str(s).strip()],
        "example": str(out.get("example") or "").strip(),
        "misconception": str(out.get("misconception") or "").strip(),
        "check": str(out.get("check") or "").strip(),
        "_failed": out.get("_failed", ""),
    }


# ===========================================================================
# 3. Answer a doubt — notes first, web second, always say which
# ===========================================================================
ANSWER = """You are Minerva, {name}'s study assistant. {name} is in {grade},
following {curriculum} at {school}.

Answer the question using the CONTEXT below. The context is the student's own
notes; anything marked WEB came from a search.

Rules:
- Lead with the answer. No preamble, no "great question".
- Cite where each fact came from using the bracketed labels, e.g. [note 2].
- If the notes cover it, use them and say so. If they do not and there is no
  web context, say plainly that it is not in the notes yet — do not fill the
  gap from memory.
- Teach at {grade} level for {curriculum}. Use the command terms and notation
  that curriculum uses.
- If the student seems to hold a misconception, correct it directly.
- Markdown. Short paragraphs, formulas on their own line."""


def answer(question: str, contexts: list[dict], profile: dict) -> str:
    if not contexts:
        body = "(no context found)"
    else:
        body = "\n\n".join(
            f"[{c['label']}] {c['title']}\n{c['text'][:2200]}" for c in contexts)
    system = ANSWER.format(
        name=profile.get("name") or "the student",
        grade=profile.get("grade") or "secondary school",
        curriculum=profile.get("curriculum") or "their curriculum",
        school=profile.get("school") or "school")
    try:
        return chat(system, f"CONTEXT\n{body}\n\nQUESTION\n{question}",
                    model=big(), temperature=0.35, max_tokens=1200)
    except AIUnavailable as exc:
        return f"I could not reach the model — {exc}"


# ===========================================================================
# Tidy a typed note into proper notes (the "make this awesome" button)
# ===========================================================================
TIDY = """You turn a raw lesson transcript, or rough notes, into full
revision-grade notes for a {curriculum} student in {grade}.

You are replacing what the student currently does by hand: paste a transcript
into a general chatbot, get back a long, well-structured set of notes, paste
that into Obsidian. Match that standard. Their handwritten version of a single
lesson runs to dozens of points across several headed sections — if your output
is visibly shorter than the input deserves, you have failed.

JSON shape:
{{"title":str,"summary":str,"blocks":[...],"tasks":[...],"diagrams":[...]}}

"diagrams" IS REQUIRED. It is a LIST of diagram specs using the shapes above,
each with an extra "after" field naming the heading it belongs under, so it can
be placed in the right section. An empty list is only acceptable for a lesson
with genuinely no shape, structure, process or relationship in it — which is
rare. A lesson defining several cases needs one diagram per case.

Example for a lesson on five categories of supply elasticity:
"diagrams":[
 {{"kind":"graph","title":"Perfectly inelastic (PES = 0)","after":"Perfectly Inelastic",
   "x":"Quantity supplied","y":"Price","note":"quantity fixed",
   "lines":[{{"label":"S","points":[[50,0],[50,100]]}}]}},
 {{"kind":"graph","title":"Unitary (PES = 1)","after":"Unitary",
   "x":"Quantity supplied","y":"Price","note":"through the origin",
   "lines":[{{"label":"S","points":[[0,0],[100,100]]}}]}}
]

Rules:
- COMPLETENESS FIRST. Work through the input from start to finish and carry
  every distinct idea across. Never compress two ideas into one line, never drop
  an aside, an example, or a piece of phrasing the teacher dictated.
- A transcript of one lesson should produce SEVERAL headed "points" blocks that
  follow the lesson's own order — not a single block of eight bullets.
- Where the teacher gave model wording, a sentence to copy, or a phrase to use
  in an essay, keep it VERBATIM as its own item prefixed with "> ".
- Where the teacher said what NOT to write, keep that too — students lose it and
  it is worth marks.
- Preserve every number, name, formula and date exactly.
- Write maths the way it is written on paper, NOT in LaTeX. No dollar signs, no
  backslash commands, no braces. Write "%ΔQs / %ΔP", not "$\\% \\Delta Q_s / \\% \\Delta P$".
  Write "Pold", "Qnew", "x²", "√16", "≤", "≥", "×", "∞", "Δ" as the characters
  themselves. A student reading the note should see notation, not code.
- Turn spoken informality into formal written notes, but do not shorten the
  substance while doing it.
- DIAGRAMS ARE REQUIRED, as {{"type":"diagram","spec":{{...}}}} blocks placed in
  the section they illustrate. Use the spec shapes given above. Do NOT write
  Mermaid, do NOT write "graph TD", do NOT put a diagram in a "content" string —
  those cannot be drawn. Give the fields directly.
- If the lesson is about the SHAPE of a relationship — a supply or demand curve,
  elasticity, a cost curve, velocity-time, rate of reaction, any y-against-x —
  use "graph", and give ONE PER CASE. A lesson defining five categories of
  elasticity needs five graphs, each in its own section, not one summary.
- Otherwise use flow for a process, compare for two things side by side,
  hierarchy for a tree, cycle for a loop, timeline for dates.
- If something is garbled or was cut off, leave it out rather than inventing
  the missing half — and do NOT turn it into a question. "gaps" is for real
  subject doubts to raise with the teacher, never for words the microphone
  failed to catch.
- Never add material that is not in the input.
- Write for {curriculum} at {grade} level, using that syllabus's command terms.

Formatting — write these notes the way a careful student writes in Obsidian:
- Use nested bullets. A sub-point goes on its own line indented by two spaces
  under its parent. Depth of two or three is normal for a real note; a flat list
  of long sentences is not a note, it is a paragraph in disguise.
- Bold the term being defined or the thing being named: **thesis statement**.
- Use `backticks` for anything to be copied exactly — a command term, a formula,
  a phrase to reuse in an essay.
- Where a point is a warning, a rule of thumb or an exam trap, start the item
  with a callout marker on its own line, Obsidian style:
    > [!warning] Do not do this
    > the text of the warning
  Valid markers: [!tip], [!warning], [!example], [!quote], [!info].
- Model wording the teacher dictated stays VERBATIM inside > [!quote].
- Keep the lesson's own order. Headings are short noun phrases, not sentences."""


PART_NOTE = (
    "\n\nThis is part {n} of {total} of one lesson. Write the sections for "
    "THIS part only. Do not summarise the whole lesson and do not repeat "
    "earlier parts."
)


def _sectioned_tidy(system: str, text: str) -> dict | None:
    """Write the note in passes, so an 8,000-token ceiling is not a wall.

    Groq allows 8,000 tokens a minute including the prompt. A lesson does not
    fit. Rather than giving up — which is what produced notes a fifth the right
    length — split the transcript, write each part inside the budget, and join
    the sections. Slower, but it always produces real notes.
    """
    words = text.split()
    if not words:
        return None
    # ~1,600 words per pass keeps prompt + answer under the limit.
    size = 1600
    parts = [" ".join(words[i:i + size]) for i in range(0, len(words), size)]
    blocks, tasks, title, summary = [], [], "", ""
    for n, part in enumerate(parts, 1):
        hint = system + PART_NOTE.format(n=n, total=len(parts))
        got = json_call(hint, part, fallback={}, model=big(), max_tokens=3000)
        if got.get("_failed"):
            continue
        blocks += normalise_blocks(got.get("blocks"))
        tasks += [t for t in (got.get("tasks") or []) if isinstance(t, dict)]
        title = title or str(got.get("title") or "")
        summary = summary or str(got.get("summary") or "")
    if not blocks:
        return None
    return {"title": title, "summary": summary, "blocks": blocks, "tasks": tasks}


def tidy(text: str, profile: dict, subject: str, topic: str) -> dict:
    fallback = {"title": topic or subject or "Note", "summary": "",
                "blocks": [{"type": "points", "heading": "Notes",
                            "items": [l.strip("-* ") for l in text.splitlines()
                                      if l.strip()][:40]}],
                "tasks": []}
    if len(text.split()) < 8:
        return fallback
    system = TIDY.format(curriculum=profile.get("curriculum") or "their curriculum",
                         grade=profile.get("grade") or "secondary")
    # Same ladder as compose(): Gemini can hold a whole lesson in one call,
    # Groq cannot — its free tier allows 8,000 tokens a minute including the
    # prompt, so asking it for 16,000 was guaranteed to 413 and drop straight to
    # the fallback. That single line is why pasting a transcript returned the
    # transcript back as bullets.
    out = gemini_json(system, text[:120000]) if gemini_ready() else None
    if not out:
        out = _sectioned_tidy(system, text)
    if not out:
        out = dict(fallback)
        out["_failed"] = _last_error or "no model could write the note"
    out["blocks"] = normalise_blocks(out.get("blocks")) or fallback["blocks"]
    out.setdefault("title", fallback["title"])
    out.setdefault("summary", "")
    out.setdefault("tasks", [])
    return _merge_diagrams(_merge_diagram(_merge_quotes(out)))

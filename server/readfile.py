"""Turn an uploaded file into text, whatever kind of file it is.

Before this, an upload was stored and listed but only PDFs and .txt were ever
read. A photo of the whiteboard, a worksheet .docx or the teacher's slides went
in as opaque bytes — they could not be searched, and they could not be folded
into a note. So "upload almost all kinds of files related to notes" was true of
the upload and false of everything after it.

Everything here is standard library except the image path, which needs a model
to read handwriting and diagrams — that goes to Gemini, the same key the
timetable reader already uses.

Office formats are ZIPs of XML. We do not need a full parser: we need the words
in reading order, which is exactly what the <w:t> / <a:t> text runs give us.
"""
from __future__ import annotations

import base64
import html
import io
import re
import zipfile

from . import config, net, pdftext

# Word/PowerPoint/Excel put visible text in these elements. Paragraph and row
# ends become newlines so the text keeps its shape instead of running together.
_RUN = re.compile(rb"<(?:w|a):t(?:\s[^>]*)?>(.*?)</(?:w|a):t>", re.S)
_CELL = re.compile(rb"<t(?:\s[^>]*)?>(.*?)</t>", re.S)
_BREAK = re.compile(rb"</(?:w:p|a:p|w:tr|row)>")
_TAG = re.compile(r"<[^>]+>")


def _zip_text(blob: bytes, members: list[str], pattern: re.Pattern) -> str:
    """Pull text runs out of the named parts of an OOXML package."""
    out = []
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        names = z.namelist()
        wanted = [n for n in names if any(re.fullmatch(p, n) for p in members)]
        # Slides are numbered; read them in order so the notes follow the deck.
        wanted.sort(key=lambda n: [int(x) if x.isdigit() else x
                                   for x in re.split(r"(\d+)", n)])
        for n, name in enumerate(wanted, 1):
            try:
                raw = z.read(name)
            except Exception:
                continue
            raw = _BREAK.sub(b"\n@@BREAK@@\n", raw)
            runs = [m.group(1).decode("utf-8", "replace")
                    for m in pattern.finditer(raw)]
            if not runs:
                continue
            chunk = "".join(runs)
            page = html.unescape(_TAG.sub("", chunk)).strip()
            if page:
                if len(wanted) > 1 and "slide" in name:
                    out.append(f"[Slide {n}]")
                out.append(page)
    return "\n\n".join(out)


def _docx(blob: bytes) -> str:
    # Paragraph ends are lost by a plain run scan, so walk paragraphs directly.
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        try:
            raw = z.read("word/document.xml")
        except KeyError:
            return ""
    lines = []
    for para in re.split(rb"</w:p>", raw):
        runs = [m.group(1).decode("utf-8", "replace") for m in _RUN.finditer(para)]
        if not runs:
            continue
        line = html.unescape(_TAG.sub("", "".join(runs))).strip()
        if not line:
            continue
        # A heading in Word carries a style; keep it as a markdown heading so
        # the note writer can see the document's own structure.
        style = re.search(rb'w:val="Heading(\d)"', para)
        lines.append(("#" * (int(style.group(1)) + 1) + " " + line) if style else line)
    return "\n".join(lines)


def _pptx(blob: bytes) -> str:
    return _zip_text(blob, [r"ppt/slides/slide\d+\.xml"], _RUN)


def _xlsx(blob: bytes) -> str:
    return _zip_text(blob, [r"xl/sharedStrings\.xml"], _CELL)


VISION_PROMPT = (
    "Read this image and return every piece of information in it as plain text, "
    "in reading order.\n\n"
    "It is a student's study material: a photo of a whiteboard, a page of "
    "handwritten notes, a worksheet, a textbook page, a slide, or a diagram.\n\n"
    "Rules:\n"
    "- Transcribe ALL text, including handwriting, exactly as written.\n"
    "- Keep headings, numbering and the order things appear on the page.\n"
    "- Write formulae and equations in plain readable notation.\n"
    "- If there is a diagram, chart or drawing, describe what it shows and how "
    "its parts connect, with every label it carries.\n"
    "- Mark anything you genuinely cannot make out as [unclear]. Never guess a "
    "number, a name or a formula.\n"
    "- Return the text only. No preamble, no commentary."
)


class ImageUnreadable(Exception):
    """Vision was attempted and failed. Carries why, so the student is told."""


def _image(blob: bytes, mime: str) -> str:
    """Read an image with Gemini vision. Returns "" if no key is configured."""
    key = config.env("GEMINI_API_KEY")
    if not key:
        return ""
    if len(blob) > 8 * 1024 * 1024:
        return ""
    payload = {
        "contents": [{"role": "user", "parts": [
            {"text": VISION_PROMPT},
            {"inline_data": {"mime_type": mime,
                             "data": base64.b64encode(blob).decode()}},
        ]}],
        # Thinking off: reading text out of a picture is transcription, not
        # reasoning, and thinking was consuming the whole budget before a
        # single visible word came back.
        "generationConfig": net.no_thinking({"temperature": 0.0,
                                             "maxOutputTokens": 8192}),
    }
    # Reuse the timetable's Gemini caller: it already handles retired model
    # names, the TLS quirk on this network, and the browser User-Agent.
    from . import timetable
    try:
        out = timetable._call_gemini(payload, key)
        return net.gemini_text(out)
    except Exception as exc:
        # Was: swallow everything and return "". A quota error, a network drop
        # and a model that answered nothing all became the same silent blank,
        # which is why images reported "not searchable" with no reason.
        raise ImageUnreadable(str(exc)) from exc
    return ""


def read(name: str, mime: str, blob: bytes) -> tuple[str, str]:
    """Extract text from an uploaded file.

    Returns (text, how) — `how` names the method so the student can be told why
    a file is not searchable instead of it silently doing nothing.
    """
    ext = (name.rsplit(".", 1)[-1] if "." in name else "").lower()
    mime = (mime or "").lower()

    try:
        if ext == "pdf" or mime == "application/pdf":
            text = pdftext.pdf_text(blob)
            if len(text.split()) >= 20:
                return text, "pdf text"
            # A scanned PDF has no text layer. Say so rather than storing blank.
            return text, "pdf appears to be scanned images — no text layer"

        if ext in ("docx", "docm"):
            return _docx(blob), "word document"
        if ext in ("pptx", "pptm"):
            return _pptx(blob), "powerpoint slides"
        if ext in ("xlsx", "xlsm"):
            return _xlsx(blob), "spreadsheet"

        if mime.startswith("image/") or ext in ("png", "jpg", "jpeg", "webp",
                                                "gif", "heic", "bmp"):
            if not config.env("GEMINI_API_KEY"):
                return "", "no Gemini key set, so images cannot be read"
            if len(blob) > 8 * 1024 * 1024:
                return "", "image is over 8 MB — too large for AI vision"
            try:
                return _image(blob, mime if mime.startswith("image/")
                              else "image/png"), "read by AI vision"
            except ImageUnreadable as exc:
                return "", f"AI vision could not read it — {exc}"

        if mime.startswith("text/") or ext in ("txt", "md", "csv", "json", "rtf"):
            text = blob.decode("utf-8", "replace")[:200000]
            if ext == "rtf":                      # strip RTF control words
                text = re.sub(r"\\[a-z]+-?\d*\s?", " ", text).replace("{", "").replace("}", "")
            return text, "plain text"

        if ext in ("doc", "ppt", "xls"):
            return "", ("old Office format — re-save it as .docx, .pptx or "
                        ".xlsx and it will be readable")
    except Exception as exc:
        return "", f"could not be read — {exc}"

    return "", f".{ext} files are stored but not readable"

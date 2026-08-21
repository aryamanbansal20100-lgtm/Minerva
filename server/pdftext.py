"""pdftext.py — read text out of a PDF with nothing installed.

Lifted from the indexer built earlier in this project and verified against real
exported PDFs. Uploaded documents become searchable by Ask because of this.
"""

from __future__ import annotations

import base64
import re
import zlib

def _pdf_decode(dict_bytes: bytes, stream: bytes) -> bytes | None:
    for flt in re.findall(rb"/(ASCII85Decode|FlateDecode|ASCIIHexDecode)", dict_bytes):
        try:
            if flt == b"ASCII85Decode":
                s = stream.strip()
                if s.startswith(b"<~"):
                    s = s[2:]
                cut = s.find(b"~>")
                if cut != -1:
                    s = s[:cut]
                stream = base64.a85decode(re.sub(rb"\s", b"", s))
            elif flt == b"FlateDecode":
                stream = zlib.decompressobj().decompress(stream)
            else:
                stream = bytes.fromhex(re.sub(rb"[^0-9a-fA-F]", b"", stream).decode())
        except Exception:
            return None
    return stream


def _parse_cmap(raw: bytes) -> dict[int, str]:
    out: dict[int, str] = {}
    for blk in re.finditer(rb"beginbfchar(.*?)endbfchar", raw, re.S):
        for src, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>", blk.group(1)):
            try:
                out[int(src, 16)] = "".join(
                    chr(int(dst[i:i + 4], 16)) for i in range(0, len(dst), 4)
                )
            except ValueError:
                pass
    for blk in re.finditer(rb"beginbfrange(.*?)endbfrange", raw, re.S):
        body = blk.group(1)
        for lo, hi, dst in re.findall(
            rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", body
        ):
            start, stop, base = int(lo, 16), int(hi, 16), int(dst, 16)
            for code in range(start, min(stop, start + 4096) + 1):
                out[code] = chr(base + code - start)
        for lo, _hi, arr in re.findall(
            rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]", body, re.S
        ):
            start = int(lo, 16)
            for i, item in enumerate(re.findall(rb"<([0-9A-Fa-f]*)>", arr)):
                try:
                    out[start + i] = "".join(
                        chr(int(item[j:j + 4], 16)) for j in range(0, len(item), 4)
                    )
                except ValueError:
                    pass
    return out


_TOKEN = re.compile(
    rb"/(\w+)\s+[\d.]+\s+Tf"          # 1 set font
    rb"|<([0-9A-Fa-f]+)>\s*Tj"        # 2 hex string
    rb"|\(((?:\\.|[^\\()])*)\)\s*Tj"  # 3 literal string
    rb"|\[(.*?)\]\s*TJ"               # 4 array
    rb"|T\*|BT|ET",
    re.S,
)


def pdf_text(raw: bytes) -> str:
    """Text out of a PDF, standard library only — no pypdf, no poppler.

    Handles FlateDecode/ASCII85 content streams and resolves subset-font
    ToUnicode CMaps, which is what makes text from a real exported PDF come out
    as words rather than gibberish.
    """
    if not raw or not raw.startswith(b"%PDF"):
        return ""

    objs: dict[int, tuple[bytes, bytes | None]] = {}
    for m in re.finditer(rb"(\d+)\s+0\s+obj\b", raw):
        num = int(m.group(1))
        end = raw.find(b"endobj", m.end())
        body = raw[m.end(): end if end != -1 else len(raw)]
        sm = re.search(rb"stream\r?\n", body)
        if sm:
            objs[num] = (body[: sm.start()], body[sm.end(): body.find(b"endstream")])
        else:
            objs[num] = (body, None)

    cmaps: dict[str, dict[int, str]] = {}
    widths: dict[str, int] = {}
    for _num, (d, _s) in objs.items():
        if b"/Font" not in d:
            continue
        for fm in re.finditer(rb"/Font\s*<<(.*?)>>", d, re.S):
            for name, ref in re.findall(rb"/(\w+)\s+(\d+)\s+0\s+R", fm.group(1)):
                key = name.decode()
                if key in cmaps or int(ref) not in objs:
                    continue
                fd, _ = objs[int(ref)]
                widths[key] = 2 if (b"/Type0" in fd or b"Identity-H" in fd) else 1
                cmaps[key] = {}
                tu = re.search(rb"/ToUnicode\s+(\d+)\s+0\s+R", fd)
                if tu and int(tu.group(1)) in objs:
                    td, ts = objs[int(tu.group(1))]
                    dec = _pdf_decode(td, ts or b"")
                    if dec:
                        cmaps[key] = _parse_cmap(dec)

    def render(content: bytes) -> str:
        lines, line, font = [], [], None
        for m in _TOKEN.finditer(content):
            tok = m.group(0)
            if m.group(1):
                font = m.group(1).decode()
                continue
            if tok in (b"BT", b"ET", b"T*"):
                if line:
                    lines.append("".join(line))
                    line = []
                continue
            if m.group(3) is not None:
                lit = m.group(3)
                lit = re.sub(rb"\\([0-7]{1,3})", lambda x: bytes([int(x.group(1), 8) & 0xFF]), lit)
                lit = lit.replace(b"\\(", b"(").replace(b"\\)", b")").replace(b"\\\\", b"\\")
                line.append(lit.decode("latin-1"))
                continue
            cmap = cmaps.get(font or "", {})
            step = 4 if widths.get(font or "", 1) == 2 else 2
            chunks = [m.group(2)] if m.group(2) else re.findall(rb"<([0-9A-Fa-f]+)>", m.group(4) or b"")
            for chunk in chunks:
                hx = chunk.decode()
                if len(hx) % 2:
                    hx += "0"
                for i in range(0, len(hx), step):
                    line.append(cmap.get(int(hx[i:i + step], 16), ""))
        if line:
            lines.append("".join(line))
        return "\n".join(x for x in lines if x.strip())

    pages = []
    seen = set()
    refs = re.findall(rb"/Contents\s+(\d+)\s+0\s+R", raw) or re.findall(
        rb"/Contents\s*\[\s*(\d+)\s+0\s+R", raw
    )
    for ref in refs:
        num = int(ref)
        if num in seen or num not in objs:
            continue
        seen.add(num)
        d, s = objs[num]
        dec = _pdf_decode(d, s or b"")
        if dec:
            pages.append(render(dec))
    return "\n\n".join(pages)


# ---------------------------------------------------------------------------
# Is this actually the file it claims to be?
# ---------------------------------------------------------------------------
ZIP = bytes([0x50, 0x4B, 0x03, 0x04])          # docx, pptx, xlsx, zip, odt
OLE = bytes([0xD0, 0xCF, 0x11, 0xE0])          # legacy doc, ppt, xls
PNG = bytes([0x89]) + b"PNG"
JPG = bytes([0xFF, 0xD8, 0xFF])

SIGNATURES = {
    "pdf": [b"%PDF"],
    "docx": [ZIP], "pptx": [ZIP], "xlsx": [ZIP], "zip": [ZIP], "odt": [ZIP],
    "doc": [OLE], "ppt": [OLE], "xls": [OLE],
    "png": [PNG], "jpg": [JPG], "jpeg": [JPG],
    "gif": [b"GIF8"], "webp": [b"RIFF"],
}

HTML_MARKERS = (b"<!doctype html", b"<html", b"<head", b"<script")


def looks_valid(name: str, blob: bytes) -> tuple[bool, str]:
    """Check the first bytes against the extension.

    A ManageBac link can answer with a login page or a preview page while still
    claiming a file content-type. Saved blindly that lands in your notebook as a
    document that will not open — exactly what happened. Checking the signature
    turns a silent corrupt file into a clear message.
    """
    if not blob:
        return False, "the download was empty"
    head = blob[:512]
    low = head.lower()
    if any(m in low for m in HTML_MARKERS):
        return False, ("that link returned a web page, not a file "
                       "(probably a login or preview page)")

    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    expected = SIGNATURES.get(ext)
    if not expected:
        return True, ""
    if any(head.startswith(sig) for sig in expected):
        return True, ""
    return False, f"the bytes are not a real .{ext} file"
